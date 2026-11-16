import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ServerNotifier,
  buildNotifyPayload,
  formatDuration,
  inferChannel,
  isAwaitingHookEvent,
  loadNotifyConfig,
  loadNotifyExtras,
  summarizeAssistantMessage,
  DEFAULT_ANSWER_CONFIG,
  DEFAULT_EVENT_FLAGS
} from '../notify'

/**
 * v2.0.2 服务器侧 webhook 推送单测（用户指令：推送+URL 全落服务器端）。
 * 触发门控/配置容错/防抖/payload 形状——fetch 注入桩，不发网络。
 */

let home: string
let pushed: Array<{ url: string; body: Record<string, unknown> }>
let clockNow: number

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cwb-server-notify-'))
  pushed = []
  clockNow = 1_000_000
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeConfig(cfg: unknown): void {
  mkdirSync(join(home, '.cwb'), { recursive: true })
  writeFileSync(join(home, '.cwb', 'notify.json'), JSON.stringify(cfg), 'utf8')
}

function makeNotifier(): ServerNotifier {
  return new ServerNotifier({
    home,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      pushed.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response('{"ok":1}')
    }) as typeof fetch,
    now: () => clockNow,
    taskNameOf: (id) => (id === 't1' ? '登录重构' : undefined)
  })
}

describe('配置读取（~/.cwb/notify.json 容错）', () => {
  it('缺失/损坏 → 禁用；正常读取；channel 缺省按 URL 推断', () => {
    expect(loadNotifyConfig(home)).toEqual({ url: '', enabled: false, channel: 'generic' })
    writeConfig('{bad json')
    expect(loadNotifyConfig(home).enabled).toBe(false)
    writeConfig({ url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', enabled: true })
    const cfg = loadNotifyConfig(home)
    expect(cfg.enabled).toBe(true)
    expect(cfg.channel).toBe('wecom')
    expect(inferChannel('https://oapi.dingtalk.com/robot/send?token=t')).toBe('dingtalk')
  })
})

describe('触发门控与防抖', () => {
  it('仅 awaiting 三源触发（Stop 走合并窗/UserPromptSubmit 忽略）；同任务 5 分钟防抖；跨任务独立', () => {
    writeConfig({ url: 'https://hook.example/x', enabled: true })
    const n = makeNotifier()
    expect(n.onHookEvent('t1', 'Stop')).toBe('pushed') // v2.2.0：排入 10s 合并窗，不立即发
    expect(n.onHookEvent('t1', 'UserPromptSubmit')).toBe('ignored')
    expect(n.onHookEvent('t1', 'SubagentStop')).toBe('ignored') // 子 agent 停止不推送
    expect(n.onHookEvent('t1', 'PermissionRequest')).toBe('pushed')
    clockNow += 60_000
    expect(n.onHookEvent('t1', 'Elicitation')).toBe('skipped-debounced')
    expect(n.onHookEvent('t2', 'PreToolUse')).toBe('pushed') // 跨任务独立
    expect(pushed).toHaveLength(2)
    n.dispose()
  })

  it('禁用/无 URL → skipped-disabled；payload 含任务名（spawn 注册名）与时间', async () => {
    writeConfig({ url: '', enabled: true })
    expect(makeNotifier().onHookEvent('t1', 'PermissionRequest')).toBe('skipped-disabled')

    writeConfig({ url: 'https://hook.example/x', enabled: false })
    expect(makeNotifier().onHookEvent('t1', 'PermissionRequest')).toBe('skipped-disabled')

    writeConfig({ url: 'https://hook.example/x', enabled: true })
    const n = makeNotifier()
    n.onHookEvent('t1', 'PermissionRequest')
    n.onHookEvent('t9', 'PermissionRequest') // 无名任务 → taskId 前 8 位
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    expect(String(pushed[0]!.body.text)).toContain('登录重构')
    expect(String(pushed[1]!.body.text)).toContain('t9')
  })

  it('payload 形状（generic {text} / wecom markdown / dingtalk markdown+title）', () => {
    expect(buildNotifyPayload('generic', 'hi')).toEqual({ text: 'hi' })
    expect(buildNotifyPayload('wecom', 'hi')).toEqual({
      msgtype: 'markdown',
      markdown: { content: 'hi' }
    })
    expect(buildNotifyPayload('dingtalk', 'hi')).toEqual({
      msgtype: 'markdown',
      markdown: { title: 'SSH Workbench', content: 'hi' }
    })
    expect(isAwaitingHookEvent('PermissionRequest')).toBe(true)
    expect(isAwaitingHookEvent('Stop')).toBe(false)
  })
})

describe('loadNotifyExtras（v2.2.0 events/answer 配置层）', () => {
  const writeCfg = (obj: unknown): void => {
    mkdirSync(join(home, '.cwb'), { recursive: true })
    writeFileSync(join(home, '.cwb', 'notify.json'), JSON.stringify(obj))
  }

  it('无配置/损坏 → 安全缺省（events 全开、answer 关）', () => {
    expect(loadNotifyExtras(home)).toEqual({
      events: DEFAULT_EVENT_FLAGS,
      answer: DEFAULT_ANSWER_CONFIG
    })
    writeCfg('not json')
    expect(loadNotifyExtras(home).answer.enabled).toBe(false)
    expect(loadNotifyExtras(home).events.stop).toBe(true)
  })

  it('events 逐项覆盖，非布尔字段回落缺省（部分损坏不影响其余）', () => {
    writeCfg({ url: 'https://x', enabled: true, events: { stop: false, exit: 'yes' } })
    const { events } = loadNotifyExtras(home)
    expect(events).toEqual({ awaiting: true, stop: false, stopFailure: true, exit: true })
  })

  it('answer：enabled 须严格 true；数值越界回落缺省', () => {
    writeCfg({ answer: { enabled: 1, ttlSec: 30, presenceMin: 5, pagePort: 0 } })
    let a = loadNotifyExtras(home).answer
    expect(a.enabled).toBe(false) // 非布尔 true 不认
    expect(a.ttlSec).toBe(900) // 30 < 60 越界
    expect(a.presenceMin).toBe(5)
    writeCfg({ answer: { enabled: true, ttlSec: 1200, presenceMin: 5, pagePort: 18080 } })
    a = loadNotifyExtras(home).answer
    expect(a).toEqual({ enabled: true, ttlSec: 1200, presenceMin: 5, tunnel: 'cloudflare', pagePort: 18080 })
  })

  it('与 loadNotifyConfig 同文件并存（互不干扰，旧返回形状不变）', () => {
    writeCfg({
      url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      enabled: true,
      channel: 'wecom',
      events: { stop: false },
      answer: { enabled: true }
    })
    expect(loadNotifyConfig(home)).toEqual({
      url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
      enabled: true,
      channel: 'wecom'
    })
    expect(loadNotifyExtras(home).events.stop).toBe(false)
    expect(loadNotifyExtras(home).answer.enabled).toBe(true)
  })
})

describe('v2.2.0 完成/停止推送（分桶/10s 合并/终态穿透）', () => {
  const text = (i: number): string => String(pushed[i]!.body.text)
  const enable = (extra: Record<string, unknown> = {}): void =>
    writeConfig({ url: 'https://hook.example/x', enabled: true, ...extra })

  afterEach(() => vi.useRealTimers())

  it('Stop 60 秒节流：窗内丢弃（仅留桶），窗后重推', () => {
    enable()
    vi.useFakeTimers()
    const n = makeNotifier()
    expect(n.onHookEvent('t1', 'Stop', '{"last_assistant_message":"PONG"}')).toBe('pushed')
    clockNow += 30_000
    expect(n.onHookEvent('t1', 'Stop')).toBe('skipped-debounced')
    clockNow += 40_000 // 距首次 70s
    expect(n.onHookEvent('t1', 'Stop')).toBe('pushed')
    n.dispose()
  })

  it('10 秒合并：Stop + 退出 → 一条「完成并退出」，摘要去代码块/压空白', () => {
    enable()
    vi.useFakeTimers()
    const n = makeNotifier()
    n.onHookEvent('t1', 'Stop', '{"last_assistant_message":"done: ```js\\nx\\n``` ok"}')
    clockNow += 5_000
    expect(n.onTaskExit('t1', 0, false)).toBe('pushed')
    expect(pushed).toHaveLength(1)
    expect(text(0)).toContain('本轮完成并退出')
    expect(text(0)).toContain('> 摘要：done: ok')
    vi.advanceTimersByTime(10_000) // 定时器已取消——不得产生第二条
    expect(pushed).toHaveLength(1)
  })

  it('终态穿透（1.6）：Stop 已推后退出仍必推', () => {
    enable()
    vi.useFakeTimers()
    const n = makeNotifier()
    n.onHookEvent('t1', 'Stop')
    vi.advanceTimersByTime(10_000)
    expect(pushed).toHaveLength(1)
    expect(text(0)).toContain('本轮完成')
    clockNow += 1_000
    expect(n.onTaskExit('t1', 0, false)).toBe('pushed')
    expect(pushed).toHaveLength(2)
    expect(text(1)).toContain('已退出')
  })

  it('退出码映射：非 0 → 异常退出（code N）；显式停止 → 已停止', () => {
    enable()
    const n = makeNotifier()
    n.onTaskExit('t1', 1, false)
    n.onTaskExit('t2', 0, true)
    expect(text(0)).toContain('异常退出（code 1）')
    expect(text(1)).toContain('已停止')
    n.dispose()
  })

  it('awaiting 与 stop 分桶（1.14 回归点）：Stop 后 60 秒内 awaiting 照推', () => {
    enable()
    vi.useFakeTimers()
    const n = makeNotifier()
    n.onHookEvent('t1', 'Stop')
    clockNow += 5_000
    expect(n.onHookEvent('t1', 'PermissionRequest')).toBe('pushed')
    vi.advanceTimersByTime(10_000)
    expect(pushed).toHaveLength(2)
    expect(text(0)).toContain('等待你的答复')
    expect(text(1)).toContain('本轮完成')
    n.dispose()
  })

  it('StopFailure：不节流、带错误首行（terminal 桶）', () => {
    enable()
    const n = makeNotifier()
    n.onHookEvent('t1', 'StopFailure', '{"error":{"message":"rate limited\\nretry later"}}')
    clockNow += 1_000
    n.onHookEvent('t1', 'StopFailure', '{"message":"second\\nmore"}')
    expect(pushed).toHaveLength(2)
    expect(text(0)).toContain('本轮异常结束')
    expect(text(0)).toContain('> 错误：rate limited')
    expect(text(1)).toContain('> 错误：second')
    n.dispose()
  })

  it('events 开关关闭 → skipped-flag（awaiting 保持默认开）', () => {
    enable({ events: { stop: false, exit: false, stopFailure: false } })
    const n = makeNotifier()
    expect(n.onHookEvent('t1', 'Stop')).toBe('skipped-flag')
    expect(n.onHookEvent('t1', 'StopFailure')).toBe('skipped-flag')
    expect(n.onTaskExit('t1', 0, false)).toBe('skipped-flag')
    expect(n.onHookEvent('t1', 'PermissionRequest')).toBe('pushed')
    n.dispose()
  })

  it('flush：停机前把合并窗内的 Stop 补推', () => {
    enable()
    vi.useFakeTimers()
    const n = makeNotifier()
    n.onHookEvent('t1', 'Stop')
    expect(pushed).toHaveLength(0)
    n.flush()
    expect(pushed).toHaveLength(1)
    expect(text(0)).toContain('本轮完成')
  })

  it('文案含项目名与耗时（metaOf）', () => {
    enable()
    const n = new ServerNotifier({
      home,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        pushed.push({ url: _url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response('{"ok":1}')
      }) as typeof fetch,
      now: () => clockNow,
      metaOf: () => ({ name: '登录重构', projectName: 'web-app', startedAt: clockNow - 151_000 })
    })
    n.onTaskExit('t1', 0, false)
    expect(text(0)).toContain('登录重构（web-app）')
    expect(text(0)).toContain('> 耗时 02:31')
    n.dispose()
  })

  it('摘要归一化与耗时格式', () => {
    const long = summarizeAssistantMessage('x'.repeat(300))
    expect(long).toHaveLength(120)
    expect(long!.endsWith('…')).toBe(true)
    expect(summarizeAssistantMessage('a\n\nb\t c')).toBe('a b c')
    expect(summarizeAssistantMessage(undefined)).toBeUndefined()
    expect(summarizeAssistantMessage('```\nonly code\n```')).toBeUndefined()
    expect(formatDuration(151_000)).toBe('02:31')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })
})
