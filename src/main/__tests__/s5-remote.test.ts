/**
 * S5 L2 验收（外围功能远端化）：远程项目注册/deferred 导入、session-import reader
 * 注入（本地/远端双源同解析）、runCliCommand 路由分派、sudo -S 命令构造（密码不进
 * argv）、skills/市场远端读、self-check server 项接线、worktree 远程显式拒绝。
 *
 * mock 连接保真策略：exec 一律经本机真实 bash 执行（env HOME=fixture home——
 * find/head/cat/test/bash -ic 语义与远端 Linux 一致，同一台机的「SSH 回环」），
 * 仅 claude/sudo/mktemp/npm-which 四类命令以罐头应答（防真实安装/慢探测）。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '../../shared/ipc-channels'
import { mungePath, listSessions, createRemoteSessionReader } from '../session-import'
import { createAppContext, registerIpcHandlers, type AppContext } from '../ipc'
import {
  bashIcCommand,
  buildRemoteNativeInstallCommand,
  buildRemoteNpmInstallCommand,
  checkClaudeUpdateRemote,
  installClaudeCliRemote,
  CliRunner,
  posixQuote
} from '../cli-runner'
import { runSelfCheck } from '../ssh/self-check'
import type { ConnectionManager, SftpSession } from '../ssh/connection-manager'
import type { ConnectionStateChangedEvent, SkillInfo, TaskRecord } from '../../shared/types'

const execFileAsync = promisify(execFile)

// ── electron mock（照 ipc.test.ts 先例：记录型 ipcMain + 广播窗口 + safeStorage）──
const h = vi.hoisted(() => {
  return {
    tempDir: '',
    handleCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
    onCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
    sent: [] as Array<{ channel: string; payload: unknown }>
  }
})

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
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handleCalls.push([channel, fn])
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.onCalls.push([channel, fn])
    }
  }
}))

// checkClaudeUpdateRemote 的 latest 链路含真实 registry HTTP——测试注入固定版本
vi.mock('../claude-version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude-version')>()
  return { ...actual, fetchLatestFromRegistry: async () => '2.2.0' }
})

/** 会话样例行（含命名素材全链：首条用户消息 + aiTitle + 时间戳） */
function sessionJsonl(title: string, firstUser: string, ts: string): string {
  return [
    `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${firstUser}"}]},"timestamp":"${ts}"}`,
    `{"type":"ai-title","aiTitle":"${title}"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[]},"timestamp":"${ts}"}`
  ].join('\n') + '\n'
}

/** mock 连接（exec=本机 bash + 罐头拦截；sftp=记录型） */
function makeMockConnection(fixtureHome: string, opts: { online?: boolean; connectFails?: boolean } = {}) {
  const commands: string[] = []
  const sftpWrites: Array<{ path: string; data: string }> = []
  const stateSubs: Array<(e: ConnectionStateChangedEvent) => void> = []
  const online = opts.online !== false
  const sftp: SftpSession = {
    list: async () => [],
    readFile: async () => Buffer.from(''),
    writeFile: async (path, data) => {
      sftpWrites.push({ path, data: data.toString() })
    }
  }
  const conn: ConnectionManager = {
    async connect(_id) {
      if (opts.connectFails === true) throw new Error('connect failed (mock offline vm)')
    },
    async disconnect(_id) {},
    getState: (_id) => (online ? 'connected' : 'offline'),
    async exec(_id, command) {
      commands.push(command)
      // 罐头拦截（防真实 claude/sudo/慢探测；命令串仍入 commands 供断言）。
      // bashIcCommand 的转义形态含 `'\''claude'\''`——按 token 组合而非原文子串判定。
      const isClaudeCmd = command.startsWith('bash -ic') && command.includes('claude')
      if (isClaudeCmd && command.includes('--version')) {
        return { code: 0, stdout: '2.1.321 (Claude Code)\n', stderr: '' }
      }
      if (isClaudeCmd) {
        return { code: 0, stdout: 'plugin command executed\n', stderr: '' }
      }
      if (command.startsWith('sudo -S')) {
        return { code: 0, stdout: 'remote install ok\n', stderr: '' }
      }
      if (command === 'mktemp') return { code: 0, stdout: '/tmp/tmp.cwbtestpw\n', stderr: '' }
      if (command.startsWith('bash -ic') && command.includes('npm')) {
        return { code: 0, stdout: '/usr/bin/npm\n', stderr: '' }
      }
      // 其余经真实 bash（HOME=fixture——与远端 Linux 同语义）
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
          env: { ...process.env, HOME: fixtureHome },
          timeout: 10_000
        })
        return { code: 0, stdout, stderr }
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number }
        return { code: e.code ?? 127, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
      }
    },
    async sftp(_id) {
      return sftp
    },
    async forwardOut() {
      throw new Error('not needed in S5 tests')
    },
    async forwardIn() {
      throw new Error('not needed in S5 tests')
    },
    onStateChange(cb) {
      stateSubs.push(cb)
      return () => {
        const i = stateSubs.indexOf(cb)
        if (i >= 0) stateSubs.splice(i, 1)
      }
    },
    onLog() {
      return () => undefined
    }
  }
  return {
    conn,
    commands,
    sftpWrites,
    fireState: (e: ConnectionStateChangedEvent) => {
      for (const cb of [...stateSubs]) cb(e)
    }
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const entry = h.handleCalls.find(([c]) => c === channel)
  if (!entry) throw new Error(`no handler registered for: ${channel}`)
  return entry[1](undefined, ...args) as Promise<T>
}

/** 轮询等待条件（deferred 导入为事件驱动的后台执行） */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met before timeout')
}

describe('S5 L2：session-import reader 注入（本地/远端双源同解析）', () => {
  let work: string
  let fixtureHome: string
  let projectDir: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'cwb-s5-'))
    fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    projectDir = join(work, 'proj-a')
    mkdirSync(projectDir, { recursive: true })
    const store = join(fixtureHome, '.claude', 'projects', mungePath(projectDir))
    mkdirSync(store, { recursive: true })
    const a = join(store, 'aaaaaaaa-0000-0000-0000-000000000001.jsonl')
    const b = join(store, 'bbbbbbbb-0000-0000-0000-000000000002.jsonl')
    writeFileSync(a, sessionJsonl('远程会话甲', '帮我看下这个报错', '2026-11-01T10:00:00.000Z'))
    writeFileSync(b, sessionJsonl('Session Beta', 'first user message beta', '2026-11-02T11:00:00.000Z'))
    utimesSync(a, new Date('2026-11-01T10:05:00.123Z'), new Date('2026-11-01T10:05:00.123Z'))
    utimesSync(b, new Date('2026-11-02T11:05:00.456Z'), new Date('2026-11-02T11:05:00.456Z'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('同一 fixture：localSessionStoreReader（缺省）与 createRemoteSessionReader（经 mock bash find/head）产出全等 SessionMeta', async () => {
    const mock = makeMockConnection(fixtureHome)
    const local = await listSessions(projectDir, {
      projectsRoot: () => join(fixtureHome, '.claude', 'projects')
    })
    const remote = await listSessions(projectDir, {
      reader: createRemoteSessionReader(mock.conn, 'c1'),
      resolveProjectsRoot: async () => `${fixtureHome}/.claude/projects`
    })
    expect(remote).toEqual(local)
    expect(local).toHaveLength(2)
    expect(local.map((s) => s.name)).toEqual(['远程会话甲', 'Session Beta']) // aiTitle 命名链生效
    expect(local[0]).toMatchObject({
      sessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
      createdAt: '2026-11-01T10:00:00.000Z',
      lastActiveAt: '2026-11-01T10:05:00.123Z'
    })
    // 远端命令形态（nvm 墙无关的标准件；流式头部只传前 HEAD_BYTES；find 序=目录序不承诺排序）
    expect(mock.commands[0]).toContain(`find '${fixtureHome}/.claude/projects/${mungePath(projectDir)}' -maxdepth 1 -name '*.jsonl' -printf`)
    const heads = mock.commands.filter((c) => c.startsWith('head -c '))
    expect(heads).toHaveLength(2)
    for (const sessionId of [
      'aaaaaaaa-0000-0000-0000-000000000001',
      'bbbbbbbb-0000-0000-0000-000000000002'
    ]) {
      expect(
        heads.some(
          (c) =>
            c ===
            `head -c 2097152 -- '${fixtureHome}/.claude/projects/${mungePath(projectDir)}/${sessionId}.jsonl'`
        )
      ).toBe(true)
    }
  })

  it('远端 reader：目录缺失 → null 语义（空列表不抛）；head 失败 → 按已读内容收场', async () => {
    const mock = makeMockConnection(fixtureHome)
    const metas = await listSessions(join(work, 'never-registered'), {
      reader: createRemoteSessionReader(mock.conn, 'c1'),
      resolveProjectsRoot: async () => `${fixtureHome}/.claude/projects`
    })
    expect(metas).toEqual([])
    const reader = createRemoteSessionReader(mock.conn, 'c1')
    expect(await reader.listSessionFiles(`${fixtureHome}/.claude/projects/-no-such-dir`)).toBeNull()
    expect(await reader.readFileHead(`${fixtureHome}/no-such-file.jsonl`, 1024)).toBe('')
  })
})

describe('S5 L2：AppContext.addProject 远程注册 + deferred 导入（3.1/3.12/6.2）', () => {
  let work: string
  let fixtureHome: string
  let projectDir: string
  let ctx: AppContext
  let mock: ReturnType<typeof makeMockConnection>

  beforeEach(() => {
    h.tempDir = mkdtempSync(join(tmpdir(), 'cwb-s5-ctx-'))
    work = mkdtempSync(join(tmpdir(), 'cwb-s5-2-'))
    fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    projectDir = join(work, 'proj-git')
    mkdirSync(join(projectDir, '.git'), { recursive: true })
    const store = join(fixtureHome, '.claude', 'projects', mungePath(projectDir))
    mkdirSync(store, { recursive: true })
    writeFileSync(
      join(store, 'cccccccc-0000-0000-0000-000000000003.jsonl'),
      sessionJsonl('已导入会话', '历史首条消息', '2026-11-03T09:00:00.000Z')
    )
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(h.tempDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(h.tempDir, 'market-home')
    h.handleCalls.length = 0
    h.onCalls.length = 0
    h.sent.length = 0
  })
  afterEach(() => {
    delete process.env['CWB_HOOK_SETTINGS_DIR']
    delete process.env['CWB_SKILLS_USER_ROOT']
    delete process.env['CWB_SKILL_MARKET_HOME']
    rmSync(work, { recursive: true, force: true })
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it('已连接：test -d 存在性/git 检测（一次往返双标记）+ 注册即远端扫描导入（stopped 任务）', async () => {
    mock = makeMockConnection(fixtureHome, { online: true })
    ctx = createAppContext({ connection: mock.conn })
    const record = await ctx.addProject(projectDir, 'conn-1')
    expect(record.connectionId).toBe('conn-1')
    expect(record.isGit).toBe(true) // stdout 含 g 标记
    const probe = mock.commands.find((c) => c.startsWith('bash -ic') && c.includes('test -d'))
    // 探测命令构造契约：bash -ic 包装 + 双层 posixQuote（dir 单引号转义后入内层脚本）
    const script = `d=${posixQuote(projectDir)}; test -d "$d" && printf x; test -d "$d/.git" && printf g`
    expect(probe).toBe(`bash -ic ${posixQuote(script)}`)
    // 注册即导入：远端扫描（HOME→find→head）生成 stopped 任务并广播
    const tasks = ctx.tasks.list(record.id)
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((t) => t.status === 'stopped')).toBe(true)
    expect(tasks[0]?.cwd).toBe(projectDir)
    expect(h.sent.filter((e) => e.channel === IpcChannels.TaskUpdate).length).toBeGreaterThan(0)
  })

  it('已连接但目录不存在：conn.proj.dirMissing 报错、不落项目记录', async () => {
    mock = makeMockConnection(fixtureHome, { online: true })
    ctx = createAppContext({ connection: mock.conn })
    const missing = join(work, 'no-such-dir')
    await expect(ctx.addProject(missing, 'conn-1')).rejects.toThrow(/远程目录不存在/)
    expect(ctx.projects.list()).toEqual([])
  })

  it('未连接（connect 失败）：注册不阻断、无检测；连接成功事件触发幂等增量补跑（3.12=a）', async () => {
    mock = makeMockConnection(fixtureHome, { online: false, connectFails: true })
    ctx = createAppContext({ connection: mock.conn })
    const record = await ctx.addProject(projectDir, 'conn-1')
    expect(record.connectionId).toBe('conn-1')
    expect(record.isGit).toBe(false) // 未连接→未检测
    expect(mock.commands.filter((c) => c.includes('test -d'))).toHaveLength(0) // 挂起：无探测
    expect(ctx.tasks.list(record.id)).toEqual([]) // 未导入
    // 连接成功事件 → deferred 补跑（项目记录即挂起登记）
    mock.fireState({ connectionId: 'conn-1', state: 'connected' })
    await until(() => ctx.tasks.list(record.id).length > 0)
    const tasks = ctx.tasks.list(record.id)
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((t: TaskRecord) => t.status === 'stopped')).toBe(true)
    const countAfterFirst = tasks.length
    // 再次连接成功 → 幂等增量（sessionId 全局查重，零新增）
    mock.fireState({ connectionId: 'conn-1', state: 'connected' })
    await new Promise((r) => setTimeout(r, 300))
    expect(ctx.tasks.list(record.id)).toHaveLength(countAfterFirst)
  })

  it('worktree 隔离：远程项目显式拒绝（校验前移，i18n 文案）', async () => {
    mock = makeMockConnection(fixtureHome, { online: true })
    ctx = createAppContext({ connection: mock.conn })
    const record = ctx.projects.add(projectDir, true, 'conn-1')
    await expect(
      ctx.createTask(record.id, 't', { isolation: 'worktree' })
    ).rejects.toThrow(/远程项目暂不支持 worktree 隔离/)
  })
})

describe('S5 L2：runCliCommand 路由分派 + cli 输出回投（M10/6.5）', () => {
  let work: string
  let fixtureHome: string
  let mock: ReturnType<typeof makeMockConnection>
  let ctx: AppContext

  beforeEach(() => {
    h.tempDir = mkdtempSync(join(tmpdir(), 'cwb-s5-cli-'))
    work = mkdtempSync(join(tmpdir(), 'cwb-s5-3-'))
    fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(h.tempDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(h.tempDir, 'market-home')
    h.handleCalls.length = 0
    h.onCalls.length = 0
    h.sent.length = 0
    mock = makeMockConnection(fixtureHome, { online: true })
    ctx = createAppContext({ connection: mock.conn })
    registerIpcHandlers(ctx)
  })
  afterEach(() => {
    delete process.env['CWB_HOOK_SETTINGS_DIR']
    delete process.env['CWB_SKILLS_USER_ROOT']
    delete process.env['CWB_SKILL_MARKET_HOME']
    rmSync(work, { recursive: true, force: true })
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it('connectionId 非空 → bash -ic 远端执行 + 输出经 cli-output 回投 + exit 事件', async () => {
    const { commandId } = await invoke<{ commandId: string }>(
      IpcChannels.CliRun,
      'claude plugin marketplace update',
      'conn-1'
    )
    expect(mock.commands).toContain(bashIcCommand(['claude', 'plugin', 'marketplace', 'update']))
    await until(() =>
      h.sent.some((e) => e.channel === IpcChannels.CliOutput && (e.payload as { commandId: string; type?: string }).commandId === commandId && (e.payload as { type?: string }).type === 'exit')
    )
    const outputs = h.sent
      .filter((e) => e.channel === IpcChannels.CliOutput && (e.payload as { commandId: string }).commandId === commandId)
      .map((e) => e.payload as { data?: string; type?: string; exitCode?: number })
    expect(outputs.some((o) => o.data?.includes('plugin command executed'))).toBe(true)
    const exit = outputs.find((o) => o.type === 'exit')
    expect(exit?.exitCode).toBe(0)
    expect(ctx.cli.isRunning(commandId)).toBe(false)
  })

  it("远端放行只读 'claude --version'（本地白名单不受影响——无 connectionId 仍拒绝）", async () => {
    const { commandId } = await invoke<{ commandId: string }>(
      IpcChannels.CliRun,
      'claude --version',
      'conn-1'
    )
    expect(mock.commands).toContain(bashIcCommand(['claude', '--version']))
    await until(() =>
      h.sent.some(
        (e) => e.channel === IpcChannels.CliOutput && (e.payload as { commandId: string }).commandId === commandId
      )
    )
    const text = h.sent
      .filter((e) => e.channel === IpcChannels.CliOutput && (e.payload as { commandId: string }).commandId === commandId)
      .map((e) => (e.payload as { data?: string }).data ?? '')
      .join('')
    expect(text).toContain('Claude Code')
    // 本地路径：--version 不在冻结白名单 → 拒绝（既有行为不变）
    await expect(invoke(IpcChannels.CliRun, 'claude --version')).rejects.toThrow(/--version/)
    expect(mock.commands.filter((c) => c.includes('--version'))).toHaveLength(1) // 只有远端那一次
  })

  it('远端同样拒绝元字符注入（校验先于 exec）', async () => {
    await expect(
      invoke(IpcChannels.CliRun, 'claude plugin install "a;rm -rf /"', 'conn-1')
    ).rejects.toThrow(/元字符/)
    expect(mock.commands.filter((c) => c.includes('rm -rf'))).toHaveLength(0)
  })
})

describe('S5 L2：sudo -S 命令构造与远端安装（6.6=B——密码不进 argv/命令串）', () => {
  const PW = 'S3cret-Pw-65oa'

  it('buildRemoteNpmInstallCommand（系统前缀）：sudo -S -p 空提示 + stdin 重定向 + 自清；命令串不含密码', () => {
    const cmd = buildRemoteNpmInstallCommand('/usr/bin/npm', '/tmp/tmp.cwbtestpw')
    expect(cmd).toContain(`sudo -S -p '' -k env PATH='/usr/bin:/usr/local/bin:/usr/bin:/bin'`)
    expect(cmd).toContain(`'npm'`.replace('npm', '/usr/bin/npm'))
    expect(cmd).toContain(`< '/tmp/tmp.cwbtestpw'`)
    expect(cmd).toContain(`rm -f '/tmp/tmp.cwbtestpw'`)
    expect(cmd).not.toContain(PW) // 密码绝不进命令串（即 argv 可见面）
    expect(cmd).toContain('install -g @anthropic-ai/claude-code')
  })

  it('buildRemoteNpmInstallCommand（用户前缀）：无 sudo 直接 bash -ic 安装', () => {
    const cmd = buildRemoteNpmInstallCommand('/home/vm/.nvm/versions/node/v22/bin/npm')
    expect(cmd.startsWith('bash -ic ')).toBe(true)
    expect(cmd).not.toContain('sudo')
  })

  it('buildRemoteNativeInstallCommand：复用 platform.ts 官方安装器模板（bash -ic 包装）', () => {
    const cmd = buildRemoteNativeInstallCommand()
    expect(cmd).toContain('bash -ic ')
    expect(cmd).toContain('claude.ai/install.sh')
  })

  it('installClaudeCliRemote（npm 系统前缀）：mktemp+SFTP 写密码文件+stdin 重定向；命令串不含密码', async () => {
    const work = mkdtempSync(join(tmpdir(), 'cwb-s5-sudo-'))
    const fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    const mock = makeMockConnection(fixtureHome, { online: true })
    const outputs: Array<{ commandId: string; data?: string }> = []
    const runner = new CliRunner({
      onData: (e) => outputs.push(e),
      onExit: () => undefined
    })
    const { commandId } = await installClaudeCliRemote(runner, mock.conn, 'c1', 'npm', {
      password: PW
    })
    await until(() => outputs.some((o) => o.commandId === commandId && o.data !== undefined))
    // 密码经 SFTP 写入 mktemp 文件（0600 既有文件覆写不改变权限）——不进任何命令串
    expect(mock.sftpWrites).toEqual([{ path: '/tmp/tmp.cwbtestpw', data: `${PW}\n` }])
    const sudoCmd = mock.commands.find((c) => c.startsWith('sudo -S'))
    expect(sudoCmd).toBeDefined()
    expect(sudoCmd).not.toContain(PW)
    expect(sudoCmd).toContain(`< '/tmp/tmp.cwbtestpw'`)
    // 输出回投（cli-output 形态）
    expect(outputs.map((o) => o.data ?? '').join('')).toContain('remote install ok')
    rmSync(work, { recursive: true, force: true })
  })

  it('installClaudeCliRemote：系统前缀而无密码（私钥档案）→ 明确报错（cli.errNoSudoPassword）', async () => {
    const work = mkdtempSync(join(tmpdir(), 'cwb-s5-sudo2-'))
    const fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    const mock = makeMockConnection(fixtureHome, { online: true })
    const runner = new CliRunner({ onData: () => undefined, onExit: () => undefined })
    await expect(
      installClaudeCliRemote(runner, mock.conn, 'c1', 'npm', {})
    ).rejects.toThrow(/私钥认证/)
    rmSync(work, { recursive: true, force: true })
  })
})

describe('S5 L2：checkClaudeUpdateRemote / self-check server 项接线', () => {
  it('checkClaudeUpdateRemote：current=远端探测、latest=registry（mock 注入）、upToDate=false', async () => {
    const work = mkdtempSync(join(tmpdir(), 'cwb-s5-upd-'))
    const fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    const mock = makeMockConnection(fixtureHome, { online: true })
    const info = await checkClaudeUpdateRemote(mock.conn, 'c1')
    expect(info).toEqual({ current: '2.1.321', latest: '2.2.0', upToDate: false })
    expect(mock.commands).toContain(bashIcCommand(['claude', '--version']))
    rmSync(work, { recursive: true, force: true })
  })

  it('runSelfCheck server 项：probeServerVersion 映射——ok:true→ok+版本；探活不通→missing（不阻断）', async () => {
    const health = 'HTTP/1.0 200 OK\r\n\r\n{"ok":true,"server":"cwb-server","version":"0.1.0"}'
    const okItems = await runSelfCheck(async (command) => {
      if (command.includes('command -v claude')) {
        return { code: 0, stdout: '/nvm/claude\n2.1.321 (Claude Code)\n', stderr: 'bash: no job control\n' }
      }
      if (command.includes('command -v node')) return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
      if (command.includes('/dev/tcp/')) return { code: 0, stdout: health, stderr: '' }
      return { code: 127, stdout: '', stderr: '' }
    })
    expect(okItems.find((i) => i.id === 'server')).toEqual({ id: 'server', status: 'ok', detail: '0.1.0' })

    const missItems = await runSelfCheck(async (command) => {
      if (command.includes('command -v claude')) {
        return { code: 0, stdout: '2.1.321 (Claude Code)\n', stderr: '' }
      }
      if (command.includes('command -v node')) return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
      return { code: 1, stdout: '', stderr: '' } // /dev/tcp 探测失败（server 未监听）
    })
    expect(missItems.find((i) => i.id === 'server')?.status).toBe('missing')
    expect(['claude', 'node'].every((id) => missItems.find((i) => i.id === id)?.status === 'ok')).toBe(true)
  })
})

describe('S5 L2：skills/市场远端读 + 远程上下文路由（6.1=a）', () => {
  let work: string
  let fixtureHome: string
  let mock: ReturnType<typeof makeMockConnection>
  let ctx: AppContext
  let savedId = ''

  beforeEach(async () => {
    h.tempDir = mkdtempSync(join(tmpdir(), 'cwb-s5-skl-'))
    work = mkdtempSync(join(tmpdir(), 'cwb-s5-4-'))
    fixtureHome = realpathSync(mkdtempSync(join(work, 'home')))
    // 用户级 skill + 插件 skill + settings 启用态
    mkdirSync(join(fixtureHome, '.claude', 'skills', 'sentinel-skill'), { recursive: true })
    writeFileSync(
      join(fixtureHome, '.claude', 'skills', 'sentinel-skill', 'SKILL.md'),
      '---\nname: sentinel-skill\ndescription: VM 侧哨兵技能\nversion: 1.0.0\n---\n正文\n'
    )
    const installPath = join(fixtureHome, '.claude', 'plugins', 'cache', 'official', 'demo', '1.0.0')
    mkdirSync(join(installPath, 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(
      join(installPath, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 插件技能\n---\n正文\n'
    )
    writeFileSync(
      join(fixtureHome, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'demo@official': [{ scope: 'user', installPath }] } })
    )
    writeFileSync(
      join(fixtureHome, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'demo@official': true } })
    )
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(h.tempDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(h.tempDir, 'market-home')
    h.handleCalls.length = 0
    h.onCalls.length = 0
    h.sent.length = 0
    mock = makeMockConnection(fixtureHome, { online: true })
    ctx = createAppContext({ connection: mock.conn })
    registerIpcHandlers(ctx)
    // 连接档案（activeConnectionId 数据源）——getState('connected') 对任意 id 均真
    const saved = await invoke<{ id: string }>(IpcChannels.ConnectionsSave, {
      name: 'vm',
      host: '127.0.0.1',
      port: 22,
      user: 'vmuser',
      authMethod: 'key',
      keyPath: '/tmp/fake-key'
    })
    savedId = saved.id
  })
  afterEach(() => {
    delete process.env['CWB_HOOK_SETTINGS_DIR']
    delete process.env['CWB_SKILLS_USER_ROOT']
    delete process.env['CWB_SKILL_MARKET_HOME']
    rmSync(work, { recursive: true, force: true })
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it('SkillsList 远程上下文：VM 侧用户级+插件级清单（dir=VM 绝对路径、启用态标注）', async () => {
    const skills = await invoke<SkillInfo[]>(IpcChannels.SkillsList)
    const sentinel = skills.find((s) => s.name === 'sentinel-skill')
    expect(sentinel).toMatchObject({
      source: 'user',
      dir: `${fixtureHome}/.claude/skills/sentinel-skill`,
      description: 'VM 侧哨兵技能',
      version: '1.0.0',
      activation: 'auto'
    })
    const demo = skills.find((s) => s.name === 'demo-skill')
    expect(demo).toMatchObject({
      source: 'plugin',
      pluginId: 'demo@official',
      pluginEnabled: true
    })
  })

  it('SkillsImport/SkillsRemove 远程上下文拒绝（错侧落盘防护）', async () => {
    await expect(
      invoke(IpcChannels.SkillsImport, '/tmp/src', { scope: 'user' })
    ).rejects.toThrow(/远程上下文暂不支持导入\/移除/)
    await expect(
      invoke(IpcChannels.SkillsRemove, { name: 'x', description: '', source: 'user', dir: '/tmp/x' })
    ).rejects.toThrow(/远程上下文暂不支持导入\/移除/)
  })

  it('SkillMarketInstall 远程上下文：runPluginRemote 分派（bash -ic claude plugin install）', async () => {
    const r = await invoke<{ ok: boolean; commandId?: string; error?: string }>(
      IpcChannels.SkillMarketInstall,
      'pdf-tools@claude-plugins-official'
    )
    expect(r.ok).toBe(true)
    expect(r.commandId).toBeDefined()
    expect(mock.commands).toContain(
      bashIcCommand(['claude', 'plugin', 'install', 'pdf-tools@claude-plugins-official', '-y'])
    )
  })

  it('SkillPluginSetEnabled 远程上下文：白名单取 VM 侧安装记录（demo@official 可启用）', async () => {
    const r = await invoke<{ ok: boolean; error?: string }>(
      IpcChannels.SkillPluginSetEnabled,
      'demo@official',
      false
    )
    expect(r.ok).toBe(true)
    expect(mock.commands).toContain(bashIcCommand(['claude', 'plugin', 'disable', 'demo@official', '-s', 'user']))
    // 未安装的 id → VM 侧白名单拒绝（不 exec）
    const r2 = await invoke<{ ok: boolean; error?: string }>(
      IpcChannels.SkillPluginSetEnabled,
      'ghost@official',
      true
    )
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('ghost@official')
    expect(mock.commands.filter((c) => c.includes('ghost@official'))).toHaveLength(0)
  })

  it('VersionGet/UpdateCheck 远程上下文：远端探测 + 来源标注（path=ssh:<id>）', async () => {
    const v = await invoke<{ version: string; path: string }>(IpcChannels.VersionGet)
    expect(v).toEqual({ version: '2.1.321', path: `ssh:${savedId}` }) // path 标注来源连接
    const u = await invoke<{ current: string; latest: string; upToDate: boolean }>(IpcChannels.UpdateCheck)
    expect(u).toEqual({ current: '2.1.321', latest: '2.2.0', upToDate: false })
  })
})
