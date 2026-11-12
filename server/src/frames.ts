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
  'proxy.config.set'
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
  if (v['envDenylist'] !== undefined) {
    expect(v, 'envDenylist', Array.isArray)
    for (const n of v['envDenylist'] as unknown[]) {
      if (!str(n)) throw new FrameDecodeError('field req.envDenylist[]: unexpected type')
    }
  }
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
    default:
      throw new FrameDecodeError('unknown frame type')
  }
}
