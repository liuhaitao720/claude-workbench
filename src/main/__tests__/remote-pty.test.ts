import { describe, expect, it, vi } from 'vitest'
import type { ClientFrame, ServerFrame } from '../../shared/remote-protocol'
import type { ConnectionStateChangedEvent, PtyDataEvent } from '../../shared/types'
import type { PtyBackendCallbacks } from '../pty-backend'
import {
  REMOTE_ENV_DENYLIST,
  RemotePtyHub,
  RemotePtyManager,
  type RemotePtyManagerOptions
} from '../remote-pty'
import {
  NEED_SERVER_INSTALL_TOKEN,
  isValidServerFrame,
  needInstallError
} from '../server-client'
import type { ServerClientEvents, ServerTransport } from '../server-client'
import type { ConnectionManager } from '../ssh/connection-manager'

/**
 * S4 L2：RemotePtyManager 状态机（mock ServerClient 帧——FakeTransport 记录出向
 * 帧/脚本化入向帧）+ 帧形状守卫 + needInstall token。
 * 覆盖：spawn→attach 背靠背（含 envDenylist/pid 回执缓存）、resume 撞存活任务=
 * re-attach、write/resize/kill 帧、killAllTrees=detach-only（绝无 task.kill）、
 * task.exit→onExit 清注册表、断连 all-detached + isRunning 保持、重连 task.list
 * 对账（存活重 attach / 消亡合成 onExit）。
 */

/** 帧级替身：记录出向帧；scripts 提供按帧类型的回执 payload */
class FakeTransport implements ServerTransport {
  readonly sent: ClientFrame[] = []
  connected = false
  /** type → payload（task.list 用）；缺省回执 {ok:true} 的 payload=undefined */
  listPayload: Array<Record<string, unknown>> = []
  /** v2.0.2 server.version 回执（缺省 0.1.1=支持 hook 服务器侧直收） */
  versionPayload: string = '0.1.1'
  /** connect() 行为（缺省成功） */
  connectImpl: () => Promise<void> = async () => {
    this.connected = true
  }
  private events: ServerClientEvents | null = null

  constructor(events?: ServerClientEvents) {
    if (events !== undefined) this.events = events
  }

  bind(events: ServerClientEvents): void {
    this.events = events
  }

  async connect(): Promise<void> {
    await this.connectImpl()
  }

  async request<T = unknown>(frame: ClientFrame): Promise<T> {
    if (!this.connected) throw new Error(`server-client not connected (${frame.type})`)
    this.sent.push(frame)
    if (frame.type === 'task.list') return this.listPayload as T
    if (frame.type === 'task.spawn') return { taskId: frame.req.taskId, pid: 4242 } as T
    if (frame.type === 'server.version') return { version: this.versionPayload } as T
    return undefined as T
  }

  send(frame: ClientFrame): boolean {
    if (!this.connected) return false
    this.sent.push(frame)
    return true
  }

  close(): void {
    this.connected = false
  }

  // ── 入向帧注入（模拟 server 推送） ────────────────────────────────────
  emit(frame: ServerFrame): void {
    if (this.events === null) throw new Error('events not bound')
    switch (frame.type) {
      case 'task.data':
        this.events.onData(frame.taskId, frame.chunk)
        return
      case 'task.exit':
        this.events.onExit(frame.taskId, frame.exitCode)
        return
      case 'server.log':
        this.events.onLog(frame.level, frame.message)
        return
      case 'conn.closed':
        this.events.onClosed(frame.reason)
        return
      case 'hook.event':
        this.events.onHookEvent?.(frame.taskId, frame.event, frame.epoch)
        return
      default:
        return
    }
  }

  framesOf(type: ClientFrame['type']): ClientFrame[] {
    return this.sent.filter((f) => f.type === type)
  }
}

/** 连接替身：状态事件注入器 */
class FakeConnection {
  state = 'connected'
  private readonly subs = new Set<(e: ConnectionStateChangedEvent) => void>()
  forwardInPorts: number[] = []
  constructor(readonly id = 'c-test') {}
  asManager(): ConnectionManager {
    return {
      connect: async () => {},
      disconnect: async () => {},
      getState: () => 'connected' as const,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      sftp: async () => {
        throw new Error('not needed')
      },
      forwardOut: async () => 0,
      forwardIn: async (_id: string, port: number) => {
        this.forwardInPorts.push(port)
      },
      onStateChange: (cb: (e: ConnectionStateChangedEvent) => void) => {
        this.subs.add(cb)
        return () => {
          this.subs.delete(cb)
        }
      },
      onLog: () => () => {}
    }
  }
  emitState(state: ConnectionStateChangedEvent['state']): void {
    this.state = state
    for (const cb of this.subs) cb({ connectionId: this.id, state })
  }
}

function makeManager(): {
  mgr: RemotePtyManager
  transport: FakeTransport
  conn: FakeConnection
  data: PtyDataEvent[]
  exits: string[]
  logs: Array<[string, string]>
} {
  const data: PtyDataEvent[] = []
  const exits: string[] = []
  const logs: Array<[string, string]> = []
  const callbacks: PtyBackendCallbacks = {
    onData: (e) => data.push(e),
    onExit: (id) => exits.push(id)
  }
  const conn = new FakeConnection()
  const transport = new FakeTransport()
  const opts: RemotePtyManagerOptions = {
    connectionId: conn.id,
    connection: conn.asManager(),
    callbacks,
    onServerLog: (level, message) => logs.push([level, message]),
    transportFactory: (events) => {
      transport.bind(events)
      return transport
    }
  }
  return { mgr: new RemotePtyManager(opts), transport, conn, data, exits, logs }
}

describe('S4 RemotePtyManager 状态机（FakeTransport 帧级 mock）', () => {
  it('① spawnClaude：task.list 对账空 → task.spawn（Linux argv/envDenylist/settingsPath）+ 背靠背 task.attach；pid 回执缓存', async () => {
    const { mgr, transport } = makeManager()
    await mgr.spawnClaude('t1', ['--session-id', 't1', '--settings', '/vm/home/.cwb-server/task-settings/t1.json'], '/home/vm/proj')
    // argv[0]=claude 裸名（server 侧登录 PATH 解析 nvm shim）
    const spawn = transport.framesOf('task.spawn')[0]
    expect(spawn).toBeDefined()
    if (spawn?.type !== 'task.spawn') throw new Error('unreachable')
    expect(spawn.req.argv).toEqual([
      'claude',
      '--session-id',
      't1',
      '--settings',
      '/vm/home/.cwb-server/task-settings/t1.json'
    ])
    expect(spawn.req.cwd).toBe('/home/vm/proj')
    expect(spawn.req.envDenylist).toEqual([...REMOTE_ENV_DENYLIST])
    expect(spawn.req.envDenylist).toContain('ANTHROPIC_BASE_URL')
    expect(spawn.req.settingsPath).toBe('/vm/home/.cwb-server/task-settings/t1.json')
    // spawn→attach 背靠背（server 侧 spawn 不自动挂 sink）
    expect(transport.framesOf('task.attach').map((f) => (f.type === 'task.attach' ? f.taskId : ''))).toEqual(['t1'])
    expect(mgr.pid('t1')).toBe(4242) // spawn 回执 payload={taskId,pid} 缓存
    expect(mgr.isRunning('t1')).toBe(true)
    expect(mgr.currentSize('t1')).toEqual({ cols: 80, rows: 24 })
    // 重复 spawn 同步拒绝（对齐本地 PtyManager 语义）
    await expect(mgr.spawnClaude('t1', [], '/cwd')).rejects.toThrow(/already running/)
  })

  it('② spawnClaude resume 撞 server 存活任务（task.list 命中）→ re-attach 不 spawn（5.9=b）', async () => {
    const { mgr, transport } = makeManager()
    transport.listPayload = [{ taskId: 't-alive', pid: 999, attached: false }]
    await mgr.spawnClaude('t-alive', ['--resume', 't-alive'], '/home/vm/proj')
    expect(transport.framesOf('task.spawn')).toHaveLength(0) // 不重复 spawn
    expect(transport.framesOf('task.attach').length).toBe(1)
    expect(mgr.pid('t-alive')).toBe(999) // list 对账补齐 pid
  })

  it('③ write/resize/kill 帧 + resize 尺寸记忆（currentSize 跟随）', async () => {
    const { mgr, transport } = makeManager()
    await mgr.spawnClaude('t1', [], '/cwd')
    mgr.write('t1', 'ls\r')
    mgr.resize('t1', 120, 40)
    mgr.kill('t1')
    expect(transport.framesOf('task.write')[0]).toMatchObject({ taskId: 't1', data: 'ls\r' })
    expect(transport.framesOf('task.resize')[0]).toMatchObject({ taskId: 't1', cols: 120, rows: 40 })
    expect(transport.framesOf('task.kill')[0]).toMatchObject({ taskId: 't1' })
    expect(mgr.currentSize('t1')).toEqual({ cols: 120, rows: 40 })
  })

  it('④ killAllTrees=detach-only：仅 close 传输，绝不 task.kill（H2/5.9=b）；forget 清记录不杀', async () => {
    const { mgr, transport } = makeManager()
    await mgr.spawnClaude('t1', [], '/cwd')
    transport.sent.length = 0
    mgr.killAllTrees()
    expect(transport.connected).toBe(false)
    expect(transport.framesOf('task.kill')).toHaveLength(0) // 红线：禁杀
    expect(mgr.isRunning('t1')).toBe(true) // 注册表保留（server 保活语义）
    mgr.forget('t1')
    expect(mgr.isRunning('t1')).toBe(false)
    expect(transport.framesOf('task.kill')).toHaveLength(0) // forget 也不杀
  })

  it('⑤ task.exit 帧 → onExit 外送 + 注册表清理（ipc markStatus exited 链路驱动源）', async () => {
    const { mgr, transport, exits, data } = makeManager()
    await mgr.spawnClaude('t1', [], '/cwd')
    transport.emit({ type: 'task.data', taskId: 't1', chunk: 'A1-OK' })
    transport.emit({ type: 'task.exit', taskId: 't1', exitCode: 0 })
    expect(data).toEqual([{ taskId: 't1', data: 'A1-OK' }])
    expect(exits).toEqual(['t1'])
    expect(mgr.isRunning('t1')).toBe(false)
    expect(mgr.pid('t1')).toBeUndefined()
    // 未知任务的迟到 exit：静默（不外送空回调）
    transport.emit({ type: 'task.exit', taskId: 'ghost', exitCode: 1 })
    expect(exits).toEqual(['t1'])
  })

  it('⑥ server.log 帧 → onServerLog 桥（RemoteServerLog EVENT 数据源）', async () => {
    const { mgr, transport, logs } = makeManager()
    await mgr.spawnClaude('t1', [], '/cwd')
    transport.emit({ type: 'server.log', level: 'warn', message: 'proxy config updated' })
    expect(logs).toEqual([['warn', 'proxy config updated']])
  })

  it('⑦ 断连（reconnecting）→ all-detached：isRunning 保持 running 语义、键入丢帧；重连对账——存活重 attach、消亡合成 onExit', async () => {
    const { mgr, transport, conn, exits } = makeManager()
    await mgr.spawnClaude('t-alive', [], '/cwd')
    await mgr.spawnClaude('t-dead', [], '/cwd')
    // 断连：状态事件 + WS close 双路径都只标记 detached
    conn.emitState('reconnecting')
    transport.emit({ type: 'conn.closed', reason: 'server shutting down' })
    expect(mgr.isRunning('t-alive')).toBe(true) // 5.9=b：冻结层语义
    mgr.write('t-alive', 'x') // 未连接 → send false（丢帧，冻结层禁输入由 UI 承担）
    // 重连：t-alive 仍在 server（list 命中）→ attach；t-dead 已消亡 → 合成 onExit
    transport.listPayload = [{ taskId: 't-alive', pid: 7, attached: false }]
    transport.connectImpl = async () => {
      transport.connected = true
    }
    transport.sent.length = 0
    conn.emitState('connected')
    await vi.waitFor(() => {
      expect(transport.framesOf('task.attach').length).toBe(1)
      expect(exits).toEqual(['t-dead'])
    })
    expect(transport.framesOf('task.attach')[0]).toMatchObject({ taskId: 't-alive' })
    expect(mgr.isRunning('t-dead')).toBe(false)
    expect(mgr.pid('t-alive')).toBe(7)
  })

  it('⑨ 重启后首连认领（v2.0.1——用户实测首开无上下文根因）：无 spawn/无传输 → connected 事件自建传输 + runningTaskIds 认领 attach（含 pid 回填）', async () => {
    const data: PtyDataEvent[] = []
    const exits: string[] = []
    const conn = new FakeConnection()
    const transport = new FakeTransport()
    const mgr = new RemotePtyManager({
      connectionId: conn.id,
      connection: conn.asManager(),
      callbacks: { onData: (e) => data.push(e), onExit: (id) => exits.push(id) },
      transportFactory: (events) => {
        transport.bind(events)
        return transport
      },
      runningTaskIds: () => ['t-prev-1', 't-prev-2']
    })
    transport.listPayload = [{ taskId: 't-prev-1', pid: 4242, attached: false }] // t-prev-2 已消亡
    transport.connectImpl = async () => {
      transport.connected = true
    }
    // 首连（此前此路径 transport===null 直接早退——什么都不发生）
    conn.emitState('connected')
    await vi.waitFor(() => {
      expect(transport.framesOf('task.attach')).toEqual([{ type: 'task.attach', taskId: 't-prev-1' }])
      expect(mgr.isRunning('t-prev-1')).toBe(true)
    })
    // 认领条目入注册表（isRunning/pid 生效）；消亡者合成 onExit（记录回终态）
    expect(mgr.isRunning('t-prev-1')).toBe(true)
    expect(mgr.pid('t-prev-1')).toBe(4242)
    expect(exits).toEqual(['t-prev-2'])
    // server 回放流（attach 后 task.data）经 onData 外送——renderer 缓冲后首开即上下文
    transport.emit({ type: 'task.data', taskId: 't-prev-1', chunk: 'ctx-line' })
    await vi.waitFor(() => {
      expect(data).toEqual([{ taskId: 't-prev-1', data: 'ctx-line' }])
    })
  })

  it('⑧ 重连时 server 不可达（needInstall）→ 降级记日志，注册表保持（不误杀）', async () => {
    const { mgr, transport, conn, logs, exits } = makeManager()
    await mgr.spawnClaude('t1', [], '/cwd')
    conn.emitState('reconnecting')
    transport.connected = false
    transport.connectImpl = async () => {
      throw needInstallError('connect ECONNREFUSED')
    }
    conn.emitState('connected')
    await vi.waitFor(() => {
      expect(logs.some(([level]) => level === 'warn')).toBe(true)
    })
    expect(exits).toEqual([]) // 不合成退出
    expect(mgr.isRunning('t1')).toBe(true)
  })

  it('⑧b 断连期间显式停止：kill 帧暂存 pendingKills，重连后补发（停止意图不丢失）', async () => {
    const { mgr, transport, conn } = makeManager()
    await mgr.spawnClaude('t1', [], '/cwd')
    conn.emitState('reconnecting')
    transport.connected = false
    mgr.kill('t1') // 断连期：帧不可达 → 暂存
    expect(transport.framesOf('task.kill')).toHaveLength(0)
    transport.connectImpl = async () => {
      transport.connected = true
    }
    conn.emitState('connected')
    await vi.waitFor(() => {
      expect(transport.framesOf('task.kill').length).toBe(1) // 重连补发
    })
    // 补发后 task.exit 到达 → pendingKills 清（幂等退出）
    transport.emit({ type: 'task.exit', taskId: 't1', exitCode: 0 })
    expect(mgr.isRunning('t1')).toBe(false)
  })
})

describe('S4 ServerClient 帧形状守卫 + needInstall token', () => {
  it('⑨ isValidServerFrame：合法帧全类型通过、畸形拒绝', () => {
    expect(isValidServerFrame({ type: 'task.data', taskId: 't', chunk: 'x' })).toBe(true)
    expect(isValidServerFrame({ type: 'task.exit', taskId: 't', exitCode: 0 })).toBe(true)
    expect(isValidServerFrame({ type: 'server.log', level: 'info', message: 'm' })).toBe(true)
    expect(isValidServerFrame({ type: 'conn.closed' })).toBe(true)
    expect(isValidServerFrame({ type: 'result', inReplyTo: 'r1', ok: true })).toBe(true)
    expect(isValidServerFrame({ type: 'task.data', taskId: 't', chunk: 42 })).toBe(false)
    expect(isValidServerFrame({ type: 'task.exit', taskId: 't', exitCode: '0' })).toBe(false)
    expect(isValidServerFrame({ type: 'result', inReplyTo: 1, ok: true })).toBe(false)
    expect(isValidServerFrame({ type: 'unknown', x: 1 })).toBe(false)
    expect(isValidServerFrame('nope')).toBe(false)
    expect(isValidServerFrame(null)).toBe(false)
  })

  it('⑩ needInstallError：token 可被 S6 NEED_INSTALL_RE（/needinstall|cwb-server/i）命中', () => {
    const err = needInstallError('connect ECONNREFUSED 127.0.0.1:17717')
    expect(err.message).toContain(NEED_SERVER_INSTALL_TOKEN)
    expect(/needinstall|cwb-server/i.test(err.message)).toBe(true)
  })
})

describe('S4 hooks 转发口（2.0.2 稳定优先口——客户端重启后保活会话的旧 hook URL 复活）', () => {
  function makeHub(mgr: ConnectionManager): RemotePtyHub {
    return new RemotePtyHub({
      connection: mgr,
      callbacks: { onData: () => {}, onExit: () => {} },
      onServerLog: () => {},
      hookSink: async () => ({ host: '127.0.0.1', port: 1 })
    })
  }

  it('默认首选稳定口 31280；同连接并发/重复取口只登记一次', async () => {
    const conn = new FakeConnection()
    const hub = makeHub(conn.asManager())
    await expect(hub.hookPortFor('c1')).resolves.toBe(31_280)
    await expect(hub.hookPortFor('c1')).resolves.toBe(31_280)
    expect(conn.forwardInPorts).toEqual([31_280])
    hub.disposeAll()
  })

  it('稳定口被 VM 占用 → 首连失败后回退随机区间（≠31280）；picker 注入时保持注入语义', async () => {
    const attempts: number[] = []
    const busy: ConnectionManager = {
      connect: async () => {},
      disconnect: async () => {},
      getState: () => 'connected' as const,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      sftp: async () => {
        throw new Error('not needed')
      },
      forwardOut: async () => 0,
      forwardIn: async (_id: string, port: number) => {
        attempts.push(port)
        if (port === 31_280) throw new Error('port busy')
      },
      onStateChange: () => () => {},
      onLog: () => () => {}
    }
    const hub = makeHub(busy)
    const got = await hub.hookPortFor('c2')
    expect(got).not.toBe(31_280)
    expect(got).toBeGreaterThanOrEqual(20_000)
    expect(got).toBeLessThan(45_000)
    expect(attempts[0]).toBe(31_280) // 先试稳定口
    hub.disposeAll()

    const pickerConn = new FakeConnection()
    const hub2 = new RemotePtyHub({
      connection: pickerConn.asManager(),
      callbacks: { onData: () => {}, onExit: () => {} },
      onServerLog: () => {},
      hookSink: async () => ({ host: '127.0.0.1', port: 1 }),
      hookPortPicker: () => 34_567
    })
    await expect(hub2.hookPortFor('c3')).resolves.toBe(34_567)
    hub2.disposeAll()
  })
})

describe('v2.0.2 推送服务器侧化（hook URL 基址门控 + hook.event 回放）', () => {
  function makeHookHub(
    conn: FakeConnection,
    o: { version?: string; sink?: { host: string; port: number } | null } = {}
  ): { hub: RemotePtyHub; transport: FakeTransport } {
    const transport = new FakeTransport()
    if (o.version !== undefined) transport.versionPayload = o.version
    const hub = new RemotePtyHub({
      connection: conn.asManager(),
      callbacks: { onData: () => {}, onExit: () => {} },
      onServerLog: () => {},
      ...(o.sink !== undefined
        ? { hookSink: async () => o.sink as { host: string; port: number } }
        : {}),
      transportFactory: (events) => {
        transport.bind(events)
        return transport
      }
    })
    return { hub, transport }
  }

  it('hookUrlBaseFor：server ≥0.1.1 → server 本机口；旧 server → 回退 forwardIn 口；serverPushesNotifyFor 同门控', async () => {
    const conn = new FakeConnection()
    const { hub } = makeHookHub(conn, { version: '0.1.1' })
    await expect(hub.hookUrlBaseFor('c1')).resolves.toBe('http://127.0.0.1:17717')
    expect(hub.serverPushesNotifyFor('c1')).toBe(true)
    hub.disposeAll()

    const old = makeHookHub(new FakeConnection(), { version: '0.1.0' })
    await expect(old.hub.hookUrlBaseFor('c2')).resolves.toBe('http://127.0.0.1:31280')
    expect(old.hub.serverPushesNotifyFor('c2')).toBe(false)
    old.hub.disposeAll()

    // 版本未知（查询失败）→ 回退 forwardIn + 不门控推送
    const fail = new FakeTransport()
    fail.connectImpl = async () => {
      throw new Error('unreachable')
    }
    const hubF = new RemotePtyHub({
      connection: new FakeConnection().asManager(),
      callbacks: { onData: () => {}, onExit: () => {} },
      onServerLog: () => {},
      transportFactory: (events) => {
        fail.bind(events)
        return fail
      }
    })
    await expect(hubF.hookUrlBaseFor('c3')).resolves.toBe('http://127.0.0.1:31280')
    expect(hubF.serverPushesNotifyFor('c3')).toBe(false)
    hubF.disposeAll()
  })

  it('hook.event 帧 → 回放进本机接收端（epoch 原样）；sink=null 静默丢弃', async () => {
    // 真实 http 接收端（收 hook POST 即 200 并记录）
    const received: string[] = []
    const sinkServer = require('node:http').createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      received.push(String(req.url))
      res.statusCode = 200
      res.end()
    })
    await new Promise<void>((r) => sinkServer.listen(0, '127.0.0.1', r))
    const sinkPort = (sinkServer.address() as { port: number }).port

    const { hub, transport } = makeHookHub(new FakeConnection(), {
      sink: { host: '127.0.0.1', port: sinkPort }
    })
    // 先触发 manager 创建（ensureTransport 绑定事件回调——server.version 顺带缓存）
    await hub.hookUrlBaseFor('c1')
    transport.connected = true
    transport.emit({
      type: 'hook.event',
      taskId: 'th-1',
      event: 'UserPromptSubmit',
      epoch: 7
    } as ServerFrame)
    await new Promise((r) => setTimeout(r, 200))
    expect(received[0]).toBe('/hook/UserPromptSubmit?e=7&t=th-1')
    hub.disposeAll()
    sinkServer.close()
  })
})
