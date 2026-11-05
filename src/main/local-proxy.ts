import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { LocalProxyStats, LocalProxyStatus } from '../shared/types'

export type { LocalProxyStats, LocalProxyStatus } from '../shared/types'

/**
 * v1.4 本地代理（纯隧道，不做协议翻译——协议兼容仍由 claude CLI 与网关承担，
 * 与 cc-switch「本地路由」的区别：只按目标 host 决定 直连/链式走外部代理）。
 *
 * 形态：127.0.0.1 隧道代理。任务 spawn 的 HTTP_PROXY 统一指向本代理；
 * 代理按 CONNECT 目标 host 匹配 provider 端点域名 → 走该 provider 配置的
 * 外部代理（如 Clash）或直连。TLS 不解密（CONNECT 隧道透传，无 MITM）。
 *
 * 可测性：路由表注入（resolveRouting 回调——生产接 ProviderStore，每连接
 * 现取，provider 改代理配置即时生效）；server/stat 全内存，dispose 供测试。
 */

/** 单条路由规则：目标 host → 上游代理（undefined = 直连） */
export interface ProxyRouteRule {
  host: string
  upstream?: string
}

export interface LocalProxyHandle {
  status(): LocalProxyStatus
  /** 启动（已运行=幂等返回）；端口占用自动递增重试（preferPort..+19），全占才报错 */
  start(): Promise<LocalProxyStatus>
  /** 停止（未运行=幂等）；活跃连接自然排空（不硬断——claude 会话长连接） */
  stop(): LocalProxyStatus
  /** 测试用：关 server 等句柄 */
  dispose(): Promise<void>
}

const DEFAULT_PORT = 12_700
const PORT_RETRY = 20

/** upstream "http://host:port" → {host, port}（协议前缀容忍） */
export function parseUpstream(upstream: string): { host: string; port: number } {
  const u = upstream.replace(/^https?:\/\//, '')
  const idx = u.lastIndexOf(':')
  if (idx < 0) return { host: u, port: 80 }
  return { host: u.slice(0, idx), port: Number(u.slice(idx + 1)) || 80 }
}

export function createLocalProxy(
  opts: { preferPort?: number; resolveRouting: () => ProxyRouteRule[] } = { resolveRouting: () => [] }
): LocalProxyHandle {
  const preferPort = opts.preferPort ?? DEFAULT_PORT
  let server: Server | null = null
  let port: number | undefined
  let startedAt: string | undefined
  const stats: LocalProxyStats = { total: 0, active: 0, direct: 0, viaProxy: 0 }

  /** 目标 host → 上游（每连接现取路由表，配置即时生效） */
  const upstreamFor = (host: string): string | undefined =>
    opts.resolveRouting().find((r) => r.host === host)?.upstream

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

    // 绝对 URI 明文转发（http:// 目标——claude 实际不走，保完整代理语义）
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

  return {
    status(): LocalProxyStatus {
      return {
        running: server !== null,
        ...(port !== undefined ? { port } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        stats: { ...stats }
      }
    },

    async start(): Promise<LocalProxyStatus> {
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

    stop(): LocalProxyStatus {
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
