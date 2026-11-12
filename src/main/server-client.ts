import { WebSocket } from 'ws'
import type { ClientFrame, ServerFrame } from '../shared/remote-protocol'
import type { ConnectionManager } from './ssh/connection-manager'

/**
 * cwb-server 协议客户端（S4）：经 ConnectionManager.forwardOut 隧道（本机随机口 →
 * VM 127.0.0.1:17717）建 WS，承载 shared/remote-protocol.ts 帧的双向收发。
 *
 * - 帧编解码：客户端侧 JSON 序列化（task.data.chunk=UTF-8 字符串透传非 base64，
 *   S3 契约裁决）；入向帧做最小形状校验（畸形帧静默丢弃——信任边界内防崩）。
 * - 请求 rid↔Promise 回执：request() 注入 rid 并等 result 帧（inReplyTo 关联），
 *   ok=false 时以脱敏 error reject；fire-and-forget 帧（task.write 等）走 send()。
 * - 生命周期跟随 ConnectionManager（RemotePtyManager 订阅状态机驱动重连，本类
 *   只做单次建立——connect() 幂等：已连接直接返回）。
 * - needInstall 判定（契约 token）：SSH 隧道已建立（forwardOut 成功=SSH 认证/TOFU/
 *   自检全通过）但 WS 拒连/超时 → cwb-server 未安装或不可用 → 错误消息携带
 *   [cwb:need-server-install]（S6 connectFlow 的 NEED_INSTALL_RE=/needinstall|cwb-server/i
 *   命中触发安装弹窗；S7 安装完成后重连即通）。
 */

/** cwb-server 固定监听口（与 server/src/cwb-server.ts DEFAULT_PORT 一致；VM 侧回环） */
export const CWB_SERVER_PORT = 17_717
export const CWB_SERVER_HOST = '127.0.0.1'

/** needInstall 约定 token（S6 UI 正则 /needinstall|cwb-server/i 自动命中） */
export const NEED_SERVER_INSTALL_TOKEN = '[cwb:need-server-install]'

/** WS 建立超时（隧道已通但 server 无响应——区分「慢」与「没有」） */
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000
/** 请求回执超时（task.spawn 含远端 PATH 发现，余量放宽） */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export interface ServerClientEvents {
  /** task.data 帧（UTF-8 chunk 透传） */
  onData: (taskId: string, chunk: string) => void
  /** task.exit 帧（显式 kill 与自行退出统一经此，H6） */
  onExit: (taskId: string, exitCode: number) => void
  /** server.log 帧（脱敏元数据，M8/8.1=A） */
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * v2.0.2 hook.event 帧（推送服务器侧化）：claude hook 直 POST 到 server，
   * server 转发给在线客户端——回放进本机 task-activity 接收端。缺省忽略
   * （事件为可选——旧 server 不发，本地/测试可不接）。
   */
  onHookEvent?: (taskId: string, event: string, epoch: number) => void
  /** 连接关闭（WS 意外断开或 server 主动 conn.closed；reason=脱敏摘要） */
  onClosed: (reason?: string) => void
}

/**
 * 传输面抽象（RemotePtyManager 依赖它而非具体 ServerClient——L2 单测注入
 * 脚本化替身做帧级 mock；生产实现=ServerClient）。
 */
export interface ServerTransport {
  readonly connected: boolean
  /** 建立 WS（幂等：已连接直接返回）；SSH 通而 WS 不通 → needInstall token 错误 */
  connect(): Promise<void>
  /** 带回执请求（注入 rid 等 result 帧；ok=false reject） */
  request<T = unknown>(frame: ClientFrame): Promise<T>
  /** fire-and-forget 发送；未连接返回 false（丢帧与否由调用方语义决定） */
  send(frame: ClientFrame): boolean
  /** 主动关闭（挂起请求全部 reject；不触发 onClosed） */
  close(): void
}

export interface ServerClientOptions extends ServerClientEvents {
  connectionId: string
  connection: ConnectionManager
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
}

export class ServerClient implements ServerTransport {
  private readonly opts: ServerClientOptions
  private ws: WebSocket | null = null
  private isConnected = false
  private seq = 0
  private readonly pending = new Map<string, Pending>()

  constructor(opts: ServerClientOptions) {
    this.opts = opts
  }

  get connected(): boolean {
    return this.isConnected
  }

  async connect(): Promise<void> {
    if (this.isConnected) return
    // 1) 隧道：本机 127.0.0.1 随机口 → VM 127.0.0.1:17717（forwardOut 内含懒连接——
    //    SSH 认证/TOFU/自检失败在这一步抛 S2 分级错误，与 needInstall 无关）
    const localPort = await this.opts.connection.forwardOut(
      this.opts.connectionId,
      CWB_SERVER_HOST,
      CWB_SERVER_PORT
    )
    // 2) WS：隧道已通而 WS 拒连/超时 = cwb-server 未安装/未监听 → needInstall token
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${localPort}`)
      const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      const timer = setTimeout(() => {
        cleanup()
        ws.terminate()
        reject(needInstallError(`WS open timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const onOpen = (): void => {
        cleanup()
        this.adopt(ws)
        resolve()
      }
      const onError = (err: Error): void => {
        cleanup()
        ws.terminate()
        reject(needInstallError(err.message))
      }
      /** 握手期被关闭（close()/对端断）：不等超时，立即失败 */
      const onEarlyClose = (): void => {
        cleanup()
        reject(new Error('server-client connection closed during handshake'))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        ws.off('open', onOpen)
        ws.off('error', onError)
        ws.off('close', onEarlyClose)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
      ws.once('close', onEarlyClose)
    })
  }

  request<T = unknown>(frame: ClientFrame): Promise<T> {
    if (!this.isConnected || this.ws === null) {
      return Promise.reject(new Error(`server-client not connected (${frame.type})`))
    }
    const rid = `r${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error(`request timeout: ${frame.type}`))
      }, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(rid, {
        resolve: (payload) => {
          clearTimeout(timer)
          resolve(payload as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      try {
        this.ws!.send(JSON.stringify({ ...frame, rid }))
      } catch (err) {
        this.pending.delete(rid)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  send(frame: ClientFrame): boolean {
    if (!this.isConnected || this.ws === null) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  close(): void {
    // 主动关闭：不触发 onClosed（调用方自知）；挂起请求以明确错误 reject
    this.drop('client closed', false)
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  /** open 事件后接管 socket：此后消息/关闭事件归属本客户端 */
  private adopt(ws: WebSocket): void {
    this.ws = ws
    this.isConnected = true
    ws.on('message', (data) => this.handleMessage(data.toString()))
    ws.once('close', () => {
      const wasConnected = this.isConnected
      this.drop('connection lost', false)
      if (wasConnected) this.opts.onClosed('connection lost')
    })
    ws.on('error', () => {
      /* error 后必然 close——统一走 close 路径 */
    })
  }

  /** 断开：清挂起请求 + 摘除监听 + 终止 socket；notify=true 时外送 onClosed */
  private drop(reason: string, notify: boolean): void {
    this.isConnected = false
    for (const [, p] of this.pending) p.reject(new Error(`${reason} (pending request dropped)`))
    this.pending.clear()
    const ws = this.ws
    this.ws = null
    if (ws !== null) {
      try {
        ws.removeAllListeners()
        ws.terminate()
      } catch {
        /* 已死连接 terminate 失败无害 */
      }
    }
    if (notify) this.opts.onClosed(reason)
  }

  private handleMessage(text: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return // 畸形帧静默丢弃（信任边界内防崩；不打日志防噪音）
    }
    if (!isValidServerFrame(raw)) return
    const f = raw as Record<string, unknown>
    switch (f['type']) {
      case 'task.data':
        this.opts.onData(f['taskId'] as string, f['chunk'] as string)
        return
      case 'task.exit':
        this.opts.onExit(f['taskId'] as string, f['exitCode'] as number)
        return
      case 'hook.event':
        this.opts.onHookEvent?.(f['taskId'] as string, f['event'] as string, f['epoch'] as number)
        return
      case 'server.log':
        this.opts.onLog(f['level'] as 'info' | 'warn' | 'error', f['message'] as string)
        return
      case 'conn.closed': {
        // server 主动断开（升级滚动替换等）：等同意外断连，交上层重连状态机
        const reason = typeof f['reason'] === 'string' ? f['reason'] : undefined
        this.drop('server closed connection', false)
        this.opts.onClosed(reason)
        return
      }
      case 'result': {
        const p = this.pending.get(f['inReplyTo'] as string)
        if (p === undefined) return
        this.pending.delete(f['inReplyTo'] as string)
        if (f['ok'] === true) p.resolve(f['payload'])
        else p.reject(new Error(typeof f['error'] === 'string' ? f['error'] : 'request failed'))
        return
      }
      default:
        return // 未知帧类型（协议演进）：忽略
    }
  }
}

/** needInstall 错误（SSH 已通前提下的 cwb-server 不可达；token=S6 UI 契约） */
export function needInstallError(detail: string): Error {
  return new Error(
    `${NEED_SERVER_INSTALL_TOKEN} cwb-server unreachable over SSH tunnel (${detail}) — ` +
      `install/upgrade cwb-server on the VM / 需在 VM 内安装 cwb-server 后重连`
  )
}

/** ServerFrame 形状守卫（畸形返回 false；导出供测试/诊断复用） */
export function isValidServerFrame(v: unknown): v is ServerFrame {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  switch (f['type']) {
    case 'task.data':
      return typeof f['taskId'] === 'string' && typeof f['chunk'] === 'string'
    case 'task.exit':
      return typeof f['taskId'] === 'string' && typeof f['exitCode'] === 'number'
    case 'hook.event':
      return (
        typeof f['taskId'] === 'string' &&
        typeof f['event'] === 'string' &&
        typeof f['epoch'] === 'number' &&
        Number.isInteger(f['epoch'])
      )
    case 'server.log':
      return (
        (f['level'] === 'info' || f['level'] === 'warn' || f['level'] === 'error') &&
        typeof f['message'] === 'string'
      )
    case 'conn.closed':
      return f['reason'] === undefined || typeof f['reason'] === 'string'
    case 'result':
      return typeof f['inReplyTo'] === 'string' && typeof f['ok'] === 'boolean'
    default:
      return false
  }
}
