import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, get as httpGet, request as httpRequest } from 'node:http'
import { connect as netConnect, createServer as netServer, type Server } from 'node:net'
import { createRemoteProxy, parseUpstream } from '../proxy-core'

/**
 * L2/L3 代理核心（local-proxy 隧道语义移植的回归——照 src/main local-proxy.test
 * 先例：真 server、echo TCP 目标、本地假上游。配置驱动路由=6.4=c 的远程形态）。
 */

describe('parseUpstream', () => {
  it('容忍协议前缀；无端口默认 80', () => {
    expect(parseUpstream('http://127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseUpstream('127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseUpstream('proxy.lan')).toEqual({ host: 'proxy.lan', port: 80 })
  })
})

describe('createRemoteProxy（真 server）', () => {
  let echoSrv: Server
  let echoPort: number
  let echoHits: string[]
  let fakeUp: Server | null
  let config: { proxyUrl?: string }

  beforeEach(async () => {
    echoHits = []
    fakeUp = null
    config = {}
    echoSrv = netServer()
    echoSrv.on('connection', (sock) => {
      echoHits.push(sock.remoteAddress ?? '?')
      sock.on('data', (d) => sock.write(d))
    })
    echoPort = await new Promise<number>((resolve) => {
      echoSrv.listen(0, '127.0.0.1', () => resolve((echoSrv.address() as { port: number }).port))
    })
  })
  afterEach(async () => {
    await new Promise<void>((r) => echoSrv.close(() => r()))
    if (fakeUp !== null) await new Promise<void>((r) => fakeUp!.close(() => r()))
  })

  function connectTunnel(
    port: number,
    targetHost: string,
    targetPort: number
  ): Promise<{ send: (s: string) => void; read: () => Promise<string>; close: () => void }> {
    return new Promise((resolve, reject) => {
      const sock = netConnect({ host: '127.0.0.1', port })
      let buf = ''
      let ready = false
      const waiters: Array<(s: string) => void> = []
      sock.on('data', (d) => {
        const text = d.toString()
        if (!ready) {
          if (text.includes('200')) {
            ready = true
            resolve({
              send: (s) => sock.write(s),
              read: () =>
                new Promise((res) => {
                  if (buf !== '') {
                    const out = buf
                    buf = ''
                    res(out)
                    return
                  }
                  waiters.push(res)
                }),
              close: () => sock.destroy()
            })
          } else if (text.includes('502')) {
            reject(new Error('tunnel refused'))
          }
          return
        }
        buf += text
        const w = waiters.shift()
        w?.(buf)
        buf = ''
      })
      sock.once('error', reject)
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
  }

  it('status 初始 stopped；start 幂等；stop 幂等；含当前配置（6.4=c）', async () => {
    const proxy = createRemoteProxy({ preferPort: 12871, resolveConfig: () => config })
    try {
      expect(proxy.status()).toMatchObject({ running: false, stats: { total: 0 }, config: {} })
      const s1 = await proxy.start()
      expect(s1.running).toBe(true)
      expect(s1.port).toBe(12871)
      expect(s1.config).toEqual({})
      const s2 = await proxy.start()
      expect(s2.port).toBe(12871) // 幂等
      config = { proxyUrl: 'http://127.0.0.1:7899' }
      expect(proxy.status().config).toEqual({ proxyUrl: 'http://127.0.0.1:7899' }) // 每连接现取
      proxy.stop()
      expect(proxy.status()).toMatchObject({ running: false })
      expect(proxy.status().port).toBeUndefined()
      proxy.stop() // 幂等
    } finally {
      await proxy.dispose()
    }
  })

  it('端口占用自动 +1 重试（12700 在部分环境被占——env 无关断言用独立口）', async () => {
    const blocker = netServer()
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port))
    })
    const proxy = createRemoteProxy({ preferPort: blockerPort, resolveConfig: () => config })
    try {
      const st = await proxy.start()
      // 被占口跳过、绑定首个空闲口（并发环境 blocker+1 可能被他人抢走——区间断言）
      expect(st.port!).toBeGreaterThan(blockerPort)
      expect(st.port!).toBeLessThan(blockerPort + 20)
    } finally {
      await proxy.dispose()
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })

  it('CONNECT 直连（未配 proxyUrl）：字节透传 echo；direct 计数', async () => {
    const proxy = createRemoteProxy({ preferPort: 12872, resolveConfig: () => config })
    try {
      const st = await proxy.start()
      const t = await connectTunnel(st.port!, '127.0.0.1', echoPort)
      t.send('ping-direct')
      expect(await t.read()).toBe('ping-direct')
      t.close()
      await new Promise((r) => setTimeout(r, 50))
      expect(proxy.status().stats).toMatchObject({ total: 1, active: 0, direct: 1, viaProxy: 0 })
    } finally {
      await proxy.dispose()
    }
  })

  it('CONNECT 经上游（配 proxyUrl）：链式透传；viaProxy 计数；改配置即时生效', async () => {
    fakeUp = createServer()
    fakeUp.on('connect', (req, client, head) => {
      const [h, p] = (req.url ?? '').split(':')
      const up = netConnect({ host: h, port: Number(p) })
      up.once('connect', () => {
        client.write('HTTP/1.1 200 OK\r\n\r\n')
        if (head.length > 0) up.write(head)
        up.pipe(client)
        client.pipe(up)
      })
      up.once('error', () => client.destroy())
    })
    const upPort = await new Promise<number>((resolve) => {
      fakeUp!.listen(0, '127.0.0.1', () => resolve((fakeUp!.address() as { port: number }).port))
    })
    const proxy = createRemoteProxy({ preferPort: 12873, resolveConfig: () => config })
    try {
      // 先直连验证，再开上游验证即时切换（每连接现取配置）
      const st0 = await proxy.start()
      const t0 = await connectTunnel(st0.port!, '127.0.0.1', echoPort)
      t0.send('before')
      expect(await t0.read()).toBe('before')
      t0.close()

      config = { proxyUrl: `http://127.0.0.1:${upPort}` }
      const st = proxy.status()
      const t = await connectTunnel(st.port!, '127.0.0.1', echoPort)
      t.send('ping-chained')
      expect(await t.read()).toBe('ping-chained') // 经假上游仍到 echo
      t.close()
      await new Promise((r) => setTimeout(r, 50))
      expect(proxy.status().stats).toMatchObject({ total: 2, direct: 1, viaProxy: 1 })
    } finally {
      await proxy.dispose()
    }
  })

  it('绝对 URI 明文转发（http 目标）：200 回读；direct 计数', async () => {
    const target = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`pong:${req.url}`)
    })
    const targetPort = await new Promise<number>((resolve) => {
      target.listen(0, '127.0.0.1', () => resolve((target.address() as { port: number }).port))
    })
    const proxy = createRemoteProxy({ preferPort: 12874, resolveConfig: () => config })
    try {
      const st = await proxy.start()
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: st.port,
            method: 'GET',
            // 标准 forward proxy 语义：绝对 URI
            path: `http://127.0.0.1:${targetPort}/ping?x=1`
          },
          (res) => {
            let out = ''
            res.on('data', (d) => (out += d.toString()))
            res.on('end', () => resolve(out))
          }
        )
        req.once('error', reject)
        req.end()
      })
      expect(body).toBe('pong:/ping?x=1')
      expect(proxy.status().stats).toMatchObject({ total: 1, direct: 1 })
    } finally {
      await proxy.dispose()
      await new Promise<void>((r) => target.close(() => r()))
    }
  })

  it('CONNECT 目标不可达→502（上游握手失败同路径）', async () => {
    const proxy = createRemoteProxy({ preferPort: 12875, resolveConfig: () => config })
    try {
      const st = await proxy.start()
      // 找一个必然拒绝的端口：先占后关，内核通常仍 RST（TIME_WAIT 边界不可靠——
      // 用未监听高位口，连接被拒概率极高；断言 502 或连接被销毁二选一）
      await expect(
        connectTunnel(st.port!, '127.0.0.1', 1)
      ).rejects.toThrow()
    } finally {
      await proxy.dispose()
    }
  })

  it('http.get 便捷面可用（探活场景）', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const targetPort = await new Promise<number>((resolve) => {
      target.listen(0, '127.0.0.1', () => resolve((target.address() as { port: number }).port))
    })
    const proxy = createRemoteProxy({ preferPort: 12876, resolveConfig: () => config })
    try {
      const st = await proxy.start()
      const code = await new Promise<number>((resolve, reject) => {
        httpGet(
          { host: '127.0.0.1', port: st.port, path: `http://127.0.0.1:${targetPort}/` },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        ).once('error', reject)
      })
      expect(code).toBe(200)
    } finally {
      await proxy.dispose()
      await new Promise<void>((r) => target.close(() => r()))
    }
  })
})
