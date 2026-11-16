/**
 * v2.0.2 服务器侧 webhook 推送（用户指令：推送移植服务器侧，URL 存服务器端）。
 * v2.2.0：新增完成/停止/异常/退出推送（1.1~1.18）与分桶节流（1.14）。
 *
 * 触发：claude hook 直 POST 到 server（/hook/<Event>）+ PTY 退出/显式停止：
 * - awaiting：PermissionRequest/Elicitation/PreToolUse（5 分钟桶）
 * - stop：Stop（每轮结束；60 秒桶 + 10 秒合并窗）
 * - stopFailure：StopFailure（异常结束；terminal，不节流）
 * - exit：PTY 退出/显式停止（terminal，不节流，穿透 1.6）
 *
 * 配置：VM 侧 ~/.cwb/notify.json（{url,enabled,channel,events,answer}——客户端
 * 设置页经 SSH 写入的同一文件；服务器读取执行推送）。客户端离线时推送照常。
 *
 * 红线（对齐 8.1=A）：仅元数据进日志——摘要/错误行只进 webhook 文案，不写日志、
 * 不落盘、不进留痕；fetch 失败静默计数。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerNotifyConfig {
  url: string
  enabled: boolean
  channel: 'wecom' | 'dingtalk' | 'generic'
}

/** awaiting 桶防抖窗（对齐客户端 src/main/notify.ts） */
export const PUSH_DEBOUNCE_MS = 5 * 60 * 1000
/** Stop 桶节流窗（1.5=A：同任务 60 秒合并） */
export const STOP_THROTTLE_MS = 60 * 1000
/** Stop→exit 合并窗（1.7=A：10 秒内到达的退出合并为一条） */
export const STOP_MERGE_MS = 10 * 1000
/** 任务退出后桶表保留时长（容忍迟到 hook；1.18：退出即清理） */
export const BUCKET_CLEANUP_MS = 60 * 1000
/** webhook POST 超时 */
const FETCH_TIMEOUT_MS = 3_000
/** 摘要单行上限（D1/A2） */
const SUMMARY_MAX_CHARS = 120

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

/** 推送事件开关（v2.2.0；缺省全开——1.13=A 完成类推送默认生效） */
export interface NotifyEventFlags {
  awaiting: boolean
  stop: boolean
  stopFailure: boolean
  exit: boolean
}

/** 手机答复配置（v2.2.0；缺省关——2.23=A 安全姿态变更须显式开启） */
export interface AnswerConfig {
  enabled: boolean
  /** 一次性 token TTL（秒） */
  ttlSec: number
  /** 桌面在场判定阈值（分钟） */
  presenceMin: number
  tunnel: 'cloudflare'
  /** 应答页监听端口（0=OS 动态分配） */
  pagePort: number
}

export const DEFAULT_EVENT_FLAGS: NotifyEventFlags = {
  awaiting: true,
  stop: true,
  stopFailure: true,
  exit: true
}

export const DEFAULT_ANSWER_CONFIG: AnswerConfig = {
  enabled: false,
  ttlSec: 900,
  presenceMin: 5,
  tunnel: 'cloudflare',
  pagePort: 0
}

/**
 * 扩展配置读取（3.1：events/answer 与 url/enabled/channel 同一文件）。
 * 与 loadNotifyConfig 分开读，保持既有返回形状不变（旧单测/调用方零改动）；
 * 缺失/损坏字段一律安全缺省，绝不抛。
 */
export function loadNotifyExtras(home: string): {
  events: NotifyEventFlags
  answer: AnswerConfig
} {
  let o: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, '.cwb', 'notify.json'), 'utf8'))
    if (isPlainObj(parsed)) o = parsed
  } catch {
    /* 缺失/损坏 → 全部缺省 */
  }
  const ev = isPlainObj(o['events']) ? o['events'] : {}
  const an = isPlainObj(o['answer']) ? o['answer'] : {}
  const flag = (k: keyof NotifyEventFlags): boolean =>
    typeof ev[k] === 'boolean' ? (ev[k] as boolean) : DEFAULT_EVENT_FLAGS[k]
  const int = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def
  return {
    events: {
      awaiting: flag('awaiting'),
      stop: flag('stop'),
      stopFailure: flag('stopFailure'),
      exit: flag('exit')
    },
    answer: {
      enabled: an['enabled'] === true,
      ttlSec: int(an['ttlSec'], DEFAULT_ANSWER_CONFIG.ttlSec, 60, 86_400),
      presenceMin: int(an['presenceMin'], DEFAULT_ANSWER_CONFIG.presenceMin, 1, 1_440),
      tunnel: 'cloudflare',
      pagePort: int(an['pagePort'], DEFAULT_ANSWER_CONFIG.pagePort, 0, 65_535)
    }
  }
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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

/**
 * 回答摘要归一化（D1/A2）：去代码块 → 压空白 → 单行截断 120 字符。
 * 摘要只进 webhook 文案；不落盘不进日志（G4 已登记内容出内网）。
 */
export function summarizeAssistantMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ') // 去围栏代码块（含内容）
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return undefined
  return text.length > SUMMARY_MAX_CHARS
    ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : text
}

/** 耗时格式：<1h=mm:ss，否则 h:mm:ss */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 任务元数据（推送文案用；注册表提供，退出后 60 秒内仍可查） */
export interface TaskPushMeta {
  name?: string
  projectName?: string
  /** 任务创建时刻（epoch ms） */
  startedAt?: number
}

export type PushOutcome =
  | 'pushed'
  | 'skipped-disabled'
  | 'skipped-debounced'
  | 'skipped-flag'
  | 'ignored'

export interface ServerNotifierOptions {
  /** HOME（配置文件定位） */
  home: string
  /** fetch 实现（测试注入） */
  fetchImpl?: typeof fetch
  /** 时间源（测试注入） */
  now?: () => number
  /** 任务名查找（spawn 注册表收录的 name；缺省 taskId 前 8 位） */
  taskNameOf?: (taskId: string) => string | undefined
  /** 任务元数据查找（名称/项目/起始时刻；缺省回退 taskNameOf） */
  metaOf?: (taskId: string) => TaskPushMeta | undefined
  /** 元数据日志（8.1=A：只记 sent/failed/skipped，不记内容） */
  log?: (level: 'info' | 'warn', message: string) => void
}

interface PendingStop {
  timer: NodeJS.Timeout
  summary?: string
  at: number
}

export class ServerNotifier {
  /** awaiting 桶（5 分钟/任务） */
  private readonly awaitingAt = new Map<string, number>()
  /** stop 桶（60 秒/任务；终态不受它限制——1.6 穿透） */
  private readonly stopAt = new Map<string, number>()
  /** 10 秒合并窗待推的 Stop（1.7） */
  private readonly pendingStops = new Map<string, PendingStop>()
  /** 任务退出后桶表清理定时器（1.18） */
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>()
  private readonly pushed = new Set<string>()

  constructor(private readonly opts: ServerNotifierOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now
  }

  /**
   * hook 事件入口（cwb-server /hook 路由调用）。返回值供测试/日志断言。
   * bodyText=原始 POST body（可选；Stop 的 last_assistant_message 用作摘要）。
   * url=手机答复链接（v2.2.0：挂起成功时由 cwb-server 传入——awaiting 文案带链接）。
   * 注意：Stop 返回 'pushed' 表示已排入 10 秒合并窗，真正 POST 在窗到期时。
   */
  onHookEvent(taskId: string, event: string, bodyText?: string, url?: string): PushOutcome {
    // 子 agent 停止不推送（用户 2026-11-16 指令；settings 未订阅该 hook，此处兜底）
    if (event === 'SubagentStop') return 'ignored'
    const config = loadNotifyConfig(this.opts.home)
    if (!config.enabled || config.url.length === 0) return 'skipped-disabled'
    const { events } = loadNotifyExtras(this.opts.home)
    const at = this.now()
    if (isAwaitingHookEvent(event)) {
      if (!events.awaiting) return 'skipped-flag'
      const last = this.awaitingAt.get(taskId)
      if (last !== undefined && at - last < PUSH_DEBOUNCE_MS) return 'skipped-debounced'
      this.awaitingAt.set(taskId, at)
      this.pushText(config, this.awaitingText(taskId, at, url), taskId)
      return 'pushed'
    }
    if (event === 'Stop') {
      if (!events.stop) return 'skipped-flag'
      const last = this.stopAt.get(taskId)
      if (last !== undefined && at - last < STOP_THROTTLE_MS) return 'skipped-debounced'
      this.stopAt.set(taskId, at)
      this.armStopMerge(taskId, config, at, parseHookBody(bodyText))
      return 'pushed'
    }
    if (event === 'StopFailure') {
      if (!events.stopFailure) return 'skipped-flag'
      this.cancelPendingStop(taskId)
      const detail = pickFailureLine(parseHookBody(bodyText))
      this.pushText(config, this.failureText(taskId, at, detail), taskId)
      return 'pushed'
    }
    return 'ignored'
  }

  /**
   * 任务退出/显式停止入口（cwb-server registry.onTaskExit → 此）。
   * 10 秒合并窗内的 Stop 与本次退出合并为一条（1.7）；否则穿透节流必推（1.6）。
   */
  onTaskExit(taskId: string, exitCode: number, stopped: boolean): PushOutcome {
    const config = loadNotifyConfig(this.opts.home)
    this.scheduleCleanup(taskId)
    const pending = this.pendingStops.get(taskId)
    this.cancelPendingStop(taskId)
    if (!config.enabled || config.url.length === 0) return 'skipped-disabled'
    const { events } = loadNotifyExtras(this.opts.home)
    if (!events.exit) return 'skipped-flag'
    const at = this.now()
    this.pushText(
      config,
      pending !== undefined
        ? this.mergedExitText(taskId, at, exitCode, stopped, pending.summary)
        : this.exitText(taskId, at, exitCode, stopped),
      taskId
    )
    return 'pushed'
  }

  /** 测试可见性：本会话已成功推送过的任务 */
  hasPushed(taskId: string): boolean {
    return this.pushed.has(taskId)
  }

  /** 停机前把 10 秒窗内的 Stop 立即推掉（不丢消息），并清理全部定时器 */
  flush(): void {
    const config = loadNotifyConfig(this.opts.home)
    for (const [taskId, pending] of [...this.pendingStops]) {
      clearTimeout(pending.timer)
      this.pendingStops.delete(taskId)
      if (config.enabled && config.url.length > 0) {
        this.pushText(config, this.stopText(taskId, pending.at, pending.summary), taskId)
      }
    }
    this.dispose()
  }

  /** 丢弃全部定时器（不推送；进程退出路径） */
  dispose(): void {
    for (const [, p] of this.pendingStops) clearTimeout(p.timer)
    this.pendingStops.clear()
    for (const [, t] of this.cleanupTimers) clearTimeout(t)
    this.cleanupTimers.clear()
  }

  // ── 内部：节流/合并 ───────────────────────────────────────────────────

  private armStopMerge(
    taskId: string,
    config: ServerNotifyConfig,
    at: number,
    body: Record<string, unknown> | undefined
  ): void {
    const summary = summarizeAssistantMessage(body?.['last_assistant_message'])
    const timer = setTimeout(() => {
      this.pendingStops.delete(taskId)
      this.pushText(config, this.stopText(taskId, at, summary), taskId)
    }, STOP_MERGE_MS)
    timer.unref?.()
    const prev = this.pendingStops.get(taskId)
    if (prev !== undefined) clearTimeout(prev.timer)
    this.pendingStops.set(taskId, { timer, ...(summary !== undefined ? { summary } : {}), at })
  }

  private cancelPendingStop(taskId: string): PendingStop | undefined {
    const pending = this.pendingStops.get(taskId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pendingStops.delete(taskId)
    }
    return pending
  }

  /** 退出后 60 秒清理桶表（容忍迟到 hook；1.18） */
  private scheduleCleanup(taskId: string): void {
    const existing = this.cleanupTimers.get(taskId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(taskId)
      this.awaitingAt.delete(taskId)
      this.stopAt.delete(taskId)
    }, BUCKET_CLEANUP_MS)
    timer.unref?.()
    this.cleanupTimers.set(taskId, timer)
  }

  // ── 内部：文案 ───────────────────────────────────────────────────────

  /** 任务标签：「名称（项目）」；名称缺省 taskId 前 8 位 */
  private label(taskId: string): string {
    const meta = this.opts.metaOf?.(taskId)
    const name = meta?.name ?? this.opts.taskNameOf?.(taskId) ?? taskId.slice(0, 8)
    return meta?.projectName !== undefined && meta.projectName !== ''
      ? `${name}（${meta.projectName}）`
      : name
  }

  /** `> 耗时 mm:ss · 时间` 行；无起始时刻则只给时间 */
  private metaLine(taskId: string, at: number): string {
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false })
    const startedAt = this.opts.metaOf?.(taskId)?.startedAt
    if (startedAt === undefined || !Number.isFinite(startedAt) || at < startedAt) {
      return `> ${when}`
    }
    return `> 耗时 ${formatDuration(at - startedAt)} · ${when}`
  }

  /**
   * awaiting 文案：未挂起=原「请回电脑处理」；挂起成功=带链接（1.11/设计 §2.2）。
   * 链接只在通知渠道可见（token 一次性 + 900s TTL 兜底——2.5/2.6 已确认接受群发风险）。
   */
  private awaitingText(taskId: string, at: number, url?: string): string {
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false })
    const head = `【SSH Workbench】任务「${this.label(taskId)}」等待你的答复（权限确认/选择）`
    if (url === undefined || url === '') {
      return `${head}，请回电脑处理\n> ${when}`
    }
    return `${head}\n> 手机答复：${url}\n> ${when}`
  }

  private stopText(taskId: string, at: number, summary?: string): string {
    const lines = [`【SSH Workbench】任务「${this.label(taskId)}」本轮完成`]
    if (summary !== undefined) lines.push(`> 摘要：${summary}`)
    lines.push(this.metaLine(taskId, at))
    return lines.join('\n')
  }

  private failureText(taskId: string, at: number, detail?: string): string {
    const lines = [`【SSH Workbench】任务「${this.label(taskId)}」本轮异常结束`]
    if (detail !== undefined) lines.push(`> 错误：${detail}`)
    lines.push(this.metaLine(taskId, at))
    return lines.join('\n')
  }

  private mergedExitText(
    taskId: string,
    at: number,
    exitCode: number,
    stopped: boolean,
    summary?: string
  ): string {
    const status = stopped
      ? '本轮完成并已停止'
      : exitCode === 0
        ? '本轮完成并退出'
        : `本轮异常退出（code ${exitCode}）`
    const lines = [`【SSH Workbench】任务「${this.label(taskId)}」${status}`]
    if (summary !== undefined) lines.push(`> 摘要：${summary}`)
    lines.push(this.metaLine(taskId, at))
    return lines.join('\n')
  }

  private exitText(taskId: string, at: number, exitCode: number, stopped: boolean): string {
    const status = stopped
      ? '已停止'
      : exitCode === 0
        ? '已退出'
        : `异常退出（code ${exitCode}）`
    return `【SSH Workbench】任务「${this.label(taskId)}」${status}\n${this.metaLine(taskId, at)}`
  }

  // ── 内部：发送 ───────────────────────────────────────────────────────

  private pushText(config: ServerNotifyConfig, text: string, taskId: string): void {
    void this.push(config, text, taskId)
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

/** 解析 hook body（容错：非法 JSON → undefined，不抛不记内容） */
function parseHookBody(bodyText: string | undefined): Record<string, unknown> | undefined {
  if (bodyText === undefined || bodyText === '') return undefined
  try {
    const parsed: unknown = JSON.parse(bodyText)
    return isPlainObj(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** StopFailure 错误首行（字段形态未实测——逐候选取值，全部缺失=undefined） */
function pickFailureLine(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined
  for (const key of ['error', 'message', 'last_assistant_message']) {
    const raw = body[key]
    const text =
      typeof raw === 'string'
        ? raw
        : isPlainObj(raw) && typeof raw['message'] === 'string'
          ? raw['message']
          : undefined
    if (text === undefined) continue
    const line = text.split('\n', 1)[0]!.trim()
    if (line !== '') return summarizeAssistantMessage(line)
  }
  return undefined
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n', 1)[0]!.slice(0, 120) : String(err)
}