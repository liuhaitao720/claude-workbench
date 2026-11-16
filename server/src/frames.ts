/**
 * 帧编解码（S3）：ClientFrame/ServerFrame 的 JSON 编解码与形状校验。
 *
 * 契约唯一事实源=src/shared/remote-protocol.ts（同步副本在 server/src/shared/，
 * 逐字节一致，勿改）。本文件只做「JSON 文本 ↔ 强类型帧」的编解码与防御性形状
 * 校验（畸形帧拒绝并给出不含对端内容的错误信息——错误消息只含字段名/类型名，
 * 不回显帧体，防终端内容经错误路径进日志，8.1=A）。
 */
import type { ClientFrame, RemoteTaskSpawnRequest, ServerFrame } from './shared/remote-protocol'

/** 解码失败（错误消息仅含字段/类型描述，不含帧体内容） */
export class FrameDecodeError extends Error {}

const CLIENT_FRAME_TYPES = [
  'task.spawn',
  'task.write',
  'task.resize',
  'task.kill',
  'task.attach',
  'task.detach',
  'task.list',
  'server.ping',
  'server.version',
  'proxy.status',
  'proxy.start',
  'proxy.stop',
  'proxy.config.get',
  'proxy.config.set',
  // v2.2.0 推送扩展 + 手机答复
  'presence',
  'server.capabilities',
  'answer.pending',
  'answer.cancel'
] as const satisfies readonly ClientFrame['type'][]

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function expect(obj: Record<string, unknown>, field: string, pred: (v: unknown) => boolean): void {
  if (!pred(obj[field])) {
    throw new FrameDecodeError(`field ${field}: unexpected type`)
  }
}

/** RemoteTaskSpawnRequest 形状校验（argv 原样透传——不解释内容） */
function assertSpawnRequest(v: unknown): asserts v is RemoteTaskSpawnRequest {
  if (!isObj(v)) throw new FrameDecodeError('field req: unexpected type')
  expect(v, 'taskId', str)
  expect(v, 'argv', Array.isArray)
  for (const a of v['argv'] as unknown[]) {
    if (!str(a)) throw new FrameDecodeError('field req.argv[]: unexpected type')
  }
  expect(v, 'cwd', str)
  const cols = v['cols']
  const rows = v['rows']
  if (!num(cols) || !num(rows) || cols < 2 || cols > 1000 || rows < 2 || rows > 1000) {
    throw new FrameDecodeError('field req.cols/rows: out of range')
  }
  if (v['settingsPath'] !== undefined) expect(v, 'settingsPath', str)
  // v2.0.2 任务显示名（服务器侧推送文案用；缺省不附）
  if (v['name'] !== undefined) expect(v, 'name', str)
  // v2.2.0 项目显示名（推送文案用；缺省不附）
  if (v['projectName'] !== undefined) expect(v, 'projectName', str)
  if (v['envDenylist'] !== undefined) {
    expect(v, 'envDenylist', Array.isArray)
    for (const n of v['envDenylist'] as unknown[]) {
      if (!str(n)) throw new FrameDecodeError('field req.envDenylist[]: unexpected type')
    }
  }
}

const ANSWER_KINDS = ['permission', 'question', 'plan'] as const
const isAnswerKind = (v: unknown): boolean =>
  (ANSWER_KINDS as readonly unknown[]).includes(v)

/** 待答复问题模型校验（问题原文/选项 label 透传——server 不解释文本语义） */
function assertAnswerPending(v: unknown): void {
  if (!isObj(v)) throw new FrameDecodeError('field pending: unexpected type')
  expect(v, 'pendingId', str)
  expect(v, 'taskId', str)
  expect(v, 'event', str)
  expect(v, 'kind', isAnswerKind)
  expect(v, 'taskName', str)
  if (v['projectName'] !== undefined) expect(v, 'projectName', str)
  expect(v, 'questions', Array.isArray)
  for (const q of v['questions'] as unknown[]) {
    if (!isObj(q)) throw new FrameDecodeError('field pending.questions[]: unexpected type')
    expect(q, 'question', str)
    if (q['header'] !== undefined) expect(q, 'header', str)
    if (q['multiSelect'] !== undefined) {
      expect(q, 'multiSelect', (x) => typeof x === 'boolean')
    }
    expect(q, 'options', Array.isArray)
    for (const o of q['options'] as unknown[]) {
      if (!isObj(o)) throw new FrameDecodeError('field pending.questions[].options[]: unexpected type')
      expect(o, 'label', str)
      if (o['description'] !== undefined) expect(o, 'description', str)
    }
  }
}

/** 手机/桌面提交的选择（索引 + 自由文本；server 侧再校验范围） */
function assertAnswerChoice(v: unknown): void {
  if (!isObj(v)) throw new FrameDecodeError('field choice: unexpected type')
  expect(v, 'kind', isAnswerKind)
  if (v['action'] !== undefined) {
    expect(v, 'action', (x) => x === 'allow' || x === 'deny' || x === 'approve' || x === 'reject')
  }
  if (v['selections'] !== undefined) {
    expect(v, 'selections', Array.isArray)
    for (const s of v['selections'] as unknown[]) {
      if (!isObj(s)) throw new FrameDecodeError('field choice.selections[]: unexpected type')
      expect(s, 'questionIndex', num)
      if (s['optionIndexes'] !== undefined) {
        expect(s, 'optionIndexes', Array.isArray)
        for (const i of s['optionIndexes'] as unknown[]) {
          if (!num(i)) throw new FrameDecodeError('field choice.selections[].optionIndexes[]: unexpected type')
        }
      }
      if (s['text'] !== undefined) expect(s, 'text', str)
    }
  }
}

function assertAnswerState(v: unknown): void {
  if (!isObj(v)) throw new FrameDecodeError('field state: unexpected type')
  expect(v, 'enabled', (x) => typeof x === 'boolean')
  if (v['baseUrl'] !== undefined) expect(v, 'baseUrl', str)
  expect(
    v,
    'tunnel',
    (x) => x === 'off' || x === 'starting' || x === 'up' || x === 'down' || x === 'missing'
  )
  expect(v, 'pendingCount', num)
}

/**
 * JSON 文本 → ClientFrame（严格形状校验；畸形抛 FrameDecodeError）。
 * 未知帧类型/字段缺失/类型不符一律拒绝——协议演进走版本协商（server.version），
 * 不做宽容解析（宽容=静默丢字段=两侧漂移不可见）。
 */
export function decodeClientFrame(text: string): ClientFrame {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new FrameDecodeError('invalid JSON')
  }
  if (!isObj(raw)) throw new FrameDecodeError('frame: not an object')
  const type = raw['type']
  if (!str(type)) throw new FrameDecodeError('field type: unexpected type')
  if (!(CLIENT_FRAME_TYPES as readonly string[]).includes(type)) {
    throw new FrameDecodeError(`unknown frame type`)
  }
  // 逐类型必填字段校验（rid 可选；fire-and-forget 帧无回执）
  switch (type) {
    case 'task.spawn':
      expect(raw, 'req', isObj)
      assertSpawnRequest(raw['req'])
      break
    case 'task.write':
    case 'task.resize':
    case 'task.attach':
    case 'task.detach':
      expect(raw, 'taskId', str)
      break
    case 'task.kill':
    case 'task.list':
    case 'server.ping':
    case 'server.version':
    case 'proxy.status':
    case 'proxy.start':
    case 'proxy.stop':
    case 'proxy.config.get':
      break
    case 'proxy.config.set':
      expect(raw, 'patch', isObj)
      break
    case 'presence':
      expect(raw, 'lastInputAt', num)
      expect(raw, 'focused', (v) => typeof v === 'boolean')
      break
    case 'server.capabilities':
      break
    case 'answer.pending':
      expect(raw, 'pending', isObj)
      assertAnswerPending(raw['pending'])
      break
    case 'answer.cancel':
      if (raw['pendingId'] !== undefined) expect(raw, 'pendingId', str)
      if (raw['taskId'] !== undefined) expect(raw, 'taskId', str)
      break
  }
  if (type === 'task.write') expect(raw, 'data', str)
  if (type === 'task.resize') {
    expect(raw, 'cols', num)
    expect(raw, 'rows', num)
  }
  if (raw['rid'] !== undefined) expect(raw, 'rid', str)
  return raw as ClientFrame
}

/** ServerFrame → JSON 文本（输出侧同样做形状校验，双向对称防回归） */
export function encodeServerFrame(frame: ServerFrame): string {
  assertServerFrame(frame)
  return JSON.stringify(frame)
}

function assertServerFrame(frame: ServerFrame): void {
  if (!isObj(frame)) throw new FrameDecodeError('frame: not an object')
  if (!str(frame['type'])) throw new FrameDecodeError('field type: unexpected type')
  switch (frame['type']) {
    case 'task.data':
      expect(frame, 'taskId', str)
      expect(frame, 'chunk', str)
      break
    case 'task.exit':
      expect(frame, 'taskId', str)
      expect(frame, 'exitCode', num)
      break
    case 'hook.event':
      // v2.0.2 hook 转发（服务器侧接收口 → 在线客户端）
      expect(frame, 'taskId', str)
      expect(frame, 'event', str)
      expect(frame, 'epoch', num)
      break
    case 'server.log':
      expect(frame, 'level', (v) => v === 'info' || v === 'warn' || v === 'error')
      expect(frame, 'message', str)
      break
    case 'conn.closed':
      if (frame['reason'] !== undefined) expect(frame, 'reason', str)
      break
    case 'result':
      expect(frame, 'inReplyTo', str)
      expect(frame, 'ok', (v) => typeof v === 'boolean')
      if (frame['error'] !== undefined) expect(frame, 'error', str)
      break
    case 'answer.pending':
      expect(frame, 'pending', isObj)
      assertAnswerPending(frame['pending'])
      if (frame['url'] !== undefined) expect(frame, 'url', str)
      break
    case 'answer.submit':
      expect(frame, 'pendingId', str)
      expect(frame, 'choice', isObj)
      assertAnswerChoice(frame['choice'])
      break
    case 'answer.resolved':
      if (frame['pendingId'] !== undefined) expect(frame, 'pendingId', str)
      expect(frame, 'taskId', str)
      expect(frame, 'by', (v) => v === 'phone' || v === 'desktop' || v === 'system')
      expect(frame, 'action', (v) => v === 'answered' || v === 'cancelled' || v === 'expired')
      break
    case 'answer.stop':
      expect(frame, 'taskId', str)
      break
    case 'answer.state':
      expect(frame, 'state', isObj)
      assertAnswerState(frame['state'])
      break
    default:
      throw new FrameDecodeError('unknown frame type')
  }
}
