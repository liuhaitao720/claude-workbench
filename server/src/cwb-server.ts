/**
 * cwb-server 协议服务端（S3）：WS 传输 + 帧分发 + PTY 注册表 + 远程代理。
 *
 * 信任边界（v1 无鉴权——显式决策）：仅监听 127.0.0.1（回环）。可达性=本机进程
 * 或经 SSH 隧道转发的客户端（sshd 自带认证/授权与 AllowTcpForwarding 门控）；
 * 网络上其他主机不可直达。任何暴露到非回环地址的改动都必须先加帧级认证。
 *
 * 5.9=b 保活：客户端 WS 断开≠杀 PTY（仅 detach 全部；PTY 由 claude 自行退出
 * 或显式 task.kill）。kill 语义=仅用户显式停止任务（对齐 5.1=A 断线不杀）。
 *
 * 8.1=A：任何终端内容/命令不落盘不进日志——server.log 帧与 stderr 镜像仅
 * 连接/任务生命周期元数据（taskId/pid/端口/错误类别），绝不含 task.data、
 * argv、错误帧原文。
 */
import { type WebSocket, WebSocketServer } from 'ws'
import { createServer, type Server as HttpServer } from 'node:http'
import pkg from '../package.json'
import { decodeClientFrame, encodeServerFrame } from './frames'
import type { ClientFrame, ServerFrame } from './shared/remote-protocol'
import { TaskRegistry, type TaskSink } from './pty-registry'
import { createRemoteProxy } from './proxy-core'
import { ConfigStore } from './config-store'
import { ServerNotifier, loadNotifyExtras, type AnswerConfig } from './notify'
import { AnswerService } from './answer-store'
import { AnswerPage } from './answer-page'
import { CloudflareTunnel, resolveCloudflaredBin, type TunnelState } from './tunnel'

/** server 版本（package.json 单一事实源；server.version 帧与 S7 升级比对共用） */
export const VERSION: string = pkg.version

/** 帧分发 handler：frame=解码后的请求帧；ctx=该连接的回帧出口与数据 sink */
export type FrameHandler = (
  frame: ClientFrame,
  ctx: FrameContext
) => void | Promise<void>

export interface FrameContext {
  /** 该连接的回帧出口（result 回执/task.data/task.exit 等全部经此） */
  send: (frame: ServerFrame) => void
  /** 该连接的任务数据 sink（attach 标记用） */
  sink: TaskSink
  /** 该连接的桌面在场状态（v2.2.0 presence 帧写入；本连接级，断开即失效） */
  presence: PresenceState
}

/** 桌面在场状态（v2.2.0）：lastInputAt=客户端最近键入时刻（不存内容），focused=窗口聚焦 */
export interface PresenceState {
  lastInputAt: number
  focused: boolean
}

/**
 * 能力清单（3.3=A capability 帧应答；客户端据此显示入口，不靠版本号猜）。
 * v2.2.0：answer/answerPage 随应答页（answer-page.ts）与隧道（tunnel.ts）落地打开。
 */
export const SERVER_CAPABILITIES = {
  pushEvents: true,
  answer: true,
  answerPage: true
} as const

/** 脱敏元数据日志出口（server.log 帧 + stderr 镜像；禁止内容型字段） */
export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void

export interface CwbServerOptions {
  /** 监听端口（默认 17717——与客户端约定固定口；0=OS 动态分配，测试用） */
  port?: number
  /** 监听地址（默认 127.0.0.1——信任边界，见文件头） */
  host?: string
  /** 配置文件路径（默认 ~/.cwb-server/config.json；测试注入临时目录） */
  configPath?: string
  /** 代理监听首选端口（默认 12700，占用自动 +1 重试；实际端口经 proxy.status 透出） */
  proxyPreferPort?: number
  /** 元数据日志出口（缺省=stderr 镜像；server.log 帧由 broadcastLog 主动发） */
  log?: LogFn
  /** v2.0.2 webhook 配置定位 HOME（缺省=process.env.HOME；测试注入临时目录） */
  notifyHome?: string
}

export const DEFAULT_PORT = 17_717
export const DEFAULT_HOST = '127.0.0.1'

/** hook 请求体读取上限（64KB；超出截断——摘要字段通常远小于此） */
const HOOK_BODY_MAX_BYTES = 64 * 1024
/** 手机答复配置轮询间隔（answer.enabled 开关即时生效，设计 §3.5） */
export const ANSWER_CONFIG_POLL_MS = 10_000

export class CwbServer {
  readonly registry: TaskRegistry
  private readonly wss: WebSocketServer
  private readonly http: HttpServer
  /** 配置存取（proxy.config.* 消费；测试直读） */
  readonly config: ConfigStore
  /** 远程代理句柄（proxy.* 消费；测试直用） */
  readonly proxy: ReturnType<typeof createRemoteProxy>
  /** 元数据日志出口 */
  readonly log: LogFn
  /** v2.0.2 服务器侧 webhook 推送器（测试直用） */
  readonly notifier: ServerNotifier
  /** v2.2.0 B 链手机答复 pending 仓库（页面/隧道在 T4 接入） */
  readonly answer: AnswerService
  /** 连接级桌面在场状态（v2.2.0 presence 帧；未上报过 presence 的旧客户端按「在场」处理） */
  private readonly presence = new Map<WebSocket, PresenceState>()
  /** 已上报过 presence 的连接状态对象（WeakSet——随状态对象回收） */
  private readonly presenceReported = new WeakSet<PresenceState>()
  /** notify.json 定位 HOME（answer 配置/presenceMin 读取） */
  private readonly notifyHome: string
  /** 显式停止意图（task.kill 先记，退出回调取用——1.12 stopped 与 exited 分流） */
  private readonly stopIntent = new Set<string>()
  /** 手机应答页（v2.2.0 T4；enabled 时监听 127.0.0.1） */
  private answerPage: AnswerPage | undefined
  /** Cloudflare 快速隧道（公网入口；URL 变化广播 answer.state） */
  private tunnel: CloudflareTunnel | undefined
  /** 最近一次 answer 配置快照（轮询差异检测） */
  private answerConfig: AnswerConfig | undefined
  /** 隧道状态（answer.state 广播/快照用） */
  private answerTunnelState: TunnelState = 'off'
  /** 配置轮询定时器（startAnswerChannel 建立） */
  private answerPollTimer: NodeJS.Timeout | undefined
  /** 配置同步串行链（避免并发启停页面/隧道） */
  private answerSyncing: Promise<void> = Promise.resolve()
  private shuttingDown = false
  private boundPort: number | undefined

  constructor(private readonly opts: CwbServerOptions = {}) {
    this.config = new ConfigStore(opts.configPath)
    this.notifyHome = opts.notifyHome ?? process.env['HOME'] ?? '/root'
    const baseLog = opts.log ?? defaultLog
    // server.log 帧通道（契约 server→client 帧之一）：本地 stderr 镜像之外，
    // 同步把元数据日志推给在线客户端（S4 桥接为 RemoteServerLog EVENT）。
    // 8.1=A：仅元数据——所有经此的消息只含生命周期事件描述，不含终端内容。
    this.log = (level, message) => {
      baseLog(level, message)
      for (const ws of this.wss?.clients ?? []) {
        this.send(ws, { type: 'server.log', level, message })
      }
    }
    this.proxy = createRemoteProxy({
      preferPort: opts.proxyPreferPort,
      resolveConfig: () => this.config.get()
    })
    this.registry = new TaskRegistry({
      onTaskSpawn: (taskId, pid) => this.log('info', `task spawned (${taskId}, pid ${pid})`),
      onTaskExit: (taskId, exitCode) => {
        this.log('info', `task exited (${taskId}, code ${exitCode})`)
        // v2.2.0 B 链：任务结束 → 该任务挂起的 hook 全部空响应释放（页面显示任务已结束）
        this.answer.cancelTask(taskId, 'system')
        // v2.2.0 完成/停止推送：退出是终态事件（1.3/1.6），与 10 秒内的 Stop 合并
        if (!this.shuttingDown) {
          this.notifier.onTaskExit(taskId, exitCode, this.stopIntent.delete(taskId))
        }
      }
    })
    // v2.0.2 服务器侧 webhook 推送（用户指令：推送+URL 全落服务器端）——
    // hook 直达 server 后由 server 读 ~/.cwb/notify.json 就地推送；客户端离线照常
    this.notifier = new ServerNotifier({
      home: this.notifyHome,
      metaOf: (taskId) => {
        const name = this.registry.nameOf(taskId)
        const projectName = this.registry.projectNameOf(taskId)
        const startedAt = this.registry.startedAtOf(taskId)
        return {
          ...(name !== undefined ? { name } : {}),
          ...(projectName !== undefined ? { projectName } : {}),
          ...(startedAt !== undefined ? { startedAt } : {})
        }
      },
      log: (level, message) => this.log(level, message)
    })
    // v2.2.0 B 链：手机答复 pending 仓库（页面/隧道就绪由 T4 经 setSurface 注入；
    // 未注入时 canHold()=false，hook 立即 200 回落 TUI——桌面行为零变化）
    this.answer = new AnswerService({
      config: () => {
        const a = loadNotifyExtras(this.notifyHome).answer
        return { enabled: a.enabled, ttlSec: a.ttlSec }
      },
      surface: () => this.answer.baseUrl,
      tunnel: () => this.answerTunnelState,
      broadcast: (frame) => this.broadcastFrame(frame),
      log: (level, message) => this.log(level, message)
    })
    this.http = createServer((req, res) => {
      // v2.0.2 hook 接收口（稳定本机口——客户端 SSH forwardIn 不再承载 hooks，
      // 客户端离线不再 ECONNREFUSED）：POST /hook/<Event>?t=<taskId>&e=<epoch>
      // → 转发 hook.event 帧给在线客户端 + 服务器侧推送。一律 200 空体（不干扰
      // claude 授权流、不触发重试——与客户端接收端同语义）。
      if (req.method === 'POST' && /^\/hook\/[A-Za-z]+$/.test((req.url ?? '').split('?')[0] ?? '')) {
        this.handleHookPost(req, res)
        return
      }
      // WS 升级由 wss 接管；这里兜非升级 HTTP（本机健康探活最小应答）
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`{"ok":true,"server":"cwb-server","version":"${VERSION}"}\n`)
    })
    this.wss = new WebSocketServer({ server: this.http })
    this.wss.on('connection', (ws) => this.handleConnection(ws))
  }

  /**
   * hook POST：URL 解析 → 收 body（≤64KB）→ 2xx 空体 → 帧转发（在线客户端）+
   * 服务器侧推送（v2.2.0：body 供 Stop 摘要；B 链挂起在 T3 接入此方法）。
   * 一律 200 空体（不干扰 claude 授权流、不触发重试——与客户端接收端同语义）。
   */
  private handleHookPost(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ): void {
    const url = req.url ?? ''
    const event = url.slice('/hook/'.length).split('?')[0] ?? ''
    let query: URLSearchParams
    try {
      query = new URL(url, 'http://127.0.0.1').searchParams
    } catch {
      res.statusCode = 200
      res.end()
      return
    }
    const taskId = query.get('t') ?? ''
    const eRaw = query.get('e')
    const epoch = eRaw === null ? Number.NaN : Number(eRaw)
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    /** finish 只处理一次（end/error/aborted 三事件可能重复触发） */
    let processed = false
    const respondEmpty = (): void => {
      if (settled) return
      settled = true
      res.statusCode = 200
      res.end()
    }
    const respondDecision = (decision: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      if (decision === null) {
        res.statusCode = 200
        res.end()
        return
      }
      const payload = JSON.stringify(decision)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(payload)
    }
    const finish = (): void => {
      if (processed) return
      processed = true
      if (taskId === '' || !Number.isInteger(epoch)) {
        respondEmpty()
        return
      }
      const body = Buffer.concat(chunks).toString('utf8')
      // 转发给全部在线客户端（activity 状态/桌面横幅；epoch/任务校验由客户端做）
      for (const ws of this.wss?.clients ?? []) {
        this.send(ws, { type: 'hook.event', taskId, event, epoch })
      }
      // v2.2.0 B 链：桌面不在场 + 配置开 + 页面/隧道就绪 → 挂起 hook 等手机答复
      const answerCfg = loadNotifyExtras(this.notifyHome).answer
      if (this.desktopAway(answerCfg.presenceMin)) {
        const name = this.registry.nameOf(taskId)
        const projectName = this.registry.projectNameOf(taskId)
        const held = this.answer.tryHold({
          taskId,
          event,
          bodyText: body,
          ...(name !== undefined ? { taskName: name } : {}),
          ...(projectName !== undefined ? { projectName } : {}),
          reply: respondDecision
        })
        if (held !== null) {
          // 延迟响应：claude 等待页面/桌面释放（hook timeout=3600s，见 settings）。
          // 客户端放弃等待（超时/任务被杀）→ pending 记 expired，页面显示已过期
          res.once('close', () => {
            if (!settled) {
              settled = true
              this.answer.abandon(held.pending.pendingId)
            }
          })
          // awaiting 推送带链接（1.11）；已由挂起覆盖，普通文案不带链接
          this.notifier.onHookEvent(taskId, event, body, held.url)
          return
        }
      }
      respondEmpty()
      // 服务器侧推送（旁路——吞错不阻塞）
      this.notifier.onHookEvent(taskId, event, body)
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total <= HOOK_BODY_MAX_BYTES) chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('error', finish)
    req.on('aborted', finish)
  }

  /** 记录显式停止意图（task.kill 先记，退出回调取用——区分 stopped 与 exited） */
  noteStopIntent(taskId: string): void {
    this.stopIntent.add(taskId)
  }

  /**
   * 停止任务（桌面 task.kill 帧 / 手机应答页 /api/stop 共用，v2.2.0）。
   * 先作废该任务的手机挂起（by 体现来源，供 answer.resolved 展示），再杀 PTY。
   */
  killTask(taskId: string, by: 'desktop' | 'phone' = 'desktop'): void {
    this.noteStopIntent(taskId)
    this.answer.cancelTask(taskId, by)
    this.registry.kill(taskId)
  }

  /** presence 帧到达（该连接为「在场感知」新客户端；旧客户端不发） */
  markPresenceReported(presence: PresenceState): void {
    this.presenceReported.add(presence)
  }

  /**
   * 启动手机答复通道（v2.2.0 T4，main.ts 装配调用）：立即同步一次配置，此后每
   * 10 秒轮询 notify.json（enabled/pagePort 变化即时生效，与 ssh 写入解耦）。
   */
  startAnswerChannel(pollMs: number = ANSWER_CONFIG_POLL_MS): void {
    if (this.answerPollTimer !== undefined) return
    void this.syncAnswerChannel()
    const timer = setInterval(() => void this.syncAnswerChannel(), pollMs)
    timer.unref?.()
    this.answerPollTimer = timer
  }

  /** 停止通道（停机路径；先由 answer.dispose 释放 pending，再 stop 子进程——§3.5） */
  private async stopAnswerChannel(): Promise<void> {
    if (this.answerPollTimer !== undefined) {
      clearInterval(this.answerPollTimer)
      this.answerPollTimer = undefined
    }
    this.tunnel?.stop()
    this.tunnel = undefined
    await this.answerPage?.stop()
    this.answerPage = undefined
    this.answer.setSurface(undefined)
    this.answerTunnelState = 'off'
  }

  /** 配置同步串行化（页面/隧道启停是异步的，轮询与手工调用不并发） */
  private syncAnswerChannel(): Promise<void> {
    this.answerSyncing = this.answerSyncing
      .then(() => this.applyAnswerConfig())
      .catch((err: unknown) => {
        this.log('warn', `answer channel sync failed (${sanitizeError(err)})`)
      })
    return this.answerSyncing
  }

  /** 差异应用：关闭→释放挂起并停页面/隧道；开启→起页面（端口变则重启）→起隧道 */
  private async applyAnswerConfig(): Promise<void> {
    const cfg = loadNotifyExtras(this.notifyHome).answer
    const prev = this.answerConfig
    this.answerConfig = cfg

    if (!cfg.enabled) {
      if (prev?.enabled === true || this.answerPage !== undefined || this.tunnel !== undefined) {
        // 关闭手机答复：先释放全部挂起（claude 立即回落 TUI），再停隧道/页面
        const released = this.answer.cancelAll('system')
        if (released > 0) this.log('info', `answer disabled: released ${released} pending`)
        this.tunnel?.stop()
        this.tunnel = undefined
        await this.answerPage?.stop()
        this.answerPage = undefined
        this.answer.setSurface(undefined)
        this.answerTunnelState = 'off'
        this.answer.broadcastState('off')
      }
      return
    }

    // 端口变更 → 页面与隧道一起重启（cloudflared 目标端口固定）
    if (this.answerPage !== undefined && prev !== undefined && prev.pagePort !== cfg.pagePort) {
      this.tunnel?.stop()
      this.tunnel = undefined
      await this.answerPage.stop()
      this.answerPage = undefined
      this.answer.setSurface(undefined)
      this.answerTunnelState = 'off'
    }

    if (this.answerPage === undefined) {
      const page = new AnswerPage({
        answer: this.answer,
        port: cfg.pagePort,
        onStop: (taskId) => this.stopTaskFromPhone(taskId),
        log: (level, message) => this.log(level, message)
      })
      await page.start()
      this.answerPage = page
    }

    if (this.tunnel === undefined) {
      const tunnel = new CloudflareTunnel({
        targetPort: () => this.answerPage?.port,
        bin: resolveCloudflaredBin({ home: this.notifyHome }),
        onState: (state, url) => this.onTunnelState(state, url),
        log: (level, message) => this.log(level, message)
      })
      this.tunnel = tunnel
      tunnel.start()
    }
  }

  /** 隧道状态：仅 up 时注入 surface（可挂起/链接可用），其余状态清空 */
  private onTunnelState(state: TunnelState, url?: string): void {
    this.answerTunnelState = state
    this.answer.setSurface(state === 'up' ? url : undefined)
    if (state === 'missing') {
      this.log('warn', 'cloudflared not found: phone answering unavailable (install cloudflared)')
    } else if (state === 'up') {
      this.log('info', 'phone answer channel up')
    } else if (state === 'down') {
      this.log('warn', 'tunnel down: reconnecting')
    }
    this.answer.broadcastState(state)
  }

  /**
   * 手机请求停止（/api/stop，2.17=B）：本地任务交回持连接的客户端（answer.stop
   * 帧）；远程任务 server 直接 kill。未知任务=false。
   */
  private stopTaskFromPhone(taskId: string): boolean {
    if (this.answer.requestStop(taskId)) return true
    try {
      this.killTask(taskId, 'phone')
      return true
    } catch {
      this.log('warn', 'phone stop ignored (unknown task)')
      return false
    }
  }

  /**
   * 桌面是否「不在场」（2.16：客户端在线且最近 presenceMin 分钟有键入=在场）。
   * - 无在线客户端 → 不在场（手机可代答）；
   * - 在线但全部是旧客户端（从未发 presence）→ 按在场处理（桌面行为不变）；
   * - 否则任一在场感知客户端在键入窗内 → 在场。
   */
  private desktopAway(presenceMin: number): boolean {
    const all = [...this.presence.values()]
    const aware = all.filter((p) => this.presenceReported.has(p))
    if (aware.length === 0) return all.length === 0
    const at = Date.now()
    const windowMs = presenceMin * 60_000
    return aware.every((p) => at - p.lastInputAt >= windowMs)
  }

  /** 帧广播（answer.pending/resolved/state；无客户端=静默） */
  private broadcastFrame(frame: ServerFrame): void {
    for (const ws of this.wss?.clients ?? []) this.send(ws, frame)
  }

  /** 监听（返回实际端口——port=0 时为 OS 动态分配） */
  async start(): Promise<{ port: number; host: string }> {
    const host = this.opts.host ?? DEFAULT_HOST
    const port = this.opts.port ?? DEFAULT_PORT
    if (this.boundPort !== undefined) return { port: this.boundPort, host }
    const bound = await new Promise<number>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, host, () => {
        const addr = this.http.address()
        resolve(typeof addr === 'object' && addr !== null ? addr.port : port)
      })
    })
    this.boundPort = bound
    this.log('info', `listening on ${host}:${bound}`)
    return { port: bound, host }
  }

  /** 已绑定的实际端口（未监听=undefined） */
  get port(): number | undefined {
    return this.boundPort
  }

  private handleConnection(ws: WebSocket): void {
    const sink: TaskSink = {
      onData: (taskId, chunk) => this.send(ws, { type: 'task.data', taskId, chunk }),
      onExit: (taskId, exitCode) => this.send(ws, { type: 'task.exit', taskId, exitCode })
    }
    const ctx: FrameContext = {
      send: (frame) => this.send(ws, frame),
      sink,
      // 无 presence 帧的旧客户端：按「在场」处理（不挂起，桌面行为不变）
      presence: { lastInputAt: Number.MAX_SAFE_INTEGER, focused: false }
    }
    this.presence.set(ws, ctx.presence)
    const handlers = createHandlers(this, ctx)
    // 帧序串行化：handler 存在异步段（spawn 的 PATH 发现/proxy.start 监听），
    // 不串行则后到帧可能先执行（spawn→attach 背靠背时 attach 先跑=unknown task）。
    // 客户端按序发送的帧必须按序生效——逐帧链式排队。
    let chain: Promise<void> = Promise.resolve()
    this.log('info', 'client connected')
    ws.on('message', (data) => {
      let frame: ClientFrame
      try {
        frame = decodeClientFrame(data.toString())
      } catch (err) {
        // 错误消息只含字段/类型描述（FrameDecodeError 构造保证），不回显帧体
        this.log('warn', `malformed frame rejected (${(err as Error).message})`)
        return
      }
      chain = chain.then(() => dispatchFrame(handlers, frame, ctx, this.log))
    })
    ws.on('close', () => {
      // 5.9=b：断连=仅 detach（该连接全部任务停推），PTY 保活继续跑
      this.registry.detachAll(sink)
      this.presence.delete(ws)
      this.log('info', 'client disconnected (tasks kept alive)')
    })
    ws.on('error', () => {
      /* ws 错误后必然 close——统一走 close 路径 */
    })
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(encodeServerFrame(frame))
  }

  /**
   * 主动服务端事件日志（升级/异常摘要等；等价于 this.log——server.log 帧 +
   * stderr 镜像，供 main/S7 装配侧调用）。
   */
  broadcastLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.log(level, message)
  }

  /**
   * 优雅停机：通知连接（conn.closed）→ detach 全部 + PTY 不杀（5.9=b 保活
   * 语义——server 退出不杀任务，claude 自行收尾）→ proxy 停止监听 → 关 WS/HTTP。
   */
  async shutdown(reason = 'server shutting down'): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    // v2.2.0 B 链：先释放全部手机挂起（空响应），claude 不必等满 hook 超时
    this.answer.dispose()
    // 手机答复通道停机：页面/隧道随之关闭（已无 pending 需要页面）
    await this.stopAnswerChannel()
    for (const ws of this.wss.clients) this.send(ws, { type: 'conn.closed', reason })
    // 10 秒合并窗内未发的 Stop 在停机前补推（不丢消息）；随后清空全部定时器
    this.notifier.flush()
    this.registry.disposeTimers()
    for (const ws of this.wss.clients) ws.close(1001, reason)
    // 恶劣客户端不响应 close 时限时兜底（2s——不因单个连接卡死停机/升级替换）
    await Promise.race([
      new Promise<void>((resolve) => this.wss.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ])
    this.proxy.stop()
    await Promise.race([
      new Promise<void>((resolve) => this.http.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ])
    this.log('info', `shutdown complete (${reason})`)
  }
}

/** 单帧分发：handler 异常→rid 回执 ok=false（脱敏）；无 rid 帧→仅记日志 */
async function dispatchFrame(
  handlers: Record<ClientFrame['type'], FrameHandler>,
  frame: ClientFrame,
  ctx: FrameContext,
  log: LogFn
): Promise<void> {
  try {
    await handlers[frame.type](frame, ctx)
  } catch (err) {
    const message = sanitizeError(err)
    if ('rid' in frame && frame.rid !== undefined) {
      ctx.send({ type: 'result', inReplyTo: frame.rid, ok: false, error: message })
    } else {
      log('warn', `frame ${frame.type} failed (${message})`)
    }
  }
}

function replyOk(ctx: FrameContext, rid: string | undefined, payload: unknown): void {
  if (rid === undefined) return // fire-and-forget 请求不回执
  ctx.send({ type: 'result', inReplyTo: rid, ok: true, payload })
}

/**
 * 协议 handler 注册表——键恰为 ClientFrame['type'] 全集（编译期完整性锁定：
 * 缺一个帧类型=编译红）。每连接一份（闭包捕获该连接的 send/sink）。
 */
function createHandlers(server: CwbServer, ctx: FrameContext): Record<ClientFrame['type'], FrameHandler> {
  const registry = server.registry
  const config = server.config
  const proxy = server.proxy
  const log = server.log
  return {
    'task.spawn': async (frame, c) => {
      if (frame.type !== 'task.spawn') return
      const pid = await registry.spawn(frame.req)
      replyOk(c, frame.rid, { taskId: frame.req.taskId, pid })
    },
    'task.write': (frame) => {
      if (frame.type !== 'task.write') return
      registry.write(frame.taskId, frame.data)
    },
    'task.resize': (frame) => {
      if (frame.type !== 'task.resize') return
      registry.resize(frame.taskId, frame.cols, frame.rows)
    },
    'task.kill': (frame, c) => {
      if (frame.type !== 'task.kill') return
      // 先记停止意图（退出回调据此推「已停止」而非「已退出」）+ 作废该任务挂起
      server.killTask(frame.taskId, 'desktop')
      replyOk(c, frame.rid, { taskId: frame.taskId })
    },
    'task.attach': (frame, c) => {
      if (frame.type !== 'task.attach') return
      registry.attach(frame.taskId, ctx.sink)
      replyOk(c, frame.rid, { taskId: frame.taskId })
    },
    'task.detach': (frame) => {
      if (frame.type !== 'task.detach') return
      registry.detach(frame.taskId, ctx.sink)
    },
    'task.list': (frame, c) => {
      if (frame.type !== 'task.list') return
      replyOk(c, frame.rid, registry.list())
    },
    'server.ping': (frame, c) => {
      if (frame.type !== 'server.ping') return
      replyOk(c, frame.rid, { pong: true, serverTime: new Date().toISOString() })
    },
    'server.version': (frame, c) => {
      if (frame.type !== 'server.version') return
      replyOk(c, frame.rid, { version: VERSION })
    },
    'proxy.status': (frame, c) => {
      if (frame.type !== 'proxy.status') return
      replyOk(c, frame.rid, proxy.status())
    },
    'proxy.start': async (frame, c) => {
      if (frame.type !== 'proxy.start') return
      const status = await proxy.start()
      log('info', `proxy started on port ${status.port ?? '?'}`)
      replyOk(c, frame.rid, status)
    },
    'proxy.stop': (frame, c) => {
      if (frame.type !== 'proxy.stop') return
      const status = proxy.stop()
      log('info', 'proxy stopped')
      replyOk(c, frame.rid, status)
    },
    'proxy.config.get': (frame, c) => {
      if (frame.type !== 'proxy.config.get') return
      replyOk(c, frame.rid, config.get())
    },
    'proxy.config.set': (frame, c) => {
      if (frame.type !== 'proxy.config.set') return
      const next = config.set(frame.patch)
      log('info', 'proxy config updated')
      replyOk(c, frame.rid, next)
    },
    // v2.2.0：桌面在场心跳（只记时间戳与聚焦态，不存内容）
    presence: (frame, c) => {
      if (frame.type !== 'presence') return
      c.presence.lastInputAt = frame.lastInputAt
      c.presence.focused = frame.focused
      server.markPresenceReported(c.presence)
    },
    'server.capabilities': (frame, c) => {
      if (frame.type !== 'server.capabilities') return
      replyOk(c, frame.rid, { ...SERVER_CAPABILITIES, version: VERSION })
    },
    // v2.2.0 B 链（本地任务挂起，D5）：客户端已解析 hook 视图 → server 建 token/推送；
// 答案经 answer.submit 帧回该连接（决策映射由客户端完成）。不可挂起时静默丢弃。
    'answer.pending': (frame, c) => {
      if (frame.type !== 'answer.pending') return
      const p = frame.pending
      server.answer.holdLocal(
        p,
        (pendingId, choice) => {
          c.send({ type: 'answer.submit', pendingId, choice })
        },
        () => c.send({ type: 'answer.stop', taskId: p.taskId })
      )
    },
    'task.meta': (frame) => {
      if (frame.type !== 'task.meta') return
      server.registry.updateMeta(frame.taskId, frame.name, frame.projectName)
    },
    'answer.cancel': (frame) => {
      if (frame.type !== 'answer.cancel') return
      server.answer.cancelFromDesktop(frame.pendingId, frame.taskId)
    }
  }
}

/** 8.1=A 兜底：stderr 仅元数据（不落盘；终端内容永不经此） */
function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`[cwb-server:${level} ${new Date().toISOString()}] ${message}\n`)
}

/** 错误脱敏：只留 message 首段（无堆栈、无多行） */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n', 1)[0]!.slice(0, 300)
}
