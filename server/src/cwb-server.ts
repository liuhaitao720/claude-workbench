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
import { ServerNotifier } from './notify'

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
}

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
  private shuttingDown = false
  private boundPort: number | undefined

  constructor(private readonly opts: CwbServerOptions = {}) {
    this.config = new ConfigStore(opts.configPath)
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
      onTaskExit: (taskId, exitCode) => this.log('info', `task exited (${taskId}, code ${exitCode})`)
    })
    // v2.0.2 服务器侧 webhook 推送（用户指令：推送+URL 全落服务器端）——
    // hook 直达 server 后由 server 读 ~/.cwb/notify.json 就地推送；客户端离线照常
    this.notifier = new ServerNotifier({
      home: opts.notifyHome ?? process.env['HOME'] ?? '/root',
      taskNameOf: (taskId) => this.registry.nameOf(taskId),
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

  /** hook POST：URL 解析 → 丢弃 body → 帧转发（在线客户端）+ 服务器侧推送 */
  private handleHookPost(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
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
    // body 丢弃（hook payload 不消费；连接即刻收口防悬挂）
    req.resume()
    res.statusCode = 200
    res.end()
    if (taskId === '' || eRaw === null) return
    const epoch = Number(eRaw)
    if (!Number.isInteger(epoch)) return
    // 转发给全部在线客户端（单客户端假设；epoch/任务校验由客户端接收端做）
    for (const ws of this.wss?.clients ?? []) {
      this.send(ws, { type: 'hook.event', taskId, event, epoch })
    }
    // 服务器侧推送（旁路——吞错不阻塞）
    this.notifier.onHookEvent(taskId, event)
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
      sink
    }
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
    for (const ws of this.wss.clients) this.send(ws, { type: 'conn.closed', reason })
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
      registry.kill(frame.taskId)
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
    }
  }
}

/** 8.1=A 兜底：stderr 仅元数据（不落盘；终端内容永不经此） */
function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`[cwb-server:${level}] ${message}\n`)
}

/** 错误脱敏：只留 message 首段（无堆栈、无多行） */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n', 1)[0]!.slice(0, 300)
}
