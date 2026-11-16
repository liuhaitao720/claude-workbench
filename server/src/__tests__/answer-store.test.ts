import { describe, expect, it } from 'vitest'
import {
  ANSWER_MAX_GLOBAL,
  AnswerService,
  type AnswerHoldRequest,
  type AnswerServiceOptions
} from '../answer-store'
import type { ServerFrame } from '../shared/remote-protocol'
import type { AnswerChoice, AnswerPendingView } from '../shared/answer-decision'

/**
 * v2.2.0 B 链：手机答复 pending 仓库。
 * 覆盖：挂起条件（配置/页面就绪/可答复载荷）、一次性 token、幂等 410、TTL、
 * 同任务同 kind 取代、上限、任务退出/桌面取消/连接断开释放、本地任务回送。
 */

interface Harness {
  svc: AnswerService
  frames: ServerFrame[]
  replies: Array<Record<string, unknown> | null>
  advance: (ms: number) => void
  setEnabled: (v: boolean) => void
}

function harness(opts: { enabled?: boolean; ttlSec?: number; surface?: string } = {}): Harness {
  let enabled = opts.enabled ?? true
  let clock = 1_700_000_000_000
  const frames: ServerFrame[] = []
  const replies: Array<Record<string, unknown> | null> = []
  const config = {
    enabled,
    ttlSec: opts.ttlSec ?? 900
  }
  const o: AnswerServiceOptions = {
    config: () => ({ enabled, ttlSec: config.ttlSec }),
    surface: () => undefined, // 由 setSurface 注入（AnswerService 自持）
    broadcast: (f) => frames.push(f),
    log: () => {},
    now: () => clock
  }
  const svc = new AnswerService(o)
  svc.setSurface(opts.surface ?? 'https://test.trycloudflare.com')
  return {
    svc,
    frames,
    replies,
    advance: (ms) => {
      clock += ms
    },
    setEnabled: (v) => {
      enabled = v
    }
  }
}

function holdReq(taskId: string, over: Partial<AnswerHoldRequest> = {}): AnswerHoldRequest & {
  reply: (d: Record<string, unknown> | null) => void
} {
  const replies: Array<Record<string, unknown> | null> = []
  return {
    taskId,
    event: 'PermissionRequest',
    bodyText: JSON.stringify({ tool_name: 'Bash' }),
    taskName: '任务甲',
    projectName: '项目一',
    reply: (d) => replies.push(d),
    ...over,
    // 让调用方可检查（通过闭包外的 getter 更复杂——这里用属性挂载）
    ...({ _replies: replies } as Record<string, unknown>)
  } as AnswerHoldRequest & { reply: (d: Record<string, unknown> | null) => void }
}

function repliesOf(req: AnswerHoldRequest): Array<Record<string, unknown> | null> {
  return (req as unknown as { _replies: Array<Record<string, unknown> | null> })._replies
}

const LOCAL_VIEW: AnswerPendingView = {
  pendingId: '',
  taskId: 't-local',
  event: 'PreToolUse',
  kind: 'permission',
  taskName: '本地任务',
  questions: [{ question: 'Bash', options: [] }]
}

describe('AnswerService：挂起条件', () => {
  it('配置关 / 页面未就绪 / 不可答复事件 / 非法 body → 不挂起（null）', () => {
    const off = harness({ enabled: false })
    expect(off.svc.tryHold(holdReq('t1'))).toBeNull()

    const noSurface = harness()
    noSurface.svc.setSurface(undefined)
    expect(noSurface.svc.tryHold(holdReq('t1'))).toBeNull()

    const h = harness()
    expect(h.svc.tryHold(holdReq('t1', { event: 'Stop', bodyText: '{}' }))).toBeNull()
    expect(h.svc.tryHold(holdReq('t1', { bodyText: 'not-json' }))).toBeNull()
    expect(h.svc.tryHold(holdReq('t1', { bodyText: JSON.stringify({}) }))).toBeNull()
    expect(h.svc.count()).toBe(0)
  })

  it('挂起成功：视图归一化 + 链接带 token + 广播 answer.pending/answer.state', () => {
    const h = harness()
    const req = holdReq('t1')
    const held = h.svc.tryHold(req)!
    expect(held).not.toBeNull()
    expect(held.pending.kind).toBe('permission')
    expect(held.pending.taskName).toBe('任务甲')
    expect(held.pending.projectName).toBe('项目一')
    expect(held.pending.pendingId).not.toBe('')
    expect(held.url).toBe(`https://test.trycloudflare.com/a/${h.svc.tokenOf(held.pending.pendingId)}`)

    const pendingFrame = h.frames.find((f) => f.type === 'answer.pending')
    expect(pendingFrame).toMatchObject({
      type: 'answer.pending',
      pending: { pendingId: held.pending.pendingId, kind: 'permission' },
      url: held.url
    })
    expect(h.frames.some((f) => f.type === 'answer.state')).toBe(true)
    expect(h.svc.count()).toBe(1)
    expect(h.svc.list()[0]!.pendingId).toBe(held.pending.pendingId)
  })
})

describe('AnswerService：提交与幂等', () => {
  it('token 校验 → 决策释放；重复提交 already-resolved；错误 token unauthorized', () => {
    const h = harness()
    const req = holdReq('t1')
    const held = h.svc.tryHold(req)!
    const id = held.pending.pendingId
    const token = h.svc.tokenOf(id)!

    expect(h.svc.submit('', id, { kind: 'permission', action: 'allow' })).toBe('unauthorized')
    expect(h.svc.submit('x'.repeat(token.length), id, { kind: 'permission', action: 'allow' })).toBe(
      'unauthorized'
    )
    expect(h.svc.submit(token, 'no-such-id', { kind: 'permission', action: 'allow' })).toBe('not-found')
    // 决策校验失败不释放 pending（页面可重答）
    expect(h.svc.submit(token, id, { kind: 'question' })).toBe('bad-choice')
    expect(h.svc.count()).toBe(1)

    expect(h.svc.submit(token, id, { kind: 'permission', action: 'allow' })).toBe('ok')
    expect(repliesOf(req)).toHaveLength(1)
    expect(repliesOf(req)[0]).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
    expect(h.svc.count()).toBe(0)
    const resolved = h.frames.filter((f) => f.type === 'answer.resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ pendingId: id, taskId: 't1', by: 'phone', action: 'answered' })

    // 幂等：同一 token 再提交 → already-resolved；错 token → not-found
    expect(h.svc.submit(token, id, { kind: 'permission', action: 'allow' })).toBe('already-resolved')
    expect(h.svc.submit('y'.repeat(token.length), id, { kind: 'permission', action: 'allow' })).toBe(
      'not-found'
    )
  })

  it('TTL 过期：提交被拒（expired）但 pending 保留，桌面仍可释放（2.15=C）', () => {
    const h = harness({ ttlSec: 60 })
    const req = holdReq('t1')
    const held = h.svc.tryHold(req)!
    const id = held.pending.pendingId
    const token = h.svc.tokenOf(id)!
    h.advance(61_000)

    expect(h.svc.detail(id)?.expired).toBe(true)
    expect(h.svc.submit(token, id, { kind: 'permission', action: 'deny' })).toBe('expired')
    expect(h.svc.count()).toBe(1)

    expect(h.svc.cancelPending(id, 'desktop')).toBe(true)
    expect(repliesOf(req)).toEqual([null])
    expect(h.svc.count()).toBe(0)
    // 已终结记录仍可幂等识别（桌面释放 → cancelled → already-resolved）
    expect(h.svc.submit(token, id, { kind: 'permission', action: 'deny' })).toBe('already-resolved')
  })

  it('同任务同 kind 新事件取代旧 pending（旧 hook 空响应）；不同 kind 并存', () => {
    const h = harness()
    const first = holdReq('t1')
    const second = holdReq('t1')
    const held1 = h.svc.tryHold(first)!
    const held2 = h.svc.tryHold(second)!
    expect(repliesOf(first)).toEqual([null])
    expect(h.svc.count()).toBe(1)
    expect(held2.pending.pendingId).not.toBe(held1.pending.pendingId)

    const plan = holdReq('t1', {
      event: 'PreToolUse',
      bodyText: JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'P' } })
    })
    expect(h.svc.tryHold(plan)).not.toBeNull()
    expect(h.svc.count()).toBe(2)
    expect(h.svc.list().map((v) => v.kind).sort()).toEqual(['permission', 'plan'])
  })
})

describe('AnswerService：上限与释放路径', () => {
  it(`全局上限 ${ANSWER_MAX_GLOBAL}：超出回落 TUI（null）`, () => {
    const h = harness()
    const kinds: Array<[string, string]> = [
      ['PermissionRequest', JSON.stringify({ tool_name: 'Bash' })],
      [
        'PreToolUse',
        JSON.stringify({
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }
        })
      ],
      ['PreToolUse', JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'P' } })]
    ]
    let held = 0
    for (let t = 0; t < 7; t += 1) {
      for (const [event, bodyText] of kinds) {
        if (h.svc.tryHold(holdReq(`t-${t}`, { event, bodyText })) !== null) held += 1
      }
    }
    expect(held).toBe(ANSWER_MAX_GLOBAL)
    expect(h.svc.count()).toBe(ANSWER_MAX_GLOBAL)
    expect(
      h.svc.tryHold(holdReq('t-late', { event: 'PermissionRequest', bodyText: '{"tool_name":"Bash"}' }))
    ).toBeNull()
  })

  it('任务结束/停止：该任务全部 pending 空响应释放，其他任务不受影响', () => {
    const h = harness()
    const a1 = holdReq('a')
    const a2 = holdReq('a', {
      event: 'PreToolUse',
      bodyText: JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} })
    })
    const b1 = holdReq('b')
    h.svc.tryHold(a1)
    h.svc.tryHold(a2)
    h.svc.tryHold(b1)

    expect(h.svc.cancelTask('a', 'system')).toBe(2)
    expect(repliesOf(a1)).toEqual([null])
    expect(repliesOf(a2)).toEqual([null])
    expect(repliesOf(b1)).toEqual([])
    expect(h.svc.count()).toBe(1)
    const resolved = h.frames.filter((f) => f.type === 'answer.resolved')
    expect(resolved.every((f) => f.type === 'answer.resolved' && f.by === 'system')).toBe(true)
  })

  it('桌面按 taskId/pendingId 取消', () => {
    const h = harness()
    const a1 = holdReq('a')
    const b1 = holdReq('b')
    const heldA = h.svc.tryHold(a1)!
    h.svc.tryHold(b1)

    expect(h.svc.cancelFromDesktop(undefined, 'a')).toBe(1)
    expect(repliesOf(a1)).toEqual([null])
    expect(h.svc.count()).toBe(1)
    expect(h.svc.cancelFromDesktop(heldA.pending.pendingId)).toBe(0)
    expect(h.svc.cancelFromDesktop(undefined, 'b')).toBe(1)
    expect(h.svc.count()).toBe(0)
  })

  it('hook 连接断开（abandon）：空响应 + 记 expired，后续提交 expired', () => {
    const h = harness()
    const req = holdReq('t1')
    const held = h.svc.tryHold(req)!
    const token = h.svc.tokenOf(held.pending.pendingId)!
    h.svc.abandon(held.pending.pendingId)
    expect(repliesOf(req)).toEqual([null])
    expect(h.svc.count()).toBe(0)
    expect(h.svc.submit(token, held.pending.pendingId, { kind: 'permission', action: 'allow' })).toBe(
      'expired'
    )
    // 未知 pending 的 abandon 静默
    h.svc.abandon('nope')
  })

  it('本地任务：答案回送 onSubmit（决策由客户端映射，D5）', () => {
    const h = harness()
    const sent: Array<[string, AnswerChoice]> = []
    const held = h.svc.holdLocal(LOCAL_VIEW, (pendingId, choice) => sent.push([pendingId, choice]))!
    expect(held).not.toBeNull()
    expect(held.pending.taskName).toBe('本地任务')
    expect(held.pending.pendingId).not.toBe('') // 空 id → server 生成

    // 客户端生成 pendingId（A 帧关联）→ 原样沿用（换 taskId 避免 2.14 同任务同 kind 取代）
    const heldClient = h.svc.holdLocal(
      { ...LOCAL_VIEW, taskId: 't-local-2', pendingId: 'client-pending-1' },
      () => {}
    )!
    expect(heldClient.pending.pendingId).toBe('client-pending-1')
    expect(h.svc.cancelPending('client-pending-1', 'desktop')).toBe(true)

    const choice: AnswerChoice = { kind: 'permission', action: 'deny' }
    expect(h.svc.submit(h.svc.tokenOf(held.pending.pendingId)!, held.pending.pendingId, choice)).toBe('ok')
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe(held.pending.pendingId)
    expect(sent[0]![1]).toEqual(choice)
    // 本地任务 kind 不符 → bad-choice 且不释放
    const h2 = harness()
    const held2 = h2.svc.holdLocal(LOCAL_VIEW, () => {})!
    expect(
      h2.svc.submit(h2.svc.tokenOf(held2.pending.pendingId)!, held2.pending.pendingId, {
        kind: 'question'
      })
    ).toBe('bad-choice')
  })

  it('停机 dispose：全部空响应释放、surface 清空、终结记录清空', () => {
    const h = harness()
    const req = holdReq('t1')
    const held = h.svc.tryHold(req)!
    const token = h.svc.tokenOf(held.pending.pendingId)!
    h.svc.dispose()
    expect(repliesOf(req)).toEqual([null])
    expect(h.svc.count()).toBe(0)
    expect(h.svc.canHold()).toBe(false)
    expect(h.svc.submit(token, held.pending.pendingId, { kind: 'permission', action: 'allow' })).toBe(
      'not-found'
    )
  })

  it('状态快照：enabled/baseUrl/tunnel/pendingCount；禁用后 canHold=false', () => {
    const h = harness()
    expect(h.svc.snapshot()).toEqual({
      enabled: true,
      baseUrl: 'https://test.trycloudflare.com',
      tunnel: 'up',
      pendingCount: 0
    })
    const held = h.svc.tryHold(holdReq('t1'))!
    expect(h.svc.snapshot('down').pendingCount).toBe(1)
    expect(h.svc.snapshot('down').tunnel).toBe('down')
    expect(held.pending.pendingId).not.toBe('')

    h.setEnabled(false)
    expect(h.svc.canHold()).toBe(false)
    expect(h.svc.snapshot().enabled).toBe(false)
  })
})