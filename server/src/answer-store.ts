/**
 * 手机答复 pending 仓库（v2.2.0 B 链，设计 §3.2/§3.3）。
 *
 * 生命周期：hook 到达时 tryHold 建 pending（一次性 token）→ 页面/桌面提交走
 * submit/cancel → 释放 hook 响应（决策 JSON 或空体）。释放来源：
 *   - phone：页面提交（answered）/ 页面「回电脑处理」（cancelled）
 *   - desktop：客户端 answer.cancel 帧（cancelled）
 *   - system：任务退出/停止、同任务同 kind 新事件取代、hook 连接断开（cancelled/expired）
 *
 * 安全（红线）：问题文本/tool_input/答案只在内存；日志只记元数据
 * （taskId/kind/来源/动作），token 不进日志；token 比较用 timingSafeEqual。
 *
 * TTL（2.5/A9）：到期后手机提交被拒（'expired'），pending 不自动释放（2.15=C 不限时，
 * 桌面仍可 cancel）；页面据 expiresAt 显示「链接已过期」。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AnswerStateView, ServerFrame } from './shared/remote-protocol'
import type { AnswerChoice, AnswerKind, AnswerPendingView, ParsedAnswerHook } from './shared/answer-decision'
import { buildHookDecision, parseAnswerableHook } from './shared/answer-decision'

/** 全局 pending 上限（3.3；超出时新 hook 回落 TUI，防本地进程刷爆内存） */
export const ANSWER_MAX_GLOBAL = 20
/** 单任务 pending 上限 */
export const ANSWER_MAX_PER_TASK = 5
/** 已终结记录保留时长（幂等 410 判定；内存有界） */
const SETTLED_TTL_MS = 10 * 60 * 1000
const SETTLED_MAX = 100

export type AnswerOrigin = 'remote' | 'local'
export type AnswerResolvedByLocal = 'phone' | 'desktop' | 'system'
export type AnswerResolvedActionLocal = 'answered' | 'cancelled' | 'expired'

export interface AnswerHoldRequest {
  taskId: string
  event: string
  /** 原始 POST body（JSON 文本；解析失败=不挂起） */
  bodyText: string
  taskName?: string
  projectName?: string
  /** 远程：把决策写回延迟的 HTTP 响应（null=空体放行） */
  reply: (decision: Record<string, unknown> | null) => void
}

export interface HeldAnswer {
  pending: AnswerPendingView
  /** 公网链接（surface 已就绪必存在） */
  url: string
  /** 待释放决策：决策 JSON=作答；null=空体回落 TUI */
  decision: Promise<Record<string, unknown> | null>
}

export type AnswerSubmitResult =
  | 'ok'
  | 'not-found'
  | 'unauthorized'
  | 'already-resolved'
  | 'expired'
  | 'bad-choice'

export interface AnswerServiceOptions {
  /** 当前配置（notify.json answer 段；每次挂起读取——enabled 即时生效） */
  config: () => { enabled: boolean; ttlSec: number }
  /** 应答页公网基址（页面/隧道就绪时非空；undefined=不挂起） */
  surface: () => string | undefined
  /** 帧广播（answer.pending / answer.resolved / answer.state） */
  broadcast: (frame: ServerFrame) => void
  /** 元数据日志（禁止问题文本/token） */
  log: (level: 'info' | 'warn', message: string) => void
  now?: () => number
}

interface Pending {
  id: string
  token: string
  taskId: string
  event: string
  kind: AnswerKind
  taskName: string
  projectName?: string
  origin: AnswerOrigin
  view: AnswerPendingView
  /** remote：server 侧解析的 hook 载荷（本地任务的决策由客户端映射——D5） */
  parsed?: ParsedAnswerHook
  createdAt: number
  expiresAt: number
  resolve: (decision: Record<string, unknown> | null) => void
  reply: (decision: Record<string, unknown> | null) => void
  onSubmit?: (pendingId: string, choice: AnswerChoice) => void
}

interface Settled {
  token: string
  state: 'answered' | 'cancelled' | 'expired'
  at: number
}

export class AnswerService {
  private readonly pendings = new Map<string, Pending>()
  /** 已终结记录（幂等：重复提交 410；有界） */
  private readonly settled = new Map<string, Settled>()
  private surfaceUrl: string | undefined

  constructor(private readonly opts: AnswerServiceOptions) {}

  private get now(): () => number {
    return this.opts.now ?? Date.now
  }

  /** 应答页/隧道就绪状态（T4 隧道管理调用；undefined=不可挂起） */
  setSurface(url: string | undefined): void {
    this.surfaceUrl = url !== undefined && url !== '' ? url : undefined
  }

  /** 挂起是否可用（配置开 + 页面/隧道就绪） */
  canHold(): boolean {
    return this.opts.config().enabled && this.surfaceUrl !== undefined
  }

  /** 当前公网入口（推送链接基址；不可用=undefined） */
  get baseUrl(): string | undefined {
    return this.surfaceUrl
  }

  /**
   * 尝试挂起 hook。不满足条件（不可答复事件/配置关/页面未就绪/超上限/载荷无法
   * 安全映射）→ null（调用方立即 200 回落 TUI）。
   */
  tryHold(req: AnswerHoldRequest): HeldAnswer | null {
    if (!this.canHold()) return null
    const parsed = parseAnswerableHook(req.event, parseJson(req.bodyText))
    if (parsed === null) return null
    if (!this.withinLimits(req.taskId)) return null
    const view: AnswerPendingView = {
      pendingId: '', // 建号时回填
      taskId: req.taskId,
      event: req.event,
      kind: parsed.kind,
      taskName: req.taskName !== undefined && req.taskName !== '' ? req.taskName : req.taskId.slice(0, 8),
      ...(req.projectName !== undefined && req.projectName !== '' ? { projectName: req.projectName } : {}),
      questions: parsed.questions
    }
    return this.create(req.taskId, req.event, view, 'remote', req.reply, parsed)
  }

  /**
   * 客户端本地任务挂起（D5）：客户端已解析出视图，答案经 onSubmit（answer.submit
   * 帧）回客户端自行映射为决策——server 不持有 tool_input。
   */
  holdLocal(
    view: AnswerPendingView,
    onSubmit: (pendingId: string, choice: AnswerChoice) => void
  ): HeldAnswer | null {
    if (!this.canHold()) return null
    if (!this.withinLimits(view.taskId)) return null
    const safe: AnswerPendingView = {
      pendingId: '',
      taskId: view.taskId,
      event: view.event,
      kind: view.kind,
      taskName: view.taskName !== '' ? view.taskName : view.taskId.slice(0, 8),
      ...(view.projectName !== undefined && view.projectName !== ''
        ? { projectName: view.projectName }
        : {}),
      questions: view.questions
    }
    return this.create(view.taskId, view.event, safe, 'local', () => {}, undefined, onSubmit)
  }

  /** 上限校验（全局 20 / 单任务 5）+ 2.14 同任务同 kind 取代 */
  private withinLimits(taskId: string): boolean {
    if (this.pendings.size >= ANSWER_MAX_GLOBAL) return false
    let perTask = 0
    for (const p of this.pendings.values()) {
      if (p.taskId === taskId) perTask += 1
    }
    return perTask < ANSWER_MAX_PER_TASK
  }

  private create(
    taskId: string,
    event: string,
    view: AnswerPendingView,
    origin: AnswerOrigin,
    reply: (decision: Record<string, unknown> | null) => void,
    parsed?: ParsedAnswerHook,
    onSubmit?: (pendingId: string, choice: AnswerChoice) => void
  ): HeldAnswer {
    // 2.14：同任务同 kind 新事件取代旧 pending（空响应释放旧 hook）
    for (const p of [...this.pendings.values()]) {
      if (p.taskId === taskId && p.kind === view.kind) {
        this.settle(p, null, 'system', 'cancelled')
      }
    }
    const at = this.now()
    const ttlSec = this.opts.config().ttlSec
    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const finalView: AnswerPendingView = { ...view, pendingId: id }
    let resolve!: (decision: Record<string, unknown> | null) => void
    const decision = new Promise<Record<string, unknown> | null>((r) => {
      resolve = r
    })
    const pending: Pending = {
      id,
      token,
      taskId,
      event,
      kind: view.kind,
      taskName: finalView.taskName,
      ...(finalView.projectName !== undefined ? { projectName: finalView.projectName } : {}),
      origin,
      view: finalView,
      ...(parsed !== undefined ? { parsed } : {}),
      createdAt: at,
      expiresAt: at + ttlSec * 1000,
      resolve,
      reply,
      ...(onSubmit !== undefined ? { onSubmit } : {})
    }
    this.pendings.set(id, pending)
    this.pruneSettled()
    const url = `${this.surfaceUrl}/a/${token}`
    this.opts.broadcast({ type: 'answer.pending', pending: finalView, url })
    this.opts.log('info', `answer held (task ${taskId.slice(0, 8)}, kind ${view.kind}, origin ${origin})`)
    this.broadcastState()
    return { pending: finalView, url, decision }
  }

  /**
   * 页面/桌面提交。token 校验 timingSafe；一次性幂等（重复提交 → already-resolved）；
   * TTL 过期 → expired（A9：过期后仅桌面可释放）。
   */
  submit(token: string, pendingId: string, choice: AnswerChoice): AnswerSubmitResult {
    const pending = this.pendings.get(pendingId)
    if (pending === undefined) {
      const settled = this.settled.get(pendingId)
      if (settled !== undefined && tokenMatches(settled.token, token)) {
        return settled.state === 'expired' ? 'expired' : 'already-resolved'
      }
      return 'not-found'
    }
    if (!tokenMatches(pending.token, token)) return 'unauthorized'
    if (this.now() >= pending.expiresAt) return 'expired'
    if (pending.origin === 'local') {
      // 本地任务：choice 交回客户端自行映射（D5；server 不持有 tool_input）
      if (choice.kind !== pending.kind) return 'bad-choice'
      pending.onSubmit?.(pending.id, choice)
      this.settle(pending, null, 'phone', 'answered')
      return 'ok'
    }
    const built = buildHookDecision(pending.parsed!, choice)
    if (!built.ok) {
      this.opts.log(
        'warn',
        `answer rejected (task ${pending.taskId.slice(0, 8)}, kind ${pending.kind}, ${built.reason})`
      )
      return 'bad-choice'
    }
    this.settle(pending, built.decision, 'phone', 'answered')
    return 'ok'
  }

  /** 单条取消（页面「回电脑处理」/桌面横幅）；不存在/已终结=false */
  cancelPending(
    pendingId: string,
    by: AnswerResolvedByLocal = 'desktop',
    action: AnswerResolvedActionLocal = 'cancelled'
  ): boolean {
    const pending = this.pendings.get(pendingId)
    if (pending === undefined) return false
    this.settle(pending, null, by, action)
    return true
  }

  /** 桌面 answer.cancel：按 pendingId 或 taskId 释放 */
  cancelFromDesktop(pendingId?: string, taskId?: string): number {
    let n = 0
    for (const p of [...this.pendings.values()]) {
      if ((pendingId !== undefined && p.id === pendingId) || (taskId !== undefined && p.taskId === taskId)) {
        this.settle(p, null, 'desktop', 'cancelled')
        n += 1
      }
    }
    return n
  }

  /** 任务退出/显式停止：该任务全部 pending 空响应释放 */
  cancelTask(taskId: string, by: AnswerResolvedByLocal = 'system'): number {
    let n = 0
    for (const p of [...this.pendings.values()]) {
      if (p.taskId === taskId) {
        this.settle(p, null, by, 'cancelled')
        n += 1
      }
    }
    return n
  }

  /** hook 连接断开（claude 端超时放弃）：pending 记 expired，不再接受提交 */
  abandon(pendingId: string): void {
    const pending = this.pendings.get(pendingId)
    if (pending === undefined) return
    this.settle(pending, null, 'system', 'expired')
  }

  /** 全部挂起（页面平铺 / 测试）；按创建时间倒序（D6） */
  list(): AnswerPendingView[] {
    return [...this.pendings.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => p.view)
  }

  /** pending 明细（页面渲染需 expiresAt；不对外协议帧） */
  detail(pendingId: string): { view: AnswerPendingView; expiresAt: number; expired: boolean } | undefined {
    const pending = this.pendings.get(pendingId)
    if (pending === undefined) return undefined
    return { view: pending.view, expiresAt: pending.expiresAt, expired: this.now() >= pending.expiresAt }
  }

  count(): number {
    return this.pendings.size
  }

  /** pending 的一次性 token（页面链接构造/测试；不进日志、不广播） */
  tokenOf(pendingId: string): string | undefined {
    let found: string | undefined
    for (const p of this.pendings.values()) {
      if (p.id === pendingId) found = p.token
    }
    return found
  }

  /** 页面状态快照（T4 隧道接 line 后广播 answer.state） */
  snapshot(tunnel: AnswerStateView['tunnel'] = this.surfaceUrl !== undefined ? 'up' : 'off'): AnswerStateView {
    return {
      enabled: this.opts.config().enabled,
      ...(this.surfaceUrl !== undefined ? { baseUrl: this.surfaceUrl } : {}),
      tunnel,
      pendingCount: this.pendings.size
    }
  }

  /** 广播当前状态（创建/释放/配置或隧道变化时） */
  broadcastState(tunnel?: AnswerStateView['tunnel']): void {
    this.opts.broadcast({ type: 'answer.state', state: this.snapshot(tunnel) })
  }

  /** 停机：全部挂起空响应释放（先释放再停页面/隧道——设计 §3.5） */
  dispose(): void {
    for (const p of [...this.pendings.values()]) {
      this.settle(p, null, 'system', 'cancelled', false)
    }
    this.settled.clear()
    this.surfaceUrl = undefined
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private settle(
    pending: Pending,
    decision: Record<string, unknown> | null,
    by: AnswerResolvedByLocal,
    action: AnswerResolvedActionLocal,
    broadcast = true
  ): void {
    if (!this.pendings.delete(pending.id)) return
    this.settled.set(pending.id, {
      token: pending.token,
      state: action === 'answered' ? 'answered' : action === 'expired' ? 'expired' : 'cancelled',
      at: this.now()
    })
    this.pruneSettled()
    pending.resolve(decision)
    // 本地任务由客户端 resolve hook（null 不写 HTTP）；远程任务写延迟响应
    pending.reply(decision)
    if (broadcast) {
      this.opts.broadcast({
        type: 'answer.resolved',
        pendingId: pending.id,
        taskId: pending.taskId,
        by,
        action
      })
      this.broadcastState()
    }
    this.opts.log(
      'info',
      `answer ${action} (task ${pending.taskId.slice(0, 8)}, kind ${pending.kind}, by ${by})`
    )
  }

  /** 终结记录有界清理（时间 + 数量双限） */
  private pruneSettled(): void {
    const at = this.now()
    for (const [id, s] of this.settled) {
      if (at - s.at > SETTLED_TTL_MS) this.settled.delete(id)
    }
    while (this.settled.size > SETTLED_MAX) {
      const first = this.settled.keys().next()
      if (first.done === true) break
      this.settled.delete(first.value)
    }
  }
}

function tokenMatches(expected: string, provided: string): boolean {
  if (typeof provided !== 'string' || provided === '') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}