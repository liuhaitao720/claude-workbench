import { describe, expect, it } from 'vitest'
import { TaskRegistry, type PtyProcess, type TaskSink } from '../pty-registry'
import type { RemoteTaskSpawnRequest } from '../shared/remote-protocol'

/**
 * L2 PTY 注册表：生命周期/attach-deton 语义/两条 re-attach 重绘路径（toggle+回放）/
 * 5.9=b 断连保活（detachAll 不杀）。FakePty 注入——真实 PTY 走 L3（l3-protocol）。
 */

class FakePty implements PtyProcess {
  readonly pid: number
  cols: number
  rows: number
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  killed = false
  private readonly dataListeners: Array<(d: string) => void> = []
  private readonly exitListeners: Array<(e: { exitCode: number }) => void> = []

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ) {
    this.pid = FakePty.nextPid++
    this.cols = options.cols
    this.rows = options.rows
  }

  private static nextPid = 40_000

  write(data: string): void {
    this.writes.push(data)
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.resizes.push({ cols, rows })
  }
  kill(): void {
    this.killed = true
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener)
    return { dispose: () => {} }
  }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener)
    return { dispose: () => {} }
  }
  emitData(d: string): void {
    for (const l of [...this.dataListeners]) l(d)
  }
  emitExit(code: number): void {
    for (const l of [...this.exitListeners]) l({ exitCode: code })
  }
}

interface RecordingSink extends TaskSink {
  chunks: string[]
  exits: Array<{ taskId: string; code: number }>
}

function recordingSink(): RecordingSink {
  const sink: RecordingSink = {
    chunks: [],
    exits: [],
    onData: (_taskId, chunk) => sink.chunks.push(chunk),
    onExit: (taskId, code) => sink.exits.push({ taskId, code })
  }
  return sink
}

const REQ = (over: Partial<RemoteTaskSpawnRequest> = {}): RemoteTaskSpawnRequest => ({
  taskId: 't-1',
  argv: ['claude', '--session-id', 't-1'],
  cwd: '/home/dev/proj',
  cols: 120,
  rows: 40,
  ...over
})

function makeRegistry() {
  const created: FakePty[] = []
  const events = { spawned: [] as Array<[string, number]>, exited: [] as Array<[string, number]> }
  const registry = new TaskRegistry(
    {
      onTaskSpawn: (taskId, pid) => events.spawned.push([taskId, pid]),
      onTaskExit: (taskId, code) => events.exited.push([taskId, code])
    },
    (file, args, options) => {
      const pty = new FakePty(file, args, options)
      created.push(pty)
      return pty
    }
  )
  return { registry, created, events }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('TaskRegistry 生命周期', () => {
  it('spawn：argv 原样/env 形态（TERM/COLORTERM/envDenylist 剥离）/cwd/尺寸', async () => {
    process.env['CLAUDECODE'] = '1' // 宿主 claude 会话标记（须剥离——独立用户会话）
    process.env['ANTHROPIC_BASE_URL'] = 'https://inherited.example'
    try {
      const { registry, created, events } = makeRegistry()
      const pid = await registry.spawn(
        REQ({ envDenylist: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] })
      )
      const pty = created[0]!
      expect(pty.file).toBe('claude')
      expect(pty.args).toEqual(['--session-id', 't-1'])
      expect(pty.options.cwd).toBe('/home/dev/proj')
      expect(pty.options.cols).toBe(120)
      expect(pty.options.rows).toBe(40)
      expect(pty.options.name).toBe('xterm-256color')
      expect(pty.options.env['TERM']).toBe('xterm-256color')
      expect(pty.options.env['COLORTERM']).toBe('truecolor')
      expect(pty.options.env['CLAUDECODE']).toBeUndefined()
      expect(pty.options.env['ANTHROPIC_BASE_URL']).toBeUndefined()
      expect(pid).toBe(pty.pid)
      expect(events.spawned).toEqual([['t-1', pty.pid]])
      expect(registry.has('t-1')).toBe(true)
    } finally {
      delete process.env['CLAUDECODE']
      delete process.env['ANTHROPIC_BASE_URL']
    }
  })

  it('重复 spawn=幂等拒绝（契约语义）', async () => {
    const { registry } = makeRegistry()
    await registry.spawn(REQ())
    await expect(registry.spawn(REQ())).rejects.toThrow('task already exists: t-1')
  })

  it('argv 空数组拒绝', async () => {
    const { registry } = makeRegistry()
    await expect(registry.spawn(REQ({ argv: [] }))).rejects.toThrow('argv')
  })

  it('write/resize 直通；同尺寸 resize=no-op', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    registry.write('t-1', 'ls\r')
    expect(pty.writes).toEqual(['ls\r'])
    registry.resize('t-1', 130, 50)
    expect(pty.resizes).toEqual([{ cols: 130, rows: 50 }])
    registry.resize('t-1', 130, 50) // 同尺寸 → no-op（契约注释语义）
    expect(pty.resizes).toEqual([{ cols: 130, rows: 50 }])
    expect(() => registry.resize('t-1', 0, 50)).toThrow('out of range')
  })

  it('未知任务：write/resize/kill/attach 抛 unknown task', async () => {
    const { registry } = makeRegistry()
    const sink = recordingSink()
    expect(() => registry.write('nope', 'x')).toThrow('unknown task: nope')
    expect(() => registry.resize('nope', 80, 24)).toThrow('unknown task: nope')
    expect(() => registry.kill('nope')).toThrow('unknown task: nope')
    expect(() => registry.attach('nope', sink)).toThrow('unknown task: nope')
  })

  it('kill：pty.kill 调用；onExit→注册表移除+sink 收 exit 帧+事件', async () => {
    const { registry, created, events } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    registry.attach('t-1', sink)
    registry.kill('t-1')
    expect(pty.killed).toBe(true)
    pty.emitExit(129)
    expect(sink.exits).toEqual([{ taskId: 't-1', code: 129 }])
    expect(events.exited).toEqual([['t-1', 129]])
    expect(registry.has('t-1')).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it('list 摘要：taskId/pid/attached/cols/rows/startedAt/lastActivityAt', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    registry.attach('t-1', sink)
    const [s] = registry.list()
    expect(s).toMatchObject({
      taskId: 't-1',
      pid: pty.pid,
      attached: true,
      cols: 120,
      rows: 40
    })
    expect(typeof s!.startedAt).toBe('string')
    expect(typeof s!.lastActivityAt).toBe('string')
  })
})

describe('attach/detach 数据流', () => {
  it('attach 前数据只进 ring；attach 后实时推送', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    pty.emitData('before-attach\n')
    expect(sink.chunks).toEqual([])
    registry.attach('t-1', sink)
    pty.emitData('after-attach\n')
    expect(sink.chunks).toEqual(['after-attach\n'])
  })

  it('detach 停推不断 PTY（5.9=b）', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    registry.attach('t-1', sink)
    registry.detach('t-1', sink)
    pty.emitData('silenced\n')
    expect(sink.chunks).toEqual([])
    expect(registry.has('t-1')).toBe(true) // PTY 仍在
    expect(pty.killed).toBe(false)
  })

  it('detach 停推数据流但生命周期退出通知仍达（对齐客户端 onExit 语义）', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    registry.attach('t-1', sink)
    registry.detach('t-1', sink)
    pty.emitData('silenced\n')
    expect(sink.chunks).toEqual([]) // 数据流已停
    pty.emitExit(0)
    expect(sink.exits).toEqual([{ taskId: 't-1', code: 0 }]) // 退出通知仍达
  })

  it('detachAll（断连语义）只摘该 sink，任务与他人不受影响', async () => {
    const { registry } = makeRegistry()
    await registry.spawn(REQ())
    const s1 = recordingSink()
    const s2 = recordingSink()
    registry.attach('t-1', s1)
    registry.attach('t-1', s2)
    registry.detachAll(s1)
    registry.write('t-1', '\r') // lastActivity 更新
    expect(registry.list()[0]!.attached).toBe(true) // s2 仍挂
    const { registry: r2 } = makeRegistry()
    await r2.spawn(REQ({ taskId: 't-2' }))
    const lone = recordingSink()
    r2.attach('t-2', lone)
    r2.detachAll(lone)
    expect(r2.list()[0]!.attached).toBe(false)
    expect(r2.has('t-2')).toBe(true)
  })
})

describe('re-attach 重绘（5.8=A）——两条路径都可断言', () => {
  it('路径1 toggle：attach 即刻 resize cols+1→复原（SIGWINCH 强制全量重绘）', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ({ cols: 100, rows: 30 }))
    const pty = created[0]!
    const sink = recordingSink()
    registry.attach('t-1', sink)
    expect(pty.resizes).toEqual([
      { cols: 101, rows: 30 }, // +1 逼 SIGWINCH
      { cols: 100, rows: 30 } // 复原
    ])
  })

  it('路径2 回放：toggle 后 300ms 无新数据→sink 收到环形缓冲尾部 ≤4000B', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    pty.emitData('boot-marker-1\nboot-marker-2\n') // 断连期间的历史输出
    registry.attach('t-1', sink)
    expect(sink.chunks).toEqual([]) // attach 不立即推历史
    await sleep(450) // >300ms 且无新数据 → 回放路径命中
    expect(sink.chunks.join('')).toContain('boot-marker-1')
    expect(sink.chunks.join('')).toContain('boot-marker-2')
    expect(Buffer.byteLength(sink.chunks.join(''), 'utf8')).toBeLessThanOrEqual(4000)
  })

  it('toggle 逼出新数据→回放取消（历史不重复推送）', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    pty.emitData('boot\n')
    registry.attach('t-1', sink)
    await sleep(80)
    pty.emitData('fresh-redraw\n') // toggle 的 SIGWINCH 逼出全量重绘（300ms 内）
    await sleep(450) // 回放窗口已过
    expect(sink.chunks.join('')).toBe('fresh-redraw\n') // boot 不再重复出现
  })

  it('任务退出后回放定时器不再投递', async () => {
    const { registry, created } = makeRegistry()
    await registry.spawn(REQ())
    const pty = created[0]!
    const sink = recordingSink()
    pty.emitData('boot\n')
    registry.attach('t-1', sink)
    pty.emitExit(0) // 300ms 窗口内退出
    await sleep(450)
    expect(sink.chunks).toEqual([]) // 无回放、无数据
    expect(sink.exits).toEqual([{ taskId: 't-1', code: 0 }])
  })
})
