/**
 * 手机答复：hook 载荷 → 待答复视图，选择 → hook 决策 JSON 的纯映射（v2.2.0 B 链）。
 *
 * 同一份实现被两端消费：server（远程任务 hook 挂起，HTTP 响应延迟释放）与客户端
 * （本地任务 hook 挂起，答案经 answer.submit 帧回到本机）。经
 * tools/sync-protocol.mjs 逐字节同步到 server/src/shared/（与 remote-protocol 同源）。
 *
 * 安全约束（2.11=A / 2.12 / D2）：
 * - 只产出问题原文 + 选项 label，绝不携带 tool_input 摘要/终端屏幕；
 * - 答案只接受「选项索引 + 自由文本」，由本模块映射为 claude 决策 JSON，
 *   不接受任意按键/任意字段名；自由文本只作为 answers 字段值（≤2000 字符）。
 */

/** 待答复种类（permission=权限确认 / question=AskUserQuestion / plan=ExitPlanMode） */
export type AnswerKind = 'permission' | 'question' | 'plan'

export interface AnswerQuestionOptionView {
  label: string
  description?: string
}

export interface AnswerQuestionView {
  question: string
  header?: string
  multiSelect?: boolean
  options: AnswerQuestionOptionView[]
}

export interface AnswerPendingView {
  /** 服务端生成的 pending id（一次性 token 的对外关联键） */
  pendingId: string
  taskId: string
  /** 原始 hook 事件名（PermissionRequest / PreToolUse） */
  event: string
  kind: AnswerKind
  taskName: string
  projectName?: string
  questions: AnswerQuestionView[]
}

/** 手机/桌面提交的选择：索引映射由本模块完成（2.12——不接受任意按键/字段名） */
export interface AnswerSelection {
  questionIndex: number
  /** 选项索引（单选=1 项；多选=有序多项） */
  optionIndexes?: number[]
  /** 自由文本（2.10=B；仅作为 answers 值，上限 2000 字符） */
  text?: string
}

export interface AnswerChoice {
  kind: AnswerKind
  /** permission: allow/deny；plan: approve/reject（allow/deny 同义接受） */
  action?: 'allow' | 'deny' | 'approve' | 'reject'
  /** question：每题的选项/自由文本 */
  selections?: AnswerSelection[]
}

/** 可结构化作答的 hook 事件集（2.8=A；Elicitation 不挂起） */
const ANSWERABLE_EVENTS = new Set(['PermissionRequest', 'PreToolUse'])

/** 载荷上限（防御异常 body；真实问题远小于此） */
const MAX_QUESTIONS = 8
const MAX_OPTIONS = 10
const MAX_TEXT_CHARS = 2_000
const MAX_LABEL_CHARS = 200

/** 解析后的 hook 载荷（视图 + 回填决策所需的原始 tool_input） */
export interface ParsedAnswerHook {
  kind: AnswerKind
  toolName: string
  /** 原始 tool_input（question 合并 answers 回填；plan 原样回放） */
  toolInput: Record<string, unknown>
  questions: AnswerQuestionView[]
}

/**
 * 判定 hook 是否可结构化作答并归一化为视图。
 * 不可（事件不在集合内/载荷形态不符/超上限）→ null（调用方回落 TUI，不挂起）。
 */
export function parseAnswerableHook(event: string, body: unknown): ParsedAnswerHook | null {
  if (!ANSWERABLE_EVENTS.has(event)) return null
  const rec = asRecord(body)
  if (rec === null) return null
  const toolName = typeof rec['tool_name'] === 'string' ? rec['tool_name'] : ''
  if (toolName === '' || toolName.length > MAX_LABEL_CHARS) return null
  const toolInput = asRecord(rec['tool_input']) ?? {}

  if (event === 'PermissionRequest') {
    // 权限卡片只显示工具名（2.11=A）：questions[0].question=工具名，选项由页面按 kind 渲染
    return {
      kind: 'permission',
      toolName,
      toolInput,
      questions: [{ question: toolName, options: [] }]
    }
  }

  if (toolName === 'ExitPlanMode') {
    // 批准/拒绝由页面按 kind 渲染；批准时按原样回放 tool_input
    return { kind: 'plan', toolName, toolInput, questions: [] }
  }

  if (toolName !== 'AskUserQuestion') return null
  const rawQuestions = Array.isArray(toolInput['questions']) ? toolInput['questions'] : []
  if (rawQuestions.length === 0 || rawQuestions.length > MAX_QUESTIONS) return null
  const questions: AnswerQuestionView[] = []
  const seen = new Set<string>()
  for (const raw of rawQuestions) {
    const q = asRecord(raw)
    if (q === null) return null
    const text = typeof q['question'] === 'string' ? q['question'].trim() : ''
    if (text === '' || text.length > MAX_TEXT_CHARS || seen.has(text)) return null
    seen.add(text)
    const rawOptions = Array.isArray(q['options']) ? q['options'] : []
    if (rawOptions.length === 0 || rawOptions.length > MAX_OPTIONS) return null
    const options: AnswerQuestionOptionView[] = []
    for (const rawOption of rawOptions) {
      const o = asRecord(rawOption)
      if (o === null) return null
      const label = typeof o['label'] === 'string' ? o['label'].trim() : ''
      if (label === '' || label.length > MAX_LABEL_CHARS) return null
      const description =
        typeof o['description'] === 'string' && o['description'].trim() !== ''
          ? o['description'].trim().slice(0, MAX_LABEL_CHARS)
          : undefined
      options.push({ label, ...(description !== undefined ? { description } : {}) })
    }
    const header =
      typeof q['header'] === 'string' && q['header'].trim() !== ''
        ? q['header'].trim().slice(0, MAX_LABEL_CHARS)
        : undefined
    questions.push({
      question: text,
      ...(header !== undefined ? { header } : {}),
      ...(typeof q['multiSelect'] === 'boolean' ? { multiSelect: q['multiSelect'] } : {}),
      options
    })
  }
  return { kind: 'question', toolName, toolInput, questions }
}

export type DecisionBuild =
  | { ok: true; decision: Record<string, unknown> }
  | { ok: false; reason: 'kind-mismatch' | 'bad-action' | 'bad-selection' | 'unanswered' }

/** 计划被手机上拒绝时回给 claude 的原因（固定文案，不经页面输入） */
const PLAN_DENIED_REASON = 'User declined the plan from the phone'

/**
 * 选择 → hook 决策 JSON（形状见设计 §3.2 表）。
 * 校验失败 → ok:false（调用方回 400/不释放 pending，pending 仍可重答）。
 */
export function buildHookDecision(parsed: ParsedAnswerHook, choice: AnswerChoice): DecisionBuild {
  if (choice.kind !== parsed.kind) return { ok: false, reason: 'kind-mismatch' }

  if (parsed.kind === 'permission') {
    if (choice.action !== 'allow' && choice.action !== 'deny') {
      return { ok: false, reason: 'bad-action' }
    }
    return {
      ok: true,
      decision: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: choice.action }
        }
      }
    }
  }

  if (parsed.kind === 'plan') {
    const allow = choice.action === 'allow' || choice.action === 'approve'
    const deny = choice.action === 'deny' || choice.action === 'reject'
    if (!allow && !deny) return { ok: false, reason: 'bad-action' }
    return {
      ok: true,
      decision: allow
        ? {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: parsed.toolInput
            }
          }
        : {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: PLAN_DENIED_REASON
            }
          }
    }
  }

  // question：逐题映射为 answers（键=问题原文；多选=数组，单选=label 或自由文本）
  const selections = Array.isArray(choice.selections) ? choice.selections : []
  const byIndex = new Map<number, AnswerSelection>()
  for (const s of selections) {
    const rec = asRecord(s)
    if (rec === null) return { ok: false, reason: 'bad-selection' }
    const index = rec['questionIndex']
    if (typeof index !== 'number' || !Number.isInteger(index)) return { ok: false, reason: 'bad-selection' }
    if (index < 0 || index >= parsed.questions.length) return { ok: false, reason: 'bad-selection' }
    byIndex.set(index, s)
  }
  const answers: Record<string, string | string[]> = {}
  for (let i = 0; i < parsed.questions.length; i += 1) {
    const question = parsed.questions[i]!
    const selection = byIndex.get(i)
    if (selection === undefined) return { ok: false, reason: 'unanswered' }
    const rawIndexes = selection.optionIndexes ?? []
    if (!Array.isArray(rawIndexes)) return { ok: false, reason: 'bad-selection' }
    const indexes: number[] = []
    for (const n of rawIndexes) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= question.options.length) {
        return { ok: false, reason: 'bad-selection' }
      }
      if (!indexes.includes(n)) indexes.push(n)
    }
    if (question.multiSelect !== true && indexes.length > 1) {
      return { ok: false, reason: 'bad-selection' }
    }
    let text: string | undefined
    if (selection.text !== undefined) {
      if (typeof selection.text !== 'string') return { ok: false, reason: 'bad-selection' }
      const trimmed = selection.text.trim()
      if (trimmed.length > MAX_TEXT_CHARS) return { ok: false, reason: 'bad-selection' }
      text = trimmed === '' ? undefined : trimmed
    }
    const labels = indexes.map((n) => question.options[n]!.label)
    if (question.multiSelect === true) {
      // 2.9：多选一次提交 answers 数组；D2：可混选选项 + 自由文本
      const values = text !== undefined ? [...labels, text] : [...labels]
      if (values.length === 0) return { ok: false, reason: 'unanswered' }
      answers[question.question] = values
    } else {
      if (text !== undefined) answers[question.question] = text
      else if (labels.length === 1) answers[question.question] = labels[0]!
      else return { ok: false, reason: 'unanswered' }
    }
  }
  return {
    ok: true,
    decision: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...parsed.toolInput, answers }
      }
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}