import { createConnection } from 'node:net'
import type { RemoteServerLogEvent } from '../shared/types'
import type { ClientFrame } from '../shared/remote-protocol'
import type { PtyBackend, PtyBackendCallbacks } from './pty-backend'
import type { ConnectionManager } from './ssh/connection-manager'
import { ServerClient, CWB_SERVER_PORT, type ServerClientEvents, type ServerTransport } from './server-client'

/**
 * 远程 PTY 后端（S4，PtyBackend 的 Remote 实现）+ 多连接枢纽（RemotePtyHub）。
 *
 * RemotePtyManager（每连接一个，hub 懒建）：
 * - spawn/spawnClaude 组 RemoteTaskSpawnRequest 经协议下发——argv 由调用方组装
 *   完整 Linux 形态（claude 裸名，server 侧登录 PATH 解析 nvm shim；--settings 用
 *   SFTP 写入 VM 的远端路径）；spawn 成功后 task.attach 背靠背（server 侧 spawn
 *   不自动挂 sink，契约注释语义）；resume 撞上 server 存活任务 = re-attach 而非
 *   spawn（5.9=b 保活语义，task.spawn 对已存在任务是幂等拒绝）。
 * - 3.3=A：不注入任何 ANTHROPIC_*（spawnClaude 的 providerEnv 参数显式忽略）；
 *   envDenylist 固定剥离端点/密钥/模型四件套，VM 内 ~/.claude 与 shell 环境为准。
 * - killAllTrees = **detach-only**（H2 契约 Javadoc）：仅断数据流，绝不 task.kill
 *   ——远端 PTY 由 cwb-server 持有保活（5.9=b），re-attach（task.attach）恢复现场。
 * - 生命周期跟随 ConnectionManager：断连（reconnecting/offline）→ 标记 all-detached
 *   （注册表保留=isRunning 保持 running 语义，S6 冻结层据此显示）；重连（connected）
 *   → 重建 server-client → task.list 对账——存活任务重 attach，已消亡任务合成
 *   onExit（→ markStatus('exited')，与本地 onExit 链路 ipc.ts:251-256 对齐）。
 *
 * RemotePtyHub：per-connection RemotePtyManager 注册表 + hooks 反向转发接线
 * （forwardIn 远端口 → 入站流 pipe 到 task-activity HTTP 接收端，A3）+ 代理帧透传
 * （proxy.*，A5）+ 连接流程健康检查（WS+server.ping——needInstall 判定）。
 */

/**
 * 3.3=A 防御性剥离清单（spawn env 剥离；契约 envDenylist 透传给 server 应用）：
 * 远程任务的端点/密钥/模型以 VM 内 ~/.claude 与 shell 环境为准，客户端绝不注入。
 */
export const REMOTE_ENV_DENYLIST: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL'
]

/** hooks 反向转发远端口随机区间（IANA 动态口内避让 49152+ 常用临时段） */
const HOOK_PORT_MIN = 20_000
const HOOK_PORT_MAX = 45_000
/**
 * hooks 转发稳定优先口（2.0.2 用户实测：Stop hook ECONNREFUSED）。
 * 根因：远端口原为每次连接随机自选——客户端重启后新连接换口，VM 侧保活会话
 * （5.9=b 断开不杀）的 settings 里钉着旧口，每轮 Stop 都撞死口。
 * 固定优先口后：重启重连在同一口重放 forwardIn，旧会话的 hook URL 重新变活
 * （接收端对未知 epoch/任务一律 200 静默丢弃，无副作用）；被占（罕见：同 VM
 * 另一客户端实例）则回退随机口——退化为旧行为，仅该实例受影响。
 */
const HOOK_PORT_PREFERRED = 31_280
/** 远端口绑定失败（VM 侧占用）重试次数（首次=优先口，其后随机） */
const HOOK_PORT_ATTEMPTS = 4
/** 默认初始栅格（与本机 PtyManager 缺省一致；resize 后按记忆尺寸复用） */
const DEFAULT_SIZE = { cols: 80, rows: 24 }

interface RemoteTaskEntry {
  /** spawn 回执缓存的远端宿主 pid（task.list 对账后可能补齐） */
  pid?: number
  cols: number
  rows: number
  attached: boolean
}

export interface RemotePtyManagerOptions {
  connectionId: string
  connection: ConnectionManager
  callbacks: PtyBackendCallbacks
  /** server.log 帧桥（hub 注入——带 connectionId 外送 RemoteServerLog EVENT） */
  onServerLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * 远程 claude 可执行名/路径（缺省 'claude' 裸名——VM 侧由 server 登录 PATH 解析；
   * CWB_REMOTE_CLAUDE_BIN 测试注入缝，照 CWB_HOOK_SETTINGS_DIR 先例）。
   */
  claudeBin?: string
  /** 传输工厂（缺省 ServerClient；L2 单测注入帧级替身） */
  transportFactory?: (events: ServerClientEvents) => ServerTransport
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  /**
   * v2.0.2 hooks 回放落点（hub 透传本机 task-activity 接收端；server 转发的
   * hook.event 帧经此 POST 回放。缺省=null=丢弃——本地/旧 server 无回放）。
   */
  hookSink?: () => Promise<{ host: string; port: number } | null>
  /**
   * v2.0.1（用户实测「重启后首开远程任务无上下文」根因修复）：本连接下记录为
   * running 的任务 id（组合根注入——tasks.json 归一后仍 running 的远程任务）。
   * reconcile 对账时除已知注册表外，**主动认领**这些任务的 server 存活实例
   * （attach+回放）——此前 reconcile 在 transport 未建时早退，且即使 transport
   * 就绪也只重连已知条目：重启后首连 ensureConnected 只建传输不对账，上一会话
   * 保活任务永远无人 attach → 首开空白（关掉重开偶发可见是后续路径副作用）。
   */
  runningTaskIds?: () => string[]
}

export class RemotePtyManager implements PtyBackend {
  private readonly opts: RemotePtyManagerOptions
  private readonly claudeBin: string
  private transport: ServerTransport | null = null
  private readonly tasks = new Map<string, RemoteTaskEntry>()
  private readonly lastSize = new Map<string, { cols: number; rows: number }>()
  private readonly spawning = new Set<string>()
  /**
   * 断连期间到达的显式停止（stopTask → kill）：帧发不出去时暂存，重连对账后
   * 补发（用户停止意图不因断连丢失）；task.exit/forget 到达即清除。
   */
  private readonly pendingKills = new Set<string>()
  /** 重连对账串行化（状态事件抖动时防并发 task.list/attach 交错） */
  private reconcileChain: Promise<void> = Promise.resolve()
  private readonly unsubState: (() => void) | null

  constructor(opts: RemotePtyManagerOptions) {
    this.opts = opts
    this.claudeBin = opts.claudeBin ?? 'claude'
    this.unsubState = opts.connection.onStateChange((e) => {
      if (e.connectionId !== opts.connectionId) return
      if (e.state === 'connected') void this.scheduleReconcile()
      else this.markAllDetached(e.state)
    })
  }

  /**
   * 远程 claude spawn：argv=[claudeBin, ...claudeArgs]（Linux 形态——不经 cmd.exe
   * 包装、不 resolveClaudeCommand（那是本机路径发现）；providerEnv 显式忽略
   * （3.3=A：远程任务不注入 ANTHROPIC_*，端点/密钥/模型以 VM 内环境为准）。
   */
  async spawnClaude(
    taskId: string,
    claudeArgs: string[],
    cwd: string,
    _providerEnv?: Record<string, string>,
    name?: string
  ): Promise<void> {
    await this.spawnOrAttach(taskId, [this.claudeBin, ...claudeArgs], cwd, name)
  }

  /** 通用 spawn（argv[0]=可执行文件）；异步失败经 onServerLog 降级（接口为 void） */
  spawn(taskId: string, file: string, args: string[], cwd: string): void {
    void this.spawnOrAttach(taskId, [file, ...args], cwd).catch((err: unknown) => {
      this.log('warn', `remote spawn failed (${taskId}): ${errMsg(err)}`)
    })
  }

  write(taskId: string, data: string): void {
    this.transport?.send({ type: 'task.write', taskId, data })
  }

  resize(taskId: string, cols: number, rows: number): void {
    this.lastSize.set(taskId, { cols, rows })
    const entry = this.tasks.get(taskId)
    if (entry !== undefined) {
      entry.cols = cols
      entry.rows = rows
    }
    this.transport?.send({ type: 'task.resize', taskId, cols, rows })
  }

  /**
   * 显式停止：协议 task.kill（server 端 terminate PTY——5.1/A 唯一杀任务入口）。
   * 断连期间帧不可达 → 暂存 pendingKills，重连对账后补发（停止意图不丢失）。
   */
  kill(taskId: string): void {
    this.pendingKills.add(taskId)
    this.transport?.send({ type: 'task.kill', taskId })
  }

  /** 注册表态（含断连期间——5.9=b 语义：server 侧保活即视为 running，S6 冻结层） */
  isRunning(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  pid(taskId: string): number | undefined {
    return this.tasks.get(taskId)?.pid
  }

  /** killAllTrees = detach-only（H2）：仅断数据流（close WS=server 侧 detachAll），
   *  绝不下发 task.kill——远端 PTY 由 cwb-server 持有（5.9=b），re-attach 恢复现场。 */
  killAllTrees(): void {
    this.transport?.close()
    for (const entry of this.tasks.values()) entry.attached = false
  }

  currentSize(taskId: string): { cols: number; rows: number } | undefined {
    const entry = this.tasks.get(taskId)
    if (entry !== undefined) return { cols: entry.cols, rows: entry.rows }
    return this.lastSize.get(taskId)
  }

  /**
   * 清本地记录（不杀不 detach——removeTask 路径，杀由调用方先 kill）。
   * pendingKills 不清：removeTask 于断连期间发起的停止意图仍应在重连后送达
   * （注册表已无该任务，kill 帧幂等——server 侧 unknown task 仅记日志）。
   */
  forget(taskId: string): void {
    this.tasks.delete(taskId)
    this.lastSize.delete(taskId)
  }

  // ── hub 消费面 ───────────────────────────────────────────────────────

  /** 建立传输并做协议级健康检查（真实往返——O6：node-pty 加载失败在此暴露） */
  async ensureReady(): Promise<void> {
    const t = await this.ensureTransport()
    await t.request({ type: 'server.ping' })
  }

  /** 协议帧透传（proxy.* 等；先确保传输就绪） */
  async request<T = unknown>(frame: ClientFrame): Promise<T> {
    const t = await this.ensureTransport()
    return t.request<T>(frame)
  }

  /** 测试/编排收尾（不在 PtyBackend 契约面） */
  dispose(): void {
    this.unsubState?.()
    this.transport?.close()
    this.transport = null
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.opts.onServerLog?.(level, message)
  }

  private transportEvents(): ServerClientEvents {
    return {
      onData: (taskId, chunk) => this.opts.callbacks.onData({ taskId, data: chunk }),
      onExit: (taskId) => {
        const known = this.tasks.delete(taskId)
        this.lastSize.delete(taskId)
        this.pendingKills.delete(taskId) // 停止意图已生效（退出到达）
        if (known) this.opts.callbacks.onExit(taskId)
      },
      onLog: (level, message) => this.log(level, message),
      // v2.0.2 hook 回放（推送服务器侧化）：server 转发的 hook 事件回放进本机
      // task-activity 接收端——epoch 校验/活动裁决/排序 touch 全走既有链路；
      // 回放失败静默（server 侧已 200，丢一帧活动信号可接受）
      onHookEvent: (taskId, event, epoch) => {
        void this.relayHookEvent(taskId, event, epoch)
      },
      onClosed: () => {
        // WS 断开（server 主动/网络）：标记 detached——重连由 ConnectionManager
        // 状态机驱动（scheduleReconcile），注册表保留维持 running 语义
        for (const entry of this.tasks.values()) entry.attached = false
      }
    }
  }

  /** hook.event 帧 → 本机接收端 HTTP POST（经既有 epoch/任务校验） */
  private async relayHookEvent(taskId: string, event: string, epoch: number): Promise<void> {
    try {
      const sink = this.opts.hookSink !== undefined ? await this.opts.hookSink() : null
      if (sink === null) return
      await fetch(
        `http://${sink.host}:${sink.port}/hook/${encodeURIComponent(event)}?e=${epoch}&t=${encodeURIComponent(taskId)}`,
        { method: 'POST', body: '{}', signal: AbortSignal.timeout(2_000) }
      )
    } catch {
      // 接收端未就绪/超时——静默（hook 是旁路信号）
    }
  }

  private async ensureTransport(): Promise<ServerTransport> {
    if (this.transport !== null && this.transport.connected) return this.transport
    if (this.transport === null) {
      const events = this.transportEvents()
      this.transport = this.opts.transportFactory
        ? this.opts.transportFactory(events)
        : new ServerClient({
            connectionId: this.opts.connectionId,
            connection: this.opts.connection,
            ...events,
            ...(this.opts.connectTimeoutMs !== undefined
              ? { connectTimeoutMs: this.opts.connectTimeoutMs }
              : {}),
            ...(this.opts.requestTimeoutMs !== undefined
              ? { requestTimeoutMs: this.opts.requestTimeoutMs }
              : {})
          })
    }
    await this.transport.connect()
    return this.transport
  }

  /**
   * spawn-or-attach：task.list 对账——server 侧已有同 taskId 存活任务（5.9=b 保活
   * 后的 resume/客户端重启恢复）→ task.attach 恢复现场；否则 task.spawn（背靠背
   * task.attach 建立 sink）+ 回执缓存 pid。
   */
  private async spawnOrAttach(
    taskId: string,
    argv: string[],
    cwd: string,
    name?: string
  ): Promise<void> {
    if (this.tasks.has(taskId)) throw new Error(`PTY already running for task ${taskId}`)
    if (this.spawning.has(taskId)) throw new Error(`PTY spawn in progress for task ${taskId}`)
    this.spawning.add(taskId)
    try {
      const t = await this.ensureTransport()
      const size = this.lastSize.get(taskId) ?? DEFAULT_SIZE
      const list = await t.request<Array<{ taskId?: unknown; pid?: unknown }>>({
        type: 'task.list'
      })
      const alive = Array.isArray(list)
        ? list.find((s) => typeof s === 'object' && s !== null && s['taskId'] === taskId)
        : undefined
      if (alive !== undefined) {
        await t.request({ type: 'task.attach', taskId })
        this.tasks.set(taskId, {
          ...(typeof alive['pid'] === 'number' ? { pid: alive['pid'] } : {}),
          cols: size.cols,
          rows: size.rows,
          attached: true
        })
        return
      }
      const settingsPath = extractSettingsPath(argv)
      const payload = await t.request<{ taskId?: unknown; pid?: unknown }>({
        type: 'task.spawn',
        req: {
          taskId,
          argv,
          cwd,
          cols: size.cols,
          rows: size.rows,
          ...(settingsPath !== undefined ? { settingsPath } : {}),
          envDenylist: [...REMOTE_ENV_DENYLIST],
          // v2.0.2：任务名上行（服务器侧 webhook 推送文案；旧 server 忽略多余字段）
          ...(name !== undefined && name !== '' ? { name } : {})
        }
      })
      // spawn→attach 背靠背（契约注释）：server 侧 spawn 不自动挂 sink，须显式 attach
      await t.request({ type: 'task.attach', taskId })
      this.tasks.set(taskId, {
        ...(typeof payload?.['pid'] === 'number' ? { pid: payload['pid'] as number } : {}),
        cols: size.cols,
        rows: size.rows,
        attached: true
      })
    } finally {
      this.spawning.delete(taskId)
    }
  }

  /** 断连（reconnecting/offline/connecting）：all-detached——注册表保留（running 语义） */
  private markAllDetached(_state: string): void {
    for (const entry of this.tasks.values()) entry.attached = false
  }

  /** 重连对账（串行化）：重建传输 → task.list——存活重 attach、消亡合成 onExit */
  private scheduleReconcile(): void {
    this.reconcileChain = this.reconcileChain.then(() => this.reconcile()).catch(() => {
      /* reconcile 自身容错（失败仅记日志）；防 floating rejection 断链 */
    })
  }

  private async reconcile(): Promise<void> {
    // v2.0.1：移除 transport===null 早退——对账自身建传输（与 ensureConnected 竞争
    // 时 ensureTransport 幂等）。候选=已知注册表 ∪ 记录 running 但未注册（重启后
    // 首连认领）；全空仍 connect 保持传输可用。
    const adopt = (this.opts.runningTaskIds?.() ?? []).filter((id) => !this.tasks.has(id))
    if (this.tasks.size === 0 && this.pendingKills.size === 0 && adopt.length === 0) {
      try {
        await this.ensureTransport()
      } catch (err) {
        this.log('warn', `server connect failed: ${errMsg(err)}`)
      }
      return
    }
    let t: ServerTransport
    try {
      t = await this.ensureTransport()
    } catch (err) {
      this.log('warn', `server reconnect failed: ${errMsg(err)}`)
      return
    }
    // 断连期间积压的显式停止：补发（发送失败不重试——下一次断连/重连周期再补）
    for (const taskId of [...this.pendingKills]) {
      t.send({ type: 'task.kill', taskId })
    }
    // v2.0.1：移除 tasks.size===0 早退——候选可纯来自 adopt（重启后首连认领）
    try {
      const list = await t.request<Array<Record<string, unknown>>>({ type: 'task.list' })
      const alive = new Map<string, Record<string, unknown>>()
      for (const s of Array.isArray(list) ? list : []) {
        if (typeof s === 'object' && s !== null && typeof s['taskId'] === 'string') {
          alive.set(s['taskId'], s)
        }
      }
      const candidates = new Set<string>([...this.tasks.keys(), ...adopt])
      for (const taskId of candidates) {
        const summary = alive.get(taskId)
        if (summary !== undefined) {
          try {
            await t.request({ type: 'task.attach', taskId })
            let entry = this.tasks.get(taskId)
            if (entry === undefined) {
              // v2.0.1 认领路径：重启后首连——记录 running 但客户端注册表无此任务
              const size = this.lastSize.get(taskId) ?? DEFAULT_SIZE
              entry = { cols: size.cols, rows: size.rows, attached: true }
              this.tasks.set(taskId, entry)
            } else {
              entry.attached = true
            }
            // pid 以对账结果为准（server 重启后宿主 pid 可能变化）
            if (typeof summary['pid'] === 'number') entry.pid = summary['pid']
          } catch (err) {
            this.log('warn', `re-attach failed (${taskId}): ${errMsg(err)}`)
          }
        } else {
          // 断连期间任务已退出（server 注册表已清）——合成退出，落 markStatus('exited')
          this.tasks.delete(taskId)
          this.lastSize.delete(taskId)
          this.opts.callbacks.onExit(taskId)
        }
      }
    } catch (err) {
      this.log('warn', `task.list reconcile failed: ${errMsg(err)}`)
    }
  }
}

/** 从 argv 提取 --settings 值（镜像进 req.settingsPath——server 侧不消费，契约字段完备） */
function extractSettingsPath(argv: string[]): string | undefined {
  const idx = argv.indexOf('--settings')
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n', 1)[0]!.slice(0, 200) : String(err)
}

// ── 多连接枢纽 ─────────────────────────────────────────────────────────

export interface RemotePtyHubOptions {
  connection: ConnectionManager
  /** 与本地 PtyManager 同源回调（onData→noteBytes+broadcast、onExit→markStatus） */
  callbacks: PtyBackendCallbacks
  /** server.log 帧桥（ipc 注入 broadcastRemoteServerLog——带 connectionId） */
  onServerLog: (e: RemoteServerLogEvent) => void
  claudeBin?: string
  /**
   * v2.0.1：连接下记录 running 的任务 id（组合根注入 tasks/projects 派生）——
   * manager 认领对账用（重启后首连 attach 保活任务；见 RemotePtyManagerOptions）
   */
  runningTaskIdsOf?: (connectionId: string) => string[]
  /**
   * hooks 反向转发接收端（ipc 注入 task-activity 的 127.0.0.1 随机口；A3 接线：
   * VM 侧 forwardIn 入站流 pipe 到这里）。未提供时入站流直接断开（禁乱拨）。
   */
  hookSink?: () => Promise<{ host: string; port: number }>
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  /** hooks 远端口选择器（缺省随机动态口；测试钉住用） */
  hookPortPicker?: () => number
  /** 传输工厂透传（v2.0.2 测试注入；缺省=每 manager 自建 ServerClient） */
  transportFactory?: (events: ServerClientEvents) => ServerTransport
}

/** server 版本比较（a≥b；点分数字逐段） */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number(x) || 0)
  const pb = b.split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

/** hooks 服务器侧直收的最低 server 版本（/hook 路由 + hook.event 转发 + 侧推送） */
const SERVER_HOOK_MIN_VERSION = '0.1.1'

export class RemotePtyHub {
  private readonly opts: RemotePtyHubOptions
  private readonly managers = new Map<string, RemotePtyManager>()
  private readonly hookPorts = new Map<string, number>()
  /** hookPortFor 并发去重（多任务并发 spawn 各自触发接线时只登记一个口） */
  private readonly hookPortInFlight = new Map<string, Promise<number>>()
  /** v2.0.2 server 版本缓存（connectionId → version；hook URL 基址/推送门控） */
  private readonly serverVersions = new Map<string, string>()

  constructor(opts: RemotePtyHubOptions) {
    this.opts = opts
  }

  /** per-connection 懒建（Stub 注入下未触远程路径则零副作用） */
  managerFor(connectionId: string): RemotePtyManager {
    let m = this.managers.get(connectionId)
    if (m === undefined) {
      m = new RemotePtyManager({
        connectionId,
        connection: this.opts.connection,
        callbacks: this.opts.callbacks,
        onServerLog: (level, message) =>
          this.opts.onServerLog({ connectionId, level, message }),
        ...(this.opts.claudeBin !== undefined ? { claudeBin: this.opts.claudeBin } : {}),
        ...(this.opts.runningTaskIdsOf !== undefined
          ? { runningTaskIds: () => this.opts.runningTaskIdsOf!(connectionId) }
          : {}),
        // v2.0.2：hook 回放落点透传（server 侧 hook 接收的客户端消费端）
        ...(this.opts.hookSink !== undefined
          ? { hookSink: () => this.opts.hookSink!() }
          : {}),
        // v2.0.2：传输工厂透传（测试注入 FakeTransport——server.version/hook 回放）
        ...(this.opts.transportFactory !== undefined
          ? { transportFactory: this.opts.transportFactory }
          : {}),
        ...(this.opts.connectTimeoutMs !== undefined
          ? { connectTimeoutMs: this.opts.connectTimeoutMs }
          : {}),
        ...(this.opts.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: this.opts.requestTimeoutMs }
          : {})
      })
      this.managers.set(connectionId, m)
    }
    return m
  }

  /**
   * 连接流程健康检查（S4 item8）：SSH 已通前提下建立 server-client 并做真实协议
   * ping（O6 安装健康语义）。失败（needInstall token 错误）由 ConnectionsConnect
   * handler 上抛——S6 connectFlow 的 NEED_INSTALL_RE 命中触发安装弹窗。
   */
  async ensureConnected(connectionId: string): Promise<void> {
    await this.managerFor(connectionId).ensureReady()
  }

  /** 代理帧透传（proxy.status/config.get/config.set；payload 形状=server 侧终态） */
  async proxyRequest<T = unknown>(connectionId: string, frame: ClientFrame): Promise<T> {
    return this.managerFor(connectionId).request<T>(frame)
  }

  /**
   * hooks 反向转发接线（A3）：在 VM 侧 127.0.0.1:<动态远端口> 监听，入站流 pipe 到
   * 接收端（本机 127.0.0.1:activityPort）。远端口=本侧自选动态口——S2 forwardIn 契约
   * 以「请求端口」为 handler 键，port 0 下 sshd 分配的实际口不入表（ssh2 回调的
   * realPort 被丢弃），真实 sshd 会拒流入站——自选动态口语义等价且两端可对账。
   * 每连接一个口（S2 重连自动重放注册）；绑定失败（VM 侧占用）换口重试。
   */
  /**
   * v2.0.2 hooks URL 基址（推送服务器侧化）：server ≥0.1.1 → server 本机 HTTP 口
   * （claude 直 POST 到 VM 侧 server——客户端离线不再 ECONNREFUSED）；旧 server →
   * 回退 SSH forwardIn 转发口（原行为）。版本查询失败也回退（保守）。
   */
  async hookUrlBaseFor(connectionId: string): Promise<string> {
    const version = await this.serverVersionOf(connectionId)
    if (version !== null && versionAtLeast(version, SERVER_HOOK_MIN_VERSION)) {
      return `http://127.0.0.1:${CWB_SERVER_PORT}`
    }
    return `http://127.0.0.1:${await this.hookPortFor(connectionId)}`
  }

  /** server ≥0.1.1=webhook 由 server 侧推送（客户端不再重复推远程任务） */
  serverPushesNotifyFor(connectionId: string): boolean {
    const v = this.serverVersions.get(connectionId)
    return v !== undefined && versionAtLeast(v, SERVER_HOOK_MIN_VERSION)
  }

  /** server 版本（缓存；失败=null=未知→按旧 server 回退） */
  private async serverVersionOf(connectionId: string): Promise<string | null> {
    const cached = this.serverVersions.get(connectionId)
    if (cached !== undefined) return cached
    try {
      const m = this.managerFor(connectionId)
      const payload = await m.request<{ version?: unknown }>({ type: 'server.version' })
      const v = payload?.version
      if (typeof v === 'string' && v !== '') {
        this.serverVersions.set(connectionId, v)
        return v
      }
    } catch {
      // 版本查询失败——按未知处理（回退 forwardIn）
    }
    return null
  }

  async hookPortFor(connectionId: string): Promise<number> {
    const cached = this.hookPorts.get(connectionId)
    if (cached !== undefined) return cached
    const inFlight = this.hookPortInFlight.get(connectionId)
    if (inFlight !== undefined) return inFlight
    const p = this.registerHookForwardIn(connectionId).finally(() => {
      this.hookPortInFlight.delete(connectionId)
    })
    this.hookPortInFlight.set(connectionId, p)
    return p
  }

  private async registerHookForwardIn(connectionId: string): Promise<number> {
    const sink = this.opts.hookSink !== undefined ? await this.opts.hookSink() : null
    let lastErr: unknown
    for (let i = 0; i < HOOK_PORT_ATTEMPTS; i++) {
      // 首选稳定口（跨客户端重启不换——保活会话的旧 hook URL 重连后复活）；
      // 失败回退随机口。picker 注入时维持注入语义（测试口即测试想要的行为）
      const port =
        i === 0 && this.opts.hookPortPicker === undefined
          ? HOOK_PORT_PREFERRED
          : this.opts.hookPortPicker
            ? this.opts.hookPortPicker()
            : HOOK_PORT_MIN + Math.floor(Math.random() * (HOOK_PORT_MAX - HOOK_PORT_MIN))
      try {
        await this.opts.connection.forwardIn(connectionId, port, (stream) =>
          this.pipeHookStream(stream, sink)
        )
        this.hookPorts.set(connectionId, port)
        return port
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /** before-quit 全连接 detach-only（H2：绝不杀远端任务，仅断数据流） */
  detachAll(): void {
    for (const m of this.managers.values()) m.killAllTrees()
  }

  /** 测试/编排收尾 */
  disposeAll(): void {
    for (const m of this.managers.values()) m.dispose()
    this.managers.clear()
    this.hookPorts.clear()
    this.hookPortInFlight.clear()
  }

  /** 入站流（ssh2 Channel）→ 接收端 TCP（task-activity HTTP server）双向 pipe */
  private pipeHookStream(
    stream: NodeJS.ReadWriteStream,
    sink: { host: string; port: number } | null
  ): void {
    // ReadWriteStream 类型面无 destroy（ssh2 Channel 实际有）——可选调用
    const destroyStream = (): void => {
      ;(stream as unknown as { destroy?: () => void }).destroy?.()
    }
    if (sink === null) {
      destroyStream()
      return
    }
    const sock = createConnection(sink, () => {
      stream.pipe(sock)
      sock.pipe(stream)
    })
    const done = (): void => {
      destroyStream()
      sock.destroy()
    }
    stream.on('close', done)
    stream.on('error', done)
    sock.on('close', done)
    sock.on('error', done)
  }
}
