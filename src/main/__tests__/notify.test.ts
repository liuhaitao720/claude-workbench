import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotifyConfig, TaskActivityEvent } from '../../shared/types'

/**
 * v0.5④N notify 单测：注入时钟（可变 clock——同 task-activity 先例）+ 假 fetch 桩。
 * 绝不真打 webhook；防抖/触发/payload 形状/失败静默全覆盖。
 * 调用计数/参数一律读 fetchImpl.mock.calls（mockXxxOnce 会绕过记录型实现）。
 */

import {
  NotifyService,
  buildNotifyPayload,
  inferChannel,
  mergeAnswerConfig,
  mergeEventFlags,
  normalizeAnswerConfig,
  normalizeEventFlags,
  validateWebhookUrl,
  DEFAULT_ANSWER_CONFIG,
  PUSH_DEBOUNCE_MS,
  STOP_MERGE_MS,
  STOP_THROTTLE_MS
} from '../notify'

describe('inferChannel / buildNotifyPayload（三通道形状）', () => {
  it('按 URL 域名推断通道', () => {
    expect(inferChannel('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x')).toBe('wecom')
    expect(inferChannel('https://oapi.dingtalk.com/robot/send?access_token=y')).toBe('dingtalk')
    expect(inferChannel('https://hooks.example.com/zzz')).toBe('generic')
    expect(inferChannel('')).toBe('generic')
  })

  it('payload 形状：wecom={msgtype,markdown.content}；dingtalk={msgtype,markdown.title+content}；generic={text}', () => {
    expect(buildNotifyPayload('wecom', 'hi')).toEqual({ msgtype: 'markdown', markdown: { content: 'hi' } })
    expect(buildNotifyPayload('dingtalk', 'hi')).toEqual({
      msgtype: 'markdown',
      markdown: { title: 'SSH Workbench', content: 'hi' }
    })
    expect(buildNotifyPayload('generic', 'hi')).toEqual({ text: 'hi' })
  })
})

describe('NotifyService', () => {
  let tempDir: string
  let file: string
  let clockNow: number
  let fetchImpl: ReturnType<typeof vi.fn>
  let svc: NotifyService

  const awaiting = (taskId: string): TaskActivityEvent => ({ taskId, activity: 'awaiting' })

  /** 第 n 次（0 基）fetch 的 (url, init) */
  const call = (n: number): { url: string; init: RequestInit } => {
    const c = fetchImpl.mock.calls[n]
    if (!c) throw new Error(`no fetch call #${n}`)
    return { url: c[0] as string, init: c[1] as RequestInit }
  }
  const callCount = (): number => fetchImpl.mock.calls.length
  const bodyOf = (n: number): Record<string, unknown> =>
    JSON.parse(String(call(n).init.body)) as Record<string, unknown>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cwb-notify-'))
    file = join(tempDir, 'notify.json')
    clockNow = 1_000_000
    fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      ({ ok: true, status: 200 } as Response)
    )
    svc = new NotifyService({
      file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clockNow,
      taskNameOf: (id) => (id === 't-1' ? '重构登录' : undefined)
    })
  })
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }))

  const advance = (ms: number): void => {
    clockNow += ms
  }

  it('默认配置 {url:"", enabled:false, channel:"wecom"}（无文件不抛）', () => {
    expect(svc.getConfig()).toEqual({ url: '', enabled: false, channel: 'wecom' })
  })

  it('setWebhook：channel 按 URL 推断、原子写盘（无 .tmp 残留）、空 URL 强制 enabled=false、可读回', () => {
    const saved = svc.setWebhook('https://qyapi.weixin.qq.com/send?key=k', true)
    expect(saved).toEqual({ url: 'https://qyapi.weixin.qq.com/send?key=k', enabled: true, channel: 'wecom' })
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as NotifyConfig
    expect(onDisk).toEqual(saved)
    expect(readdirSync(tempDir).some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(svc.getConfig()).toEqual(saved)

    expect(svc.setWebhook('https://oapi.dingtalk.com/x', true).channel).toBe('dingtalk')
    expect(svc.setWebhook('', true)).toEqual({ url: '', enabled: false, channel: 'generic' })
  })

  it('awaiting 触发：POST 一次（wecom payload 形状 + 任务名入文案 + 方法/头）', () => {
    svc.setWebhook('https://qyapi.weixin.qq.com/send?key=k', true)
    svc.onActivityEvent(awaiting('t-1'))
    expect(callCount()).toBe(1)
    expect(call(0).url).toBe('https://qyapi.weixin.qq.com/send?key=k')
    expect(call(0).init.method).toBe('POST')
    const body = bodyOf(0)
    expect(body.msgtype).toBe('markdown')
    expect(String((body.markdown as { content: string }).content)).toContain('重构登录')
    expect(String((body.markdown as { content: string }).content)).toContain('等待你的答复')
    // 未知任务名回退 taskId 前 8 位
    svc.onActivityEvent(awaiting('abcdefgh-1234'))
    expect(String((bodyOf(1).markdown as { content: string }).content)).toContain('abcdefgh')
  })

  it('非 awaiting（busy/idle）不推送；未启用/空 URL 不推送', () => {
    svc.onActivityEvent({ taskId: 't-1', activity: 'busy' })
    svc.onActivityEvent({ taskId: 't-1', activity: 'idle' })
    expect(callCount()).toBe(0)

    svc.setWebhook('https://qyapi.weixin.qq.com/send?key=k', false) // 配置了但未启用
    svc.onActivityEvent(awaiting('t-1'))
    expect(callCount()).toBe(0)
  })

  it('防抖：同任务 5min 内第二次 awaiting 不推；跨过窗口恢复推送（注入时钟推进）', () => {
    svc.setWebhook('https://hooks.example.com/g', true)
    svc.onActivityEvent(awaiting('t-1'))
    expect(callCount()).toBe(1)

    advance(PUSH_DEBOUNCE_MS - 1)
    svc.onActivityEvent(awaiting('t-1'))
    expect(callCount()).toBe(1) // 窗内静默

    advance(1) // 恰跨过 5min
    svc.onActivityEvent(awaiting('t-1'))
    expect(callCount()).toBe(2)

    // 不同任务互不影响
    svc.onActivityEvent(awaiting('t-2'))
    expect(callCount()).toBe(3)
  })

  it('失败静默：fetch 抛错/非 2xx → console.error、不抛、防抖仍记账（防重试风暴）', async () => {
    const errors: unknown[][] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a)
    })
    try {
      fetchImpl.mockRejectedValueOnce(new Error('network down'))
      svc.setWebhook('https://qyapi.weixin.qq.com/send?key=k', true)
      expect(() => svc.onActivityEvent(awaiting('t-1'))).not.toThrow()
      expect(callCount()).toBe(1)

      svc.onActivityEvent(awaiting('t-1')) // 窗内（含失败在内都记账）
      expect(callCount()).toBe(1)

      advance(PUSH_DEBOUNCE_MS)
      fetchImpl.mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      expect(() => svc.onActivityEvent(awaiting('t-1'))).not.toThrow()
      expect(callCount()).toBe(2)
      // console.error 在 push 的异步 catch 里——冲刷微任务后再断言
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(errors.length).toBeGreaterThanOrEqual(2) // 网络错 + HTTP 500 各一条
    } finally {
      errSpy.mockRestore()
    }
  })

  it('sendTest：立即 POST 固定文案；无 URL 返回 ok:false；网络错误返回 error 不抛', async () => {
    const noUrl = await svc.sendTest()
    expect(noUrl.ok).toBe(false)
    expect(callCount()).toBe(0)

    svc.setWebhook('https://oapi.dingtalk.com/robot/send?access_token=t', true)
    const ok = await svc.sendTest()
    expect(ok).toEqual({ ok: true })
    expect(callCount()).toBe(1)
    const body = bodyOf(0)
    expect(body.msgtype).toBe('markdown')
    expect(String((body.markdown as { title: string }).title)).toBe('SSH Workbench')
    expect(String((body.markdown as { content: string }).content)).toContain('测试推送')

    fetchImpl.mockRejectedValueOnce(new Error('boom'))
    const failed = await svc.sendTest()
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe('boom')
  })

  it('损坏配置文件容错 → 默认配置、不推送', () => {
    writeFileSync(file, '{broken json', 'utf8')
    expect(svc.getConfig()).toEqual({ url: '', enabled: false, channel: 'wecom' })
    svc.onActivityEvent(awaiting('t-1'))
    expect(callCount()).toBe(0)
  })
})

describe('v0.5.4 validateWebhookUrl（误填管理页防护）', () => {
  it('机器人管理页/openBotProfile 地址 → 拒绝并给出正确指引', () => {
    const err = validateWebhookUrl(
      'https://work.weixin.qq.com/wework_admin/common/openBotProfile/24e94e30050d97c2d09e27e7b3024ba424'
    )
    expect(err).not.toBeNull()
    expect(err).toContain('qyapi.weixin.qq.com/cgi-bin/webhook/send')
  })

  it('正确企微/钉钉/通用 URL 与空串合法；非 http(s) 拒绝', () => {
    expect(validateWebhookUrl('')).toBeNull()
    expect(validateWebhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x')).toBeNull()
    expect(validateWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=y')).toBeNull()
    expect(validateWebhookUrl('https://example.com/hook')).toBeNull()
    expect(validateWebhookUrl('ftp://x')).toContain('http')
  })

  it('setWebhook 拒绝管理页地址（抛错不落盘）；postJson 错误带 HTTP 状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwb-notify-v054-'))
    const n = new NotifyService({ file: join(dir, 'n.json') })
    try {
      expect(() =>
        n.setWebhook('https://work.weixin.qq.com/wework_admin/common/openBotProfile/abc', true)
      ).toThrow(/管理页/)
      // 测试推送错误透传：404 mock
      const bad = new NotifyService({
        file: join(dir, 'n2.json'),
        fetchImpl: (async () =>
          ({ ok: false, status: 404, text: async () => '<!DOCTYPE html>404 page' }) as unknown as Response) as typeof fetch
      })
      bad.setWebhook('https://example.com/hook', true) // 同步保存
      const r = await bad.sendTest()
      expect(r.ok).toBe(false)
      expect(r.error).toContain('404')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── v1.2.0 推送文案随语言 ──────────────────────────────────
  it('language=en：推送正文/错误提示英文（任务名与 URL 仍原样）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwb-notify-en-'))
    const posts: string[] = []
    const n = new NotifyService({
      file: join(dir, 'n.json'),
      language: () => 'en',
      taskNameOf: () => 'refactor login',
      fetchImpl: (async (_url: string, init: { body: string }) => {
        posts.push(init.body)
        return { ok: true, status: 200, text: async () => '' } as unknown as Response
      }) as unknown as typeof fetch
    })
    try {
      n.setWebhook('https://example.com/hook', true)
      n.onActivityEvent({ taskId: 't1', activity: 'awaiting' })
      await new Promise((r) => setTimeout(r, 10))
      expect(posts).toHaveLength(1)
      expect(posts[0]).toContain('waiting for your answer')
      expect(posts[0]).toContain('refactor login')

      const missing = await new NotifyService({ file: join(dir, 'n2.json'), language: () => 'en' }).sendTest()
      expect(missing.ok).toBe(false)
      expect(missing.error).toBe('No webhook URL configured')

      expect(() => n.setWebhook('ftp://x', true)).toThrow(/must start with http/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('v2.2.0 配置扩展（events/answer + read-modify-write）', () => {
  let dir: string
  let file: string
  let svc: NotifyService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cwb-notify-ext-'))
    file = join(dir, 'notify.json')
    svc = new NotifyService({ file, language: () => 'zh' })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const onDisk = (): Record<string, unknown> =>
    JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

  it('setWebhook 保留 events/answer/未来未知字段（3.2=A）', () => {
    writeFileSync(
      file,
      JSON.stringify({
        url: 'https://old.example.com/h',
        enabled: false,
        channel: 'generic',
        events: { stop: false },
        answer: { enabled: true, ttlSec: 1200 },
        futureField: { keep: 1 }
      })
    )
    const saved = svc.setWebhook('https://qyapi.weixin.qq.com/h?key=k', true)
    expect(saved).toEqual({
      url: 'https://qyapi.weixin.qq.com/h?key=k',
      enabled: true,
      channel: 'wecom'
    })
    const disk = onDisk()
    expect(disk['events']).toEqual({ stop: false })
    expect(disk['answer']).toEqual({ enabled: true, ttlSec: 1200 })
    expect(disk['futureField']).toEqual({ keep: 1 })
  })

  it('getEvents 缺省全开；setEvents 部分更新且保留未知字段', () => {
    expect(svc.getEvents()).toEqual({ awaiting: true, stop: true, stopFailure: true, exit: true })
    svc.setWebhook('https://example.com/h', true)
    const next = svc.setEvents({ stop: false })
    expect(next).toEqual({ awaiting: true, stop: false, stopFailure: true, exit: true })
    const disk = onDisk()
    expect(disk['url']).toBe('https://example.com/h')
    expect(disk['events']).toEqual(next)
  })

  it('setEvents 忽略非布尔值（防注入）', () => {
    const next = svc.setEvents({ stop: 'no' as unknown as boolean })
    expect(next.stop).toBe(true)
  })

  it('getAnswer 缺省关；setAnswer 合并更新；越界抛错且不落盘', () => {
    expect(svc.getAnswer()).toEqual({
      enabled: false,
      ttlSec: 900,
      presenceMin: 5,
      tunnel: 'cloudflare',
      pagePort: 0
    })
    const next = svc.setAnswer({ enabled: true, ttlSec: 1200, pagePort: 18080 })
    expect(next).toEqual({
      enabled: true,
      ttlSec: 1200,
      presenceMin: 5,
      tunnel: 'cloudflare',
      pagePort: 18080
    })
    expect(onDisk()['answer']).toEqual(next)
    const before = readFileSync(file, 'utf8')
    expect(() => svc.setAnswer({ ttlSec: 10 })).toThrow(/ttlSec/)
    expect(() => svc.setAnswer({ pagePort: 70000 })).toThrow(/pagePort/)
    expect(() => svc.setAnswer({ presenceMin: 0 })).toThrow(/presenceMin/)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('三组配置共存同一文件（setWebhook 不清 events/answer，反之亦然）', () => {
    svc.setEvents({ exit: false })
    svc.setAnswer({ enabled: true, presenceMin: 3 })
    svc.setWebhook('https://example.com/x', true)
    expect(svc.getEvents().exit).toBe(false)
    expect(svc.getAnswer().presenceMin).toBe(3)
    expect(svc.getConfig()).toEqual({ url: 'https://example.com/x', enabled: true, channel: 'generic' })
  })
})

describe('v2.2.0 T2 完成/停止/异常推送（hook + 终态）', () => {
  let tempDir: string
  let file: string
  let clockNow: number
  let fetchImpl: ReturnType<typeof vi.fn>

  const WEBHOOK = 'https://qyapi.weixin.qq.com/send?key=k'
  /** 构造服务（每用例独立防抖/合并态；taskNameOf 固定 t-1 显示名） */
  const newSvc = (extra?: {
    taskMetaOf?: (taskId: string) => { name?: string; projectName?: string; startedAt?: number }
  }): NotifyService =>
    new NotifyService({
      file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clockNow,
      taskNameOf: (id) => (id === 't-1' ? '重构登录' : undefined),
      ...(extra?.taskMetaOf !== undefined ? { taskMetaOf: extra.taskMetaOf } : {})
    })

  const callCount = (): number => fetchImpl.mock.calls.length
  const textOf = (n: number): string => {
    const c = fetchImpl.mock.calls[n]
    if (!c) throw new Error(`no fetch call #${n}`)
    const body = JSON.parse(String((c[1] as RequestInit).body)) as {
      markdown: { content: string }
    }
    return body.markdown.content
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cwb-notify-t2-'))
    file = join(tempDir, 'notify.json')
    clockNow = 1_000_000
    fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 } as Response))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('Stop 排队 10s 合并窗（窗内不推）；到期推一条「本轮完成」+ 单行摘要', () => {
    vi.useFakeTimers()
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    expect(svc.onHookEvent('t-1', 'Stop', JSON.stringify({ last_assistant_message: '改了 3 个文件\n见上' }))).toBe(
      'pushed'
    )
    expect(callCount()).toBe(0)
    clockNow += STOP_MERGE_MS
    vi.advanceTimersByTime(STOP_MERGE_MS)
    expect(callCount()).toBe(1)
    const text = textOf(0)
    expect(text).toContain('本轮完成')
    expect(text).toContain('重构登录')
    expect(text).toContain('摘要：改了 3 个文件 见上')
  })

  it('Stop→exit 10s 内合并为一条「本轮完成并退出」（含摘要，不重复推）', () => {
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    svc.onHookEvent('t-1', 'Stop', JSON.stringify({ last_assistant_message: '已完成' }))
    expect(svc.onTaskExit('t-1', 0, false)).toBe('pushed')
    expect(callCount()).toBe(1)
    const text = textOf(0)
    expect(text).toContain('本轮完成并退出')
    expect(text).toContain('已完成')
  })

  it('SubagentStop / 其他 hook 事件：显式忽略（子 agent 停止不推送）', () => {
    vi.useFakeTimers()
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    expect(svc.onHookEvent('t-1', 'SubagentStop', '{}')).toBe('ignored')
    expect(svc.onHookEvent('t-1', 'PreToolUse', '{}')).toBe('ignored')
    expect(svc.onHookEvent('t-1', 'UserPromptSubmit', '{}')).toBe('ignored')
    vi.advanceTimersByTime(STOP_MERGE_MS)
    expect(callCount()).toBe(0)
  })

  it('Stop 60s 节流：同任务窗内第二次 skipped-debounced（只推一条）', () => {
    vi.useFakeTimers()
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    expect(svc.onHookEvent('t-1', 'Stop')).toBe('pushed')
    clockNow += 1_000
    expect(svc.onHookEvent('t-1', 'Stop')).toBe('skipped-debounced')
    vi.advanceTimersByTime(STOP_MERGE_MS)
    expect(callCount()).toBe(1)
    // 窗过期后恢复
    clockNow += STOP_THROTTLE_MS
    expect(svc.onHookEvent('t-1', 'Stop')).toBe('pushed')
  })

  it('StopFailure：立即推送「本轮异常结束」并取消待推 Stop（不给旧摘要）', () => {
    vi.useFakeTimers()
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    svc.onHookEvent('t-1', 'Stop', JSON.stringify({ last_assistant_message: '旧摘要' }))
    expect(svc.onHookEvent('t-1', 'StopFailure', JSON.stringify({ error: 'API 500 超限' }))).toBe('pushed')
    expect(callCount()).toBe(1)
    const text = textOf(0)
    expect(text).toContain('本轮异常结束')
    expect(text).toContain('错误：API 500 超限')
    expect(text).not.toContain('旧摘要')
    vi.advanceTimersByTime(STOP_MERGE_MS)
    expect(callCount()).toBe(1)
  })

  it('exit 文案：stopped=已停止；exitCode 0/未知=已退出；>0=异常退出（code N）', () => {
    const cases: Array<{ exitCode: number | undefined; stopped: boolean; want: string }> = [
      { exitCode: 0, stopped: true, want: '已停止' },
      { exitCode: 0, stopped: false, want: '已退出' },
      { exitCode: undefined, stopped: false, want: '已退出' },
      { exitCode: 2, stopped: false, want: '异常退出（code 2）' }
    ]
    for (const c of cases) {
      const svc = newSvc()
      svc.setWebhook(WEBHOOK, true)
      expect(svc.onTaskExit('t-1', c.exitCode, c.stopped)).toBe('pushed')
      expect(textOf(callCount() - 1)).toContain(c.want)
    }
  })

  it('事件开关：stop/stopFailure/exit 关闭 → skipped-flag（不发请求）', () => {
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    svc.setEvents({ stop: false })
    expect(svc.onHookEvent('t-1', 'Stop')).toBe('skipped-flag')
    svc.setEvents({ stopFailure: false })
    expect(svc.onHookEvent('t-1', 'StopFailure')).toBe('skipped-flag')
    svc.setEvents({ exit: false })
    expect(svc.onTaskExit('t-1', 0, false)).toBe('skipped-flag')
    expect(callCount()).toBe(0)
  })

  it('未启用/空 URL：skipped-disabled；flush 在退出前把窗内 Stop 推掉', () => {
    const off = newSvc()
    expect(off.onHookEvent('t-1', 'Stop')).toBe('skipped-disabled')
    expect(off.onTaskExit('t-1', 0, false)).toBe('skipped-disabled')

    vi.useFakeTimers()
    const svc = newSvc()
    svc.setWebhook(WEBHOOK, true)
    svc.onHookEvent('t-1', 'Stop', JSON.stringify({ last_assistant_message: '收尾' }))
    svc.flush()
    expect(callCount()).toBe(1)
    expect(textOf(0)).toContain('收尾')
    vi.advanceTimersByTime(STOP_MERGE_MS)
    expect(callCount()).toBe(1) // 定时器已清理，不重复推
  })

  it('远程 override：用 VM 侧配置推送且不受本地 events 开关影响', () => {
    const svc = newSvc()
    // 本地未配置（enabled=false）+ 本地关掉 stop——override 仍推
    svc.setEvents({ stop: false })
    const remote: NotifyConfig = { url: 'https://oapi.dingtalk.com/robot/send?x=1', enabled: true, channel: 'dingtalk' }
    expect(svc.onHookEvent('t-1', 'Stop', undefined, remote)).toBe('pushed')
    expect(svc.onTaskExit('t-1', 0, false, remote)).toBe('pushed')
    expect(callCount()).toBe(1) // Stop 被 exit 合并
    expect((fetchImpl.mock.calls[0]![0] as string)).toBe(remote.url)
    expect(textOf(0)).toContain('本轮完成并退出')
  })

  it('taskMetaOf：文案含「名称（项目）」与耗时 mm:ss；缺起始时刻只给时间', () => {
    const svc = newSvc({
      taskMetaOf: () => ({ name: '重构登录', projectName: 'claude-workbench', startedAt: clockNow - 65_000 })
    })
    svc.setWebhook(WEBHOOK, true)
    svc.onTaskExit('t-1', 0, false)
    const text = textOf(0)
    expect(text).toContain('重构登录（claude-workbench）')
    expect(text).toContain('耗时 01:05')

    const svc2 = newSvc({ taskMetaOf: () => ({ name: '备用' }) })
    svc2.setWebhook(WEBHOOK, true)
    svc2.onTaskExit('t-1', 0, false)
    expect(textOf(1)).not.toContain('> 耗时')
  })
})

describe('v2.2.0 配置归一化/部分更新（本地与远程共用同一套语义）', () => {
  it('normalizeEventFlags：非法形状全默认；逐键保留布尔、忽略非布尔', () => {
    expect(normalizeEventFlags(null)).toEqual({ awaiting: true, stop: true, stopFailure: true, exit: true })
    expect(normalizeEventFlags({ awaiting: false, stop: 'yes', exit: 0 })).toEqual({
      awaiting: false,
      stop: true,
      stopFailure: true,
      exit: true
    })
  })

  it('normalizeAnswerConfig：越界数值回落缺省；enabled 仅 ===true 生效；隧道固定 cloudflare', () => {
    expect(normalizeAnswerConfig(undefined)).toEqual(DEFAULT_ANSWER_CONFIG)
    expect(
      normalizeAnswerConfig({
        enabled: 1,
        ttlSec: 59,
        presenceMin: 1_441,
        tunnel: 'ngrok',
        pagePort: 70_000
      })
    ).toEqual({ ...DEFAULT_ANSWER_CONFIG, enabled: false })
    expect(
      normalizeAnswerConfig({ enabled: true, ttlSec: 3_600, presenceMin: 30, pagePort: 18_080 })
    ).toEqual({ enabled: true, ttlSec: 3_600, presenceMin: 30, tunnel: 'cloudflare', pagePort: 18_080 })
  })

  it('mergeEventFlags：只接受布尔补丁', () => {
    const base = { awaiting: true, stop: true, stopFailure: true, exit: true }
    expect(mergeEventFlags(base, { awaiting: false, exit: 'x' as unknown as boolean })).toEqual({
      awaiting: false,
      stop: true,
      stopFailure: true,
      exit: true
    })
  })

  it('mergeAnswerConfig：合法补丁生效；越界抛可操作错误', () => {
    expect(mergeAnswerConfig(DEFAULT_ANSWER_CONFIG, { enabled: true, ttlSec: 1_800 })).toEqual({
      ...DEFAULT_ANSWER_CONFIG,
      enabled: true,
      ttlSec: 1_800
    })
    expect(() => mergeAnswerConfig(DEFAULT_ANSWER_CONFIG, { ttlSec: 30 })).toThrow(/ttlSec/)
    expect(() => mergeAnswerConfig(DEFAULT_ANSWER_CONFIG, { presenceMin: 0 })).toThrow(/presenceMin/)
    expect(() => mergeAnswerConfig(DEFAULT_ANSWER_CONFIG, { pagePort: 65_536 })).toThrow(/pagePort/)
  })
})
