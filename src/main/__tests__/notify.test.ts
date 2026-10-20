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

import { NotifyService, buildNotifyPayload, inferChannel, validateWebhookUrl, PUSH_DEBOUNCE_MS } from '../notify'

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
      markdown: { title: 'Claude Workbench', content: 'hi' }
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
    expect(String((body.markdown as { title: string }).title)).toBe('Claude Workbench')
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
})
