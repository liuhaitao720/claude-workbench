import type {
  ConnectionRuntimeState,
  ConnectionStateChangedEvent,
  RemoteServerLogEvent
} from '../../shared/types'

/**
 * SSH 远程模式：连接管理器契约（S1 批0 定接口 / S2 实现）。
 *
 * 语义锚点（确认单）：
 * - 每台服务器一条连接多路复用（4.3=a），任务=该连接上的通道/协议流；
 * - 认证=私钥+密码（1.3=B）；host key=TOFU 首连确认锁定（1.5=A）；
 * - keepalive 15s×连续 3 次无响应判死（4.4=a）；判死后指数退避自动重连
 *   （5.7=a：1s→2s→5s→10s 封顶无限重试）+外部可触发手动重试；
 * - 断开/退出不杀远端任务（5.9=b：会话由 cwb-server 保活）。
 *
 * 入站流交付（M7）：forwardIn 的远端入站流以回调交付（不落内部路由）——
 * S4 把 stream pipe 到 task-activity 接收端（hooks 回调链路 4.6=A）。
 */

/** 远端命令执行结果（只读自检 2.1 / S5 白名单路由；非交互命令） */
export interface SshExecResult {
  /** 退出码（远端命令异常未能拿到时为非 0 哨兵，S2 定） */
  code: number
  stdout: string
  stderr: string
}

/** SFTP 子会话（S2 实现 ssh2 sftp 原语的最小面；S1 只锁形状） */
export interface SftpSession {
  /** 目录清单（S6 注册对话框浏览器消费，3.1=C；不含 . / ..） */
  list(dir: string): Promise<Array<{ name: string; isDir: boolean }>>
  /** 读远端文件（自检/版本探测用） */
  readFile(path: string): Promise<Buffer>
  /** 覆写远端文件（4.6 --settings 写 VM；6.7 server 推送） */
  writeFile(path: string, data: string | Buffer): Promise<void>
  /** 建远端目录（v1.7.0 远程 skills 导入递归上传用；已存在时幂等成功） */
  mkdir?(dir: string): Promise<void>

  /* ── v2.0 远程文件管理（FilesPanel：全量清单 + 分块读写 + 元数据操作）──── */

  /** 全量目录清单（含文件：name/isDir/size/mtimeMs；不含 . / ..）——区别于
   *  list()（仅目录，注册对话框专用语义 v1.5.4，两接口并存互不影响） */
  listAll?(dir: string): Promise<RemoteFileEntry[]>

  /** 重命名/移动（同目录重命名；跨目录移动由调用方组合 mkdir+rename） */
  rename?(from: string, to: string): Promise<void>

  /** 删除单个文件/符号链接（目录删除走 exec 递归协议，不经此口） */
  unlinkFile?(path: string): Promise<void>

  /** 元数据（冲突预检/列表刷新单点探测用；不存在 → Error） */
  statFile?(path: string): Promise<RemoteFileStat>

  /**
   * 分块读（下载）：读 [start, start+length) 区间，不足 length 返回短块（EOF）。
   * 每 chunk 一次 open-read-close（无句柄态——取消/重试无泄漏面；SFTP open
   * 单 RTT 开销相对 1MB 传输可忽略）。
   */
  readRange?(path: string, start: number, length: number): Promise<Buffer>

  /**
   * 分块写（上传）：start=0 → open 'w'（存在即截断，覆盖语义）；start>0 →
   * open 'r+' 定位写（断点续传预留——v2.0 失败重试从头，接口已就位）。
   */
  writeRange?(path: string, start: number, data: Buffer): Promise<void>
}

/** v2.0 文件条目（FilesPanel 列表；mtimeMs 取不到=0） */
export interface RemoteFileEntry {
  name: string
  isDir: boolean
  /** 文件字节数；目录=0 */
  size: number
  /** 修改时刻（epoch ms；attrs 缺失=0） */
  mtimeMs: number
}

/** v2.0 单点元数据（冲突预检等） */
export interface RemoteFileStat {
  isDir: boolean
  size: number
  mtimeMs: number
  /** 目标是否存在（statFile 对不存在路径 resolve exists:false 而非 reject——
   *  调用方分支更平） */
  exists: boolean
}

export interface ConnectionManager {
  /**
   * 建立并维护到指定连接档案的 SSH 连接（懒连接 2.5=a；已连接=幂等返回）。
   * 状态迁移经 onStateChange 推送——connect() resolve 不承诺 'connected'
   * （认证/自检流程见 S2）。
   */
  connect(connectionId: string): Promise<void>
  /** 主动断开（幂等）。5.9=b：仅断 SSH 通道，绝不杀远端任务会话 */
  disconnect(connectionId: string): Promise<void>
  /** 当前运行时状态（从未连接过的档案返回 'offline'） */
  getState(connectionId: string): ConnectionRuntimeState
  /**
   * 远端命令执行（只读自检：sshd/claude/node/cwb-server 探测 2.1；S5 白名单
   * 路由经 SSH 的 CLI 命令）。非交互、聚合输出；交互式长命令走协议帧不经此。
   */
  exec(connectionId: string, command: string, opts?: { cwd?: string }): Promise<SshExecResult>
  /** 打开 SFTP 子会话（复用同一条 SSH 连接；browseRemoteDir/写 settings 用） */
  sftp(connectionId: string): Promise<SftpSession>
  /**
   * 正向转发（本地→远端）：在本机 127.0.0.1 随机端口监听并转发到远端
   * remoteHost:remotePort；返回本地端口。cwb-server WS 隧道锚点：VM 侧
   * 127.0.0.1:17717 → 客户端本地口（S4 消费，实测兼容既有接收端口语义）。
   */
  forwardOut(connectionId: string, remoteHost: string, remotePort: number): Promise<number>
  /**
   * 反向转发（远端→本地，M7）：在 VM 侧监听 remotePort，入站流以 handler
   * 回调交付——S4 将 stream pipe 到 task-activity 的 HTTP 接收端（hooks 上报
   * 4.6=A：hook URL 指向 VM 侧转发端口）。同 remotePort 重复注册=S2 定去重语义。
   */
  forwardIn(
    connectionId: string,
    remotePort: number,
    handler: (stream: NodeJS.ReadWriteStream) => void
  ): Promise<void>
  /**
   * 连接状态订阅（disposer 模式）。ConnectionStateChanged 的唯一产生者=S2
   * （A2 权属定案），经 S1 的 ipc.ts broadcastConnectionState 挂钩广播。
   */
  onStateChange(cb: (e: ConnectionStateChangedEvent) => void): () => void
  /** 连接/server 层日志订阅（脱敏元数据——终端内容不落盘，8.1=A） */
  onLog(cb: (e: RemoteServerLogEvent) => void): () => void
}

/**
 * S1 接线桩：AppContext.connection 的占位实现（A0=S1 桩+S2 实）。
 * 组合根（main.ts → createAppContext）注入；S2 以真实 ssh2 实现替换。
 * 全方法显式抛错——防止桩被误当可用实现消费。
 */
export class StubConnectionManager implements ConnectionManager {
  private static unsupported(method: string): never {
    throw new Error(`S2 未实现：ConnectionManager.${method}（S1 契约桩）`)
  }

  async connect(_connectionId: string): Promise<void> {
    StubConnectionManager.unsupported('connect')
  }

  async disconnect(_connectionId: string): Promise<void> {
    StubConnectionManager.unsupported('disconnect')
  }

  getState(_connectionId: string): ConnectionRuntimeState {
    StubConnectionManager.unsupported('getState')
  }

  async exec(
    _connectionId: string,
    _command: string,
    _opts?: { cwd?: string }
  ): Promise<SshExecResult> {
    StubConnectionManager.unsupported('exec')
  }

  async sftp(_connectionId: string): Promise<SftpSession> {
    StubConnectionManager.unsupported('sftp')
  }

  async forwardOut(
    _connectionId: string,
    _remoteHost: string,
    _remotePort: number
  ): Promise<number> {
    StubConnectionManager.unsupported('forwardOut')
  }

  async forwardIn(
    _connectionId: string,
    _remotePort: number,
    _handler: (stream: NodeJS.ReadWriteStream) => void
  ): Promise<void> {
    StubConnectionManager.unsupported('forwardIn')
  }

  onStateChange(_cb: (e: ConnectionStateChangedEvent) => void): () => void {
    StubConnectionManager.unsupported('onStateChange')
  }

  onLog(_cb: (e: RemoteServerLogEvent) => void): () => void {
    StubConnectionManager.unsupported('onLog')
  }
}
