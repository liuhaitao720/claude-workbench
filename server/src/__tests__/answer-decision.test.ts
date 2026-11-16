import { describe, expect, it } from 'vitest'
import {
  buildHookDecision,
  parseAnswerableHook,
  type AnswerChoice
} from '../shared/answer-decision'

/**
 * 手机答复纯映射（v2.2.0 B 链）：hook 载荷 → 待答视图、选择 → 决策 JSON。
 * 两端共用同一实现（sync-protocol 同步到 server/src/shared）。
 */

const askBody = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: '用哪种方案？',
        header: '方案',
        multiSelect: false,
        options: [
          { label: '方案 A', description: '快但粗糙' },
          { label: '方案 B' }
        ]
      },
      {
        question: '要包含哪些文件？',
        multiSelect: true,
        options: [{ label: '源码' }, { label: '测试' }, { label: '文档' }]
      }
    ]
  }
}

describe('parseAnswerableHook：可结构化作答判定与视图归一化', () => {
  it('PermissionRequest → permission（只留工具名，不带 tool_input——2.11=A）', () => {
    const parsed = parseAnswerableHook('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' }
    })
    expect(parsed?.kind).toBe('permission')
    expect(parsed?.questions).toEqual([{ question: 'Bash', options: [] }])
    expect(JSON.stringify(parsed?.questions)).not.toContain('rm -rf')
  })

  it('PreToolUse + AskUserQuestion → question（问题原文/选项 label，description 截断保留）', () => {
    const parsed = parseAnswerableHook('PreToolUse', askBody)
    expect(parsed?.kind).toBe('question')
    expect(parsed?.questions).toHaveLength(2)
    expect(parsed?.questions[0]).toMatchObject({
      question: '用哪种方案？',
      header: '方案',
      multiSelect: false,
      options: [{ label: '方案 A', description: '快但粗糙' }, { label: '方案 B' }]
    })
    expect(parsed?.questions[1]?.multiSelect).toBe(true)
  })

  it('PreToolUse + ExitPlanMode → plan（tool_input 原样保留供批准回放）', () => {
    const parsed = parseAnswerableHook('PreToolUse', {
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '先改 A 再改 B' }
    })
    expect(parsed?.kind).toBe('plan')
    expect(parsed?.toolInput).toEqual({ plan: '先改 A 再改 B' })
    expect(parsed?.questions).toEqual([])
  })

  it('不可挂起：其他事件/其他工具/Elicitation/空载荷/畸形问题 → null', () => {
    expect(parseAnswerableHook('Stop', {})).toBeNull()
    expect(parseAnswerableHook('Elicitation', { tool_name: 'X' })).toBeNull()
    expect(parseAnswerableHook('PreToolUse', { tool_name: 'Bash', tool_input: {} })).toBeNull()
    expect(parseAnswerableHook('PermissionRequest', {})).toBeNull()
    expect(parseAnswerableHook('PreToolUse', null)).toBeNull()
    expect(
      parseAnswerableHook('PreToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Q', options: [] }] }
      })
    ).toBeNull()
    // 重复问题文本（answers 映射键冲突）拒绝
    expect(
      parseAnswerableHook('PreToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'Q', options: [{ label: 'A' }] },
            { question: ' Q ', options: [{ label: 'B' }] }
          ]
        }
      })
    ).toBeNull()
  })
})

describe('buildHookDecision：选择 → claude 决策 JSON（2.12 索引映射）', () => {
  const permission = parseAnswerableHook('PermissionRequest', { tool_name: 'Bash' })!
  const plan = parseAnswerableHook('PreToolUse', {
    tool_name: 'ExitPlanMode',
    tool_input: { plan: 'P' }
  })!
  const question = parseAnswerableHook('PreToolUse', askBody)!

  it('permission：allow/deny → hookSpecificOutput.decision.behavior', () => {
    expect(buildHookDecision(permission, { kind: 'permission', action: 'allow' })).toEqual({
      ok: true,
      decision: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      }
    })
    expect(buildHookDecision(permission, { kind: 'permission', action: 'deny' })).toMatchObject({
      decision: { hookSpecificOutput: { decision: { behavior: 'deny' } } }
    })
    expect(buildHookDecision(permission, { kind: 'permission', action: 'approve' })).toEqual({
      ok: false,
      reason: 'bad-action'
    })
  })

  it('plan：批准回放 tool_input；拒绝给固定原因（页面无自由文本）', () => {
    expect(buildHookDecision(plan, { kind: 'plan', action: 'approve' })).toEqual({
      ok: true,
      decision: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { plan: 'P' }
        }
      }
    })
    const denied = buildHookDecision(plan, { kind: 'plan', action: 'reject' })
    expect(denied.ok).toBe(true)
    if (denied.ok) {
      const hso = denied.decision['hookSpecificOutput'] as Record<string, unknown>
      expect(hso['permissionDecision']).toBe('deny')
      expect(String(hso['permissionDecisionReason'])).toContain('declined')
    }
  })

  it('question：单选 → label；多选 → 数组；可混自由文本（D2）；updatedInput 保留原字段', () => {
    const built = buildHookDecision(question, {
      kind: 'question',
      selections: [
        { questionIndex: 0, optionIndexes: [0] },
        { questionIndex: 1, optionIndexes: [0, 2], text: '另外加 CI' }
      ]
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const hso = built.decision['hookSpecificOutput'] as Record<string, unknown>
    expect(hso['hookEventName']).toBe('PreToolUse')
    expect(hso['permissionDecision']).toBe('allow')
    const updated = hso['updatedInput'] as Record<string, unknown>
    // 其他 tool_input 字段原样保留（claude 需要完整输入）
    expect(updated['questions']).toEqual(askBody.tool_input.questions)
    expect(updated['answers']).toEqual({
      '用哪种方案？': '方案 A',
      '要包含哪些文件？': ['源码', '文档', '另外加 CI']
    })
  })

  it('question：单选自由文本替代选项；未答/越界/多选超选/类型不符 → 拒绝', () => {
    const textOnly = buildHookDecision(question, {
      kind: 'question',
      selections: [
        { questionIndex: 0, text: '第三种方案' },
        { questionIndex: 1, optionIndexes: [1] }
      ]
    })
    expect(textOnly.ok).toBe(true)
    if (textOnly.ok) {
      const answers = (textOnly.decision['hookSpecificOutput'] as Record<string, unknown>)[
        'updatedInput'
      ] as Record<string, unknown>
      expect((answers['answers'] as Record<string, unknown>)['用哪种方案？']).toBe('第三种方案')
    }

    expect(buildHookDecision(question, { kind: 'question', selections: [{ questionIndex: 0 }] })).toEqual({
      ok: false,
      reason: 'unanswered'
    })
    expect(
      buildHookDecision(question, {
        kind: 'question',
        selections: [
          { questionIndex: 0, optionIndexes: [9] },
          { questionIndex: 1, optionIndexes: [0] }
        ]
      })
    ).toEqual({ ok: false, reason: 'bad-selection' })
    // 单选给多项
    expect(
      buildHookDecision(question, {
        kind: 'question',
        selections: [
          { questionIndex: 0, optionIndexes: [0, 1] },
          { questionIndex: 1, optionIndexes: [0] }
        ]
      })
    ).toEqual({ ok: false, reason: 'bad-selection' })
    // 自由文本超 2000 字符
    expect(
      buildHookDecision(question, {
        kind: 'question',
        selections: [
          { questionIndex: 0, text: 'x'.repeat(2001) },
          { questionIndex: 1, optionIndexes: [0] }
        ]
      })
    ).toEqual({ ok: false, reason: 'bad-selection' })
    // kind 不符
    const wrong: AnswerChoice = { kind: 'permission', action: 'allow' }
    expect(buildHookDecision(question, wrong)).toEqual({ ok: false, reason: 'kind-mismatch' })
  })
})