import { describe, expect, it } from 'vitest'
import {
  decodeClientFrame,
  encodeServerFrame,
  FrameDecodeError
} from '../frames'
import type { ClientFrame, ServerFrame } from '../shared/remote-protocol'

/**
 * L2 帧编解码：ClientFrame 14 型全解、ServerFrame 5 型全编、畸形拒绝。
 * 编解码是两侧逐帧一致的地基——契约形状变化必须先过这里（再走 sync-protocol 校验）。
 */

/** 全部 14 型合法 ClientFrame 样本（字段值=契约 JSDoc 语义的最小代表） */
const CLIENT_FRAMES: ClientFrame[] = [
  {
    type: 'task.spawn',
    rid: 'r1',
    req: {
      taskId: 't-uuid',
      argv: ['claude', '--session-id', 't-uuid', '-n', '名字可以中文'],
      cwd: '/home/dev/proj',
      cols: 120,
      rows: 40,
      settingsPath: '/home/dev/.cwb-server/task-abc.settings.json',
      envDenylist: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']
    }
  },
  { type: 'task.spawn', req: { taskId: 't2', argv: ['claude'], cwd: '/tmp', cols: 80, rows: 24 } },
  { type: 'task.write', taskId: 't2', data: 'ls -la\r' },
  { type: 'task.resize', taskId: 't2', cols: 100, rows: 30 },
  { type: 'task.kill', taskId: 't2', rid: 'r2' },
  { type: 'task.kill', taskId: 't2' },
  { type: 'task.attach', taskId: 't2', rid: 'r3' },
  { type: 'task.detach', taskId: 't2' },
  { type: 'task.list', rid: 'r4' },
  { type: 'server.ping', rid: 'r5' },
  { type: 'server.version', rid: 'r6' },
  { type: 'proxy.status', rid: 'r7' },
  { type: 'proxy.start', rid: 'r8' },
  { type: 'proxy.stop', rid: 'r9' },
  { type: 'proxy.config.get', rid: 'r10' },
  { type: 'proxy.config.set', rid: 'r11', patch: { proxyUrl: 'http://127.0.0.1:7890' } }
]

describe('decodeClientFrame（14 型全解）', () => {
  for (const frame of CLIENT_FRAMES) {
    it(`解码 ${frame.type}${'rid' in frame ? '(rid)' : '(fire-and-forget)'}`, () => {
      const decoded = decodeClientFrame(JSON.stringify(frame))
      expect(decoded).toEqual(frame)
    })
  }

  it("14 型全集=契约 ClientFrame['type']（缺一即编译红+此处失败）", () => {
    expect(new Set(CLIENT_FRAMES.map((f) => f.type))).toEqual(
      new Set([
        'task.spawn', 'task.write', 'task.resize', 'task.kill', 'task.attach',
        'task.detach', 'task.list', 'server.ping', 'server.version',
        'proxy.status', 'proxy.start', 'proxy.stop', 'proxy.config.get', 'proxy.config.set'
      ])
    )
  })

  it('JSON 往返保留 UTF-8 内容（task.write 中文/控制字符）', () => {
    const decoded = decodeClientFrame(
      JSON.stringify({ type: 'task.write', taskId: 't', data: '中文输入\x1b[A\r\n' })
    )
    expect(decoded).toEqual({ type: 'task.write', taskId: 't', data: '中文输入\x1b[A\r\n' })
  })
})

describe('decodeClientFrame 畸形拒绝', () => {
  const cases: Array<[string, unknown, string]> = [
    ['非法 JSON', '{not json', 'invalid JSON'],
    ['非对象', '[1,2]', 'not an object'],
    ['缺 type', JSON.stringify({ taskId: 't' }), 'field type'],
    ['未知帧类型', JSON.stringify({ type: 'task.nope' }), 'unknown frame type'],
    ['task.write 缺 data', JSON.stringify({ type: 'task.write', taskId: 't' }), 'field data'],
    ['task.write 缺 taskId', JSON.stringify({ type: 'task.write', data: 'x' }), 'field taskId'],
    ['task.resize 缺尺寸', JSON.stringify({ type: 'task.resize', taskId: 't' }), 'field cols'],
    ['task.spawn 缺 req', JSON.stringify({ type: 'task.spawn' }), 'field req'],
    ['task.spawn req.argv 非字符串数组', JSON.stringify({ type: 'task.spawn', req: { taskId: 't', argv: [1], cwd: '/tmp', cols: 80, rows: 24 } }), 'req.argv'],
    ['task.spawn req.cols 越界', JSON.stringify({ type: 'task.spawn', req: { taskId: 't', argv: ['x'], cwd: '/tmp', cols: 1, rows: 24 } }), 'out of range'],
    ['task.spawn req.envDenylist 非字符串', JSON.stringify({ type: 'task.spawn', req: { taskId: 't', argv: ['x'], cwd: '/tmp', cols: 80, rows: 24, envDenylist: [3] } }), 'envDenylist'],
    ['proxy.config.set 缺 patch', JSON.stringify({ type: 'proxy.config.set' }), 'field patch'],
    ['rid 类型错误', JSON.stringify({ type: 'server.ping', rid: 42 }), 'field rid']
  ]
  for (const [name, raw, expectMsg] of cases) {
    it(`拒绝：${name}`, () => {
      expect(() => decodeClientFrame(raw as string)).toThrowError(FrameDecodeError)
      try {
        decodeClientFrame(raw as string)
      } catch (err) {
        // 错误消息只含字段/类型描述——不回显帧体（8.1=A：内容不进日志）
        expect((err as Error).message).toContain(expectMsg)
      }
    })
  }
})

describe('encodeServerFrame（5 型全编 + rid 关联）', () => {
  const frames: ServerFrame[] = [
    { type: 'task.data', taskId: 't', chunk: 'output 中文 \x1b[2J' },
    { type: 'task.exit', taskId: 't', exitCode: 0 },
    { type: 'server.log', level: 'info', message: 'listening on 127.0.0.1:17717' },
    { type: 'conn.closed', reason: 'server shutting down' },
    { type: 'conn.closed' },
    { type: 'result', inReplyTo: 'r1', ok: true, payload: { pong: true } },
    { type: 'result', inReplyTo: 'r2', ok: false, error: 'unknown task: t' }
  ]
  for (const frame of frames) {
    it(`编码 ${frame.type}`, () => {
      expect(JSON.parse(encodeServerFrame(frame))).toEqual(frame)
    })
  }

  it('result.inReplyTo 关联请求 rid（编码保留原值）', () => {
    const rid = 'req-abc-123'
    const encoded = encodeServerFrame({ type: 'result', inReplyTo: rid, ok: true, payload: {} })
    expect((JSON.parse(encoded) as { inReplyTo: string }).inReplyTo).toBe(rid)
  })

  it('拒绝：未知类型/缺必填', () => {
    expect(() => encodeServerFrame({ type: 'nope' } as unknown as ServerFrame)).toThrowError(
      FrameDecodeError
    )
    expect(() =>
      encodeServerFrame({ type: 'result', ok: true } as unknown as ServerFrame)
    ).toThrowError(FrameDecodeError)
    expect(() =>
      encodeServerFrame({ type: 'task.exit', taskId: 't' } as unknown as ServerFrame)
    ).toThrowError(FrameDecodeError)
  })
})
