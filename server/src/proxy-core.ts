/**
 * 远程代理核心（S3，6.4=c）：local-proxy.ts 隧道核心移植（语义忠实——直连/上游
 * HTTP 代理路由、CONNECT 隧道透传、绝对 URI 明文转发、统计口径全同源），差异仅：
 *
 * 1. 路由来源=RemoteProxyConfig（VM 侧配置）：proxyUrl 设置→全部 host 经上游；
 *    空/缺省→全部直连（v1.4 路由表按 host 精确匹配，远程配置只有全局开关，
 *    host 维度路由语义保留在 upstreamFor 的接缝上）。
 * 2. 每连接现取配置（config.set 即时生效，不重启）。
 * 3. 生命周期由 server 协议帧驱动（proxy.start/stop/status）。
 *
 * TLS 不解密（CONNECT 隧道字节透传，无 MITM）。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { LocalProxyStats, RemoteProxyStatus } from './shared/types'

export type { LocalProxyStats } from './shared/types'

/** upstream "http://host:port" → {host, port}（协议前缀容忍；照 local-proxy） */
export function parseUpstream(upstream: string): { host: string; port: number } {
  const u = upstream.replace(/^https?:\/\//, '')
  const idx = u.lastIndexOf(':')
  if (idx < 0) return { host: u, port: 80 }
  return { host: u.slice(0, idx), port: Number(u.slice(idx + 1)) || 80 }
}

export interface RemoteProxyHandle {
  status(): RemoteProxyStatus
  /** 启动（已运行=幂等返回）；端口占用自动递增重试（preferPort..+19），全占才报错 */
  start(): Promise<RemoteProxyStatus>
  /** 停止（未运行=幂等）；活跃连接自然排空（不硬断——claude 会话长连接） */
  stop(): RemoteProxyStatus
  /** 测试用：关 server 等句柄 */
  dispose(): Promise<void>
}

const DEFAULT_PORT = 12_700
const PORT_RETRY = 20

export function createRemoteProxy(
  opts: {
    preferPort?: number
    /** 每连接现取当前生效配置（proxyUrl 空/缺省=直连） */
    resolveConfig: () => { proxyUrl?: string }
  } = { resolveConfig: () => ({}) }
): RemoteProxyHandle {
  const preferPort = opts.preferPort ?? DEFAULT_PORT
  let server: Server | null = null
  let port: number | undefined
  let startedAt: string | undefined
  const stats: LocalProxyStats = { total: 0, active: 0, direct: 0, viaProxy: 0 }

  /** 目标 host → 上游（6.4=c：全局配置语义——设置即全走上游，未设置=直连） */
  const upstreamFor = (_host: string): string | undefined => {
    const url = opts.resolveConfig().proxyUrl
    return typeof url === 'string' && url.length > 0 ? url : undefined
  }

  const attach = (s: Server): void => {
    // CONNECT host:port（HTTPS 隧道——claude API 全走这条路）
    s.on('connect', (req, clientSocket: Socket, head: Buffer) => {
      const target = req.url ?? ''
      const host = target.split(':')[0] ?? ''
      const upstream = upstreamFor(host)
      stats.total += 1
      stats.active += 1
      if (upstream === undefined) stats.direct += 1
      else stats.viaProxy += 1
      const onGone = (): void => {
        stats.active = Math.max(0, stats.active - 1)
      }
      clientSocket.once('close', onGone)

      const established = (upstreamSocket: Socket): void => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstreamSocket.write(head)
        upstreamSocket.pipe(clientSocket)
        clientSocket.pipe(upstreamSocket)
        upstreamSocket.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => upstreamSocket.destroy())
      }
      const refused = (): void => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        clientSocket.destroy()
      }

      if (upstream === undefined) {
        // 直连目标
        const [h, p] = target.split(':')
        const direct = netConnect({ host: h, port: Number(p) || 443 })
        direct.once('connect', () => established(direct))
        direct.once('error', refused)
        return
      }
      // 经上游代理：向其发 CONNECT，等 2xx 再接管
      const up = parseUpstream(upstream)
      const upSocket = netConnect({ host: up.host, port: up.port })
      upSocket.once('connect', () => {
        upSocket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      })
      let handshake = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        handshake = Buffer.concat([handshake, chunk])
        const idx = handshake.indexOf('\r\n\r\n')
        if (idx < 0) {
          if (handshake.length > 8192) upSocket.destroy()
          return
        }
        upSocket.off('data', onData)
        const statusLine = handshake.subarray(0, handshake.indexOf('\r\n')).toString()
        if (/\s2\d\d/.test(statusLine)) {
          const rest = handshake.subarray(idx + 4)
          established(upSocket)
          if (rest.length > 0) clientSocket.write(rest)
        } else {
          refused()
        }
      }
      upSocket.on('data', onData)
      upSocket.once('error', refused)
    })

    // 绝对 URI 明文转发（http:// 目标——保完整代理语义）
    s.on('request', (req, res) => {
      let url: URL
      try {
        url = new URL(req.url ?? '')
      } catch {
        res.writeHead(400).end()
        return
      }
      stats.total += 1
      stats.active += 1
      if (upstreamFor(url.hostname) === undefined) stats.direct += 1
      else stats.viaProxy += 1
      res.once('close', () => {
        stats.active = Math.max(0, stats.active - 1)
      })
      const upstream = upstreamFor(url.hostname)
      const up = upstream !== undefined ? parseUpstream(upstream) : { host: url.hostname, port: Number(url.port) || 80 }
      const proxied = httpRequest(
        {
          method: req.method,
          headers: req.headers,
          host: up.host,
          port: up.port,
          // 明文直连目标：path 形态；经上游代理：绝对 URI 形态（标准 forward proxy 语义）
          path: upstream !== undefined ? (req.url ?? '/') : `${url.pathname}${url.search}`
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          upRes.pipe(res)
        }
      )
      proxied.on('error', () => res.destroy())
      req.pipe(proxied)
    })
  }

  const listen = (srv: Server, portTry: number): Promise<number> =>
    new Promise((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(portTry, '127.0.0.1', () => {
        const addr = srv.address() as AddressInfo
        resolve(addr.port)
      })
    })

  const snapshot = (): RemoteProxyStatus => ({
    running: server !== null,
    ...(port !== undefined ? { port } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    stats: { ...stats }
  })

  return {
    status(): RemoteProxyStatus {
      return { ...snapshot(), config: opts.resolveConfig() }
    },

    async start(): Promise<RemoteProxyStatus> {
      if (server !== null) return this.status()
      const srv = createServer()
      attach(srv)
      for (let tryPort = preferPort; tryPort < preferPort + PORT_RETRY; tryPort += 1) {
        try {
          port = await listen(srv, tryPort)
          server = srv
          startedAt = new Date().toISOString()
          return this.status()
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'EADDRINUSE' || tryPort === preferPort + PORT_RETRY - 1) {
            srv.close()
            throw err
          }
        }
      }
      throw new Error('no available port')
    },

    stop(): RemoteProxyStatus {
      if (server !== null) {
        server.close() // 不硬断活跃连接：排空后句柄释放
        server = null
        port = undefined
        startedAt = undefined
      }
      return this.status()
    },

    async dispose(): Promise<void> {
      if (server !== null) {
        const s = server
        server = null
        port = undefined
        startedAt = undefined
        await new Promise<void>((resolve) => s.close(() => resolve()))
      }
    }
  }
}
