/**
 * v2.0.2 服务器侧 webhook 推送（用户指令：推送移植服务器侧，URL 存服务器端）。
 *
 * 触发：claude hook 直 POST 到 server（/hook/<Event>）——PermissionRequest/
 * Elicitation/PreToolUse（=客户端 awaiting 三源，等待用户确认）。Stop 等
 * 其余事件不推送（与客户端 notify 语义对齐：只推「等待确认」）。
 *
 * 配置：VM 侧 ~/.cwb/notify.json（{url,enabled,channel}——客户端设置页经 SSH
 * 写入的同一文件；服务器读取执行推送。客户端离线时推送照常（保活会话自主提醒）。
 *
 * 红线（对齐 8.1=A）：仅元数据进日志——不落终端内容；fetch 失败静默计数。
 * 防抖：同任务 5 分钟（对齐客户端 PUSH_DEBOUNCE_MS）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerNotifyConfig {
  url: string
  enabled: boolean
  channel: 'wecom' | 'dingtalk' | 'generic'
}

/** 同任务防抖窗（对齐客户端 src/main/notify.ts） */
export const PUSH_DEBOUNCE_MS = 5 * 60 * 1000
/** webhook POST 超时 */
const FETCH_TIMEOUT_MS = 3_000

/** 触发推送的 hook 事件集（awaiting 三源） */
const AWAITING_EVENTS = new Set(['PermissionRequest', 'Elicitation', 'PreToolUse'])

export function isAwaitingHookEvent(event: string): boolean {
  return AWAITING_EVENTS.has(event)
}

/** 容错读配置（缺失/损坏 → 禁用缺省——推送是旁路，绝不抛） */
export function loadNotifyConfig(home: string): ServerNotifyConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, '.cwb', 'notify.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return disabled()
    const o = parsed as Record<string, unknown>
    const url = typeof o['url'] === 'string' ? o['url'] : ''
    const enabled = o['enabled'] === true && url.length > 0
    const channel =
      o['channel'] === 'wecom' || o['channel'] === 'dingtalk' || o['channel'] === 'generic'
        ? o['channel']
        : inferChannel(url)
    return { url, enabled, channel }
  } catch {
    return disabled()
  }
}

function disabled(): ServerNotifyConfig {
  return { url: '', enabled: false, channel: 'generic' }
}

/** 按 URL 推断通道（镜像客户端 inferChannel） */
export function inferChannel(url: string): ServerNotifyConfig['channel'] {
  const u = url.toLowerCase()
  if (u.includes('qyapi.weixin.qq.com')) return 'wecom'
  if (u.includes('oapi.dingtalk.com')) return 'dingtalk'
  return 'generic'
}

/** payload 形状（镜像客户端 buildNotifyPayload） */
export function buildNotifyPayload(
  channel: ServerNotifyConfig['channel'],
  text: string
): Record<string, unknown> {
  if (channel === 'wecom') return { msgtype: 'markdown', markdown: { content: text } }
  if (channel === 'dingtalk')
    return { msgtype: 'markdown', markdown: { title: 'SSH Workbench', content: text } }
  return { text }
}

export interface ServerNotifierOptions {
  /** HOME（配置文件定位） */
  home: string
  /** fetch 实现（测试注入） */
  fetchImpl?: typeof fetch
  /** 时间源（测试注入） */
  now?: () => number
  /** 任务名查找（spawn 注册表收录的 name；缺省 taskId 前 8 位） */
  taskNameOf?: (taskId: string) => string | undefined
  /** 元数据日志（8.1=A：只记 sent/failed/skipped，不记内容） */
  log?: (level: 'info' | 'warn', message: string) => void
}

export class ServerNotifier {
  private readonly lastPushAt = new Map<string, number>()
  private readonly pushed = new Set<string>()

  constructor(private readonly opts: ServerNotifierOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  /**
   * hook 事件入口（cwb-server /hook 路由调用）。返回值供测试/日志断言：
   * 'pushed' | 'skipped-disabled' | 'skipped-debounced' | 'ignored'。
   */
  onHookEvent(taskId: string, event: string): 'pushed' | 'skipped-disabled' | 'skipped-debounced' | 'ignored' {
    if (!isAwaitingHookEvent(event)) return 'ignored'
    const config = loadNotifyConfig(this.opts.home)
    if (!config.enabled || config.url.length === 0) return 'skipped-disabled'
    const at = this.opts.now?.() ?? Date.now()
    const last = this.lastPushAt.get(taskId)
    if (last !== undefined && at - last < PUSH_DEBOUNCE_MS) return 'skipped-debounced'
    this.lastPushAt.set(taskId, at)
    const name = this.opts.taskNameOf?.(taskId) ?? taskId.slice(0, 8)
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false })
    // 文案对齐客户端 zh 版 notify.awaiting（服务器无 i18n——用户态中文）
    const text = `【SSH Workbench】任务「${name}」等待你的答复（权限确认/选择），请回电脑处理\n> ${when}`
    void this.push(config, text, taskId)
    return 'pushed'
  }

  /** 测试可见性：本会话已成功推送过的任务 */
  hasPushed(taskId: string): boolean {
    return this.pushed.has(taskId)
  }

  private async push(
    config: ServerNotifyConfig,
    text: string,
    taskId: string
  ): Promise<void> {
    try {
      const res = await this.fetchImpl(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildNotifyPayload(config.channel, text)),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.pushed.add(taskId)
      this.opts.log?.('info', `notify pushed (${taskId.slice(0, 8)})`)
    } catch (err) {
      this.opts.log?.('warn', `notify push failed (${taskId.slice(0, 8)}): ${errText(err)}`)
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n', 1)[0]!.slice(0, 120) : String(err)
}
