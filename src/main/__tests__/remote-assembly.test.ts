import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { promisify } from 'node:util'
import { IpcChannels } from '../../shared/ipc-channels'
import type { SftpSession, SshExecResult } from '../ssh/connection-manager'
import { RealConnectionManager } from '../ssh/manager'
import { ConnectionError } from '../ssh/errors'
import { ConnectionsStore, parseConnectionInput, type SafeStoragePort } from '../connections-store'
import { createAppContext, registerIpcHandlers, type AppContext } from '../ipc'

/**
 * S4 L2.5 装配验证（真实 cwb-server 子进程 + ServerClient 直连，A1/A5）与
 * 真实 sshd 反向转发全链（A3）：
 * - A1：ctx.createTask（远程项目桩：connectionId 指向 mock 连接——forwardOut 直返
 *   真实 server 端口，不经 SSH）→ 真实 server spawn 测试 shim（bash echo，1s 后
 *   退出）→ PtyData 事件回流 renderer 通道面（BrowserWindow mock 断言字节>0 且含
 *   --settings 远端路径）→ task.exit 帧落 markStatus('exited')。
 * - A5：RemoteProxyConfigSet → ConfigGet 回环一致（真实 server 代理配置持久化）。
 * - A3：本机真实 sshd（active）：临时测试密钥对（authorized_keys 追加带 marker 的
 *   行，测完仅删自己的行——S7 并行测试同文件，快照恢复会互相踩）→ 真实
 *   RealConnectionManager（TOFU/自检走真链路）→ forwardIn → 「VM 侧」POST
 *   /hook/PermissionRequest?e=<epoch>&t=<taskId> → 入站流 pipe 到 task-activity
 *   接收端 → 广播面断言 awaiting（错误 epoch 被丢弃 + Stop 归零）。
 */

const execFileAsync = promisify(execFile)
const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))

const h = vi.hoisted(() => ({
  tempDir: '',
  handleCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
  sentEvents: [] as Array<[string, unknown]>
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => h.tempDir,
    getVersion: () => '1.4.2-test',
    isPackaged: false,
    quit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  shell: { openExternal: vi.fn(async () => {}) },
  net: undefined,
  session: undefined,
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => {
            h.sentEvents.push([channel, payload])
          }
        }
      }
    ]
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handleCalls.push([channel, fn])
    },
    on: () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`el:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^el:/, '')
  }
}))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(25)
  }
  throw new Error(`waitFor timeout: ${what}`)
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const entry = h.handleCalls.find(([c]) => c === channel)
  if (entry === undefined) throw new Error(`no handler registered for ${channel}`)
  return entry[1](undefined, ...args)
}

// ── 真实 cwb-server 子进程（照 server/src/__tests__/l3-harness 模式；esbuild
//    从根 node_modules 解析（vite/vitest 传递依赖），bundle 落 server/dist 使
//    external 的 node-pty/ws 向上解析命中 server/node_modules）──────────────

interface ServerProc {
  proc: ChildProcess
  port: number
  stop: () => Promise<void>
}

async function bootServer(): Promise<ServerProc> {
  const outDir = join(repoRoot, 'server', 'dist')
  mkdirSync(outDir, { recursive: true })
  const bundleFile = join(outDir, `main.s4test-${process.pid}.cjs`)
  await build({
    entryPoints: [join(repoRoot, 'server', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundleFile,
    external: ['node-pty', 'ws'],
    logLevel: 'silent'
  })
  const home = mkdtempSync(join(tmpdir(), 'cwb-s4-srvhome-'))
  const proc = spawn(process.execPath, [bundleFile, '--port', '0'], {
    env: { ...process.env, CWB_SERVER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stderr!.on('data', () => {}) // 元数据日志不进测试输出
  const port = await new Promise<number>((resolve_, reject) => {
    const timer = setTimeout(() => reject(new Error('server boot timeout')), 20_000)
    let buf = ''
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        clearTimeout(timer)
        resolve_((JSON.parse(buf.slice(0, idx)) as { port: number }).port)
      }
    })
    proc.once('exit', (code) => reject(new Error(`server exited early: ${code}`)))
  })
  expect(port).toBeGreaterThan(0)
  return {
    proc,
    port,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        await Promise.race([
          new Promise<void>((r) => proc.once('exit', () => r())),
          sleep(3000)
        ])
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
      rmSync(bundleFile, { force: true })
      rmSync(home, { recursive: true, force: true })
    }
  }
}

// ── 直连 mock 连接（A1/A5）：forwardOut 返回真实 server 端口（不经 SSH 隧道）──

class DirectMockConnection {
  readonly forwardOutCalls: Array<{ host: string; port: number }> = []
  readonly forwardInPorts: number[] = []
  /** exec 白名单：settings 目录预备命令 → 返回桩 home；其余 127 */
  readonly vmHome: string
  /** sftp writeFile 落盘内容（path → content）——settings 断言用 */
  readonly remoteFiles = new Map<string, string>()

  constructor(vmHome: string) {
    this.vmHome = vmHome
  }

  asManager(): import('../ssh/connection-manager').ConnectionManager {
    return {
      connect: async () => {},
      disconnect: async () => {},
      getState: () => 'connected' as const,
      exec: async (_id: string, command: string): Promise<SshExecResult> => {
        if (command.includes('mkdir -p') && command.includes('.cwb-server/task-settings')) {
          mkdirSync(join(this.vmHome, '.cwb-server', 'task-settings'), { recursive: true })
          return { code: 0, stdout: `${this.vmHome}\n`, stderr: '' }
        }
        return { code: 127, stdout: '', stderr: `unknown command: ${command}` }
      },
      sftp: async (): Promise<SftpSession> => ({
        list: async () => [],
        readFile: async (path: string) => Buffer.from(this.remoteFiles.get(path) ?? '', 'utf8'),
        writeFile: async (path: string, data: string | Buffer) => {
          const content = typeof data === 'string' ? data : data.toString('utf8')
          this.remoteFiles.set(path, content)
          writeFileSync(path, content, 'utf8') // 本机直连场景：VM 路径=本机路径
        }
      }),
      forwardOut: async (_id: string, host: string, port: number): Promise<number> => {
        this.forwardOutCalls.push({ host, port })
        return serverPortRef.port // 直连：隧道端口=真实 server 监听口
      },
      forwardIn: async (_id: string, port: number) => {
        this.forwardInPorts.push(port)
      },
      onStateChange: () => () => {},
      onLog: () => () => {}
    }
  }
}

/** server 端口注入缝（bootServer 后回填；DirectMockConnection 闭包读取） */
const serverPortRef = { port: 0 }

let serverProc: ServerProc | null = null
afterAll(async () => {
  if (serverProc !== null) await serverProc.stop()
})

// ── 测试环境装配 ────────────────────────────────────────────────────────

let tempDirs: string[] = []
function newTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cwb-s4-asm-'))
  tempDirs.push(d)
  return d
}

beforeEach(() => {
  h.handleCalls.length = 0
  h.sentEvents.length = 0
})

afterEach(() => {
  tempDirs = tempDirs.filter((d) => {
    rmSync(d, { recursive: true, force: true })
    return false
  })
  delete process.env['CWB_HOOK_SETTINGS_DIR']
  delete process.env['CWB_SKILLS_USER_ROOT']
  delete process.env['CWB_SKILL_MARKET_HOME']
  delete process.env['CWB_REMOTE_CLAUDE_BIN']
})

function seedRemoteProject(baseDir: string, connectionId: string, dir: string): void {
  writeFileSync(
    join(baseDir, 'projects.json'),
    JSON.stringify([
      {
        id: 'proj-r1',
        name: 'vm-project',
        dir,
        isGit: false,
        connectionId,
        createdAt: new Date().toISOString()
      }
    ]),
    'utf8'
  )
}

/** renderer 通道面上的 PtyData 字节聚合（按 taskId） */
function ptyBytes(taskId: string): string {
  return h.sentEvents
    .filter(([c, p]) => c === IpcChannels.PtyData && (p as { taskId: string }).taskId === taskId)
    .map(([, p]) => (p as { data: string }).data)
    .join('')
}

function taskUpdates(): Array<{ id: string; status: string }> {
  return h.sentEvents
    .filter(([c]) => c === IpcChannels.TaskUpdate)
    .map(([, p]) => p as { id: string; status: string })
}

// ── A1 + A5：真实 server 直连（ServerClient 全链，不经 SSH）────────────

describe('S4 L2.5 A1/A5：真实 cwb-server + ServerClient 直连装配', () => {
  it('A1 ctx.createTask（远程项目）→ 真实 spawn → PtyData 回流 renderer 通道面 → exit 落 exited', { timeout: 60_000 }, async () => {
    serverProc = await bootServer()
    serverPortRef.port = serverProc.port

    // 测试 shim：1s 后输出 A1-OK + 实际 argv（证明 --settings 远端路径随 argv 下发）再退出
    const runDir = join(newTempDir(), 'cwb-pty-run')
    mkdirSync(runDir, { recursive: true })
    const shim = join(runDir, 'claude')
    writeFileSync(shim, '#!/usr/bin/env bash\nsleep 1\necho A1-OK\necho "argv: $*"\n', 'utf8')
    chmodSync(shim, 0o755)
    process.env['CWB_REMOTE_CLAUDE_BIN'] = shim

    const baseDir = newTempDir()
    h.tempDir = baseDir
    const vmHome = join(newTempDir(), 'vmhome')
    mkdirSync(vmHome, { recursive: true })
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(baseDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(baseDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(baseDir, 'market-home')
    seedRemoteProject(baseDir, 'conn-direct', runDir)

    const mockConn = new DirectMockConnection(vmHome)
    const ctx: AppContext = createAppContext({ connection: mockConn.asManager() })
    registerIpcHandlers(ctx)

    const task = await ctx.createTask('proj-r1', 'a1-task', { isolation: 'shared' })
    expect(task.status).toBe('running')
    expect(task.cwd).toBe(runDir) // 远端工作目录（VM Linux 路径字符串）

    // 隧道锚点：forwardOut 目标=固定 127.0.0.1:17717（协议约定）
    await waitFor(() => mockConn.forwardOutCalls.length > 0, 5_000, 'forwardOut called')
    expect(mockConn.forwardOutCalls[0]).toEqual({ host: '127.0.0.1', port: 17_717 })

    // hooks 反向转发已接线（动态远端口入 settings URL）
    expect(mockConn.forwardInPorts.length).toBeGreaterThan(0)
    const hookPort = mockConn.forwardInPorts[0]!

    // PtyData 事件回流 renderer 通道面（BrowserWindow mock = 通道面）：字节>0
    await waitFor(() => ptyBytes(task.id).includes('A1-OK'), 20_000, 'PtyData A1-OK')
    const bytes = ptyBytes(task.id)
    expect(Buffer.byteLength(bytes, 'utf8')).toBeGreaterThan(0)

    // settings 全链断言：SFTP 写远端 + URL base=forwardIn 端口 + epoch 顺序（e=1）
    const settingsPath = `${vmHome}/.cwb-server/task-settings/${task.id}.json`
    const content = mockConn.remoteFiles.get(settingsPath)
    expect(content).toBeDefined()
    const urls = Array.from((JSON.parse(content!) as { hooks: Record<string, unknown> }).hooks[
      'Stop'
    ] as Array<{ hooks: Array<{ url: string }> }>)[0]!.hooks[0]!.url
    expect(urls).toBe(`http://127.0.0.1:${hookPort}/hook/Stop?e=1&t=${task.id}`)
    // argv 携带 --settings <远端路径>（shim 回显取证）
    await waitFor(() => ptyBytes(task.id).includes(settingsPath), 10_000, 'argv echoes settings path')

    // task.exit 帧 → markStatus('exited')（ipc.ts 语义对齐）
    await waitFor(
      () => ctx.tasks.get(task.id)?.status === 'exited',
      15_000,
      "task marked 'exited' via task.exit frame"
    )
    expect(taskUpdates().some((t) => t.id === task.id && t.status === 'exited')).toBe(true)
    expect(ctx.pty.isRunning(task.id)).toBe(false)
  })

  it('A5 RemoteProxyConfigSet → ConfigGet 回环一致（真实 server 代理配置持久化）', { timeout: 45_000 }, async () => {
    // server 沿用 A1 起的实例（若 A1 未跑/被独跑，这里自举——*-file 独立可跑）
    if (serverProc === null) {
      serverProc = await bootServer()
      serverPortRef.port = serverProc.port
    }
    const baseDir = newTempDir()
    h.tempDir = baseDir
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(baseDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(baseDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(baseDir, 'market-home')
    seedRemoteProject(baseDir, 'conn-direct', '/tmp/probe')

    const mockConn = new DirectMockConnection(join(baseDir, 'vmhome'))
    const ctx = createAppContext({ connection: mockConn.asManager() })
    registerIpcHandlers(ctx)

    const set = (await invoke(IpcChannels.RemoteProxyConfigSet, 'conn-direct', {
      proxyUrl: 'http://127.0.0.1:3128'
    })) as { proxyUrl?: string }
    expect(set).toEqual({ proxyUrl: 'http://127.0.0.1:3128' })

    const got = (await invoke(IpcChannels.RemoteProxyConfigGet, 'conn-direct')) as {
      proxyUrl?: string
    }
    expect(got).toEqual(set) // 回环一致（A5 验收）

    const status = (await invoke(IpcChannels.RemoteProxyStatus, 'conn-direct')) as {
      running: boolean
      stats: { total: number }
      config?: { proxyUrl?: string }
    }
    expect(status.running).toBe(false)
    expect(status.stats).toEqual({ total: 0, active: 0, direct: 0, viaProxy: 0 })
    expect(status.config).toEqual({ proxyUrl: 'http://127.0.0.1:3128' })

    // 白名单外的字段被拒（IPC 边界）；空 connectionId 拒绝
    await expect(invoke(IpcChannels.RemoteProxyConfigSet, 'conn-direct', 'not-an-object')).rejects.toThrow()
    await expect(invoke(IpcChannels.RemoteProxyStatus, '')).rejects.toThrow()
  })
})

// ── A3：本机真实 sshd 反向转发全链 ──────────────────────────────────────

describe('S4 L2.5 A3：真实 sshd → forwardIn → task-activity 接收端', () => {
  it('VM 侧 POST /hook/*?t=&e= 经反向转发到达接收端（epoch 匹配采纳/错配丢弃）', { timeout: 60_000 }, async () => {
    const keyDir = newTempDir()
    const keyPath = join(keyDir, 'id_ed25519')
    const marker = `cwb-s4-a3-${process.pid}-${Date.now()}`
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', marker, '-f', keyPath])
    const pubLine = readFileSync(`${keyPath}.pub`, 'utf8').trim()

    // authorized_keys：追加带 marker 的行；清理=仅删自己的行（S7 并行测试同文件——
    // 快照恢复会互踩，surgical 删除互不干扰）
    const akPath = join(homedir(), '.ssh', 'authorized_keys')
    const akExisted = existsSync(akPath)
    if (!akExisted) {
      mkdirSync(join(homedir(), '.ssh'), { recursive: true })
      writeFileSync(akPath, '', { mode: 0o600 })
    }
    chmodSync(akPath, 0o600)
    appendFileSync(akPath, `${pubLine}\n`, 'utf8')
    const removeOwnLine = (): void => {
      try {
        if (!existsSync(akPath)) return
        const lines = readFileSync(akPath, 'utf8').split('\n')
        const kept = lines.filter((l) => !l.includes(marker))
        writeFileSync(akPath, kept.join('\n'), 'utf8')
        if (!akExisted) rmSync(akPath, { force: true })
      } catch {
        /* best effort */
      }
    }

    // 连接档案：真实 sshd（127.0.0.1:22，key 认证）
    const connDir = newTempDir()
    const mockStoreSafeStorage: SafeStoragePort = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`ENC:${s}`),
      decryptString: (b: Buffer) => {
        const s = b.toString('utf8')
        if (!s.startsWith('ENC:')) throw new Error('Could not decrypt (invalid ciphertext)')
        return s.slice(4)
      }
    }
    const store = new ConnectionsStore(connDir, mockStoreSafeStorage)
    const parsed = parseConnectionInput('zh', {
      id: '',
      name: 'a3-local-sshd',
      host: '127.0.0.1',
      port: 22,
      user: userInfo().username,
      authMethod: 'key',
      keyPath
    })
    const saved = store.save(parsed.record, parsed.plainPassword)
    const mgr = new RealConnectionManager({ store, language: () => 'zh' })
    const baseDir = newTempDir()

    try {
      // TOFU：首连 hostKeyConfirm（真实 sshd host key 指纹）→ 档案锁定 → 连通
      const first = await mgr.connect(saved.id).then(
        () => {
          throw new Error('expected hostKeyConfirm')
        },
        (e: unknown) => e as ConnectionError
      )
      expect(first).toBeInstanceOf(ConnectionError)
      expect(first.kind).toBe('hostKeyConfirm')
      store.save({ ...store.get(saved.id)!, lastHostKeyFingerprint: first.hostKeyFingerprint! })
      await mgr.connect(saved.id) // 自检走真实 exec（bash -ic claude/node——本机实证可见）
      expect(mgr.getState(saved.id)).toBe('connected')

      h.tempDir = baseDir
      process.env['CWB_HOOK_SETTINGS_DIR'] = join(baseDir, 'cwb-settings')
      process.env['CWB_SKILLS_USER_ROOT'] = join(baseDir, 'skills-user')
      process.env['CWB_SKILL_MARKET_HOME'] = join(baseDir, 'market-home')
      const ctx = createAppContext({ connection: mgr })

      // epoch 顺序：noteSpawn 拿新 epoch（e=1），hooks 以该 epoch 采纳
      const taskId = 'a3-hook-probe'
      ctx.activity.noteSpawn(taskId)

      // forwardIn 接线（hub）：动态远端口 + 入站流 pipe 到 activity 接收端
      const remotePort = await ctx.remotePty.hookPortFor(saved.id)
      expect(remotePort).toBeGreaterThan(0)

      // 「VM 侧」POST（本机=VM，127.0.0.1:<远端口> 即 sshd 监听口）
      const post = async (event: string, epoch: number): Promise<number> => {
        const res = await fetch(
          `http://127.0.0.1:${remotePort}/hook/${event}?e=${epoch}&t=${taskId}`,
          { method: 'POST', body: '{}' }
        )
        return res.status
      }

      expect(await post('PermissionRequest', 1)).toBe(200)
      await waitFor(
        () => ctx.activity.current(taskId) === 'awaiting',
        10_000,
        'PermissionRequest e=1 → awaiting'
      )
      expect(h.sentEvents.some(([c, p]) => c === IpcChannels.TaskActivity && (p as { taskId: string; activity: string }).taskId === taskId && (p as { activity: string }).activity === 'awaiting')).toBe(true)

      // 错误 epoch（旧 PTY 迟到 hook）：丢弃——裁决不变化
      expect(await post('Stop', 9)).toBe(200)
      await sleep(500)
      expect(ctx.activity.current(taskId)).toBe('awaiting')

      // 正确 epoch Stop → idle（裁决迁移 + 广播）
      expect(await post('Stop', 1)).toBe(200)
      await waitFor(() => ctx.activity.current(taskId) === 'idle', 10_000, 'Stop e=1 → idle')
    } finally {
      removeOwnLine()
      mgr.disposeAll()
      rmSync(keyDir, { recursive: true, force: true })
    }
  })
})
