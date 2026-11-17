import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type {
  AnswerConfig,
  NotifyConfig,
  NotifyEventFlags,
  TaskActivityEvent
} from '../shared/types'
import { translate, type Language } from '../shared/i18n'
import { mainLanguage } from './language'

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

/** v2.2.0 事件开关缺省（全开：配置了 webhook 的用户默认收到完成推送——1.13=A） */
export const DEFAULT_EVENT_FLAGS: NotifyEventFlags = {
  awaiting: true,
  stop: true,
  stopFailure: true,
  exit: true
}

/** v2.2.0 手机答复缺省（关：公网暴露入口须显式开启——2.23=A） */
export const DEFAULT_ANSWER_CONFIG: AnswerConfig = {
  enabled: false,
  ttlSec: 900,
  presenceMin: 5,
  tunnel: 'cloudflare',
  pagePort: 0
}

/** Stop 桶节流窗（1.5=A：同任务 60 秒合并） */
export const STOP_THROTTLE_MS = 60 * 1000
/** Stop→exit 合并窗（1.7=A：10 秒内到达的退出合并为一条） */
export const STOP_MERGE_MS = 10 * 1000
/** 任务退出后桶表保留时长（容忍迟到 hook；1.18） */
export const BUCKET_CLEANUP_MS = 60 * 1000
/** 摘要单行上限（D1/A2） */
const SUMMARY_MAX_CHARS = 120

/** 推送任务元数据（名称/项目/起始时刻；ipc 从 tasks/projects 派生） */
export interface NotifyTaskMeta {
  name?: string
  projectName?: string
  /** 任务创建时刻（epoch ms） */
  startedAt?: number
}

export type NotifyOutcome =
  | 'pushed'
  | 'skipped-disabled'
  | 'skipped-debounced'
  | 'skipped-flag'
  | 'ignored'

/**
 * 回答摘要归一化（D1/A2，与 server/src/notify.ts 同语义）：去代码块 → 压空白 →
 * 单行截断 120 字符。摘要只进 webhook 文案，不落盘不进日志（G4）。
 */
export function summarizeAssistantMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return undefined
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text
}

/** 耗时格式：<1h=mm:ss，否则 h:mm:ss（与 server/src/notify.ts 同语义） */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export interface NotifyServiceOptions {
  /** 配置文件路径（组合根注入 join(userData, 'notify.json')） */
  file: string
  /** fetch 实现（测试注入桩） */
  fetchImpl?: typeof fetch
  /** 时间源（测试注入；同 task-activity 的 now 先例） */
  now?: () => number
  /** 任务显示名查找（推送文案含任务名；缺省用 taskId 前 8 位） */
  taskNameOf?: (taskId: string) => string | undefined
  /** v2.2.0 任务元数据（项目名/起始时刻；缺省回退 taskNameOf 且无耗时） */
  taskMetaOf?: (taskId: string) => NotifyTaskMeta | undefined
  /** v1.2.0 文案语言来源（缺省读 main 进程级 mainLanguage()；测试可注入固定值） */
  language?: () => Language
}

/**
 * Webhook URL 校验（v0.5.4：用户误填机器人管理页——给出可操作指引而非静默 404）。
 * 返回 null=合法；字符串=拒绝原因。
 */
export function validateWebhookUrl(url: string, language: Language = 'zh'): string | null {
  const trimmed = url.trim()
  if (trimmed.length === 0) return null // 空=禁用，合法
  if (/work\.weixin\.qq\.com\/wework_admin|openBotProfile/i.test(trimmed)) {
    return translate(language, 'notify.urlIsAdminPage')
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return translate(language, 'notify.urlScheme')
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
export interface NotifyTrailEntry {
  at: string
  taskId: string
  status: 'sent' | 'failed' | 'skipped'
  detail?: string
}

export function buildNotifyPayload(channel: NotifyConfig['channel'], text: string): Record<string, unknown> {
  if (channel === 'wecom') {
    return { msgtype: 'markdown', markdown: { content: text } }
  }
  if (channel === 'dingtalk') {
    return { msgtype: 'markdown', markdown: { title: 'SSH Workbench', content: text } }
  }
  return { text }
}

/**
 * notify.json `events` 段归一化（本地/远程共用；缺失/类型不符回落缺省全开）。
 * 远程路径（remote-notify）与本地 NotifyService 同语义——两端口径唯一。
 */
export function normalizeEventFlags(raw: unknown): NotifyEventFlags {
  const o = isPlainObj(raw) ? raw : {}
  const flag = (k: keyof NotifyEventFlags): boolean =>
    typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_EVENT_FLAGS[k]
  return {
    awaiting: flag('awaiting'),
    stop: flag('stop'),
    stopFailure: flag('stopFailure'),
    exit: flag('exit')
  }
}

/** notify.json `answer` 段归一化（数值越界回落缺省；隧道固定 cloudflare——2.3f=A） */
export function normalizeAnswerConfig(raw: unknown): AnswerConfig {
  const o = isPlainObj(raw) ? raw : {}
  const int = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def
  return {
    enabled: o['enabled'] === true,
    ttlSec: int(o['ttlSec'], DEFAULT_ANSWER_CONFIG.ttlSec, 60, 86_400),
    presenceMin: int(o['presenceMin'], DEFAULT_ANSWER_CONFIG.presenceMin, 1, 1_440),
    tunnel: 'cloudflare',
    pagePort: int(o['pagePort'], DEFAULT_ANSWER_CONFIG.pagePort, 0, 65_535)
  }
}

/** 事件开关部分更新（pickBooleans 忽略非布尔；本地/远程共用） */
export function mergeEventFlags(
  base: NotifyEventFlags,
  patch: Partial<NotifyEventFlags>
): NotifyEventFlags {
  return { ...base, ...pickBooleans(patch) }
}

/** 手机答复部分更新（数值越界抛错——设置页应给可操作反馈；本地/远程共用） */
export function mergeAnswerConfig(base: AnswerConfig, patch: Partial<AnswerConfig>): AnswerConfig {
  const next: AnswerConfig = { ...base, tunnel: 'cloudflare' }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.ttlSec !== undefined) {
    if (!Number.isInteger(patch.ttlSec) || patch.ttlSec < 60 || patch.ttlSec > 86_400) {
      throw new Error('ttlSec out of range (60..86400)')
    }
    next.ttlSec = patch.ttlSec
  }
  if (patch.presenceMin !== undefined) {
    if (!Number.isInteger(patch.presenceMin) || patch.presenceMin < 1 || patch.presenceMin > 1_440) {
      throw new Error('presenceMin out of range (1..1440)')
    }
    next.presenceMin = patch.presenceMin
  }
  if (patch.pagePort !== undefined) {
    if (!Number.isInteger(patch.pagePort) || patch.pagePort < 0 || patch.pagePort > 65_535) {
      throw new Error('pagePort out of range (0..65535)')
    }
    next.pagePort = patch.pagePort
  }
  return next
}

export class NotifyService {
  constructor(private readonly opts: NotifyServiceOptions) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  private language(): Language {
    return this.opts.language?.() ?? mainLanguage()
  }

  private t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
    return translate(this.language(), key, params)
  }

  /** 读取配置（容错：缺失/损坏 → 默认 {url:'', enabled:false, channel:'wecom'}） */
  getConfig(): NotifyConfig {
    return this.load()
  }

  /**
   * 保存 webhook 配置（channel 按 URL 推断；URL 为空强制 enabled=false）并返回。
   * 3.2=A read-modify-write：保留磁盘上的未知字段（events/answer 及未来版本新增
   * 字段），两端版本不一致时不互相抹除。
   */
  setWebhook(url: string, enabled: boolean): NotifyConfig {
    const trimmed = url.trim()
    const invalid = validateWebhookUrl(trimmed, this.language())
    if (invalid !== null) throw new Error(invalid)
    const config: NotifyConfig = {
      url: trimmed,
      enabled: enabled && trimmed.length > 0,
      channel: inferChannel(trimmed)
    }
    this.writeRaw({ ...this.loadRaw(), ...config })
    return { ...config }
  }

  /** v2.2.0 事件开关（完成/停止/异常/退出推送；缺省全开） */
  getEvents(): NotifyEventFlags {
    return normalizeEventFlags(this.loadRaw()['events'])
  }

  /** 保存事件开关（部分更新，其余字段保留） */
  setEvents(patch: Partial<NotifyEventFlags>): NotifyEventFlags {
    const next = mergeEventFlags(this.getEvents(), patch)
    this.writeRaw({ ...this.loadRaw(), events: next })
    return next
  }

  /** v2.2.0 手机答复配置（缺省关；数值越界回落缺省） */
  getAnswer(): AnswerConfig {
    return normalizeAnswerConfig(this.loadRaw()['answer'])
  }

  /** 保存手机答复配置（部分更新；数值越界抛错——设置页应给可操作反馈） */
  setAnswer(patch: Partial<AnswerConfig>): AnswerConfig {
    const next = mergeAnswerConfig(this.getAnswer(), patch)
    this.writeRaw({ ...this.loadRaw(), answer: next })
    return next
  }

  /**
   * activity 事件入口（组合根接 onActivity——每事件调用，非 awaiting 直接忽略）。
   * 防抖命中/未启用静默跳过；推送本身 fire-and-forget 且吞错（不抛、不 reject）。
   * v1.7.0：configOverride 供远程任务分流（组合根按任务 connectionId 解析 VM 侧
   * ~/.cwb/notify.json 传入；未传=本地配置——行为不变）。
   */
  onActivityEvent(event: TaskActivityEvent, configOverride?: NotifyConfig): void {
    if (event.activity !== 'awaiting') return
    // events.awaiting 开关只对本地配置生效（远程 override=VM 侧文件，开关值未取回——
    // 保持旧行为全量推送，避免跨端配置语义猜测）
    if (configOverride === undefined && !this.getEvents().awaiting) return
    const config = configOverride ?? this.load()
    if (!config.enabled || config.url.length === 0) {
      this.recordTrail(event.taskId, 'skipped', config.enabled ? 'no url' : 'disabled')
      return
    }
    const at = this.now()
    const last = this.lastPushAt.get(event.taskId)
    if (last !== undefined && at - last < PUSH_DEBOUNCE_MS) return
    this.lastPushAt.set(event.taskId, at)
    const name = this.opts.taskNameOf?.(event.taskId) ?? event.taskId.slice(0, 8)
    const when = new Date(at).toLocaleString(this.language() === 'en' ? 'en-US' : 'zh-CN', {
      hour12: false
    })
    const text = this.t('notify.awaiting', { name, when })
    void this.push(config, text, event.taskId)
  }

  /**
   * hook 事件入口（v2.2.0 本地任务 A 链）：Stop/StopFailure 触发完成/异常推送。
   * `SubagentStop` 显式忽略——子 agent 的停止不推送（用户 2026-11-16 指令）。
   * 返回值供测试断言；Stop 的 'pushed' = 已排入 10 秒合并窗（真正 POST 在窗到期）。
   */
  onHookEvent(
    taskId: string,
    event: string,
    bodyText?: string,
    configOverride?: NotifyConfig
  ): NotifyOutcome {
    if (event === 'SubagentStop') return 'ignored'
    if (event !== 'Stop' && event !== 'StopFailure') return 'ignored'
    const config = configOverride ?? this.load()
    if (!config.enabled || config.url.length === 0) return 'skipped-disabled'
    // 开关只对本地配置生效（远程 override=VM 侧文件，其 events 开关未取回——保持全量）
    const flags = configOverride === undefined ? this.getEvents() : undefined
    const at = this.now()
    if (event === 'Stop') {
      if (flags !== undefined && !flags.stop) return 'skipped-flag'
      const last = this.stopAt.get(taskId)
      if (last !== undefined && at - last < STOP_THROTTLE_MS) return 'skipped-debounced'
      this.stopAt.set(taskId, at)
      this.armStopMerge(taskId, config, at, parseHookBody(bodyText))
      return 'pushed'
    }
    // StopFailure：异常结束必推（terminal，不节流）
    if (flags !== undefined && !flags.stopFailure) return 'skipped-flag'
    this.cancelPendingStop(taskId)
    const detail = pickFailureLine(parseHookBody(bodyText))
    void this.push(config, this.failureText(taskId, at, detail), taskId)
    return 'pushed'
  }

  /**
   * 任务退出/显式停止入口（本地任务 markStatus 调用；v2.2.0）。
   * 10 秒合并窗内的 Stop 与本次退出合并为一条（1.7）；否则穿透节流必推（1.6）。
   * exitCode：0=正常，>0=异常，undefined/-1=未知（中性「已退出」，不误报异常）。
   */
  onTaskExit(
    taskId: string,
    exitCode: number | undefined,
    stopped: boolean,
    configOverride?: NotifyConfig
  ): NotifyOutcome {
    const config = configOverride ?? this.load()
    this.scheduleCleanup(taskId)
    const pending = this.cancelPendingStop(taskId)
    if (!config.enabled || config.url.length === 0) return 'skipped-disabled'
    // 开关只对本地配置生效（远程 override=VM 侧文件，见 onHookEvent 同注）
    if (configOverride === undefined && !this.getEvents().exit) return 'skipped-flag'
    const at = this.now()
    const code = exitCode ?? -1
    void this.push(
      config,
      pending !== undefined
        ? this.mergedExitText(taskId, at, code, stopped, pending.summary)
        : this.exitText(taskId, at, code, stopped),
      taskId
    )
    return 'pushed'
  }

  /**
   * 丢弃全部定时器（不推送）。v2.2.2（用户 2026-11-17 指令 #7）：应用退出是用户
   * 在场的动作——合并窗内未推的 Stop 不再补推，直接丢弃（原 flush 补推已移除）。
   */
  dispose(): void {
    for (const [, p] of this.pendingStops) clearTimeout(p.timer)
    this.pendingStops.clear()
    for (const [, t] of this.cleanupTimers) clearTimeout(t)
    this.cleanupTimers.clear()
  }

  /** 以指定配置立即推送（远程「测试推送」用——本地测试走 sendTest） */
  async sendTestWith(config: NotifyConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.url.length === 0) return { ok: false, error: this.t('notify.needUrl') }
    try {
      await this.postJson(config, this.t('notify.test'))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 立即推送固定测试文案（设置面板「测试推送」）；错误显式返回不静默 */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const config = this.load()
    if (config.url.length === 0) return { ok: false, error: this.t('notify.needUrl') }
    try {
      await this.postJson(config, this.t('notify.test'))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** taskId → 最近一次推送时刻（防抖表） */
  private readonly lastPushAt = new Map<string, number>()
  /** v2.2.0 stop 桶（60 秒/任务；终态不受它限制——1.6 穿透） */
  private readonly stopAt = new Map<string, number>()
  /** v2.2.0 10 秒合并窗待推的 Stop（1.7） */
  private readonly pendingStops = new Map<string, PendingStop>()
  /** v2.2.0 任务退出后桶表清理定时器（1.18） */
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>()

  // ── v2.2.0 节流/合并/文案 ──────────────────────────────────────────

  private armStopMerge(
    taskId: string,
    config: NotifyConfig,
    at: number,
    body: Record<string, unknown> | undefined
  ): void {
    const summary = summarizeAssistantMessage(body?.['last_assistant_message'])
    const prev = this.pendingStops.get(taskId)
    if (prev !== undefined) clearTimeout(prev.timer)
    const timer = setTimeout(() => {
      this.pendingStops.delete(taskId)
      void this.push(config, this.stopText(taskId, at, summary), taskId)
    }, STOP_MERGE_MS)
    timer.unref?.()
    this.pendingStops.set(taskId, { timer, at, ...(summary !== undefined ? { summary } : {}) })
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
      this.lastPushAt.delete(taskId)
      this.stopAt.delete(taskId)
    }, BUCKET_CLEANUP_MS)
    timer.unref?.()
    this.cleanupTimers.set(taskId, timer)
  }

  /** 任务标签：「名称（项目）」；名称缺省 taskId 前 8 位 */
  private label(taskId: string): string {
    const meta = this.opts.taskMetaOf?.(taskId)
    const name = meta?.name ?? this.opts.taskNameOf?.(taskId) ?? taskId.slice(0, 8)
    return meta?.projectName !== undefined && meta.projectName !== ''
      ? `${name}（${meta.projectName}）`
      : name
  }

  /** `> 耗时 mm:ss · 时间` 行；无起始时刻则只给时间 */
  private metaLine(taskId: string, at: number): string {
    const when = new Date(at).toLocaleString(this.language() === 'en' ? 'en-US' : 'zh-CN', {
      hour12: false
    })
    const startedAt = this.opts.taskMetaOf?.(taskId)?.startedAt
    if (startedAt === undefined || !Number.isFinite(startedAt) || at < startedAt) {
      return this.t('notify.metaTime', { when })
    }
    return this.t('notify.metaLine', { duration: formatDuration(at - startedAt), when })
  }

  private stopText(taskId: string, at: number, summary?: string): string {
    const lines = [this.t('notify.completed', { name: this.label(taskId) })]
    if (summary !== undefined) lines.push(this.t('notify.summaryLine', { summary }))
    lines.push(this.metaLine(taskId, at))
    return lines.join('\n')
  }

  private failureText(taskId: string, at: number, detail?: string): string {
    const lines = [this.t('notify.failedTurn', { name: this.label(taskId) })]
    if (detail !== undefined) lines.push(this.t('notify.errorLine', { error: detail }))
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
    const name = this.label(taskId)
    const status = stopped
      ? this.t('notify.completedAndStopped', { name })
      : exitCode === 0
        ? this.t('notify.completedAndExit', { name })
        : exitCode < 0
          ? this.t('notify.completedAndExit', { name }) // 退出码未知：中性表述
          : this.t('notify.failedExit', { name, code: exitCode })
    const lines = [status]
    if (summary !== undefined) lines.push(this.t('notify.summaryLine', { summary }))
    lines.push(this.metaLine(taskId, at))
    return lines.join('\n')
  }

  private exitText(taskId: string, at: number, exitCode: number, stopped: boolean): string {
    const name = this.label(taskId)
    const status = stopped
      ? this.t('notify.stopped', { name })
      : exitCode === 0 || exitCode < 0
        ? this.t('notify.exited', { name })
        : this.t('notify.abnormalExit', { name, code: exitCode })
    return `${status}\n${this.metaLine(taskId, at)}`
  }

  // ── 发送 ─────────────────────────────────────────────────────────────

  /** 推送（失败静默 + console.error——旁路提醒不阻塞状态机）；v2.0.1 留痕（设置页诊断） */
  private async push(config: NotifyConfig, text: string, taskId?: string): Promise<void> {
    try {
      await this.postJson(config, text)
      if (taskId !== undefined) this.recordTrail(taskId, 'sent')
    } catch (err) {
      console.error('[cwb] notify push failed:', err instanceof Error ? err.message : err)
      if (taskId !== undefined) this.recordTrail(taskId, 'failed', err instanceof Error ? err.message : String(err))
    }
  }

  /** 最近推送尝试留痕（环形 8 条；onNotifyTrail 订阅外送——设置 Webhook 页消费） */
  private readonly trail: NotifyTrailEntry[] = []
  private readonly trailListeners = new Set<(e: NotifyTrailEntry) => void>()

  recordTrail(taskId: string, status: NotifyTrailEntry['status'], detail?: string): void {
    const entry: NotifyTrailEntry = {
      at: new Date().toISOString(),
      taskId,
      status,
      ...(detail !== undefined ? { detail } : {})
    }
    this.trail.push(entry)
    if (this.trail.length > 8) this.trail.shift()
    for (const cb of this.trailListeners) cb(entry)
  }

  listTrail(): readonly NotifyTrailEntry[] {
    return [...this.trail]
  }

  onNotifyTrail(cb: (e: NotifyTrailEntry) => void): () => void {
    this.trailListeners.add(cb)
    return () => {
      this.trailListeners.delete(cb)
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
      throw new Error(
        `${this.t('notify.httpStatus', { status: res.status })}${snippet ? '：' + snippet : ''}`
      )
    }
  }

  private load(): NotifyConfig {
    const rec = this.loadRaw()
    const url = typeof rec['url'] === 'string' ? rec['url'] : ''
    const enabled = rec['enabled'] === true
    const channel =
      rec['channel'] === 'wecom' || rec['channel'] === 'dingtalk' || rec['channel'] === 'generic'
        ? rec['channel']
        : 'wecom'
    return { url, enabled, channel }
  }

  /** 整文件原始对象（缺失/损坏 → {}；read-modify-write 的基础——3.2=A） */
  private loadRaw(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.opts.file, 'utf8'))
      if (isPlainObj(parsed)) return parsed
    } catch {
      /* 缺失/损坏 → 空对象 */
    }
    return {}
  }

  /** 原子整文件写（tmp+rename；URL 属凭据仅存本地——红线 1） */
  private writeRaw(obj: Record<string, unknown>): void {
    const tmp = `${this.opts.file}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    renameSync(tmp, this.opts.file)
  }
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 10 秒合并窗内的 Stop（summary=body 的 last_assistant_message 摘要） */
interface PendingStop {
  timer: NodeJS.Timeout
  at: number
  summary?: string
}

/** 解析 hook body（容错：非法 JSON → undefined；不记内容） */
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

/** 只保留布尔字段（部分更新防注入非布尔值） */
function pickBooleans(patch: Partial<NotifyEventFlags>): Partial<NotifyEventFlags> {
  const out: Partial<NotifyEventFlags> = {}
  for (const k of ['awaiting', 'stop', 'stopFailure', 'exit'] as const) {
    if (typeof patch[k] === 'boolean') out[k] = patch[k]
  }
  return out
}
