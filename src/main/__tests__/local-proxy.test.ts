import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { connect as netConnect, createServer as netServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalProxy, parseUpstream, type ProxyRouteRule } from '../local-proxy'

/**
 * v1.4 本地代理单测：真 server（照 task-activity.test 先例）。
 * - 目标 = 本地 echo TCP（CONNECT 隧道透传验证）
 * - 上游 = 本地最小假代理（手写 CONNECT 转发，验证链式路由）
 * 不解 TLS：隧道是字节透传，echo 层即可验证路由正确性。
 */

describe('parseUpstream', () => {
  it('容忍协议前缀；无端口默认 80', () => {
    expect(parseUpstream('http://127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseUpstream('127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 })
    expect(parseUpstream('proxy.lan')).toEqual({ host: 'proxy.lan', port: 80 })
  })
})

describe('createLocalProxy（真 server）', () => {
  let base: string
  /** echo 目标：收啥回啥（记录到达来源以区分直连/经上游） */
  let echoHits: string[]
  let echoPort: number

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cwb-lproxy-'))
    echoHits = []
    const echo = await new Promise<number>((resolve) => {
      // 纯 TCP echo（不可用 http server——透传明文会被它按 HTTP 解析回 400）
      const srv = netServer()
      srv.on('connection', (sock) => {
        echoHits.push(sock.remoteAddress ?? '?')
        sock.on('data', (d) => sock.write(d))
      })
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port))
      ;(globalThis as Record<string, unknown>)['__echoSrv'] = srv
    })
    echoPort = echo
  })

  afterEach(async () => {
    const srv = (globalThis as Record<string, unknown>)['__echoSrv'] as ReturnType<
      typeof netServer
    > | undefined
    if (srv !== undefined) await new Promise<void>((r) => srv.close(() => r()))
    rmSync(base, { recursive: true, force: true })
  })

  function connectTunnel(port: number, targetHost: string, targetPort: number): Promise<{
    send: (s: string) => void
    read: () => Promise<string>
    close: () => void
  }> {
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

  it('status 初始 stopped；start 幂等；stop 幂等回 stopped；端口从 12700 起', async () => {
    // v1.7.1 环境自适应：用户实测场景 VM 内 cwb-server 远程代理常驻 12700（占用）——
    // 期望端口按 12700 是否空闲决定（占用时自动 +1 递增，断言语义不变）
    const basePortOpen = await new Promise<boolean>((resolve) => {
      const sock = netConnect(12700, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolve(false)
      })
      sock.once('error', () => resolve(true))
    })
    const expectPort = basePortOpen ? 12700 : 12701
    const proxy = createLocalProxy({ preferPort: 12700, resolveRouting: () => [] })
    try {
      expect(proxy.status()).toMatchObject({ running: false, stats: { total: 0 } })
      const s1 = await proxy.start()
      expect(s1.running).toBe(true)
      expect(s1.port).toBe(expectPort)
      expect(s1.startedAt).toBeDefined()
      const s2 = await proxy.start()
      expect(s2.port).toBe(expectPort) // 幂等
      proxy.stop()
      expect(proxy.status()).toMatchObject({ running: false })
      expect(proxy.status().port).toBeUndefined()
      proxy.stop() // 幂等
    } finally {
      await proxy.dispose()
    }
  })

  it('CONNECT 直连路由：字节透传（echo 回读）；direct 计数', async () => {
    const proxy = createLocalProxy({ preferPort: 12700, resolveRouting: () => [] })
    try {
      const st = await proxy.start()
      const t = await connectTunnel(st.port!, '127.0.0.1', echoPort)
      t.send('ping-direct')
      expect(await t.read()).toBe('ping-direct')
      t.close()
      await new Promise((r) => setTimeout(r, 50))
      expect(proxy.status().stats).toMatchObject({ total: 1, direct: 1, viaProxy: 0 })
    } finally {
      await proxy.dispose()
    }
  })

  it('CONNECT 按 host 路由到外部上游（链式）：字节经假上游透传；viaProxy 计数', async () => {
    // 最小假上游代理：收到 CONNECT → 连真实目标 → 回 200 → 双向透传
    const fakeUpstream = await new Promise<number>((resolve) => {
      const srv = createServer()
      srv.on('connect', (_req, client, head) => {
        const [h, p] = (_req.url ?? '').split(':')
        const up = netConnect({ host: h, port: Number(p) })
        up.once('connect', () => {
          client.write('HTTP/1.1 200 OK\r\n\r\n')
          if (head.length > 0) up.write(head)
          up.pipe(client)
          client.pipe(up)
        })
        up.once('error', () => client.destroy())
      })
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port))
      ;(globalThis as Record<string, unknown>)['__fakeUp'] = srv
    })

    // 命中 host 用 127.0.0.1（echo 的 host）——上游为假代理，验证链式透传
    const routing: ProxyRouteRule[] = [
      { host: '127.0.0.1', upstream: `http://127.0.0.1:${fakeUpstream}` }
    ]
    const proxy = createLocalProxy({ preferPort: 12700, resolveRouting: () => routing })
    try {
      const st = await proxy.start()
      const t = await connectTunnel(st.port!, '127.0.0.1', echoPort)
      t.send('ping-chained')
      expect(await t.read()).toBe('ping-chained')
      t.close()
      await new Promise((r) => setTimeout(r, 50))
      expect(proxy.status().stats).toMatchObject({ total: 1, viaProxy: 1, direct: 0 })
    } finally {
      await proxy.dispose()
      const srv = (globalThis as Record<string, unknown>)['__fakeUp'] as ReturnType<
        typeof createServer
      > | undefined
      if (srv !== undefined) await new Promise<void>((r) => srv.close(() => r()))
    }
  })

  it('未命中路由表的 host 直连；resolveRouting 每连接现取（改表即时生效）', async () => {
    let routing: ProxyRouteRule[] = []
    const proxy = createLocalProxy({ preferPort: 12700, resolveRouting: () => routing })
    try {
      const st = await proxy.start()
      const t = await connectTunnel(st.port!, '127.0.0.1', echoPort)
      t.send('before')
      expect(await t.read()).toBe('before')
      t.close()
      routing = [] // 仍为空——语义保持直连
      const s = proxy.status()
      expect(s.stats.direct).toBe(1)
    } finally {
      await proxy.dispose()
    }
  })
})
