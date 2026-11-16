import { randomUUID } from 'node:crypto'
import type { ClientFrame } from '../shared/remote-protocol'
import type {
  AnswerChoice,
  AnswerPendingView,
  ParsedAnswerHook
} from '../shared/answer-decision'
import { buildHookDecision, parseAnswerableHook } from '../shared/answer-decision'
import type {
  AnswerConfig,
  AnswerPendingInfo,
  AnswerResolvedEvent,
  AnswerRuntimeState
} from '../shared/types'

/**
 * 本地任务手机答复桥（v2.2.0 B 链，设计 §3.6）。
 *
 * 数据流：本地 claude hook → task-activity 挂起（onPending）→ 本模块上行
 * `answer.pending`（客户端生成 pendingId，server 沿用）→ server 建 token/推送/应答页
 * → 页面提交 → `answer.submit` 帧 → 本模块用 buildHookDecision 映射为 hook 决策 JSON
 * → 挂起的 HTTP 响应带决策返回（claude 继续，无需用户回电脑）。
 *
 * 门控（不放行即立即 200 回落 TUI——与 A11 一致）：
 * 1. `answer.enabled`；
 * 2. 载荷可结构化映射（parseAnswerableHook）；
 * 3. 桌面不在场（2.16：presenceMin 分钟无键入）；
 * 4. 存在已连接且支持 answer 的 server 连接（无连接=无隧道=无链接）。
 *
 * 释放路径：手机答案（submit）/手机或桌面取消（resolved）/连接断开/进程退出——
 * 一律以 null 或决策 resolve，绝不留下永不落定的 Promise。
 */

/** ack 等待时长（server 回执 answer.pending；超时=回落 TUI） */
export const ANSWER_ACK_TIMEOUT_MS = 1_500
/** presence 键入节流窗（设计 §4：键入时节流 5s） */
export const PRESENCE_THROTTLE_MS = 5_000
/** presence 心跳周期（30s） */
export const PRESENCE_HEARTBEAT_MS = 30_000

interface LocalPending {
  pendingId: string
  connectionId: string
  taskId: string
  parsed: ParsedAnswerHook
  view: AnswerPendingView
  resolve: (decision: Record<string, unknown> | null) => void
  /** 回执已到（server 已建号；url 可能为空=隧道未就绪） */
  acked: boolean
  ackUrl: string | undefined
  /** ack 等待者（回执/超时/释放） */
  ackWaiters: Set<(ok: boolean) => void>
}

export interface AnswerBridgeOptions {
  /** 本地手机答复配置（notify.json answer 段） */
  getConfig: () => AnswerConfig
  /** 可承载答复的 server 连接（已连接且能力 answer=true；无 → undefined） */
  answerConnection: () => Promise<string | undefined>
  /** 上行即发即忘帧（未连接返回 false） */
  sendFrame: (connectionId: string, frame: ClientFrame) => boolean
  /** presence 全连接播报（返回送出连接数） */
  broadcastPresence: (lastInputAt: number, focused: boolean) => number
  /** 任务显示名/项目名（横幅与页面文案） */
  taskMetaOf: (taskId: string) => { taskName?: string; projectName?: string }
  /** 手机请求停止本地任务（answer.stop 帧） */
  stopTask: (taskId: string) => void
  /** renderer：待答复横幅 */
  onPending: (info: AnswerPendingInfo) => void
  /** renderer：已处理（清横幅 + toast） */
  onResolved: (e: AnswerResolvedEvent) => void
  /** renderer：通道状态 */
  onState: (s: AnswerRuntimeState) => void
  now?: () => number
  ackTimeoutMs?: number
}

export class AnswerBridge {
  private readonly opts: AnswerBridgeOptions
  /** 本地挂起（pendingId=客户端生成，server 沿用） */
  private readonly pendings = new Map<string, LocalPending>()
  /** 全局最近键入（epoch ms；0=从未） */
  private lastInputAt = 0
  private focused = true
  private lastPresenceSentAt = 0
  private heartbeat: NodeJS.Timeout | undefined

  constructor(opts: AnswerBridgeOptions) {
    this.opts = opts
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now
  }

  /** 桌面是否不在场（2.16：presenceMin 分钟无键入） */
  desktopAway(presenceMin: number): boolean {
    const now = this.now()
    // 本轮从未键入 → 不在场（键入会刷新 lastInputAt）
    return this.lastInputAt === 0 || now - this.lastInputAt >= presenceMin * 60_000
  }

  /** 当前挂起数（诊断/测试） */
  count(): number {
    return this.pendings.size
  }

  /**
   * hook 挂起请求（task-activity.onPending 实现）：满足全部门控才上行，否则 null。
   * 返回的 Promise 在手机作答/任何释放路径落定。
   */
  async requestHold(req: {
    taskId: string
    event: string
    body: string
  }): Promise<Record<string, unknown> | null> {
    const cfg = this.opts.getConfig()
    if (!cfg.enabled) return null
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(req.body)
    } catch {
      return null
    }
    const parsed = parseAnswerableHook(req.event, parsedBody)
    if (parsed === null) return null
    if (!this.desktopAway(cfg.presenceMin)) return null
    const cid = await this.opts.answerConnection()
    if (cid === undefined) return null

    const pendingId = randomUUID()
    const meta = this.opts.taskMetaOf(req.taskId)
    const view: AnswerPendingView = {
      pendingId,
      taskId: req.taskId,
      event: req.event,
      kind: parsed.kind,
      taskName:
        meta.taskName !== undefined && meta.taskName !== '' ? meta.taskName : req.taskId.slice(0, 8),
      ...(meta.projectName !== undefined && meta.projectName !== ''
        ? { projectName: meta.projectName }
        : {}),
      questions: parsed.questions
    }

    let resolveDecision!: (d: Record<string, unknown> | null) => void
    const decision = new Promise<Record<string, unknown> | null>((r) => {
      resolveDecision = r
    })
    const entry: LocalPending = {
      pendingId,
      connectionId: cid,
      taskId: req.taskId,
      parsed,
      view,
      resolve: resolveDecision,
      acked: false,
      ackUrl: undefined,
      ackWaiters: new Set()
    }
    this.pendings.set(pendingId, entry)

    if (!this.opts.sendFrame(cid, { type: 'answer.pending', pending: view })) {
      this.finish(pendingId, null)
      return null
    }
    const ok = await this.awaitAck(entry)
    if (!ok) {
      // 超时/释放前被取消：回落 TUI（entry 可能已由取消路径结束——finish 幂等）
      this.finish(pendingId, null)
      return null
    }
    // 注意：回执与答案可能同拍到达（极快作答）——entry 已被 finish 也照常返回
    // 已落定的 decision（不按 pendings 是否存在二次判空）
    this.opts.onPending({
      connectionId: cid,
      pending: view,
      ...(entry.ackUrl !== undefined ? { url: entry.ackUrl } : {})
    })
    return decision
  }

  /** ack 等待（已回执=立即通过；超时以 null 释放，绝不无限等待） */
  private awaitAck(entry: LocalPending): Promise<boolean> {
    if (entry.acked) return Promise.resolve(true)
    const timeoutMs = this.opts.ackTimeoutMs ?? ANSWER_ACK_TIMEOUT_MS
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        entry.ackWaiters.delete(done)
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      timer.unref?.()
      entry.ackWaiters.add(done)
    })
  }

  /** server 回执 answer.pending：本地挂起确认（记录 url）或远程挂起横幅 */
  handleServerPending(connectionId: string, pending: AnswerPendingView, url?: string): void {
    const entry = this.pendings.get(pending.pendingId)
    if (entry !== undefined) {
      entry.acked = true
      entry.ackUrl = url
      for (const w of [...entry.ackWaiters]) {
        entry.ackWaiters.delete(w)
        w(true)
      }
      return
    }
    this.opts.onPending({
      connectionId,
      pending,
      ...(url !== undefined ? { url } : {})
    })
  }

  /** 手机答案回送：映射为 hook 决策并释放挂起 */
  handleServerSubmit(connectionId: string, pendingId: string, choice: AnswerChoice): void {
    void connectionId
    const entry = this.pendings.get(pendingId)
    if (entry === undefined) return
    const built = buildHookDecision(entry.parsed, choice)
    this.finish(pendingId, built.ok ? built.decision : null)
  }

  /** 已处理（手机/桌面/系统）：释放本 pending/本任务挂起 + 横幅/提示 */
  handleServerResolved(
    connectionId: string,
    pendingId: string | undefined,
    taskId: string,
    by: AnswerResolvedEvent['by'],
    action: AnswerResolvedEvent['action']
  ): void {
    if (pendingId !== undefined) {
      this.finish(pendingId, null)
    } else {
      for (const e of [...this.pendings.values()]) {
        if (e.taskId === taskId && e.connectionId === connectionId) this.finish(e.pendingId, null)
      }
    }
    this.opts.onResolved({
      connectionId,
      ...(pendingId !== undefined ? { pendingId } : {}),
      taskId,
      by,
      action
    })
  }

  /** 手机请求停止本地任务 */
  handleServerStop(_connectionId: string, taskId: string): void {
    this.opts.stopTask(taskId)
  }

  /** 通道状态（设置页状态卡） */
  handleServerState(connectionId: string, state: Omit<AnswerRuntimeState, 'connectionId'>): void {
    this.opts.onState({ connectionId, ...state })
  }

  /**
   * 桌面中止（「回电脑处理」）：向 server 发 answer.cancel（server 释放 hook 并
   * 广播 resolved），本地立即以 null 释放（不等广播——桌面要的是马上回到 TUI）。
   */
  cancel(connectionId: string | undefined, pendingId?: string, taskId?: string): void {
    const targets = [...this.pendings.values()].filter(
      (e) =>
        (connectionId === undefined || e.connectionId === connectionId) &&
        (pendingId === undefined || e.pendingId === pendingId) &&
        (taskId === undefined || e.taskId === taskId)
    )
    for (const e of targets) this.finish(e.pendingId, null)
    const cids =
      connectionId !== undefined ? [connectionId] : [...new Set(targets.map((e) => e.connectionId))]
    for (const cid of cids) {
      this.opts.sendFrame(cid, {
        type: 'answer.cancel',
        ...(pendingId !== undefined ? { pendingId } : {}),
        ...(taskId !== undefined ? { taskId } : {})
      })
    }
  }

  /** 连接断开/退出：全部本地挂起空响应释放（避免桌面永久无框） */
  releaseAll(): number {
    let n = 0
    for (const id of [...this.pendings.keys()]) {
      if (this.finish(id, null)) n += 1
    }
    return n
  }

  // ── presence（桌面在场心跳） ────────────────────────────────────────

  /** 键入信号（ptyWrite 全量调用）：刷新时刻并按 5s 节流播报 */
  noteInput(): void {
    this.lastInputAt = this.now()
    this.maybeSendPresence(false)
  }

  /** 窗口焦点变化：立即播报 */
  setFocused(focused: boolean): void {
    this.focused = focused
    this.maybeSendPresence(true)
  }

  /** 连接建立后立即播报一次 */
  announcePresence(): void {
    this.maybeSendPresence(true)
  }

  /** 启动 30s 心跳（组合根随应用生命周期；幂等） */
  startPresenceHeartbeat(): void {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => this.maybeSendPresence(true), PRESENCE_HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  stopPresenceHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private maybeSendPresence(force: boolean): void {
    const at = this.now()
    if (!force && at - this.lastPresenceSentAt < PRESENCE_THROTTLE_MS) return
    this.lastPresenceSentAt = at
    this.opts.broadcastPresence(this.lastInputAt, this.focused)
  }

  /** 单条释放（幂等） */
  private finish(pendingId: string, decision: Record<string, unknown> | null): boolean {
    const entry = this.pendings.get(pendingId)
    if (entry === undefined) return false
    this.pendings.delete(pendingId)
    entry.resolve(decision)
    // ack 等待者一并放行（门控阶段被释放时——等待者看到 ok=false 即回落）
    for (const w of [...entry.ackWaiters]) {
      entry.ackWaiters.delete(w)
      w(false)
    }
    return true
  }
}