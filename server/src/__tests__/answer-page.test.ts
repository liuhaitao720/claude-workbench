import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnswerPage } from '../answer-page'
import { AnswerService, type AnswerHoldRequest } from '../answer-store'
import type { ServerFrame } from '../shared/remote-protocol'

/**
 * v2.2.0 T4 手机应答页：进程内真实 http server + 真实 fetch。
 * 验收：token 鉴权（会话级，D6 平铺）、提交/取消/停止路由、安全响应头、
 * 过期状态；页面不泄漏 token。
 */
describe('v2.2.0 应答页 HTTP 接口', () => {
  let svc: AnswerService
  let page: AnswerPage
  let base: string
  let frames: ServerFrame[]
  let clock: number
  const stops: string[] = []
  const replies: Array<Record<string, unknown> | null> = []
  let taskSeq = 0

  const SURFACE = 'https://test.trycloudflare.com'

  function hold(over: Partial<AnswerHoldRequest> = {}): AnswerHoldRequest {
    taskSeq += 1
    return {
      taskId: `t${taskSeq}`,
      event: 'PermissionRequest',
      bodyText: JSON.stringify({ tool_name: 'Bash' }),
      taskName: '页面任务',
      projectName: '项目一',
      reply: (d) => replies.push(d),
      ...over
    }
  }

  beforeAll(async () => {
    clock = 1_700_000_000_000
    frames = []
    svc = new AnswerService({
      config: () => ({ enabled: true, ttlSec: 60 }),
      surface: () => undefined,
      broadcast: (f) => frames.push(f),
      log: () => {},
      now: () => clock
    })
    svc.setSurface(SURFACE)
    page = new AnswerPage({
      answer: svc,
      port: 0,
      onStop: (taskId) => {
        stops.push(taskId)
        return taskId !== 'unknown'
      }
    })
    const port = await page.start()
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await page.stop()
  })

  async function post(path: string, body: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }

  async function state(t: string): Promise<{ status: number; data: any }> {
    const res = await fetch(`${base}/api/state?token=${encodeURIComponent(t)}`)
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }

  it('GET /a/<token>：单页 HTML + no-store/DENY/CSP 安全头（无外部资源）', async () => {
    const res = await fetch(`${base}/a/${'a'.repeat(40)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'unsafe-inline'")
    const html = await res.text()
    expect(html).toContain('手机答复')
    expect(html).toContain('/api/state')
    expect(html).not.toContain('https://')
  })

  it('GET /api/state：无效 token 410；有效 token 平铺 pending（不泄漏 token）', async () => {
    expect((await state('x'.repeat(43))).status).toBe(410)
    expect((await state('')).status).toBe(410)

    const req = hold()
    const held = svc.tryHold(req)!
    const t = svc.tokenOf(held.pending.pendingId)!
    const { status, data } = await state(t)
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.ended).toBe(false)
    expect(data.pendings).toHaveLength(1)
    expect(data.pendings[0]).toMatchObject({
      pendingId: held.pending.pendingId,
      taskId: req.taskId,
      kind: 'permission',
      taskName: '页面任务',
      projectName: '项目一',
      expired: false
    })
    expect(typeof data.pendings[0].expiresAt).toBe('number')
    expect(data.tasks).toEqual([{ taskId: req.taskId, taskName: '页面任务', projectName: '项目一' }])
    expect(JSON.stringify(data)).not.toContain(t)

    // 清理
    svc.cancelPending(held.pending.pendingId, 'system')
  })

  it('POST /api/answer：无效 token/shape 拒绝；正确提交释放决策；重复 410', async () => {
    const req = hold()
    const held = svc.tryHold(req)!
    const id = held.pending.pendingId
    const t = svc.tokenOf(id)!

    expect((await post('/api/answer', { token: 'bad', pendingId: id, choice: { kind: 'permission', action: 'allow' } })).status).toBe(410)
    expect((await post('/api/answer', { token: t, pendingId: id })).status).toBe(400)
    // 非法答案（kind 不符）→ 400 且 pending 保留
    const bad = await post('/api/answer', { token: t, pendingId: id, choice: { kind: 'question' } })
    expect(bad.status).toBe(400)
    expect(bad.data.error).toBe('bad-choice')
    expect(svc.count()).toBe(1)

    const ok = await post('/api/answer', { token: t, pendingId: id, choice: { kind: 'permission', action: 'allow' } })
    expect(ok.status).toBe(200)
    expect(ok.data).toEqual({ ok: true })
    expect(replies.at(-1)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
    expect(svc.count()).toBe(0)

    const again = await post('/api/answer', { token: t, pendingId: id, choice: { kind: 'permission', action: 'allow' } })
    expect(again.status).toBe(410)
    expect(again.data.error).toBe('already-resolved')
  })

  it('会话级 token（D6 平铺）：任一有效 token 可答页面上其他 pending', async () => {
    const a = hold()
    const b = hold({ event: 'PreToolUse', bodyText: JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'P' } }) })
    const ha = svc.tryHold(a)!
    const hb = svc.tryHold(b)!
    const tokenA = svc.tokenOf(ha.pending.pendingId)!

    const res = await post('/api/answer', {
      token: tokenA,
      pendingId: hb.pending.pendingId,
      choice: { kind: 'plan', action: 'approve' }
    })
    expect(res.status).toBe(200)
    expect(replies.at(-1)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { plan: 'P' } }
    })
    svc.cancelPending(ha.pending.pendingId, 'system')
  })

  it('POST /api/cancel：空响应 + token 转 settled（state 显示 ended）', async () => {
    const req = hold()
    const held = svc.tryHold(req)!
    const t = svc.tokenOf(held.pending.pendingId)!
    const res = await post('/api/cancel', { token: t, pendingId: held.pending.pendingId })
    expect(res.status).toBe(200)
    expect(replies.at(-1)).toBeNull()
    const after = await state(t)
    expect(after.status).toBe(200)
    expect(after.data.ended).toBe(true)
    // 再次取消 → 410
    expect((await post('/api/cancel', { token: t, pendingId: held.pending.pendingId })).status).toBe(410)
  })

  it('POST /api/stop：已知任务交回调；未知任务 404；无效 token 410', async () => {
    const req = hold()
    const held = svc.tryHold(req)!
    const t = svc.tokenOf(held.pending.pendingId)!
    expect((await post('/api/stop', { token: t, taskId: req.taskId })).status).toBe(200)
    expect(stops).toContain(req.taskId)
    expect((await post('/api/stop', { token: t, taskId: 'unknown' })).status).toBe(404)
    expect((await post('/api/stop', { token: 'bad', taskId: req.taskId })).status).toBe(410)
    svc.cancelPending(held.pending.pendingId, 'system')
  })

  it('过期 pending：state 标 expired，提交被拒 410', async () => {
    const req = hold()
    const held = svc.tryHold(req)!
    const t = svc.tokenOf(held.pending.pendingId)!
    clock += 61_000
    const { data } = await state(t)
    expect(data.pendings[0].expired).toBe(true)
    const res = await post('/api/answer', {
      token: t,
      pendingId: held.pending.pendingId,
      choice: { kind: 'permission', action: 'deny' }
    })
    expect(res.status).toBe(410)
    expect(res.data.error).toBe('expired')
    svc.cancelPending(held.pending.pendingId, 'system')
  })

  it('未知路由 404；畸形 JSON 400', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    const res = await fetch(`${base}/api/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })
    expect(res.status).toBe(400)
  })
})