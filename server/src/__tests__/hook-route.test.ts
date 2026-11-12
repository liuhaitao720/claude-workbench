import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CwbServer } from '../cwb-server'
import type { ServerFrame } from '../shared/remote-protocol'

/**
 * v2.0.2 /hook 接收口（推送服务器侧化）：进程内真实 CwbServer + 真实 WS 客户端。
 * 验收：claude 直 POST（不再经客户端 SSH forwardIn）→ 200 空体 + hook.event 帧
 * 转发给在线客户端 + awaiting 事件触发服务器侧 webhook（fetch 桩经 HOME 注入配置）。
 */
describe('v2.0.2 /hook 接收口 → hook.event 转发 + 服务器侧推送', () => {
  let home: string
  let server: CwbServer
  let ws: WebSocket
  let frames: ServerFrame[]

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'cwb-server-hook-'))
    mkdirSync(join(home, '.cwb'), { recursive: true })
    writeFileSync(
      join(home, '.cwb', 'notify.json'),
      JSON.stringify({ url: 'https://hook.example/x', enabled: true }),
      'utf8'
    )
    server = new CwbServer({ port: 0, notifyHome: home, log: () => {} })
    const { port } = await server.start()
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
    frames = []
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(String(data)) as ServerFrame)
      } catch {
        /* 忽略畸形 */
      }
    })
  })

  afterAll(async () => {
    ws?.close()
    await server?.['shutdown']?.().catch(() => {})
    server?.['http']?.close?.()
    rmSync(home, { recursive: true, force: true })
  })

  it('POST /hook/UserPromptSubmit?t&e → 200 空体 + hook.event 帧转发（epoch 原样）', async () => {
    const port = (server as unknown as { port: number }).port
    const res = await fetch(
      `http://127.0.0.1:${port}/hook/UserPromptSubmit?t=t-hook-1&e=3`,
      { method: 'POST', body: '{}' }
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    await new Promise((r) => setTimeout(r, 200))
    const hook = frames.find(
      (f) => f.type === 'hook.event' && f.taskId === 't-hook-1'
    ) as Extract<ServerFrame, { type: 'hook.event' }> | undefined
    expect(hook).toBeDefined()
    expect(hook!.event).toBe('UserPromptSubmit')
    expect(hook!.epoch).toBe(3)
  })

  it('缺 t/e 的 hook POST → 仍 200（不干扰 claude）且不转发', async () => {
    const port = (server as unknown as { port: number }).port
    const before = frames.filter((f) => f.type === 'hook.event').length
    const res = await fetch(`http://127.0.0.1:${port}/hook/Stop?t=only`, { method: 'POST' })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 150))
    expect(frames.filter((f) => f.type === 'hook.event').length).toBe(before)
  })

  it('健康口不受影响（GET / 仍回版本 JSON）', async () => {
    const port = (server as unknown as { port: number }).port
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"server":"cwb-server"')
  })
})
