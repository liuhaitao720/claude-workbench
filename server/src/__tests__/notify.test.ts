import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ServerNotifier,
  buildNotifyPayload,
  inferChannel,
  isAwaitingHookEvent,
  loadNotifyConfig,
  loadNotifyExtras,
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
  it('仅 awaiting 三源触发（Stop/UserPromptSubmit 忽略）；同任务 5 分钟防抖；跨任务独立', () => {
    writeConfig({ url: 'https://hook.example/x', enabled: true })
    const n = makeNotifier()
    expect(n.onHookEvent('t1', 'Stop')).toBe('ignored')
    expect(n.onHookEvent('t1', 'UserPromptSubmit')).toBe('ignored')
    expect(n.onHookEvent('t1', 'PermissionRequest')).toBe('pushed')
    clockNow += 60_000
    expect(n.onHookEvent('t1', 'Elicitation')).toBe('skipped-debounced')
    expect(n.onHookEvent('t2', 'PreToolUse')).toBe('pushed') // 跨任务独立
    expect(pushed).toHaveLength(2)
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
