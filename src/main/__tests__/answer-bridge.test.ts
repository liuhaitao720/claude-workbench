import { describe, expect, it } from 'vitest'
import {
  AnswerBridge,
  PRESENCE_THROTTLE_MS,
  type AnswerBridgeOptions
} from '../answer-bridge'
import type { ClientFrame } from '../../shared/remote-protocol'
import type {
  AnswerConfig,
  AnswerPendingInfo,
  AnswerResolvedEvent,
  AnswerRuntimeState
} from '../../shared/types'

/**
 * v2.2.0 B 链（本地任务手机答复桥）：门控、ack 关联、答案映射、释放路径、presence。
 * 全部依赖注入（无真实 WS/server）——帧与回执以方法调用模拟。
 */

interface Harness {
  bridge: AnswerBridge
  frames: Array<{ cid: string; frame: ClientFrame }>
  banners: AnswerPendingInfo[]
  resolved: AnswerResolvedEvent[]
  states: AnswerRuntimeState[]
  presence: Array<[number, boolean]>
  stops: string[]
  setCid: (cid: string | undefined) => void
  setEnabled: (on: boolean) => void
  advance: (ms: number) => void
}

function harness(over: Partial<AnswerBridgeOptions> = {}): Harness {
  const frames: Array<{ cid: string; frame: ClientFrame }> = []
  const banners: AnswerPendingInfo[] = []
  const resolved: AnswerResolvedEvent[] = []
  const states: AnswerRuntimeState[] = []
  const presence: Array<[number, boolean]> = []
  const stops: string[] = []
  let cid: string | undefined = 'c1'
  let enabled = true
  let clock = 1_000_000
  const cfg = (): AnswerConfig => ({
    enabled,
    ttlSec: 900,
    presenceMin: 5,
    tunnel: 'cloudflare',
    pagePort: 0
  })
  const bridge = new AnswerBridge({
    getConfig: cfg,
    answerConnection: async () => cid,
    sendFrame: (c, frame) => {
      frames.push({ cid: c, frame })
      return true
    },
    broadcastPresence: (t, f) => {
      presence.push([t, f])
      return 1
    },
    taskMetaOf: () => ({ taskName: '任务A', projectName: '项目P' }),
    stopTask: (t) => stops.push(t),
    onPending: (i) => banners.push(i),
    onResolved: (e) => resolved.push(e),
    onState: (s) => states.push(s),
    now: () => clock,
    ackTimeoutMs: 20,
    ...over
  })
  return {
    bridge,
    frames,
    banners,
    resolved,
    states,
    presence,
    stops,
    setCid: (c) => {
      cid = c
    },
    setEnabled: (on) => {
      enabled = on
    },
    advance: (ms) => {
      clock += ms
    }
  }
}

const PERM_BODY = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })

/** 等待上行帧并取 pendingId（客户端生成，server 沿用） */
async function sentPendingId(h: Harness): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const frame = h.frames.find((f) => f.frame.type === 'answer.pending')
    if (frame !== undefined && frame.frame.type === 'answer.pending') return frame.frame.pending.pendingId
    await sleep(2)
  }
  throw new Error('no pending frame')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AnswerBridge 门控（不放行=立即 null 回落 TUI）', () => {
  it('配置关 / 桌面在场 / 无连接 / 载荷不可映射 → null，且不上行帧', async () => {
    // 配置关
    const a = harness()
    a.setEnabled(false)
    expect(await a.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: PERM_BODY })).toBeNull()
    expect(a.frames).toHaveLength(0)

    // 无连接（A11：无隧道即无链接）
    const b = harness()
    b.setCid(undefined)
    expect(await b.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: PERM_BODY })).toBeNull()

    // 桌面在场（5 分钟内键入过）
    const c = harness()
    c.bridge.noteInput()
    expect(await c.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: PERM_BODY })).toBeNull()
    expect(c.frames).toHaveLength(0)

    // 载荷不可结构化映射（缺 tool_name / 事件不可答复）
    const d = harness()
    expect(await d.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: '{}' })).toBeNull()
    expect(await d.bridge.requestHold({ taskId: 't1', event: 'Elicitation', body: PERM_BODY })).toBeNull()
    expect(await d.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: 'not json' })).toBeNull()

    // 桌面离开阈值：5 分钟后放行
    const e = harness()
    e.bridge.noteInput()
    e.advance(5 * 60_000)
    const p = e.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: PERM_BODY })
    const id = await sentPendingId(e)
    e.bridge.handleServerPending('c1', pendingViewOf(e, id), 'https://x.trycloudflare.com')
    await sleep(5)
    e.bridge.handleServerSubmit('c1', id, { kind: 'permission', action: 'allow' })
    expect(await p).not.toBeNull()
  })
})

/** 取上行帧里的待答复视图（构造回执用） */
function pendingViewOf(h: Harness, id: string) {
  for (const { frame } of h.frames) {
    if (frame.type === 'answer.pending' && frame.pending.pendingId === id) return frame.pending
  }
  throw new Error('no pending view')
}

describe('AnswerBridge 挂起与答案映射', () => {
  it('上行 answer.pending → 回执后出横幅（含 url）→ answer.submit 映射决策 JSON', async () => {
    const h = harness()
    const p = h.bridge.requestHold({ taskId: 't1', event: 'PermissionRequest', body: PERM_BODY })
    const id = await sentPendingId(h)
    expect(h.bridge.count()).toBe(1)
    // 上行帧形状：客户端生成 id + 任务元数据
    const sent = h.frames[0]!
    expect(sent.cid).toBe('c1')
    expect(sent.frame).toMatchObject({
      type: 'answer.pending',
      pending: {
        pendingId: id,
        taskId: 't1',
        event: 'PermissionRequest',
        kind: 'permission',
        taskName: '任务A',
        projectName: '项目P'
      }
    })
    // 未回执前不出横幅（避免无链接的空横幅）
    expect(h.banners).toHaveLength(0)
    h.bridge.handleServerPending('c1', pendingViewOf(h, id), 'https://x.trycloudflare.com')
    await sleep(10) // 让 ack 后的 await 继续
    expect(h.banners).toHaveLength(1)
    expect(h.banners[0]!.url).toBe('https://x.trycloudflare.com')

    h.bridge.handleServerSubmit('c1', id, { kind: 'permission', action: 'allow' })
    expect(await p).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' }
      }
    })
    expect(h.bridge.count()).toBe(0)
  })

  it('AskUserQuestion：选项映射为 updatedInput.answers', async () => {
    const h = harness()
    const body = JSON.stringify({
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: '用哪个方案？', header: '方案', options: [{ label: 'A' }, { label: 'B' }] }
        ]
      }
    })
    const p = h.bridge.requestHold({ taskId: 't2', event: 'PreToolUse', body })
    const id = await sentPendingId(h)
    h.bridge.handleServerPending('c1', pendingViewOf(h, id))
    await sleep(10)
    h.bridge.handleServerSubmit('c1', id, {
      kind: 'question',
      selections: [{ questionIndex: 0, optionIndexes: [1] }]
    })
    const decision = (await p) as Record<string, unknown>
    expect(decision).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { answers: { '用哪个方案？': 'B' } }
      }
    })
  })

  it('kind 不符的提交 → 空响应释放（不写非法决策）', async () => {
    const h = harness()
    const p = h.bridge.requestHold({ taskId: 't3', event: 'PermissionRequest', body: PERM_BODY })
    const id = await sentPendingId(h)
    h.bridge.handleServerPending('c1', pendingViewOf(h, id))
    await sleep(10)
    h.bridge.handleServerSubmit('c1', id, { kind: 'question' })
    expect(await p).toBeNull()
  })

  it('回执超时 → null（回落 TUI），挂起清除', async () => {
    const h = harness()
    const p = h.bridge.requestHold({ taskId: 't4', event: 'PermissionRequest', body: PERM_BODY })
    expect(await p).toBeNull()
    expect(h.bridge.count()).toBe(0)
    expect(h.banners).toHaveLength(0)
  })
})

describe('AnswerBridge 释放路径', () => {
  it('answer.resolved（手机作答）→ null + 已处理事件', async () => {
    const h = harness()
    const p = h.bridge.requestHold({ taskId: 't5', event: 'PermissionRequest', body: PERM_BODY })
    const id = await sentPendingId(h)
    h.bridge.handleServerPending('c1', pendingViewOf(h, id))
    await sleep(10)
    h.bridge.handleServerResolved('c1', id, 't5', 'phone', 'answered')
    expect(await p).toBeNull()
    expect(h.resolved).toEqual([
      { connectionId: 'c1', pendingId: id, taskId: 't5', by: 'phone', action: 'answered' }
    ])
  })

  it('桌面中止 cancel：本地立即 null + 上行 answer.cancel', async () => {
    const h = harness()
    const p = h.bridge.requestHold({ taskId: 't6', event: 'PermissionRequest', body: PERM_BODY })
    const id = await sentPendingId(h)
    h.bridge.handleServerPending('c1', pendingViewOf(h, id))
    await sleep(10)
    h.bridge.cancel(undefined, id)
    expect(await p).toBeNull()
    expect(h.frames.some((f) => f.frame.type === 'answer.cancel' && f.frame.pendingId === id)).toBe(true)
  })

  it('连接断开 releaseAll → 全部 null；answer.stop 交 stopTask', async () => {
    const h = harness()
    const p = h.bridge.requestHold({ taskId: 't7', event: 'PermissionRequest', body: PERM_BODY })
    const id = await sentPendingId(h)
    h.bridge.handleServerPending('c1', pendingViewOf(h, id))
    await sleep(10)
    expect(h.bridge.releaseAll()).toBe(1)
    expect(await p).toBeNull()

    h.bridge.handleServerStop('c1', 't7')
    expect(h.stops).toEqual(['t7'])
    h.bridge.handleServerState('c1', { enabled: true, tunnel: 'up', baseUrl: 'https://x', pendingCount: 0 })
    expect(h.states[0]).toMatchObject({ connectionId: 'c1', tunnel: 'up' })
  })
})

describe('AnswerBridge presence（桌面在场心跳）', () => {
  it('键入节流 5s；焦点切换立即播报；lastInputAt 随键入刷新', () => {
    const h = harness()
    h.bridge.noteInput()
    expect(h.presence).toHaveLength(1)
    expect(h.presence[0]![0]).toBe(1_000_000)

    h.advance(PRESENCE_THROTTLE_MS - 1)
    h.bridge.noteInput()
    expect(h.presence).toHaveLength(1) // 节流窗内不重播

    h.advance(1)
    h.bridge.noteInput()
    expect(h.presence).toHaveLength(2)
    expect(h.presence[1]![0]).toBe(1_000_000 + PRESENCE_THROTTLE_MS)

    h.bridge.setFocused(false) // 焦点变化立即播报（不受节流）
    expect(h.presence).toHaveLength(3)
    expect(h.presence[2]![1]).toBe(false)

    h.bridge.announcePresence()
    expect(h.presence).toHaveLength(4)
  })

  it('desktopAway：从未键入=不在场；键入后窗内=在场；超窗=不在场', () => {
    const h = harness()
    expect(h.bridge.desktopAway(5)).toBe(true)
    h.bridge.noteInput()
    expect(h.bridge.desktopAway(5)).toBe(false)
    h.advance(5 * 60_000)
    expect(h.bridge.desktopAway(5)).toBe(true)
  })
})