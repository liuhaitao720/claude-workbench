import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutingPtyManager } from '../ipc'
import type { PtyBackend } from '../pty-backend'
import { RemotePtyHub } from '../remote-pty'
import { startTaskActivityServer } from '../task-activity'
import { TaskStore } from '../task-store'
import { runSelfCheck } from '../ssh/self-check'

/**
 * S4 L2：路由分派 + buildSettings 参数化 + normalizeOnStartup 分流 + 自检命令形态。
 * - RoutingPtyManager：task→connectionId 分派 Local/Remote（记录在 store 时）；
 *   killAllTrees=本地杀树+远程 detach-only。
 * - buildSettings：urlBase 注入（VM 侧 forwardIn 口）/ sink 远端写（SFTP）/ epoch
 *   顺序（noteSpawn 先行，settings 捕获新 epoch）；缺省参数=本地行为不变。
 * - task-store：远程项目 running 不归一（M11），本地照旧。
 * - self-check：bash -ic 命令形态（nvm PATH 墙）+ stderr 噪音剥离。
 */

/** 记录型后端替身（方法命中计数） */
class CountingBackend implements PtyBackend {
  readonly hits: string[] = []
  running = new Set<string>()
  async spawnClaude(): Promise<void> {
    this.hits.push('spawnClaude')
  }
  spawn(): void {
    this.hits.push('spawn')
  }
  write(): void {
    this.hits.push('write')
  }
  resize(): void {
    this.hits.push('resize')
  }
  kill(): void {
    this.hits.push('kill')
  }
  isRunning(taskId: string): boolean {
    this.hits.push('isRunning')
    return this.running.has(taskId)
  }
  pid(): number | undefined {
    this.hits.push('pid')
    return undefined
  }
  killAllTrees(): void {
    this.hits.push('killAllTrees')
  }
  currentSize(): { cols: number; rows: number } | undefined {
    this.hits.push('currentSize')
    return undefined
  }
  forget(): void {
    this.hits.push('forget')
  }
}

/** hub 替身：managerFor 返回固定 backend（不触真实连接） */
function fakeHub(target: PtyBackend): RemotePtyHub {
  return {
    managerFor: () => target,
    ensureConnected: async () => {},
    proxyRequest: async () => undefined,
    hookPortFor: async () => 39000,
    detachAll: () => target.killAllTrees(),
    disposeAll: () => {}
  } as unknown as RemotePtyHub
}

describe('S4 RoutingPtyManager 路由分派（task→project.connectionId）', () => {
  it('① 远程任务（connectionId 解析命中）→ Remote 后端；本地/未知任务 → Local 后端', () => {
    const local = new CountingBackend()
    const remote = new CountingBackend()
    const routing = new RoutingPtyManager(local, fakeHub(remote), (taskId) =>
      taskId.startsWith('r-') ? 'conn-1' : undefined
    )
    routing.write('r-remote-task', 'hi')
    expect(remote.hits).toEqual(['write'])
    expect(local.hits).toEqual([])
    routing.write('local-task', 'hi')
    routing.resize('local-task', 80, 24)
    routing.kill('local-task')
    routing.isRunning('local-task')
    routing.forget('local-task')
    expect(local.hits).toEqual(['write', 'resize', 'kill', 'isRunning', 'forget'])
    expect(remote.hits).toEqual(['write'])
  })

  it('② killAllTrees 双语义分发：Local=杀树 + Remote=detach-only（hub.detachAll）', () => {
    const local = new CountingBackend()
    const remote = new CountingBackend()
    const routing = new RoutingPtyManager(local, fakeHub(remote), () => 'conn-1')
    routing.killAllTrees()
    expect(local.hits).toContain('killAllTrees')
    expect(remote.hits).toContain('killAllTrees') // 经 hub.detachAll → manager 的 detach-only
  })
})

describe('S4 buildSettings 参数化（urlBase/远端 sink/epoch 顺序）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cwb-s4-settings-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('③ 缺省参数=本地行为不变：写 settingsDir/<taskId>.json、URL=127.0.0.1:<port>', async () => {
    const h = startTaskActivityServer({ settingsDir: dir })
    try {
      await h.ready()
      const path = await h.buildSettings('t-local')
      expect(path).toBe(join(dir, 't-local.json'))
      expect(existsSync(path)).toBe(true)
      const url = (JSON.parse(readFileSync(path, 'utf8')) as { hooks: { Stop: Array<{ hooks: Array<{ url: string }> }> } })
        .hooks.Stop[0]!.hooks[0]!.url
      expect(url).toBe(`http://127.0.0.1:${h.port}/hook/Stop?e=0&t=t-local`)
    } finally {
      h.dispose()
    }
  })

  it('④ urlBase+sink（远程分支）：URL 指向 VM 侧 forwardIn 口、内容经 sink 写远端、返回 sink.path、本地零落盘', async () => {
    const h = startTaskActivityServer({ settingsDir: dir })
    try {
      await h.ready()
      // epoch 顺序（照 ipc.ts:437-440 本地先例）：先 noteSpawn 拿新 epoch 再构造 settings
      h.noteSpawn('t-remote') // epoch 0→1
      const written: string[] = []
      const path = await h.buildSettings('t-remote', {
        urlBase: 'http://127.0.0.1:39527',
        sink: {
          path: '/home/vmuser/.cwb-server/task-settings/t-remote.json',
          write: (c) => {
            written.push(c)
            return Promise.resolve()
          }
        }
      })
      expect(path).toBe('/home/vmuser/.cwb-server/task-settings/t-remote.json')
      expect(written).toHaveLength(1)
      expect(existsSync(join(dir, 't-remote.json'))).toBe(false) // 本地零落盘
      const parsed = JSON.parse(written[0]!) as {
        hooks: {
          Stop: Array<{ hooks: Array<{ url: string }> }>
          PreToolUse: Array<{ matcher?: string; hooks: Array<{ url: string }> }>
        }
      }
      expect(parsed.hooks.Stop[0]!.hooks[0]!.url).toBe(
        'http://127.0.0.1:39527/hook/Stop?e=1&t=t-remote' // e=1：noteSpawn 后的新 epoch
      )
      expect(parsed.hooks.PreToolUse[0]!.matcher).toBe('AskUserQuestion|ExitPlanMode')
      expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.url).toContain(
        'http://127.0.0.1:39527/hook/PreToolUse?e=1&t=t-remote'
      )
      // 再 resume：epoch 递增（e=2）——旧 PTY 迟到 hook 作废语义在远程同样成立
      h.noteSpawn('t-remote')
      await h.buildSettings('t-remote', {
        urlBase: 'http://127.0.0.1:39527',
        sink: { path: '/x/t.json', write: () => Promise.resolve() }
      })
      const second = JSON.parse(written[0]!) as { hooks: { Stop: Array<{ hooks: Array<{ url: string }> }> } }
      expect(second.hooks.Stop[0]!.hooks[0]!.url).toContain('e=1') // 第一次的快照不受影响
      const third = await h.buildSettings('t-remote', {
        urlBase: 'http://127.0.0.1:39527',
        sink: {
          path: '/x/t.json',
          write: (c) => {
            written.push(c)
            return Promise.resolve()
          }
        }
      })
      expect(third).toBe('/x/t.json')
      expect(
        (JSON.parse(written[written.length - 1]!) as { hooks: { Stop: Array<{ hooks: Array<{ url: string }> }> } })
          .hooks.Stop[0]!.hooks[0]!.url
      ).toContain('e=2')
    } finally {
      h.dispose()
    }
  })
})

describe('S4 task-store normalizeOnStartup 分流（M11：远程 running 不归一）', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cwb-s4-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('⑤ 远程项目任务保持 running（重连 5.6 自动恢复视图）；本地归一 stopped；无参=全归一（兼容）', () => {
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify([
        { id: 't-remote', projectId: 'p-r', name: 'r', sessionId: 't-remote', cwd: '/vm/a', status: 'running', createdAt: now, lastActiveAt: now },
        { id: 't-local', projectId: 'p-l', name: 'l', sessionId: 't-local', cwd: '/local/a', status: 'running', createdAt: now, lastActiveAt: now }
      ]),
      'utf8'
    )
    const isRemote = (t: { projectId: string }): boolean => t.projectId === 'p-r'
    new TaskStore(dir).normalizeOnStartup(isRemote)
    const after = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as Array<{ id: string; status: string }>
    expect(after.find((t) => t.id === 't-remote')?.status).toBe('running') // 5.9=b 保活语义
    expect(after.find((t) => t.id === 't-local')?.status).toBe('stopped')
    // 无参（旧行为兼容）：全归一
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify([{ id: 't-remote', projectId: 'p-r', name: 'r', sessionId: 't-remote', cwd: '/vm/a', status: 'running', createdAt: now, lastActiveAt: now }]),
      'utf8'
    )
    new TaskStore(dir).normalizeOnStartup()
    const after2 = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as Array<{ id: string; status: string }>
    expect(after2[0]?.status).toBe('stopped')
  })
})

describe('S2/S4 self-check 命令形态升级（bash -ic 破 nvm PATH 墙）', () => {
  it('⑥ claude/node 探测命令包 bash -ic（非交互 exec 的 PATH 不含 nvm shim）；stderr 噪音剥离、stdout 末行=版本', async () => {
    const commands: string[] = []
    const exec = async (cmd: string): Promise<{ code: number; stdout: string; stderr: string }> => {
      commands.push(cmd)
      if (cmd.includes('command -v claude')) {
        return {
          code: 0,
          stdout: '/home/vm/.nvm/versions/node/v22.14.0/bin/claude\n2.1.321 (Claude Code)\n',
          stderr: 'bash: 无法设定终端进程组 (-1)\nbash: 此 shell 中无任务控制\n'
        }
      }
      if (cmd.includes('command -v node')) {
        return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
      }
      return { code: 127, stdout: '', stderr: '' }
    }
    const items = await runSelfCheck(exec)
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ['sshd', 'ok'],
      ['claude', 'ok'],
      ['node', 'ok'],
      ['server', 'unknown']
    ])
    expect(items[1]?.detail).toBe('2.1.321 (Claude Code)') // 取 stdout 末行（command -v 路径行不混入）
    expect(items[2]?.detail).toBe('v22.14.0')
    expect(commands[0]).toBe(`bash -ic 'command -v claude && claude --version'`)
    expect(commands[1]).toBe(`bash -ic 'command -v node && node --version'`)
  })

  it('⑦ claude 缺失：bash -ic 整体退出非 0 → missing（detail 不含 bash 噪音行）', async () => {
    const items = await runSelfCheck(async (cmd) => {
      if (cmd.includes('command -v claude')) {
        return { code: 1, stdout: '', stderr: 'bash: 此 shell 中无任务控制\n' }
      }
      return { code: 0, stdout: 'v22.14.0\n', stderr: '' }
    })
    const claudeItem = items.find((i) => i.id === 'claude')!
    expect(claudeItem.status).toBe('missing')
    expect(claudeItem.detail).toBe('exit 1') // 噪音行剥离后无版本可取 → 退出码摘要
  })
})
