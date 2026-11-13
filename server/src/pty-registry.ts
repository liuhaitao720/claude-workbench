/**
 * PTY 注册表（S3）：taskId → PTY 会话；5.9=b 保活语义核心。
 *
 * - PTY 由 server 持有；sink（=WS 连接）attach/detach 只控制数据推送，不影响
 *   PTY 生命周期——断连≠杀任务（5.1=A/5.2=A/5.9=b），kill 仅显式停止。
 * - re-attach 重绘（5.8=A）：attach 时 resize toggle（cols+1→复原）强制
 *   SIGWINCH 逼 claude TUI 全量重绘；300ms 内无新输出则回放环形缓冲尾部
 *   ≤4000 字节（两条路径都实现、可断言）。
 * - spawn env 语义参照本机 pty-manager（TERM=xterm-256color+COLORTERM、剥离
 *   会话身份标记、Linux PATH 增强）+ 契约 envDenylist 剥离（3.3=A：远程任务
 *   不注入 ANTHROPIC_*——端点/密钥/模型以 VM 内 shell 环境为准）。
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn as realPtySpawn } from 'node-pty'
import type { RemoteTaskSpawnRequest } from './shared/remote-protocol'
import { OutputRingBuffer } from './ring-buffer'

/** 数据出口（cwb-server 里=WS 连接的 task.data/task.exit 帧出口；测试注入替身） */
export interface TaskSink {
  onData(taskId: string, chunk: string): void
  onExit(taskId: string, exitCode: number): void
}

/** 可注入的 PTY 工厂面（=node-pty IPty 公共面；L2 单测用替身） */
export interface PtyProcess {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export type PtySpawnFn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
) => PtyProcess

const defaultSpawn: PtySpawnFn = (file, args, options) => realPtySpawn(file, args, options)

/** 任务摘要（task.list payload 元素形状，S3 定终态） */
export interface TaskSummary {
  taskId: string
  pid: number
  /** 是否有 sink 正在接收数据流 */
  attached: boolean
  cols: number
  rows: number
  /** ISO 创建时刻 */
  startedAt: string
  /** ISO 最近一次输出/键入时刻 */
  lastActivityAt: string
}

export interface TaskRegistryEvents {
  /** 任务退出（含 exitCode；用于 server.log 元数据日志） */
  onTaskExit?: (taskId: string, exitCode: number) => void
  /** 任务创建（元数据日志用） */
  onTaskSpawn?: (taskId: string, pid: number) => void
}

/** 会话身份标记剥离清单（照抄 pty-manager：工作台终端是独立用户会话，不继承宿主 claude 身份） */
const SESSION_MARKER_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID'
] as const

/**
 * v2.1.1（用户实测「首开只有末尾一点且不能滚」根因）：环形缓冲 8KB/回放 4KB
 * 只够当前屏——改为全量历史回放。容量对齐客户端 xterm scrollback（8000 行量级，
 * ~2MB 上限）；回放上限 1.5MB（taskDataPending 客户端缓冲 800KB + 直通余量）。
 */
const REPLAY_MAX_BYTES = 1_500_000
/** 环形缓冲容量（全量回放预算 + 余量；>容量丢最旧——超长会话保最近 2MB） */
const RING_CAPACITY_BYTES = 2_000_000

interface Entry {
  taskId: string
  /** v2.0.2 任务显示名（spawn req.name；服务器侧推送文案用） */
  name?: string
  pty: PtyProcess
  /** 数据订阅（task.data 推送对象=当前 attach 的 sink） */
  sinks: Set<TaskSink>
  /** 生命周期订阅（task.exit 通知对象=曾 attach 过的 sink——detach 停数据流不停
   *  生命周期事件，对齐客户端 PtyManager.onExit 与终端可见性无关的语义；
   *  WS 断连（detachAll）才整体退订） */
  lifecycleSinks: Set<TaskSink>
  ring: OutputRingBuffer
  startedAt: string
  lastActivityAt: string
  /** 本轮 attach 后新产出字节数（>0 = toggle 已逼出输出，取消回放） */
  freshBytes: number
  replayTimer: NodeJS.Timeout | null
}

export class TaskRegistry {
  private readonly entries = new Map<string, Entry>()
  /** 创建中的 taskId（spawn 含 PATH 发现异步段——跨连接并发同 id 的原子性护栏） */
  private readonly spawning = new Set<string>()
  private extraPathDirs: string[] | null = null

  constructor(
    private readonly events: TaskRegistryEvents = {},
    private readonly ptySpawn: PtySpawnFn = defaultSpawn
  ) {}

  /** v2.0.2：任务显示名（服务器侧推送文案；未注册=undefined） */
  nameOf(taskId: string): string | undefined {
    return this.entries.get(taskId)?.name
  }

  /** task.spawn：不存在则创建；已存在=幂等拒绝（契约语义）。返回 pid。 */
  async spawn(req: RemoteTaskSpawnRequest): Promise<number> {
    if (this.entries.has(req.taskId) || this.spawning.has(req.taskId)) {
      throw new Error(`task already exists: ${req.taskId}`)
    }
    if (req.argv.length === 0) throw new Error('spawn req.argv must not be empty')
    this.spawning.add(req.taskId)
    try {
      const env = await this.buildSpawnEnv(req.envDenylist)
      // argv 原样（客户端已组装完整形态：argv[0]=可执行文件，含 --settings 等全部参数）
      const pty = this.ptySpawn(req.argv[0]!, req.argv.slice(1), {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: req.cwd,
        env
      })
      const now = new Date().toISOString()
      const entry: Entry = {
        taskId: req.taskId,
        ...(req.name !== undefined && req.name !== '' ? { name: req.name } : {}),
        pty,
        sinks: new Set(),
        lifecycleSinks: new Set(),
        ring: new OutputRingBuffer(RING_CAPACITY_BYTES),
        startedAt: now,
        lastActivityAt: now,
        freshBytes: 0,
        replayTimer: null
      }
      this.entries.set(req.taskId, entry)
      pty.onData((chunk) => this.handleData(entry, chunk))
      pty.onExit((event) => this.handleExit(entry, event.exitCode))
      this.events.onTaskSpawn?.(req.taskId, pty.pid)
      return pty.pid
    } finally {
      this.spawning.delete(req.taskId)
    }
  }

  /**
   * task.attach：标记+开始推送。v2.1.1 改为**全量历史回放优先**——环形缓冲尾部
   * （≤1.5MB）即刻投递（含当前屏：空闲会话的末屏即最后渲染帧，滚动完整）；
   * 环为空（零输出会话）时 resize toggle 逼一次 SIGWINCH 重绘作兜底（防白屏）。
   * 旧「toggle 优先+300ms 定时回放 4KB」废弃（toggle 会致回放+重绘双屏重复）。
   */
  attach(taskId: string, sink: TaskSink): void {
    const entry = this.require(taskId)
    if (entry.replayTimer !== null) {
      clearTimeout(entry.replayTimer)
      entry.replayTimer = null
    }
    entry.sinks.add(sink)
    entry.lifecycleSinks.add(sink)
    entry.freshBytes = 0
    const tail = entry.ring.tail(REPLAY_MAX_BYTES)
    if (tail !== '') {
      sink.onData(taskId, tail)
      return
    }
    // 空环兜底：resize toggle（cols+1→复原）强制 SIGWINCH——TUI 收到即全量重绘
    const { cols, rows } = entry.pty
    entry.pty.resize(cols + 1, rows)
    entry.pty.resize(cols, rows)
  }

  /** task.detach：停推数据流不断 PTY、不退订生命周期（5.9=b） */
  detach(taskId: string, sink: TaskSink): void {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return
    entry.sinks.delete(sink)
  }

  /** 某 sink 断连：数据+生命周期全退订（绝不杀 PTY——5.1=A 断线不杀） */
  detachAll(sink: TaskSink): void {
    for (const entry of this.entries.values()) {
      entry.sinks.delete(sink)
      entry.lifecycleSinks.delete(sink)
    }
  }

  write(taskId: string, data: string): void {
    const entry = this.require(taskId)
    entry.lastActivityAt = new Date().toISOString()
    entry.pty.write(data)
  }

  /** 同尺寸 no-op（契约注释语义）；尺寸变化透传 pty.resize */
  resize(taskId: string, cols: number, rows: number): void {
    const entry = this.require(taskId)
    if (cols < 2 || cols > 1000 || rows < 2 || rows > 1000) {
      throw new Error('resize out of range')
    }
    if (entry.pty.cols === cols && entry.pty.rows === rows) return
    entry.pty.resize(cols, rows)
  }

  /** 显式停止（唯一杀 PTY 的入口；已退出时幂等） */
  kill(taskId: string): void {
    const entry = this.require(taskId)
    try {
      entry.pty.kill()
    } catch {
      // 已退出时 kill 可能抛错（onExit 已/将清理）——幂等
    }
  }

  list(): TaskSummary[] {
    return [...this.entries.values()].map((e) => ({
      taskId: e.taskId,
      pid: e.pty.pid,
      attached: e.sinks.size > 0,
      cols: e.pty.cols,
      rows: e.pty.rows,
      startedAt: e.startedAt,
      lastActivityAt: e.lastActivityAt
    }))
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId)
  }

  /** 丢弃全部 replay 定时器（进程退出前清理用；不杀 PTY） */
  disposeTimers(): void {
    for (const entry of this.entries.values()) {
      if (entry.replayTimer !== null) clearTimeout(entry.replayTimer)
      entry.replayTimer = null
    }
  }

  private require(taskId: string): Entry {
    const entry = this.entries.get(taskId)
    if (entry === undefined) throw new Error(`unknown task: ${taskId}`)
    return entry
  }

  private handleData(entry: Entry, chunk: string): void {
    if (this.entries.get(entry.taskId) !== entry) return
    entry.freshBytes += Buffer.byteLength(chunk, 'utf8')
    entry.lastActivityAt = new Date().toISOString()
    entry.ring.push(chunk) // 断连期间也持续记录（保活重挂回放的原料）
    for (const sink of entry.sinks) sink.onData(entry.taskId, chunk)
  }

  private handleExit(entry: Entry, exitCode: number): void {
    if (this.entries.get(entry.taskId) !== entry) return
    if (entry.replayTimer !== null) clearTimeout(entry.replayTimer)
    this.entries.delete(entry.taskId)
    // 生命周期通知：曾 attach 的全部 sink（当前是否 detach 不影响——退出是任务
    // 终态，客户端须能落 exited 状态）
    for (const sink of entry.lifecycleSinks) sink.onExit(entry.taskId, exitCode)
    this.events.onTaskExit?.(entry.taskId, exitCode)
  }

  /**
   * spawn env：透传 server 进程环境 + TERM/COLORTERM - 会话标记 - envDenylist
   * + Linux PATH 增强（登录 PATH/常见安装目录前置——参照 platform.ts 语义，
   * 保证 VM 内 `claude` 裸名与 `#!/usr/bin/env node` shebang 可解析）。
   */
  private async buildSpawnEnv(envDenylist?: string[]): Promise<Record<string, string>> {
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
      string,
      string
    >
    for (const name of SESSION_MARKER_VARS) delete env[name]
    for (const name of envDenylist ?? []) delete env[name]
    const extra = await this.discoverExtraPathDirs()
    if (extra.length > 0) {
      const parts = [...extra, ...(env['PATH'] ?? '').split(':')].filter((d) => d.length > 0)
      env['PATH'] = [...new Set(parts)].join(':')
    }
    return env
  }

  /** 登录 PATH + 常见安装目录中，进程 env.PATH 之外的新增目录（缓存；失败=空） */
  private async discoverExtraPathDirs(): Promise<string[]> {
    if (this.extraPathDirs !== null) return this.extraPathDirs
    const own = new Set((process.env['PATH'] ?? '').split(':').filter((d) => d.length > 0))
    const login = await new Promise<string[]>((resolve) => {
      execFile('bash', ['-l', '-c', 'printf %s "$PATH"'], { timeout: 5000 }, (err, stdout) => {
        resolve(err ? [] : stdout.split(':').filter((d) => d.length > 0))
      })
    })
    const dirs = [...login, ...knownInstallDirs()]
    this.extraPathDirs = [...new Set(dirs.filter((d) => !own.has(d)))]
    return this.extraPathDirs
  }
}

/** 常见 claude/node 安装目录（存在性过滤；nvm 逐版本枚举）——照 platform.ts */
function knownInstallDirs(): string[] {
  const home = homedir()
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ]
  const nvmBase = join(home, '.nvm', 'versions', 'node')
  try {
    for (const v of readdirSync(nvmBase)) dirs.push(join(nvmBase, v, 'bin'))
  } catch {
    // 未装 nvm
  }
  return dirs.filter((d) => {
    try {
      return existsSync(d)
    } catch {
      return false
    }
  })
}
