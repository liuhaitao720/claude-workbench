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

  it('v2.2.0：POST body 完整透传给服务器侧推送（Stop 摘要来源）', async () => {
    const port = (server as unknown as { port: number }).port
    const calls: Array<[string, string, string | undefined]> = []
    const orig = server.notifier.onHookEvent.bind(server.notifier)
    server.notifier.onHookEvent = (taskId, event, body) => {
      calls.push([taskId, event, body])
      return 'ignored'
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/hook/Stop?t=t-body&e=2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ last_assistant_message: 'PONG' })
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
      await new Promise((r) => setTimeout(r, 150))
      expect(calls).toHaveLength(1)
      expect(calls[0]![0]).toBe('t-body')
      expect(calls[0]![1]).toBe('Stop')
      expect(JSON.parse(calls[0]![2] ?? '{}')).toMatchObject({ last_assistant_message: 'PONG' })
    } finally {
      server.notifier.onHookEvent = orig
    }
  })
})

/**
 * v2.2.0 B 链：/hook 延迟响应（手机答复挂起）。
 * 验收：桌面不在场 + 配置开 + 页面就绪 → hook 不立即 200，而由页面提交释放决策
 * JSON；任务结束/手机停止/桌面取消 → 空响应回落 TUI；旧客户端/在场时行为不变。
 */
describe('v2.2.0 /hook 挂起 → 手机提交 → 决策 JSON', () => {
  const SURFACE = 'https://test.trycloudflare.com'
  let home: string
  let server: CwbServer
  let ws: WebSocket
  let frames: ServerFrame[]
  let port: number

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function waitFor(pred: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
    const started = Date.now()
    while (!pred()) {
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
      await sleep(20)
    }
  }

  function hookUrl(event: string, taskId: string): string {
    return `http://127.0.0.1:${port}/hook/${event}?t=${taskId}&e=1`
  }

  function postHook(
    event: string,
    taskId: string,
    body: unknown
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    return fetch(hookUrl(event, taskId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  function resolvedFrames(taskId: string): Array<Extract<ServerFrame, { type: 'answer.resolved' }>> {
    return frames.filter(
      (f): f is Extract<ServerFrame, { type: 'answer.resolved' }> =>
        f.type === 'answer.resolved' && f.taskId === taskId
    )
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'cwb-server-answer-'))
    mkdirSync(join(home, '.cwb'), { recursive: true })
    // 推送不配 url（不触发真实 webhook）；仅打开手机答复
    writeFileSync(
      join(home, '.cwb', 'notify.json'),
      JSON.stringify({ events: {}, answer: { enabled: true, ttlSec: 900, presenceMin: 5 } }),
      'utf8'
    )
    server = new CwbServer({ port: 0, notifyHome: home, log: () => {} })
    ;({ port } = await server.start())
    server.answer.setSurface(SURFACE)
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
    for (const t of server?.registry.list() ?? []) {
      try {
        server.registry.kill(t.taskId)
      } catch {
        /* 已退出 */
      }
    }
    ws?.close()
    await server?.['shutdown']?.().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  })

  it('旧客户端在线（从未发 presence）→ 按在场处理：立即 200 空体，不挂起', async () => {
    const res = await postHook('PermissionRequest', 't-legacy', { tool_name: 'Bash' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(server.answer.count()).toBe(0)
  })

  it('桌面 5 分钟无键入（presence）→ 挂起；页面提交 → 决策 JSON；重复提交幂等', async () => {
    // 上报「很久没动」→ 桌面不在场
    ws.send(JSON.stringify({ type: 'presence', lastInputAt: 1, focused: false }))
    await sleep(150)

    const resP = postHook('PermissionRequest', 't-hold', { tool_name: 'Bash' })
    await waitFor(() => server.answer.count() === 1, 'hook 挂起')
    const pending = server.answer.list().find((p) => p.taskId === 't-hold')!
    expect(pending).toBeDefined()
    expect(pending.kind).toBe('permission')
    const token = server.answer.tokenOf(pending.pendingId)!

    // 延迟响应尚未放行；错误 token 不放行（只看 HTTP 是否已结束）
    expect(
      server.answer.submit('x'.repeat(token.length), pending.pendingId, {
        kind: 'permission',
        action: 'allow'
      })
    ).toBe('unauthorized')
    const early = await Promise.race([
      resP.then(() => 'done' as const),
      sleep(150).then(() => 'pending' as const)
    ])
    expect(early).toBe('pending')

    // answer.pending 帧带公网链接（桌面横幅/推送同源）
    const pendingFrame = frames.find(
      (f): f is Extract<ServerFrame, { type: 'answer.pending' }> => f.type === 'answer.pending'
    )
    expect(pendingFrame?.url).toBe(`${SURFACE}/a/${token}`)

    // 页面提交 allow → claude 收到 PermissionRequest 决策 JSON（A 链）
    expect(
      server.answer.submit(token, pending.pendingId, { kind: 'permission', action: 'allow' })
    ).toBe('ok')
    const res = await resP
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(JSON.parse(await res.text())).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
    })
    await waitFor(() => resolvedFrames('t-hold').length === 1, 'answer.resolved')
    expect(resolvedFrames('t-hold')[0]).toMatchObject({ by: 'phone', action: 'answered' })
    expect(
      server.answer.submit(token, pending.pendingId, { kind: 'permission', action: 'allow' })
    ).toBe('already-resolved')
  })

  it('挂起成功时 awaiting 推送文案带手机链接（1.11）', async () => {
    const calls: Array<{ taskId: string; event: string; url?: string }> = []
    const orig = server.notifier.onHookEvent
    server.notifier.onHookEvent = (taskId, event, _body, url) => {
      calls.push({ taskId, event, ...(url !== undefined ? { url } : {}) })
      return 'ignored'
    }
    try {
      const resP = postHook('PermissionRequest', 't-link', { tool_name: 'Bash' })
      await waitFor(() => server.answer.count() === 1, 't-link 挂起')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toMatch(new RegExp(`^${SURFACE}/a/.+`))
      const p = server.answer.list()[0]!
      server.answer.cancelPending(p.pendingId, 'phone')
      expect(await (await resP).text()).toBe('')
    } finally {
      server.notifier.onHookEvent = orig
    }
  })

  it('桌面在场（最近键入）→ 不挂起；桌面取消帧 → 空响应回落 TUI', async () => {
    // 最近键入 → 在场
    ws.send(JSON.stringify({ type: 'presence', lastInputAt: Date.now(), focused: true }))
    await sleep(150)
    const before = server.answer.count()
    const res = await postHook('PermissionRequest', 't-present', { tool_name: 'Bash' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(server.answer.count()).toBe(before)

    // 回到不在场，挂起后经 answer.cancel 帧释放（桌面「改本机输入」）
    ws.send(JSON.stringify({ type: 'presence', lastInputAt: 1, focused: false }))
    await sleep(150)
    const resP = postHook('PermissionRequest', 't-cancel', { tool_name: 'Bash' })
    await waitFor(() => server.answer.count() === 1, 't-cancel 挂起')
    ws.send(JSON.stringify({ type: 'answer.cancel', taskId: 't-cancel' }))
    expect(await (await resP).text()).toBe('')
    await waitFor(() => resolvedFrames('t-cancel').length === 1, 'desktop resolved')
    expect(resolvedFrames('t-cancel')[0]).toMatchObject({ by: 'desktop', action: 'cancelled' })
  })

  it('手机请求停止（killTask phone）→ 该任务挂起空响应 + 任务退出', async () => {
    await server.registry.spawn({
      taskId: 't-kill',
      argv: ['/bin/sh', '-c', 'sleep 30'],
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      name: '待停止任务'
    })
    const resP = postHook('PermissionRequest', 't-kill', { tool_name: 'Bash' })
    await waitFor(
      () => server.answer.list().some((p) => p.taskId === 't-kill'),
      't-kill 挂起'
    )
    server.killTask('t-kill', 'phone')
    expect(await (await resP).text()).toBe('')
    expect(server.answer.list().some((p) => p.taskId === 't-kill')).toBe(false)
    await waitFor(() => resolvedFrames('t-kill').length === 1, 'phone stop resolved')
    expect(resolvedFrames('t-kill')[0]).toMatchObject({ by: 'phone', action: 'cancelled' })
  })
})
