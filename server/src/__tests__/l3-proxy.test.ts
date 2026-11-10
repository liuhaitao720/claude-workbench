import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server as HttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { bootServer, connect, request, type ServerProc } from './l3-harness'

/**
 * L3 远程代理（6.4=c）：真实 server 子进程经协议帧起代理 → curl 经代理访问
 * 本机 HTTP 测试端点 200；proxy.config.set→get 回环（A5 协议半边）；stop 后
 * 拒绝服务；状态统计（请求/活跃/直连/分流）随 status 返回；配置落盘 VM 侧。
 * 经上游链式路由与 CONNECT 隧道语义在 proxy-core.test（L2，假上游）覆盖。
 */

const execFileAsync = promisify(execFile)

let server: ServerProc | undefined
let endpoint: HttpServer
let endpointPort = 0
let endpointHits = 0
let proxyPort = 0

beforeAll(async () => {
  server = await bootServer()
  endpoint = createServer((req, res) => {
    endpointHits += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`pong:${req.url}`)
  })
  endpointPort = await new Promise<number>((resolve) => {
    endpoint.listen(0, '127.0.0.1', () => resolve((endpoint.address() as { port: number }).port))
  })
}, 30_000)

afterAll(async () => {
  if (endpoint !== undefined) await new Promise<void>((r) => endpoint.close(() => r()))
  await server?.stop()
})

interface StatusPayload {
  running: boolean
  port?: number
  startedAt?: string
  stats: { total: number; active: number; direct: number; viaProxy: number }
  config?: { proxyUrl?: string }
}

describe('L3 proxy.*（真实 server + curl 经代理）', () => {
  it('proxy.status 初始 stopped（含零统计与空配置）', async () => {
    const ws = await connect(server!.port)
    try {
      const res = await request(ws, { type: 'proxy.status', rid: 'ps-0' })
      expect(res.ok).toBe(true)
      const st = res.payload as StatusPayload
      expect(st.running).toBe(false)
      expect(st.stats).toEqual({ total: 0, active: 0, direct: 0, viaProxy: 0 })
      expect(st.config).toEqual({})
    } finally {
      ws.close()
    }
  })

  it('proxy.start→curl 经代理访问本机 HTTP 端点 200→统计（请求/直连）', async () => {
    const ws = await connect(server!.port)
    try {
      const started = await request(ws, { type: 'proxy.start', rid: 'ps-1' })
      expect(started.ok).toBe(true)
      const st = started.payload as StatusPayload
      expect(st.running).toBe(true)
      expect(st.port).toBeGreaterThan(0)
      expect(st.startedAt).toBeDefined()
      proxyPort = st.port!

      // 真实 curl 经代理（绝对 URI 明文转发路径——标准 forward proxy GET）。
      // 剥离 no_proxy/NO_PROXY：本环境 no_proxy 含 127.0.0.1 会让 curl 绕过代理
      // 直连目标（响应巧合同形、代理统计恒 0——曾致假绿/假红，见测试注释）。
      const { stdout } = await execFileAsync(
        'curl',
        ['-sS', '--max-time', '5', '-x', `http://127.0.0.1:${proxyPort}`, `http://127.0.0.1:${endpointPort}/ping?x=1`],
        { timeout: 8000, env: { ...process.env, no_proxy: '', NO_PROXY: '' } }
      )
      expect(stdout).toBe('pong:/ping?x=1')
      expect(endpointHits).toBe(1)

      const status = await request(ws, { type: 'proxy.status', rid: 'ps-2' })
      const st2 = status.payload as StatusPayload
      expect(st2.stats.total).toBeGreaterThanOrEqual(1)
      expect(st2.stats.direct).toBeGreaterThanOrEqual(1)
      expect(st2.stats.active).toBeLessThan(st2.stats.total) // 已完成、连接排空
    } finally {
      ws.close()
    }
  })

  it('proxy.config.set→get 回环一致（A5 协议半边）；状态透出当前配置', async () => {
    const ws = await connect(server!.port)
    try {
      const set = await request(ws, {
        type: 'proxy.config.set',
        rid: 'pc-1',
        patch: { proxyUrl: 'http://127.0.0.1:7897' }
      })
      expect(set.ok).toBe(true)
      expect(set.payload).toEqual({ proxyUrl: 'http://127.0.0.1:7897' })
      const got = await request(ws, { type: 'proxy.config.get', rid: 'pc-2' })
      expect(got.ok).toBe(true)
      expect(got.payload).toEqual({ proxyUrl: 'http://127.0.0.1:7897' })
      const st = await request(ws, { type: 'proxy.status', rid: 'pc-3' })
      expect((st.payload as StatusPayload).config).toEqual({ proxyUrl: 'http://127.0.0.1:7897' })
      // 清回直连（后续用例不被上游劫持）。线上清键语义：JSON 序列化丢弃
      // undefined，故 wire 形态用 ''（server 端 sanitize 空串=清除）
      const cleared = await request(ws, {
        type: 'proxy.config.set',
        rid: 'pc-4',
        patch: { proxyUrl: '' }
      })
      expect(cleared.payload).toEqual({})
    } finally {
      ws.close()
    }
  })

  it('proxy.stop→running false→原端口 curl 连接被拒', async () => {
    const ws = await connect(server!.port)
    try {
      const stopped = await request(ws, { type: 'proxy.stop', rid: 'px-1' })
      expect(stopped.ok).toBe(true)
      const st = stopped.payload as StatusPayload
      expect(st.running).toBe(false)
      expect(st.port).toBeUndefined()
      await expect(
        execFileAsync('curl', ['-sS', '--max-time', '3', `http://127.0.0.1:${proxyPort}/`], {
          timeout: 5000
        })
      ).rejects.toThrow()
    } finally {
      ws.close()
    }
  })

  it('配置持久化在 VM 侧（config.json 落盘——CWB_SERVER_HOME 注入的临时目录）', async () => {
    const ws = await connect(server!.port)
    try {
      await request(ws, {
        type: 'proxy.config.set',
        rid: 'pp-1',
        patch: { proxyUrl: 'http://persist.example:7890' }
      })
      const raw = JSON.parse(
        await readFile(join(server!.workDir, 'cwb-home', 'config.json'), 'utf8')
      ) as { proxyUrl?: string }
      expect(raw.proxyUrl).toBe('http://persist.example:7890')
      // 清回（不污染同 server 的其他用例；wire 清键=''）
      await request(ws, { type: 'proxy.config.set', rid: 'pp-2', patch: { proxyUrl: '' } })
    } finally {
      ws.close()
    }
  })
})
