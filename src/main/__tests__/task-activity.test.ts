import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTaskActivityServer, type TaskActivityHandle } from '../task-activity'
import type { TaskActivityEvent } from '../../shared/types'

/**
 * S7 task-activity 单测：真 http server（127.0.0.1:0）+ 真 settings 文件落盘。
 * 时间经 opts.now 注入（可变 clock 对象手动推进），时间窗断言无需真实等待。
 */

let settingsDir: string
let clockNow: number
let events: TaskActivityEvent[]
let handle: TaskActivityHandle

beforeEach(async () => {
  settingsDir = mkdtempSync(join(tmpdir(), 'cwb-task-activity-'))
  clockNow = 1_000_000
  events = []
  handle = startTaskActivityServer({
    settingsDir,
    onActivity: (e) => events.push(e),
    now: () => clockNow
  })
  await handle.ready() // 端口确定后再开测（构造急启动的确定性收口）
})

afterEach(() => {
  handle.dispose()
  rmSync(settingsDir, { recursive: true, force: true })
})

const advance = (ms: number): void => {
  clockNow += ms
}

/** 依当前 epoch/taskId 构造 hook URL 并 POST（真实 http 往返） */
async function postHook(event: string, taskId: string, epoch: number, body = '{}'): Promise<Response> {
  const url = `http://127.0.0.1:${handle.port}/hook/${event}?e=${epoch}&t=${encodeURIComponent(taskId)}`
  return fetch(url, { method: 'POST', body })
}

function settingsUrl(event: string, settingsPath: string): string {
  const parsed: { hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>> } = JSON.parse(
    readFileSync(settingsPath, 'utf8')
  )
  return parsed.hooks[event]?.[0]?.hooks[0]?.url as string
}

describe('server 与 settings 注入', () => {
  it('ready 后端口确定（>0）；非 POST 405、未知路径 404、已知事件一律 200 空体', async () => {
    await handle.ready()
    expect(handle.port).toBeGreaterThan(0)
    expect((await fetch(`http://127.0.0.1:${handle.port}/hook/Stop?e=1&t=x`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${handle.port}/nope`, { method: 'POST' })).status).toBe(404)
    expect((await postHook('UserPromptSubmit', 'unknown-task', 1)).status).toBe(200)
  })

  it('buildSettings：原子写 6 事件 hooks 文件（URL 含端口/epoch/taskId；PreToolUse 带 matcher；timeout=3）', async () => {
    handle.noteSpawn('t1')
    const path = await handle.buildSettings('t1')
    expect(path).toBe(join(settingsDir, 't1.json'))
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; url: string; timeout: number }> }>>
    }
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['Elicitation', 'PermissionRequest', 'PreToolUse', 'Stop', 'StopFailure', 'UserPromptSubmit'].sort()
    )
    for (const [event, group] of Object.entries(parsed.hooks)) {
      const entry = group[0]?.hooks[0]
      expect(entry?.type, event).toBe('http')
      expect(entry?.timeout, event).toBe(3)
      expect(entry?.url).toContain(`/hook/${event}?e=1&t=t1`)
    }
    expect(parsed.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion|ExitPlanMode')
    expect(settingsUrl('UserPromptSubmit', path)).toContain(`127.0.0.1:${handle.port}`)
    // 原子写不留 tmp 残留
    expect(readdirSync(settingsDir).some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('同 taskId resume 复用同一路径（重写内容捕获新 epoch）', async () => {
    handle.noteSpawn('t1')
    const p1 = await handle.buildSettings('t1')
    handle.noteSpawn('t1')
    const p2 = await handle.buildSettings('t1')
    expect(p2).toBe(p1)
    expect(settingsUrl('Stop', p2)).toContain('e=2')
  })
})

describe('hook 事件 → 状态转换（真实 POST）', () => {
  it('UserPromptSubmit→busy；Stop/StopFailure→idle；PermissionRequest/PreToolUse/Elicitation→awaiting', async () => {
    handle.noteSpawn('t1')
    const cases: ReadonlyArray<[string, TaskActivityEvent['activity']]> = [
      ['UserPromptSubmit', 'busy'],
      ['PermissionRequest', 'awaiting'],
      ['PreToolUse', 'awaiting'],
      ['Elicitation', 'awaiting'],
      ['Stop', 'idle'],
      ['StopFailure', 'idle']
    ]
    for (const [event, want] of cases) {
      const res = await postHook(event, 't1', 1)
      expect(res.status, event).toBe(200)
      expect(handle.current('t1'), event).toBe(want)
      advance(10)
    }
    // 广播流只含值变化（同值 hook 去抖不播，见下一用例）
    expect(events).toEqual([
      { taskId: 't1', activity: 'idle' },
      { taskId: 't1', activity: 'busy' },
      { taskId: 't1', activity: 'awaiting' },
      { taskId: 't1', activity: 'idle' }
    ])
    expect(handle.current('t1')).toBe('idle')
  })

  it('epoch 不匹配（旧 PTY 迟到 hook）→ 忽略；URL 缺 e/t → 忽略；未知事件名 → 忽略', async () => {
    handle.noteSpawn('t1') // epoch 1
    handle.noteSpawn('t1') // epoch 2（resume）
    expect((await postHook('UserPromptSubmit', 't1', 1)).status).toBe(200) // 旧 epoch
    expect((await fetch(`http://127.0.0.1:${handle.port}/hook/UserPromptSubmit?t=t1`, { method: 'POST', body: '{}' })).status).toBe(200) // 缺 e
    expect((await fetch(`http://127.0.0.1:${handle.port}/hook/UserPromptSubmit?e=2`, { method: 'POST', body: '{}' })).status).toBe(200) // 缺 t
    expect((await postHook('SubagentStop', 't1', 2)).status).toBe(200) // 未配置事件名
    expect(events).toEqual([{ taskId: 't1', activity: 'idle' }])
    expect(handle.current('t1')).toBe('idle')

    // 当前 epoch 正常采纳
    await postHook('UserPromptSubmit', 't1', 2)
    expect(handle.current('t1')).toBe('busy')
  })

  it('Stop payload background_tasks/session_crons 非空 → 记录标志但 activity 仍 idle', async () => {
    handle.noteSpawn('t1')
    await postHook('UserPromptSubmit', 't1', 1)
    expect(handle.current('t1')).toBe('busy')
    await postHook('Stop', 't1', 1, JSON.stringify({ background_tasks: [{ id: 'b' }], session_crons: [] }))
    expect(handle.current('t1')).toBe('idle')
    expect(handle.backgroundWork('t1')).toBe(true)

    // 空 payload → 标志复位
    await postHook('UserPromptSubmit', 't1', 1)
    await postHook('Stop', 't1', 1, JSON.stringify({ background_tasks: [], session_crons: [] }))
    expect(handle.backgroundWork('t1')).toBe(false)
  })

  it('去抖：同值 hook 事件不重复广播', async () => {
    handle.noteSpawn('t1')
    await postHook('UserPromptSubmit', 't1', 1)
    advance(100)
    await postHook('UserPromptSubmit', 't1', 1) // 同值 busy
    expect(events).toEqual([
      { taskId: 't1', activity: 'idle' },
      { taskId: 't1', activity: 'busy' }
    ])
  })
})

describe('本地合成与字节兜底', () => {
  it('noteSpawn：本地合成 idle（绿）广播；随后 8s 内的字节不翻案（就绪窗）', async () => {
    handle.noteSpawn('t1')
    expect(events).toEqual([{ taskId: 't1', activity: 'idle' }])
    advance(1_000)
    handle.noteBytes('t1') // claude banner 输出
    advance(2_000)
    handle.tick()
    expect(handle.current('t1')).toBe('idle') // LOCAL_FRESH_MS(8s) 内本地合成优先
    expect(events).toHaveLength(1)
  })

  it('字节兜底：就绪窗过后活跃字节→busy（经 tick 广播）；静默超 4s→idle', async () => {
    handle.noteSpawn('t1')
    advance(9_000) // 本地合成过期
    handle.noteBytes('t1')
    handle.tick()
    expect(handle.current('t1')).toBe('busy')
    expect(events.at(-1)).toEqual({ taskId: 't1', activity: 'busy' })

    advance(4_001) // 字节静默超窗
    handle.tick()
    expect(handle.current('t1')).toBe('idle')
    expect(events.at(-1)).toEqual({ taskId: 't1', activity: 'idle' })
  })

  it('hook 新鲜窗：Stop(idle) 后 15s 内的尾部输出字节不翻案；窗外活跃字节→busy', async () => {
    handle.noteSpawn('t1')
    await postHook('Stop', 't1', 1)
    advance(3_000)
    handle.noteBytes('t1') // 回合完成后的尾部渲染
    handle.tick()
    expect(handle.current('t1')).toBe('idle') // HOOK_FRESH_MS(15s) 内 hook 裁决优先

    advance(12_001) // 距 Stop 已 15s+，hook 裁决过期
    handle.noteBytes('t1') // 字节活跃（claude 仍在输出）
    handle.tick()
    expect(handle.current('t1')).toBe('busy')
  })

  it('本地 Esc：busy → 合成 idle；非 busy（idle/awaiting）不动作；方向键等多字节序列不走此路径', async () => {
    handle.noteSpawn('t1')
    await postHook('UserPromptSubmit', 't1', 1)
    expect(handle.current('t1')).toBe('busy')
    handle.onEsc('t1')
    expect(handle.current('t1')).toBe('idle')
    expect(events.at(-1)).toEqual({ taskId: 't1', activity: 'idle' })

    handle.onEsc('t1') // 已 idle：无新广播
    expect(events.filter((e) => e.activity === 'idle')).toHaveLength(2) // spawn + esc

    await postHook('PermissionRequest', 't1', 1)
    expect(handle.current('t1')).toBe('awaiting')
    handle.onEsc('t1') // awaiting：Esc 不合成（spec 仅 busy）
    expect(handle.current('t1')).toBe('awaiting')
    expect(handle.onEsc.bind(handle, 'no-such')).not.toThrow()
  })

  it('awaiting 粘滞：静默不降级（tick/时间推进后仍红）；宽限后新字节→busy；宽限内字节视为重绘噪音', async () => {
    handle.noteSpawn('t1')
    await postHook('PermissionRequest', 't1', 1) // awaiting 落定于 T0
    advance(500)
    handle.noteBytes('t1') // 宽限内（<1s）：对话框重绘不解除粘滞
    expect(handle.current('t1')).toBe('awaiting')

    advance(60_000) // 长静默
    handle.tick()
    expect(handle.current('t1')).toBe('awaiting') // 粘滞：字节兜底永不翻 awaiting

    handle.noteBytes('t1') // 宽限早过 → claude 恢复输出 → busy
    expect(handle.current('t1')).toBe('busy')
    expect(events.at(-1)).toEqual({ taskId: 't1', activity: 'busy' })
  })
})

describe('生命周期', () => {
  it('forget：删 settings 文件与内存态（current→undefined；迟到 hook 忽略）', async () => {
    handle.noteSpawn('t1')
    const path = await handle.buildSettings('t1')
    expect(existsSync(path)).toBe(true)
    handle.forget('t1')
    expect(existsSync(path)).toBe(false)
    expect(handle.current('t1')).toBeUndefined()
    expect((await postHook('UserPromptSubmit', 't1', 1)).status).toBe(200) // 无状态 → 忽略
    expect(events).toEqual([{ taskId: 't1', activity: 'idle' }])
  })

  it('cleanupOrphans：不在 keep 集内的 *.json 与 *.json.tmp 删除，保留集不动', () => {
    const live = join(settingsDir, 'live.json')
    const dead = join(settingsDir, 'dead.json')
    const tmpLeftover = join(settingsDir, 'crash.json.tmp')
    const unrelated = join(settingsDir, 'notes.txt')
    writeFileSync(live, '{}')
    writeFileSync(dead, '{}')
    writeFileSync(tmpLeftover, '{}')
    writeFileSync(unrelated, 'x')
    handle.cleanupOrphans(['live'])
    expect(existsSync(live)).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(tmpLeftover)).toBe(false)
    expect(existsSync(unrelated)).toBe(true) // 只扫 cwb settings 文件
  })

  it('dispose：端口关闭（后续连接拒绝）、定时器停', async () => {
    handle.noteSpawn('t1')
    await handle.buildSettings('t1')
    const port = handle.port
    handle.dispose()
    await expect(fetch(`http://127.0.0.1:${port}/hook/Stop?e=1&t=t1`, { method: 'POST' })).rejects.toThrow()
    const before = events.length
    advance(10_000)
    handle.tick() // 手动 tick 仍可用（幂等），但 interval 已停
    expect(events.length).toBeGreaterThanOrEqual(before)
  })
})

describe('v0.4.2 输入回显抑制（键入后 2s 内的 PTY 字节=TUI 重绘，不点亮 busy）', () => {
  it('打字场景：noteUserInput 后即时字节 → 保持 idle；持续打字（输入+字节交替）始终 idle', () => {
    handle.noteSpawn('t-echo')
    handle.noteUserInput('t-echo')
    handle.noteBytes('t-echo') // 键入 0ms 后的重绘字节
    handle.tick()
    expect(handle.current('t-echo')).toBe('idle')

    for (let i = 0; i < 5; i++) {
      advance(300)
      handle.noteUserInput('t-echo')
      handle.noteBytes('t-echo')
      handle.tick()
      expect(handle.current('t-echo')).toBe('idle') // 连续打字全程绿
    }
  })

  it('真实输出：字节晚于最后按键 >2s → busy；静默超窗回落 idle', () => {
    handle.noteSpawn('t-real')
    handle.noteUserInput('t-real') // t0 键入（如 Enter）
    advance(8_500) // 同时越过本地合成 8s 就绪窗与 2s 回显窗，claude 仍在输出
    handle.noteBytes('t-real')
    handle.tick()
    expect(handle.current('t-real')).toBe('busy')
    advance(4_500) // 输出停止超 4s 窗
    handle.tick()
    expect(handle.current('t-real')).toBe('idle')
  })

  it('awaiting 粘滞尊重回显抑制：答复框内打字（回显字节）不解粘；真实输出（>2s 离键）才转 busy', async () => {
    handle.noteSpawn('t-red')
    await postHook('PermissionRequest', 't-red', 1)
    expect(handle.current('t-red')).toBe('awaiting')

    advance(6_000) // 超过 5s 解粘宽限
    handle.noteUserInput('t-red') // 用户在答复框打字
    handle.noteBytes('t-red') // 每键重绘字节（回显）
    handle.tick()
    expect(handle.current('t-red')).toBe('awaiting') // 不被击键误解除

    advance(2_500) // 用户提交后 claude 真实输出
    handle.noteBytes('t-red')
    handle.tick()
    expect(handle.current('t-red')).toBe('busy')
  })
})

describe('v0.4.5 busy 滞回（防切换 tab 等瞬态翻转闪绿）', () => {
  it('字节窗刚过期但 1.5s 内确认过 busy → 保持；确认超 1.5s 后才降 idle', () => {
    handle.noteSpawn('t-hyst')
    advance(9_000) // 越过本地合成 8s 窗
    handle.noteUserInput('t-hyst')
    advance(2_100) // 越过回显抑制窗
    handle.noteBytes('t-hyst')
    handle.tick()
    expect(handle.current('t-hyst')).toBe('busy')

    advance(3_800) // 字节窗仍新鲜（3800<4000），持续确认 busy
    handle.tick()
    expect(handle.current('t-hyst')).toBe('busy')

    advance(300) // 字节窗刚过期（4100>4000），但 300ms < 1.5s 滞回 → 保持 busy（不闪绿）
    handle.tick()
    expect(handle.current('t-hyst')).toBe('busy')

    advance(1_300) // 距最后确认 1600ms > 1.5s → 正常降 idle
    handle.tick()
    expect(handle.current('t-hyst')).toBe('idle')
  })
})
