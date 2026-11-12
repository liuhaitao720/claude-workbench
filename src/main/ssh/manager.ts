import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { Client, type Channel, type SFTPWrapper, type Stats } from 'ssh2'
import type { Language } from '../../shared/i18n'
import type {
  ConnectionRuntimeState,
  ConnectionStateChangedEvent,
  RemoteServerLogEvent,
  SftpBrowseResult
} from '../../shared/types'
import { ConnectionsStore } from '../connections-store'
import type {
  ConnectionManager,
  SftpSession,
  SshExecResult
} from './connection-manager'
import { openSshClient, type OpenedSshClient, type SshClientTuning } from './client-core'
import { ConnectionError, isFatalConnectionError, mapSshError } from './errors'
import { BLOCKING_CHECK_IDS, runSelfCheck } from './self-check'

/**
 * S2 真实连接管理器（implements S1 契约 ConnectionManager，接口不得改动）。
 *
 * 语义锚点（确认单/方案 §2）：
 * - 每档案一条连接多路复用（4.3=a）：exec/sftp/forwardOut/forwardIn 共用同一 ssh2 Client；
 * - connect() resolve 不承诺 'connected'（认证/TOFU/自检流程可能拒绝）；
 * - 意外断链（非用户 disconnect）→ 'reconnecting' + 指数退避 1→2→5→10s 封顶无限重试
 *   （5.7=A）；connect() 在重连循环中再次调用 = 手动重试（清退避、立即尝试）；
 * - 判死（4.4=A）由 ssh2 keepalive 承担：keepaliveInterval 15s × keepaliveCountMax 3
 *   连续无响应 → ssh2 error+close → 本层转入重连；
 * - disconnect() 仅断 SSH 通道，绝不杀远端任务会话（5.9=b）；
 * - onLog 仅脱敏元数据（host:port/用户/事件；密钥/密码/passphrase 内容绝不入日志）。
 */

/** 5.7=A 退避序列（ms；封顶后无限重试） */
const DEFAULT_BACKOFF_SCHEDULE_MS = [1_000, 2_000, 5_000, 10_000]

export interface RealConnectionManagerOptions extends SshClientTuning {
  store: ConnectionsStore
  language: () => Language
  /** 重连退避序列（测试注入短序列） */
  backoffScheduleMs?: number[]
}

interface ConnEntry {
  id: string
  state: ConnectionRuntimeState
  client: Client | null
  sftpPromise: Promise<RealSftpSession> | null
  /** 目标态：connect() 置 true / disconnect() 置 false（意外断链后自动重连的依据） */
  wantConnected: boolean
  /** 用户主动断开（区别于意外断链；不再自动重连） */
  userDisconnect: boolean
  /** 重连循环活跃（失败继续退避重试） */
  loopActive: boolean
  attempt: number
  timer: NodeJS.Timeout | null
  establishing: Promise<void> | null
  /** forwardIn 注册表：remotePort → 入站流交付回调（重连后自动重放注册） */
  forwardIns: Map<number, (stream: NodeJS.ReadWriteStream) => void>
  /** 当前 client 上已向 server 侧登记的 remotePort（新 client 重置，防重复 forwardIn） */
  forwardInPorts: Set<number>
  /** forwardOut 本地监听（意外断链保留——重连后恢复转发；disconnect 时关闭） */
  forwardOutServers: Set<{ server: import('node:net').Server }>
}

export class RealConnectionManager implements ConnectionManager {
  private readonly store: ConnectionsStore
  private readonly language: () => Language
  private readonly backoff: number[]
  private readonly tuning: SshClientTuning
  private readonly entries = new Map<string, ConnEntry>()
  private readonly stateSubs = new Set<(e: ConnectionStateChangedEvent) => void>()
  private readonly logSubs = new Set<(e: RemoteServerLogEvent) => void>()

  constructor(opts: RealConnectionManagerOptions) {
    this.store = opts.store
    this.language = opts.language
    this.backoff =
      opts.backoffScheduleMs !== undefined && opts.backoffScheduleMs.length > 0
        ? opts.backoffScheduleMs
        : DEFAULT_BACKOFF_SCHEDULE_MS
    this.tuning = {
      connectTimeoutMs: opts.connectTimeoutMs,
      keepaliveIntervalMs: opts.keepaliveIntervalMs,
      keepaliveCountMax: opts.keepaliveCountMax
    }
  }

  async connect(connectionId: string): Promise<void> {
    const lang = this.language()
    const record = this.store.get(connectionId)
    if (record === undefined) throw new ConnectionError('notFound', lang, { detail: connectionId })
    const entry = this.ensureEntry(connectionId)

    entry.wantConnected = true
    entry.userDisconnect = false

    if (this.isOnline(entry)) return
    // 幂等/并发去重：已有进行中的建立尝试 → 等它收敛；未连上则视为手动重试立即再试
    if (entry.establishing !== null) {
      await entry.establishing
      if (this.isOnline(entry)) return
    }

    // 手动重试（5.7=A 外部触发）：重连循环等待中 → 清退避计时，立即重连
    const inLoop = entry.loopActive || entry.state === 'reconnecting'
    this.clearTimer(entry)
    entry.attempt = 0
    return this.runEstablish(entry, record, { reschedule: inLoop, propagate: true })
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId)
    if (entry === undefined) return
    entry.wantConnected = false
    entry.userDisconnect = true
    entry.loopActive = false
    this.clearTimer(entry)
    const client = entry.client
    entry.client = null
    entry.sftpPromise = null
    entry.forwardInPorts.clear()
    for (const { server } of entry.forwardOutServers) this.closeServer(server)
    entry.forwardOutServers.clear()
    if (client !== null) {
      try {
        client.end()
      } catch {
        /* 已死连接 end 失败无害 */
      }
    }
    if (entry.state !== 'offline') this.setState(entry, 'offline') // 幂等：已 offline 不重播事件
    this.log(entry.id, 'info', 'disconnected by user (remote task sessions kept alive, 5.9=b)')
  }

  getState(connectionId: string): ConnectionRuntimeState {
    return this.entries.get(connectionId)?.state ?? 'offline'
  }

  async exec(connectionId: string, command: string, opts?: { cwd?: string }): Promise<SshExecResult> {
    const entry = this.requireLiveEntry(connectionId)
    const full =
      opts?.cwd !== undefined && opts.cwd !== ''
        ? `cd ${posixQuote(opts.cwd)} && ${command}`
        : command
    return execOnClient(entry.client!, full, this.language())
  }

  async sftp(connectionId: string): Promise<SftpSession> {
    await this.connect(connectionId) // 懒连接（2.5=a；已连接幂等返回）
    const entry = this.requireLiveEntry(connectionId)
    if (entry.sftpPromise === null) {
      entry.sftpPromise = new Promise<RealSftpSession>((resolve, reject) => {
        entry.client!.sftp((err, sftp) => {
          if (err != null) {
            entry.sftpPromise = null
            reject(new Error(sanitize(err.message)))
            return
          }
          resolve(new RealSftpSession(sftp))
        })
      })
    }
    return entry.sftpPromise
  }

  async forwardOut(connectionId: string, remoteHost: string, remotePort: number): Promise<number> {
    await this.connect(connectionId) // 懒连接（S4 cwb-server WS 隧道锚点）
    const entry = this.requireLiveEntry(connectionId)
    const server = createNetServer((sock: Socket) => {
      const client = entry.client
      if (client === null) {
        sock.destroy()
        return
      }
      client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, stream) => {
        if (err != null) {
          sock.destroy()
          return
        }
        sock.pipe(stream)
        stream.pipe(sock)
        const done = (): void => {
          stream.destroy()
          sock.destroy()
        }
        sock.on('close', done)
        stream.on('close', done)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    entry.forwardOutServers.add({ server })
    const port = (server.address() as AddressInfo).port
    this.log(connectionId, 'info', `forwardOut local 127.0.0.1:${port} -> ${remoteHost}:${remotePort}`)
    return port
  }

  /**
   * 反向转发（M7）：VM 侧监听 127.0.0.1:remotePort，入站流以 handler 回调交付
   * （ssh2 'tcp' 事件 accept()）。同 remotePort 重复注册=去重：覆盖 handler、
   * 不重复向 server 登记（S2 定语义）；重连成功后自动重放全部注册。
   */
  async forwardIn(
    connectionId: string,
    remotePort: number,
    handler: (stream: NodeJS.ReadWriteStream) => void
  ): Promise<void> {
    await this.connect(connectionId) // 懒连接（S4 hooks 上报接线）
    const entry = this.requireLiveEntry(connectionId)
    entry.forwardIns.set(remotePort, handler)
    if (entry.forwardInPorts.has(remotePort)) return
    await this.requestForwardIn(entry, remotePort)
  }

  onStateChange(cb: (e: ConnectionStateChangedEvent) => void): () => void {
    this.stateSubs.add(cb)
    return () => this.stateSubs.delete(cb)
  }

  onLog(cb: (e: RemoteServerLogEvent) => void): () => void {
    this.logSubs.add(cb)
    return () => this.logSubs.delete(cb)
  }

  /** 全量清理（测试/编排收尾用；不在 S1 契约面内） */
  disposeAll(): void {
    for (const id of [...this.entries.keys()]) {
      void this.disconnect(id)
    }
  }

  // ── 内部：建立/重连状态机 ─────────────────────────────────────────────

  /**
   * 建立尝试（初始 connect / 定时重连 / 手动重试共用）。
   * mode.reschedule=true：非致命失败继续退避循环（重连/手动重试）；
   * mode.propagate=true：失败错误上抛调用方（connect() 的 await 拿到分级错误）。
   */
  private async runEstablish(
    entry: ConnEntry,
    record: import('../../shared/types').ConnectionRecord,
    mode: { reschedule: boolean; propagate: boolean }
  ): Promise<void> {
    const lang = this.language()
    const promise = (async () => {
      if (!mode.reschedule && entry.state !== 'reconnecting') this.setState(entry, 'connecting')
      let opened: OpenedSshClient | null = null
      try {
        const secret = this.store.revealSecret(record)
        opened = await openSshClient(record, secret, { language: this.language, ...this.tuning })
        if (!entry.wantConnected) {
          opened.client.end()
          this.setState(entry, 'offline')
          return
        }
        // 只读自检（2.1/2.2=A）：缺失阻断项 → 状态回 offline + 结构化失败清单上抛
        const checks = await runSelfCheck((command) => execOnClient(opened!.client, command, lang))
        if (!entry.wantConnected) {
          opened.client.end()
          this.setState(entry, 'offline')
          return
        }
        const missing = checks
          .filter((c) => c.status === 'missing' && (BLOCKING_CHECK_IDS as readonly string[]).includes(c.id))
          .map((c) => c.id)
        if (missing.length > 0) {
          opened.client.end()
          throw new ConnectionError('selfCheckFailed', lang, { missing, checks })
        }
        this.attach(entry, opened)
        entry.attempt = 0
        entry.loopActive = false
        this.setState(entry, 'connected')
        this.log(
          entry.id,
          'info',
          `connected ${record.host}:${record.port} as ${record.user} (host key ${opened.fingerprint})`
        )
        await this.replayForwardIns(entry) // 失败不阻断连接（log 降级）
      } catch (err) {
        try {
          opened?.client.end()
        } catch {
          /* noop */
        }
        const cerr = err instanceof ConnectionError ? err : mapSshError(err, lang)
        if (!entry.wantConnected) {
          this.setState(entry, 'offline')
          entry.loopActive = false
          return
        }
        const fatal = isFatalConnectionError(cerr.kind)
        if (!mode.reschedule || fatal) {
          // 用户显式 connect 的失败（或重连循环遇到致命类）：offline + 上抛/记日志，
          // 不自动重试——手动重试入口在 UI（5.7）
          entry.wantConnected = false
          entry.loopActive = false
          this.clearTimer(entry)
          this.setState(entry, 'offline')
          this.log(entry.id, 'error', `connect failed (${cerr.kind}): ${cerr.message}`)
          if (mode.propagate) throw cerr
          return
        }
        // 循环内非致命失败：继续退避重试；手动重试（propagate）同时把错误回给调用方
        this.scheduleReconnect(entry, cerr)
        if (mode.propagate) throw cerr
      }
    })()
    entry.establishing = promise
    try {
      await promise
    } finally {
      if (entry.establishing === promise) entry.establishing = null
    }
  }

  /** 意外断链调度：attempt+1 → 'reconnecting'（携 attempt）→ 退避后重试（5.7=A） */
  private scheduleReconnect(entry: ConnEntry, cause?: ConnectionError): void {
    entry.attempt += 1
    const delay = this.backoff[Math.min(entry.attempt - 1, this.backoff.length - 1)]
    entry.loopActive = true
    this.clearTimer(entry)
    this.setState(entry, 'reconnecting', entry.attempt)
    this.log(
      entry.id,
      'warn',
      `connection lost; auto-reconnect attempt ${entry.attempt} in ${delay}ms${cause !== undefined ? ` (${cause.kind})` : ''}`
    )
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (!entry.wantConnected || entry.userDisconnect) {
        entry.loopActive = false
        this.setState(entry, 'offline')
        return
      }
      const record = this.store.get(entry.id)
      if (record === undefined) {
        entry.loopActive = false
        entry.wantConnected = false
        this.setState(entry, 'offline')
        this.log(entry.id, 'error', 'connection profile removed; reconnect loop stopped')
        return
      }
      void this.runEstablish(entry, record, { reschedule: true, propagate: false }).catch(() => {
        /* runEstablish 自处理调度/上抛规则；此处兜底防 floating rejection */
      })
    }, delay)
  }

  private attach(entry: ConnEntry, opened: OpenedSshClient): void {
    entry.client = opened.client
    entry.sftpPromise = null
    entry.forwardInPorts.clear()
    const client = opened.client
    // 断链处理以 client 实例为身份：旧连接的迟到 error/close 不得误杀重连后的新连接
    client.on('error', (err: Error) => {
      // keepalive 判死（4.4）与传输层错误都经此/close 到达 → 按意外断链处理
      this.onDrop(entry, client, err)
    })
    client.on('close', () => this.onDrop(entry, client))
    client.on(
      'tcp connection',
      (
        details: { destPort: number },
        accept: () => Channel,
        reject: (() => void) | undefined
      ) => {
        const handler = entry.forwardIns.get(details.destPort)
        if (handler === undefined) {
          reject?.()
          return
        }
        this.log(entry.id, 'info', `forwardIn inbound stream (remote port ${details.destPort})`)
        handler(accept())
      }
    )
  }

  /** 断链统一处理（error+close 双触发幂等；establishing 期间交由 runEstablish 兜底） */
  private onDrop(entry: ConnEntry, source: Client, err?: Error): void {
    if (entry.client !== source) return
    if (entry.establishing !== null && entry.state !== 'connected') return
    const wasConnected = entry.state === 'connected'
    entry.client = null
    entry.sftpPromise = null
    entry.forwardInPorts.clear()
    if (!entry.wantConnected || entry.userDisconnect || !wasConnected) {
      entry.loopActive = false
      this.setState(entry, 'offline')
      if (err !== undefined) this.log(entry.id, 'warn', `connection dropped: ${sanitize(err.message)}`)
      return
    }
    this.log(entry.id, 'warn', 'unexpected disconnect; entering auto-reconnect (5.7)')
    this.scheduleReconnect(entry, err !== undefined ? mapSshError(err, this.language()) : undefined)
  }

  private async requestForwardIn(entry: ConnEntry, remotePort: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      entry.client!.forwardIn('127.0.0.1', remotePort, (err) => {
        if (err != null) {
          reject(new Error(sanitize(err.message)))
          return
        }
        entry.forwardInPorts.add(remotePort)
        resolve()
      })
    })
    this.log(entry.id, 'info', `forwardIn listening on remote 127.0.0.1:${remotePort}`)
  }

  private async replayForwardIns(entry: ConnEntry): Promise<void> {
    for (const port of [...entry.forwardIns.keys()]) {
      try {
        await this.requestForwardIn(entry, port)
      } catch (err) {
        this.log(
          entry.id,
          'warn',
          `forwardIn replay failed for remote port ${port}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  private isOnline(entry: ConnEntry): boolean {
    return entry.state === 'connected'
  }

  private ensureEntry(id: string): ConnEntry {
    let entry = this.entries.get(id)
    if (entry === undefined) {
      entry = {
        id,
        state: 'offline',
        client: null,
        sftpPromise: null,
        wantConnected: false,
        userDisconnect: false,
        loopActive: false,
        attempt: 0,
        timer: null,
        establishing: null,
        forwardIns: new Map(),
        forwardInPorts: new Set(),
        forwardOutServers: new Set()
      }
      this.entries.set(id, entry)
    }
    return entry
  }

  private requireLiveEntry(id: string): ConnEntry {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.client === null || entry.state !== 'connected') {
      throw new ConnectionError('unavailable', this.language(), { detail: `not connected: ${id}` })
    }
    return entry
  }

  private setState(entry: ConnEntry, state: ConnectionRuntimeState, attempt?: number): void {
    entry.state = state
    const event: ConnectionStateChangedEvent = {
      connectionId: entry.id,
      state,
      ...(attempt !== undefined && state === 'reconnecting' ? { attempt } : {})
    }
    for (const cb of this.stateSubs) cb(event)
  }

  /** 连接层日志（8.1=A：脱敏元数据；密钥/密码/passphrase 内容绝不进入） */
  private log(connectionId: string, level: 'info' | 'warn' | 'error', message: string): void {
    const event: RemoteServerLogEvent = { connectionId, level, message: sanitize(message) }
    for (const cb of this.logSubs) cb(event)
  }

  private clearTimer(entry: ConnEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  private closeServer(server: import('node:net').Server): void {
    try {
      server.close()
      // @types/node 的 net.Server 未声明 closeAllConnections（Node ≥18.2 运行时存在）
      const anyServer = server as unknown as { closeAllConnections?: () => void }
      anyServer.closeAllConnections?.()
    } catch {
      /* noop */
    }
  }
}

// ── exec 聚合（连接与一次性自检共用）──────────────────────────────────

/** 退出码哨兵：远端异常未拿到退出码时（契约「非 0 哨兵，S2 定」=255，SSH 惯例） */
export const EXIT_CODE_UNKNOWN = 255

export async function execOnClient(
  client: Client,
  command: string,
  lang: Language
): Promise<SshExecResult> {
  return new Promise<SshExecResult>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err != null) {
        reject(mapSshError(err, lang))
        return
      }
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let code: number | null = null
      stream.on('data', (chunk: Buffer) => out.push(chunk))
      stream.stderr?.on('data', (chunk: Buffer) => errOut.push(chunk))
      stream.on('exit', (c: number | null | undefined) => {
        if (typeof c === 'number') code = c
      })
      stream.on('error', (e: Error) => reject(mapSshError(e, lang)))
      stream.on('close', () => {
        resolve({
          code: code ?? EXIT_CODE_UNKNOWN,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8')
        })
      })
    })
  })
}

/** POSIX 单引号包裹（远端为 Linux；防 cwd 空格/元字符注入命令行） */
function posixQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** 日志/错误消息脱敏（截断；防意外夹带敏感长文本） */
function sanitize(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 300 ? `${t.slice(0, 300)}…` : t
}

// ── SFTP 子会话 ───────────────────────────────────────────────────────

export class RealSftpSession implements SftpSession {
  constructor(private readonly sftp: SFTPWrapper) {}

  /**
   * 目录清单（S6 注册对话框浏览器；名字排序；不含 . / ..）。
   * v1.5.4（用户 Windows 实测反馈）：仅返回目录——该清单的用途是「远程项目根
   * 目录选择器」，文件对用户是噪音；指向目录的符号链接（readdir attrs 为
   * LNK 模式 120777 → isDirectory()=false，被误判为文件）以 stat（跟链）复核
   * 纳入——死链/指向文件的链接自然落选。
   */
  async list(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const entries = await new Promise<Array<{ filename: string; attrs: { isDirectory(): boolean; mode?: number } }>>(
      (resolve, reject) => {
        this.sftp.readdir(dir, (err, list) => {
          if (err != null) reject(new Error(sanitize(err.message)))
          else resolve(list as Array<{ filename: string; attrs: { isDirectory(): boolean; mode?: number } }>)
        })
      }
    )
    const S_IFMT = 0o170000
    const S_IFLNK = 0o120000
    const out: Array<{ name: string; isDir: boolean }> = []
    for (const e of entries) {
      if (e.filename === '.' || e.filename === '..') continue
      if (e.attrs.isDirectory()) {
        out.push({ name: e.filename, isDir: true })
        continue
      }
      // 符号链接：跟链 stat 复核目标是否目录（每链接一次往返——目录内链接通常少量）
      const mode = e.attrs.mode ?? 0
      if ((mode & S_IFMT) === S_IFLNK) {
        const st = await this.statAny(`${dir === '/' ? '' : dir}/${e.filename}`).catch(() => null)
        if (st?.isDirectory() === true) out.push({ name: e.filename, isDir: true })
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** SFTP stat（跟符号链接；list 的 LNK 复核用——路径为远端 POSIX 形态，手动拼接防 Windows path.join 反斜杠） */
  /** 单点 stat（跟链；不存在 reject）——list 的 LNK 复核与 mkdir 幂等共用 */
  private async statAny(path: string): Promise<{ isDirectory(): boolean }> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (err, st) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve(st as { isDirectory(): boolean })
      })
    })
  }

  // ── v2.0 远程文件管理原语（契约见 SftpSession；无句柄态——每操作自足）────

  /** 全量清单：readdir attrs → {name,isDir,size,mtimeMs}；符号链接跟链 stat
   *  判目录（与 list() 的 LNK 复核同语义——链接指向目录在文件面板可进入）。 */
  async listAll(dir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtimeMs: number }>> {
    const raw = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
      this.sftp.readdir(dir, (err, list) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve(list as Array<{ filename: string; attrs: Stats }>)
      })
    })
    const S_IFMT2 = 0o170000
    const S_IFLNK2 = 0o120000
    const out: Array<{ name: string; isDir: boolean; size: number; mtimeMs: number }> = []
    for (const e of raw) {
      if (e.filename === '.' || e.filename === '..') continue
      if (e.attrs.isDirectory()) {
        out.push({ name: e.filename, isDir: true, size: 0, mtimeMs: statMtimeMs(e.attrs) })
        continue
      }
      // 软链接目录（v2.0.1 修复——用户实测 /home/<user>/src→/mnt/src 被当文件）：
      // readdir attrs 是链接自身（LNK/isDirectory=false）——跟链 stat 复核目标，
      // 目录则按目录呈现（可进入；list() v1.5.4 同语义补齐）。死链保持文件态。
      const mode = e.attrs.mode ?? 0
      if ((mode & S_IFMT2) === S_IFLNK2) {
        const st = await this.statAny(`${dir === '/' ? '' : dir}/${e.filename}`).catch(() => null)
        if (st?.isDirectory() === true) {
          out.push({ name: e.filename, isDir: true, size: 0, mtimeMs: statMtimeMs(e.attrs) })
          continue
        }
      }
      out.push({ name: e.filename, isDir: false, size: e.attrs.size, mtimeMs: statMtimeMs(e.attrs) })
    }
    return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  }

  async rename(from: string, to: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sftp.rename(from, to, (err) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve()
      })
    })
  }

  async unlinkFile(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sftp.unlink(path, (err) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve()
      })
    })
  }

  async statFile(path: string): Promise<{ isDir: boolean; size: number; mtimeMs: number; exists: boolean }> {
    return new Promise((resolve) => {
      this.sftp.stat(path, (err, st) => {
        if (err != null || st == null) {
          resolve({ isDir: false, size: 0, mtimeMs: 0, exists: false })
          return
        }
        resolve({ isDir: st.isDirectory(), size: st.size, mtimeMs: statMtimeMs(st), exists: true })
      })
    })
  }

  async readRange(path: string, start: number, length: number): Promise<Buffer> {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.open(path, 'r', (err, h) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve(h as Buffer)
      })
    })
    try {
      const buf = Buffer.alloc(length)
      const read = await new Promise<{ br: number; b: Buffer }>((resolve, reject) => {
        this.sftp.read(handle, buf, 0, length, start, (err, br, b) => {
          if (err != null) reject(new Error(sanitize(err.message)))
          else resolve({ br, b })
        })
      })
      return read.br === length ? read.b : read.b.subarray(0, Math.max(0, read.br))
    } finally {
      await new Promise<void>((resolve) => {
        this.sftp.close(handle, () => resolve())
      })
    }
  }

  async writeRange(path: string, start: number, data: Buffer): Promise<void> {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      // start=0 覆盖语义：'w' 截断建；>0 续写：'r+' 定位（断点续传预留）
      this.sftp.open(path, start === 0 ? 'w' : 'r+', (err, h) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve(h as Buffer)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        this.sftp.write(handle, data, 0, data.length, start, (err) => {
          if (err != null) reject(new Error(sanitize(err.message)))
          else resolve()
        })
      })
    } finally {
      await new Promise<void>((resolve) => {
        this.sftp.close(handle, () => resolve())
      })
    }
  }

  /** v1.7.0 建远端目录（远程 skills 导入递归上传）；已存在视为成功（幂等） */
  async mkdir(dir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, (err) => {
        // ssh2 对已存在目录回调 err(FAILURE)——幂等语义：重新 stat 验证确为目录则成功
        if (err == null) {
          resolve()
          return
        }
        this.statAny(dir)
          .then((st) => (st.isDirectory() ? resolve() : reject(new Error(sanitize(err.message)))))
          .catch(() => reject(err))
      })
    })
  }

  async readFile(path: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.sftp.readFile(path, (err, buf) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve(buf as Buffer)
      })
    })
  }

  async writeFile(path: string, data: string | Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.writeFile(path, data, (err) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve()
      })
    })
  }

  /** S2 内部（不在 S1 契约面）：解析绝对路径（browseRemoteDir 求远端 home 用） */
  async realpath(p: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.sftp.realpath(p, (err, abs) => {
        if (err != null) reject(new Error(sanitize(err.message)))
        else resolve(abs as string)
      })
    })
  }
}

/**
 * SFTP 目录浏览（ipc.ts SftpBrowse handler 委托；3.1=C 注册对话框）。
 * 缺省请求=远端 home（realpath('.')）；任何失败 → { ok:false, error }（分级文案
 * 已由 ConnectionError.message 本地化）。
 */
export async function browseRemoteDir(
  mgr: ConnectionManager,
  connectionId: string,
  requested?: string
): Promise<SftpBrowseResult> {
  try {
    const session = await mgr.sftp(connectionId) // 懒连接含 TOFU/自检（失败即分级错误）
    const real = session instanceof RealSftpSession ? session : (session as unknown as RealSftpSession)
    const dir = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : '.'
    const resolved = await real.realpath(dir)
    const entries = await real.list(resolved)
    return { ok: true, path: resolved, entries }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** v2.0：ssh2 Stats → epoch ms（attrs 缺失字段兜 0；ssh2 内部为秒/毫秒双态） */
function statMtimeMs(st: { mtime?: number; mtimeMs?: number }): number {
  if (typeof st.mtimeMs === 'number') return st.mtimeMs
  if (typeof st.mtime === 'number') return st.mtime * 1000
  return 0
}
