import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { NotifyConfig, TaskActivityEvent } from '../shared/types'

/**
 * v0.5④N webhook 推送（企业微信/钉钉/通用 JSON）。
 *
 * 配置持久化 userData/notify.json（原子写 tmp+rename；URL 属凭据仅存本地，
 * 不入仓库——红线 1）。channel 按 URL 域名推断：qyapi.weixin.qq.com→wecom /
 * oapi.dingtalk.com→dingtalk / 其他→generic。
 *
 * 触发接线（终版评审高1）：组合根 startTaskActivityServer({ onActivity }) 回调
 * 过滤 activity==='awaiting'（勿挂 markStatus——它只承载 stopped/exited 终态）；
 * 同任务 5min 防抖；fetch POST 3s 超时；失败静默 + console.error 不抛
 * （推送是旁路提醒，绝不阻塞状态机）。
 */

/** 同任务同状态推送防抖窗 */
export const PUSH_DEBOUNCE_MS = 5 * 60 * 1000
/** webhook POST 超时 */
export const FETCH_TIMEOUT_MS = 3_000

export interface NotifyServiceOptions {
  /** 配置文件路径（组合根注入 join(userData, 'notify.json')） */
  file: string
  /** fetch 实现（测试注入桩） */
  fetchImpl?: typeof fetch
  /** 时间源（测试注入；同 task-activity 的 now 先例） */
  now?: () => number
  /** 任务显示名查找（推送文案含任务名；缺省用 taskId 前 8 位） */
  taskNameOf?: (taskId: string) => string | undefined
}

/**
 * Webhook URL 校验（v0.5.4：用户误填机器人管理页——给出可操作指引而非静默 404）。
 * 返回 null=合法；字符串=拒绝原因。
 */
export function validateWebhookUrl(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed.length === 0) return null // 空=禁用，合法
  if (/work\.weixin\.qq\.com\/wework_admin|openBotProfile/i.test(trimmed)) {
    return '这是企业微信机器人的管理页地址，不是 Webhook 推送地址。请在 群设置 → 群机器人 → 复制 Webhook 地址（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）'
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'URL 须以 http:// 或 https:// 开头'
  }
  return null
}

/** 按 URL 推断通道（导出便于单测） */
export function inferChannel(url: string): NotifyConfig['channel'] {
  const u = url.toLowerCase()
  if (u.includes('qyapi.weixin.qq.com')) return 'wecom'
  if (u.includes('oapi.dingtalk.com')) return 'dingtalk'
  return 'generic'
}

/** 按通道构造 payload（导出便于单测；形状见 spec-v0.5 ④N） */
export function buildNotifyPayload(channel: NotifyConfig['channel'], text: string): Record<string, unknown> {
  if (channel === 'wecom') {
    return { msgtype: 'markdown', markdown: { content: text } }
  }
  if (channel === 'dingtalk') {
    return { msgtype: 'markdown', markdown: { title: 'Claude Workbench', content: text } }
  }
  return { text }
}

export class NotifyService {
  constructor(private readonly opts: NotifyServiceOptions) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  /** 读取配置（容错：缺失/损坏 → 默认 {url:'', enabled:false, channel:'wecom'}） */
  getConfig(): NotifyConfig {
    return this.load()
  }

  /** 保存 webhook 配置（channel 按 URL 推断；URL 为空强制 enabled=false）并返回 */
  setWebhook(url: string, enabled: boolean): NotifyConfig {
    const trimmed = url.trim()
    const invalid = validateWebhookUrl(trimmed)
    if (invalid !== null) throw new Error(invalid)
    const config: NotifyConfig = {
      url: trimmed,
      enabled: enabled && trimmed.length > 0,
      channel: inferChannel(trimmed)
    }
    const tmp = `${this.opts.file}.tmp`
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
    renameSync(tmp, this.opts.file)
    return { ...config }
  }

  /**
   * activity 事件入口（组合根接 onActivity——每事件调用，非 awaiting 直接忽略）。
   * 防抖命中/未启用静默跳过；推送本身 fire-and-forget 且吞错（不抛、不 reject）。
   */
  onActivityEvent(event: TaskActivityEvent): void {
    if (event.activity !== 'awaiting') return
    const config = this.load()
    if (!config.enabled || config.url.length === 0) return
    const at = this.now()
    const last = this.lastPushAt.get(event.taskId)
    if (last !== undefined && at - last < PUSH_DEBOUNCE_MS) return
    this.lastPushAt.set(event.taskId, at)
    const name = this.opts.taskNameOf?.(event.taskId) ?? event.taskId.slice(0, 8)
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false })
    const text = `【Claude Workbench】任务「${name}」等待你的答复（权限确认/选择），请回电脑处理\n> ${when}`
    void this.push(config, text)
  }

  /** 立即推送固定测试文案（设置面板「测试推送」）；错误显式返回不静默 */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const config = this.load()
    if (config.url.length === 0) return { ok: false, error: '未配置 webhook URL' }
    try {
      await this.postJson(config, '【Claude Workbench】测试推送：通知配置已生效')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** taskId → 最近一次推送时刻（防抖表） */
  private readonly lastPushAt = new Map<string, number>()

  /** 推送（失败静默 + console.error——旁路提醒不阻塞状态机） */
  private async push(config: NotifyConfig, text: string): Promise<void> {
    try {
      await this.postJson(config, text)
    } catch (err) {
      console.error('[cwb] notify push failed:', err instanceof Error ? err.message : err)
    }
  }

  private async postJson(config: NotifyConfig, text: string): Promise<void> {
    const payload = buildNotifyPayload(config.channel, text)
    const res = await this.fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) {
      let snippet = ''
      try {
        snippet = (await res.text()).replace(/s+/g, ' ').slice(0, 80)
      } catch {
        // 无 body 忽略
      }
      throw new Error(`webhook 响应 HTTP ${res.status}${snippet ? '：' + snippet : ''}`)
    }
  }

  private load(): NotifyConfig {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.opts.file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const rec = parsed as Record<string, unknown>
        const url = typeof rec['url'] === 'string' ? rec['url'] : ''
        const enabled = rec['enabled'] === true
        const channel =
          rec['channel'] === 'wecom' || rec['channel'] === 'dingtalk' || rec['channel'] === 'generic'
            ? rec['channel']
            : 'wecom'
        return { url, enabled, channel }
      }
      return { url: '', enabled: false, channel: 'wecom' }
    } catch {
      return { url: '', enabled: false, channel: 'wecom' }
    }
  }
}
