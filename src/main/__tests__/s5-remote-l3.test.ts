/**
 * S5 L3 验收（真实执行·本机 localhost sshd + 真实 ~/.claude）：
 * ① 注册 /tmp/cwb-pty-run 为远程项目 → 真实远端 git 检测 + 会话扫描导入生成任务记录
 *    （任务数 > 0 且 status=stopped）；
 * ② runCliCommand('claude --version', connId) 远端执行——真实 claude 二进制，输出回流
 *    含 'Claude Code'；
 * ③ skills 远端清单非空（本机 ~/.claude/skills 即远端侧——如空则放哨兵目录后清理）。
 *
 * 链路：真 sshd + 真 bash -ic（nvm PATH 墙实证面）+ 真 find/head 流式读 + 真会话 jsonl。
 * 凭据：临时 ed25519 密钥对（照 S2/S7 先例），authorized_keys 以 marker 行定位、
 * teardown surgical 删除并收尾 grep 复核（并发教训见 checkpoint-main）。
 * 运行前提：本机 sshd(22) + claude/node 可解析（自检阻断项）——不可达时整组跳过。
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAppContext, type AppContext } from '../ipc'
import { CliRunner } from '../cli-runner'
import { createSshConnectionStack } from '../ssh'
import { RealConnectionManager } from '../ssh/manager'
import { ConnectionsStore, parseConnectionInput } from '../connections-store'
import { ConnectionError } from '../ssh/errors'
import type { CliOutputEvent } from '../../shared/types'

const sshPortOpen = (): boolean => {
  try {
    execFileSync('bash', ['-c', 'exec 3<>/dev/tcp/127.0.0.1/22'], { timeout: 3_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ── electron mock（AppContext 组合所需最小面；userData 指向 temp 防污染真实数据）──
const h = vi.hoisted(() => ({ tempDir: '', sent: [] as Array<{ channel: string; payload: unknown }> }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  app: {
    getPath: (_name: string) => h.tempDir,
    getVersion: () => '1.1.0-test',
    isPackaged: false,
    quit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  shell: { openExternal: vi.fn(async () => true), trashItem: vi.fn(async () => undefined) },
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } }
    ]
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const REMOTE_PROJECT_DIR = '/tmp/cwb-pty-run'
const SESSIONS_DIR = join(homedir(), '.claude', 'projects', '-tmp-cwb-pty-run')
const SKILLS_DIR = join(homedir(), '.claude', 'skills')
const SENTINEL_SKILL = 'cwb-s5-l3-sentinel'

describe.skipIf(!sshPortOpen())('S5 L3：localhost sshd + 真实 ~/.claude 全链', () => {
  let workDir: string
  let keyPath: string
  let authorizedKeysPath: string
  let authorizedKeysLinesBefore: number
  let manager: RealConnectionManager
  let connectionId: string
  let ctx: AppContext
  let cliOutputs: CliOutputEvent[]
  let sessionsDirExisted: boolean
  let sentinelCreated: boolean
  let gitInitializedByTest = false

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'cwb-s5-l3-'))
    h.tempDir = join(workDir, 'userdata')
    mkdirSync(h.tempDir, { recursive: true })

    // ① 远端（=本机）项目目录：真实 git 仓库（git 检测断言依据）。目录可能以空壳
    //    残留（S4 测试先例）——存在但非 git 仓库时补 git init；.git 由本测试创建则
    //    teardown 还原（目录本体留置——先于本测试存在，不属清理权责）
    gitInitializedByTest = !existsSync(join(REMOTE_PROJECT_DIR, '.git'))
    if (gitInitializedByTest) {
      mkdirSync(REMOTE_PROJECT_DIR, { recursive: true })
      execFileSync('git', ['-C', REMOTE_PROJECT_DIR, 'init'], { stdio: 'ignore' })
    }
    // ② 真实 ~/.claude/projects 会话数据：目标 munged 目录不存在则播一条真实形态 jsonl
    sessionsDirExisted = existsSync(SESSIONS_DIR)
    if (!sessionsDirExisted) {
      mkdirSync(SESSIONS_DIR, { recursive: true })
      writeFileSync(
        join(SESSIONS_DIR, 's5l30000-0000-4000-8000-000000000001.jsonl'),
        [
          '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"L3 远端会话导入链路验证"}]},"timestamp":"2026-11-10T08:00:00.000Z"}',
          '{"type":"ai-title","aiTitle":"L3 远端导入验证会话"}',
          '{"type":"assistant","message":{"role":"assistant","content":[]},"timestamp":"2026-11-10T08:00:01.000Z"}'
        ].join('\n') + '\n'
      )
    }
    // ③ skills 哨兵（清单非空断言依据；本机已有 skills 时不创建）
    sentinelCreated = false
    if (!existsSync(SKILLS_DIR) || readdirSafe(SKILLS_DIR).length === 0) {
      mkdirSync(join(SKILLS_DIR, SENTINEL_SKILL), { recursive: true })
      writeFileSync(
        join(SKILLS_DIR, SENTINEL_SKILL, 'SKILL.md'),
        '---\nname: cwb-s5-l3-sentinel\ndescription: L3 哨兵技能\n---\n正文\n'
      )
      sentinelCreated = true
    }

    // ④ 临时密钥对 + authorized_keys marker 追加（surgical teardown 见 afterAll）
    keyPath = join(workDir, 'id_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'cwb-s5-l3'], {
      stdio: 'ignore'
    })
    const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const marker = `# cwb-s5-l3 ${join(workDir, '')}`
    authorizedKeysPath = join(process.env['HOME'] ?? tmpdir(), '.ssh', 'authorized_keys')
    const before = readFileSync(authorizedKeysPath, 'utf8')
    authorizedKeysLinesBefore = before.split('\n').filter((l) => l !== '').length
    appendFileSync(authorizedKeysPath, `${marker}\n${pub}\n`)

    // ⑤ 真实连接栈 + TOFU 两步锁定（S7 先例；store 目录先行——persist 原子写的父目录）
    mkdirSync(join(workDir, 'store'), { recursive: true })
    const store = new ConnectionsStore(join(workDir, 'store'))
    manager = createSshConnectionStack({ baseDir: join(workDir, 'store') })
    let record = store.save(
      parseConnectionInput('zh', {
        name: 's5-l3',
        host: '127.0.0.1',
        port: 22,
        user: process.env['USER'] ?? 'nobody',
        authMethod: 'key',
        keyPath
      }).record
    )
    connectionId = record.id
    try {
      await manager.connect(connectionId)
    } catch (err) {
      if (
        err instanceof ConnectionError &&
        err.kind === 'hostKeyConfirm' &&
        err.hostKeyFingerprint !== undefined
      ) {
        record = store.save({ ...record, lastHostKeyFingerprint: err.hostKeyFingerprint })
        await manager.connect(connectionId)
      } else {
        throw err
      }
    }
    expect(manager.getState(connectionId)).toBe('connected')

    // ⑥ AppContext（注入真实连接；广播面由 h.sent 承接断言）
    cliOutputs = []
    ctx = createAppContext({
      connection: manager,
      onPtyData: () => undefined
    })
  }, 120_000)

  afterAll(() => {
    try {
      manager?.disconnect(connectionId)
    } catch {
      /* best effort */
    }
    manager?.disposeAll()
    // authorized_keys surgical 清理（marker+key 两行）+ 收尾复核（checkpoint 教训）
    try {
      const lines = readFileSync(authorizedKeysPath, 'utf8').split('\n')
      const idx = lines.findIndex((l) => l.startsWith('# cwb-s5-l3 '))
      if (idx >= 0) lines.splice(idx, 2)
      writeFileSync(authorizedKeysPath, lines.join('\n'))
      const after = readFileSync(authorizedKeysPath, 'utf8')
      expect(after.includes('# cwb-s5-l3 ')).toBe(false)
      expect(after.split('\n').filter((l) => l !== '').length).toBe(authorizedKeysLinesBefore)
    } catch (err) {
      throw new Error(`authorized_keys 清理复核失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 会话种子目录/git 仓库补建/哨兵 skill——仅清理本测试创建的部分
    try {
      if (gitInitializedByTest && existsSync(join(REMOTE_PROJECT_DIR, '.git'))) {
        rmSync(join(REMOTE_PROJECT_DIR, '.git'), { recursive: true, force: true })
      }
      if (!sessionsDirExisted && existsSync(SESSIONS_DIR)) rmSync(SESSIONS_DIR, { recursive: true, force: true })
      if (sentinelCreated && existsSync(join(SKILLS_DIR, SENTINEL_SKILL))) {
        rmSync(join(SKILLS_DIR, SENTINEL_SKILL), { recursive: true, force: true })
      }
    } catch {
      /* best effort */
    }
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true })
  })

  it('① 远程项目注册：真实 git 检测 + ~/.claude/projects 会话扫描导入（任务 > 0 且 stopped）', async () => {
    const record = await ctx.addProject(REMOTE_PROJECT_DIR, connectionId)
    expect(record.connectionId).toBe(connectionId)
    expect(record.isGit).toBe(true) // 真实远端 test -d /tmp/cwb-pty-run/.git
    const tasks = ctx.tasks.list(record.id)
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((t) => t.status === 'stopped')).toBe(true)
    expect(tasks.some((t) => t.sessionId === 's5l30000-0000-4000-8000-000000000001')).toBe(!sessionsDirExisted)
    console.log('[S5-L3] ① 注册导入任务数:', tasks.length, '样例:', JSON.stringify(tasks[0]?.name))
  }, 60_000)

  it('② runCliCommand 远端执行：真实 claude --version 输出回流含 Claude Code', async () => {
    const runner = new CliRunner({
      onData: (e) => cliOutputs.push(e),
      onExit: (commandId, exitCode) => cliOutputs.push({ commandId, type: 'exit', exitCode })
    })
    const { commandId } = await runner.runRemote(manager, connectionId, 'claude --version')
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000
      const tick = (): void => {
        if (cliOutputs.some((o) => o.commandId === commandId && o.type === 'exit')) resolve()
        else if (Date.now() > deadline) reject(new Error('remote claude --version timeout'))
        else setTimeout(tick, 100)
      }
      tick()
    })
    const text = cliOutputs
      .filter((o) => o.commandId === commandId && o.data !== undefined)
      .map((o) => o.data)
      .join('')
    console.log('[S5-L3] ② 远端 claude --version 原始输出:', JSON.stringify(text.trim()))
    expect(text).toContain('Claude Code')
    const exit = cliOutputs.find((o) => o.commandId === commandId && o.type === 'exit')
    expect(exit?.exitCode).toBe(0)
  }, 45_000)

  it('③ skills 远端清单非空（经 SSH 读远端 ~/.claude/skills+插件级）', async () => {
    const skills = await ctx.skills.listRemote(manager, connectionId)
    console.log(
      '[S5-L3] ③ 远端 skills 数:',
      skills.length,
      '来源分布:',
      JSON.stringify({
        user: skills.filter((s) => s.source === 'user').length,
        plugin: skills.filter((s) => s.source === 'plugin').length
      })
    )
    expect(skills.length).toBeGreaterThan(0)
    for (const s of skills) expect(s.dir.startsWith('/')).toBe(true) // VM 绝对路径（来源标注）
  }, 60_000)
})

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
