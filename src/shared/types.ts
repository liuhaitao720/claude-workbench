/**
 * SSH Workbench 跨进程契约（S1.5 主控落骨架）
 * 唯一事实源：doc/design/spec-v1.md §5（v1.3）。契约变更须走主控编译红流程，子任务不得静默修改。
 */

/** 项目记录【S2 project-store 写 / S3 侧栏读】 */
export interface ProjectRecord {
  /** uuid */
  id: string
  /** 显示名——renameProject 仅改此字段，绝不改动磁盘目录名 */
  name: string
  /** 项目磁盘目录绝对路径（注册后不可变）；远程项目=VM 内 Linux 绝对路径字符串 */
  dir: string
  /** 注册时检测的 git 状态 */
  isGit: boolean
  /**
   * SSH 远程归属（7.1=A，S1 批0）：绑定的连接档案 id（ConnectionRecord.id）；
   * undefined=本地项目（存量记录零迁移，9.1=A）。远程路由（S4）按此分流
   * AppContext.pty 到本地/远程 backend。
   */
  connectionId?: string
  /** ISO 8601 */
  createdAt: string
}

/** 任务记录【S2 task-store 写 / S3 任务列表读】 */
export interface TaskRecord {
  /** uuid；同一值同时作为 claude --session-id（spawn 契约，id===sessionId） */
  id: string
  projectId: string
  /** 显示名——renameTask 仅改元数据；会话内 claude 显示名下次 spawn（含 resume -n）生效 */
  name: string
  /** claude 会话 ID（=== id） */
  sessionId: string
  /** 实际工作目录：worktree 路径或项目根 */
  cwd: string
  /** 仅 isolation='worktree' 时存在 */
  worktreePath?: string
  /**
   * 跳过 claude 权限确认（spawn 附加 --dangerously-skip-permissions）。
   * 仅在下次 spawn（新建/恢复）生效——运行中会话不受切换影响；默认缺省=关闭（安全默认）。
   */
  skipPermissions?: boolean
  /**
   * 任务指定使用的模型服务 provider（v1.4；ProviderConfig.id）。
   * 与 skipPermissions 同语义：仅在下次 spawn 生效；缺省=跟随默认 provider；
   * 引用的 provider 已删除时回退默认 provider 链。
   */
  providerId?: string
  /**
   * 任务指定模型（v1.4；注入 ANTHROPIC_MODEL）。缺省=provider 的 defaultModel，
   * 两者皆空则不注入（claude 用账号默认）。
   */
  model?: string
  /**
   * 任务模型选择模式（v1.4）：'auto'=由 claude CLI 自主选择——不注入 ANTHROPIC_MODEL，
   * 档位映射（provider.slotModels）照常生效；undefined=旧语义（model → defaultModel 链）。
   */
  modelMode?: 'auto'
  /**
   * 任务状态（v0.3.2 三态跟踪）：
   * - running：PTY 运行中（UI 绿点+脉冲动画+运行时长）
   * - stopped：显式停止（灰点）
   * - exited：会话自行退出/崩溃（红点）——stopTask 之外路径的 onExit 落此态；
   *   stopped 与 exited 均可 resume；应用重启归一化 running→stopped（v0.1.2 语义不变）
   */
  status: 'running' | 'stopped' | 'exited'
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601 */
  lastActiveAt: string
}

/** PTY 输出事件【S2 pty-manager 推送 / S3 终端面板消费】 */
export interface PtyDataEvent {
  taskId: string
  /** 终端转义字节流（UTF-8 字符串） */
  data: string
}

/** 任务变更事件（状态迁移/重命名等）【S2 推送 / S3 状态刷新】 */
export type TaskUpdateEvent = TaskRecord


/** skill 元信息【v0.5③：main skills-store 扫描 / renderer Skill 弹窗消费】 */
export interface SkillInfo {
  name: string
  description: string
  version?: string
  author?: string
  /**
   * user=用户级(~/.claude/skills，全局生效) | project=项目级(.claude/skills，仅该项目)
   * | plugin=插件（v1.2.1：~/.claude/plugins/cache/…，由 claude 插件机制加载）
   */
  source: 'user' | 'project' | 'plugin'
  projectId?: string
  /** skill 目录绝对路径（removeSkill 归属校验用） */
  dir: string
  /** v1.2.1 插件来源 id，如 `skill-creator@claude-plugins-official`（启用/停用/卸载的键） */
  pluginId?: string
  /** v1.2.1 插件是否在 claude settings.json 的 enabledPlugins 中启用（停用=会话里不生效） */
  pluginEnabled?: boolean
  /**
   * v1.2.1 调用方式（由 SKILL.md frontmatter 推导，见 main/skill-files 的 activationOf）：
   * - auto：默认生效——模型按需自动调用，用户也可 /name 手动触发
   * - paths：默认生效，但只在模型碰到匹配 files 时加载（frontmatter `paths`）
   * - modelOnly：模型自动调用，用户看不到斜杠命令（`user-invocable: false`）
   * - manual：模型不会自动用，必须用户输入 /name（`disable-model-invocation: true`）
   */
  activation?: 'auto' | 'paths' | 'modelOnly' | 'manual'
}

/** Skill 市场条目【v1.2.0：来自本机已配置 marketplace 目录】 */
export interface SkillMarketEntry {
  name: string
  /** marketplace 名（安装时拼 <name>@<marketplace>） */
  marketplace: string
  description: string
  category?: string
  author?: string
  version?: string
  /** 安装量（用于排序；无数据=0） */
  installs: number
  /** `<name>@<marketplace>`，安装命令与去重键 */
  installId: string
}

/** 已配置的 marketplace 概要【v1.2.0】 */
export interface SkillMarketplaceInfo {
  name: string
  count: number
}

/** CLI 执行输出事件【v0.5③：main CliRunner 推送 / renderer 弹窗内嵌终端消费】 */
export interface CliOutputEvent {
  commandId: string
  /** 输出字节（type='exit' 时缺省） */
  data?: string
  /** 缺省='output'；'exit'=进程结束（exitCode 见字段） */
  type?: 'exit'
  exitCode?: number
}

/** webhook 通知配置【v0.5④N：url 属凭据仅存 userData】 */
export interface NotifyConfig {
  url: string
  enabled: boolean
  channel: 'wecom' | 'dingtalk' | 'generic'
}

/** v2.0 远程文件条目（FilesPanel 列表） */
export interface RemoteFileEntry {
  name: string
  isDir: boolean
  size: number
  /** epoch ms；取不到=0 */
  mtimeMs: number
}

/** v2.0 传输条目（传输条/队列） */
export interface TransferItem {
  id: string
  direction: 'upload' | 'download'
  name: string
  status: 'queued' | 'active' | 'done' | 'error' | 'canceled'
  transferredBytes: number
  totalBytes: number
  error?: string
  finishedAt?: number
}

/** v2.0 文件浏览结果（FilesList） */
export interface FilesBrowseResult {
  ok: boolean
  path?: string
  entries?: RemoteFileEntry[]
  error?: string
}

/** 应用更新说明条目【v1.1.0：main 解析仓库 CHANGELOG.md → 设置中心展示】 */
export interface AppChangelogEntry {
  version: string
  items: string[]
}

/** 应用更新检查结果【v1.1.0】 */
export interface AppUpdateInfo {
  current: string
  latest: string
  upToDate: boolean
  /** current→latest 更新说明（已是最新=当前版本段）；拉取失败为空数组 */
  notes: AppChangelogEntry[]
  /** 清单/CHANGELOG 拉取失败时的降级描述（不影响版本对比结论） */
  manifestError?: string
  notesError?: string
  /** v1.3：当前平台是否支持应用内自动升级（win=true；linux 检查更新可用，
   *  下载/安装被门禁拒绝——UI 显示手动更新指引，不亮侧栏更新角标） */
  platformSupported?: boolean
}

/** v1.4 本地代理统计【main local-proxy 维护 / renderer 状态卡展示】 */
export interface LocalProxyStats {
  /** 累计连接数（CONNECT + 绝对 URI 请求） */
  total: number
  /** 当前活跃连接 */
  active: number
  /** 直连路由的连接数 */
  direct: number
  /** 经外部代理路由的连接数 */
  viaProxy: number
}

/** v1.4 本地代理状态（纯隧道：按目标 host 路由直连/外部代理；不做协议翻译） */
export interface LocalProxyStatus {
  running: boolean
  /** 实际监听端口（running 时存在；被占自动 +1 重试） */
  port?: number
  /** ISO 启动时刻 */
  startedAt?: string
  stats: LocalProxyStats
}

// ── SSH 远程模式契约（S1 批0 骨架；实现/消费子任务号见各 JSDoc）──────────

/**
 * SSH 连接档案【S2 connections-store 持久化（userData/connections.json，
 * 照 providers.json 原子写+容错读先例）/ S6 设置中心编辑与侧栏服务器节点展示】
 * （1.2=A，字段集=确认单 1.2；认证=1.3=B=B 私钥+密码）。
 */
/** 只读自检单项（S2 产出；S7 接管 server 项） */
export interface SelfCheckItem {
  id: 'sshd' | 'claude' | 'node' | 'server'
  status: 'ok' | 'missing' | 'unknown'
  /** 版本摘要等非敏感信息 */
  detail?: string
}

export interface ConnectionTestResult {
  ok: boolean
  error?: string
  /** 分级错误码：refused/timeout/auth/hostKeyConfirm/hostKeyChanged/selfCheckFailed…（仅 IPC 返回对象时保留） */
  kind?: string
  /** TOFU 首连/变更时出现；SHA256:<base64> 原串 */
  hostKeyFingerprint?: string
  checks?: SelfCheckItem[]
}

export interface ConnectionRecord {
  /** uuid（保存时 id 空串=新增，照 ProviderConfig 先例；S2 分配） */
  id: string
  /** 显示名（列表/侧栏服务器节点用） */
  name: string
  /** SSH 主机（VM 地址） */
  host: string
  /** SSH 端口（通常 22；S2 校验合法端口） */
  port: number
  /** 登录用户名 */
  user: string
  /** 认证方式（1.3=B：私钥+密码两种） */
  authMethod: 'key' | 'password'
  /** 私钥文件本机路径（authMethod='key' 时；S2 校验存在性） */
  keyPath?: string
  /**
   * base64(safeStorage 密文)——authMethod='password' 时的 SSH 密码
   * （1.4=A：Electron safeStorage 加密存 userData，凭据不落明文不入仓库）。
   * 仅 S2 connections-store 读写；renderer 经 saveConnection 传入后不回读展示。
   */
  /**
   * 一次性明文 password（saveConnection 单程传递专用）：
   * authMethod='password' 时=SSH 密码，'key' 时=可选私钥口令。
   * 仅 main 侧 parseConnectionInput 读取并即刻 safeStorage 加密，绝不进任何
   * 持久化/日志/回传（list()/get() 输出与 store 内部档案均不含本字段）。
   * 注意：把明文放进 passwordEncrypted 会被 main 视为既有密文原样传入而在
   * save 合并时丢弃（历史 bug：新建密码认证连接保存必失败——密码认证必须
   * 提供密码）。
   */
  password?: string
  passwordEncrypted?: string
  /**
   * TOFU 首连确认后锁定的 host key 指纹（1.5=A）；后续指纹变更阻断+告警（S2）。
   */
  lastHostKeyFingerprint?: string
  /** ISO 8601 */
  createdAt: string
}

/**
 * 连接认证材料（S1 定形状 / S2 connect 时由 ConnectionRecord 解出使用；不落盘）。
 * passwordEncrypted 同 ConnectionRecord 字段语义（safeStorage 密文 base64）。
 */
export type ConnectionAuth =
  | { method: 'key'; keyPath: string }
  | { method: 'password'; passwordEncrypted: string }

/**
 * 连接运行时状态（5.4=A：独立运行时维度，不写 tasks.json——断连是瞬态可自愈，
 * 不污染持久状态机）【S2 唯一产生 / S4 路由与 S6 状态着色消费】。
 */
export type ConnectionRuntimeState = 'connected' | 'connecting' | 'reconnecting' | 'offline'

/**
 * 连接状态变迁事件载荷【S2 唯一产生（经 S1 ipc.ts broadcastConnectionState 挂钩
 * → cwb:event:connection-state-changed）/ S6 侧栏服务器节点与断连冻结层消费】（A2 权属）。
 */
export interface ConnectionStateChangedEvent {
  connectionId: string
  state: ConnectionRuntimeState
  /** 自动重连尝试序号（state='reconnecting' 时存在；5.7=A 指数退避 1s→2s→5s→10s 封顶） */
  attempt?: number
}

/**
 * 远程 server 日志事件载荷【S3 产生（server.log 帧，脱敏元数据）/ S4 桥接为
 * cwb:event:remote-server-log / S6 安装升级弹窗消费】。8.1=A：仅元数据——
 * 终端内容（代码/可能的密钥）不落盘不进日志。
 */
export interface RemoteServerLogEvent {
  connectionId: string
  level: 'info' | 'warn' | 'error'
  message: string
}

/**
 * SFTP 目录浏览结果【S2 实现（ConnectionManager.sftp.list）/ S6 远程项目注册
 * 对话框的目录浏览器消费（3.1=C 手输+SFTP 浏览器）】。
 */
export interface SftpBrowseResult {
  ok: boolean
  /** 浏览成功的远端当前绝对路径（缺省请求=远端 home） */
  path?: string
  /** 目录条目（排序由 S2 定；不含 . / ..） */
  entries?: Array<{ name: string; isDir: boolean }>
  /** ok=false 时的分级错误文案（2.3=A，i18n conn.err.*） */
  error?: string
}

/**
 * 远程代理配置（6.4=c：代理由远程 server 内置，配置存 VM 侧，客户端经 SSH/
 * server 协议读写）【S4 定字段终态并实现协议转发 / S6 设置页「远程代理」消费】。
 */
export interface RemoteProxyConfig {
  /** 外部代理 URL（空/缺省=直连；路由语义沿用 v1.4 local-proxy） */
  proxyUrl?: string
}

/** 远程代理状态（6.4=c；统计口径同 LocalProxyStats）【S4 经协议 proxy.status 透出】 */
export interface RemoteProxyStatus {
  running: boolean
  /** VM 侧监听端口（running 时存在） */
  port?: number
  /** ISO 启动时刻 */
  startedAt?: string
  stats: LocalProxyStats
  /** 当前生效配置（proxy.config.get 读取） */
  config?: RemoteProxyConfig
}

/** 应用自更新进度事件【v1.1.0：下载/校验/就绪/安装中/出错】 */
export type AppUpdateProgressEvent =
  | { phase: 'downloading'; percent: number }
  | { phase: 'verifying' }
  | { phase: 'ready' }
  /** v1.2.1 自动升级：已下载就绪，正在等运行中的任务结束（count=当前运行任务数） */
  | { phase: 'waiting-tasks'; count: number }
  | { phase: 'installing' }
  | { phase: 'error'; error: string }
  /**
   * v1.2.1 启动自动检查结果（含版本对比与更新说明）：renderer 据此更新侧栏角标与
   * 设置中心说明，无需再次自查（与 checkAppUpdate 的缓存同源）。
   */
  | { phase: 'available'; info: AppUpdateInfo }

/** main 侧应用设置（v0.9：关闭行为/开机自启——userData/settings.json） */
export interface AppSettings {
  /** 关窗=最小化到托盘（true，v0.5⑥ 默认）/ 直接退出（false，退出仍走运行任务 confirm） */
  closeToTray: boolean
  /** 开机自启（app.setLoginItemSettings） */
  launchAtLogin: boolean
  /**
   * 界面语言（v1.2.0）：renderer 是权威（localStorage），打开/切换语言时同步到此，
   * 供 main 侧的托盘菜单与退出确认框取文案。缺省='zh'。
   */
  language?: 'zh' | 'en'
  /* ── v2.0 远程文件管理（下载落位；确认单：目录/方式/按连接分档）────── */
  /** 下载根目录（空串=默认「系统下载目录/SSH Workbench」） */
  downloadDir?: string
  /** direct=直接存入（同名自动重命名）；ask=每次弹保存框。缺省 direct */
  downloadMode?: 'direct' | 'ask'
  /** 按连接分子目录（缺省 true） */
  downloadPerConnection?: boolean
  /** v2.0 文件面板 per-connection 目录记忆（cid → 远端路径） */
  filesPanelPath?: Record<string, string>
  /** v2.0.1 侧栏作用域：'all' | 'local' | 连接 id（连接删除后消费点归一回 all） */
  sidebarScope?: string
  /**
   * 自动升级（v1.2.1，缺省 true）：启动静默检查 → 有新版本后台下载校验 →
   * 运行中的任务全部结束后自动退出替换重启（有任务在跑时不打断）。
   * false 时仅检查并提示，由用户在设置中心手动升级。
   */
  autoUpdate?: boolean
  /** v1.4 本地代理随应用启动（缺省 false；运行期间任务 HTTP_PROXY 统一指向
   * 本地代理，停止则回退直接注入 provider 代理配置） */
  proxyAutoStart?: boolean
  /**
   * SSH 远程模式侧栏持久化键（S1 批0 锁键，3.7/3.8/3.10；S6 消费——renderer
   * 写入经 setAppSettings，main 侧仅存取不解释）。缺省不落键=现行为。
   */
  /** 侧栏宽度像素（3.7=A 可拖拽调宽 240–480，跨会话记住） */
  sidebarWidth?: number
  /** 整栏折叠态持久化（3.10=A：推翻 A17「折叠态刷新重置」） */
  sidebarCollapsedPersist?: boolean
  /** 服务器节点折叠态（3.8=A：连接档案 id → 折叠/展开） */
  serverNodesCollapsed?: Record<string, boolean>
}

/** 任务活动状态事件（v3.2：'busy'=执行中黄转圈 | 'awaiting'=待答复红 | 'idle'=就绪绿） */
export interface TaskActivityEvent {
  taskId: string
  activity: 'busy' | 'awaiting' | 'idle'
}

/** 事件订阅退订函数 */
export type Unsubscribe = () => void

/** createTask 隔离选项【S3 经人工确认对话框传入 / S2 校验】 */
export interface CreateTaskOptions {
  /** 'worktree' 仅对 git 项目合法（非 git 项目的 worktree 请求 main 侧报错）；'shared' 共享项目根 */
  isolation: 'worktree' | 'shared'
  /** 传 true 时 spawn 附加 --dangerously-skip-permissions（缺省=关闭，安全默认） */
  skipPermissions?: boolean
  /** v1.4 任务指定 provider（ProviderConfig.id；缺省=默认 provider） */
  providerId?: string
  /** v1.4 任务指定模型（缺省=provider.defaultModel） */
  model?: string
  /** v1.4 任务模型模式：'auto'=CLI 自主选择（不注入 ANTHROPIC_MODEL） */
  modelMode?: 'auto'
}

/**
 * 模型服务 provider 档案【v1.4（参考 cc-switch）：main providers-store 持久化 /
 * renderer 设置中心「模型服务」编辑 / createTask-resumeTask 解析注入 env】。
 *
 * 本工具只做 API 配置注入（用户确认的边界）：协议兼容由 claude CLI 与 API 网关
 * 承担——baseUrl 必须是 claude 可用的 Anthropic 协议端点根（Anthropic 格式直连；
 * OpenAI 格式网关须自行提供 Anthropic 兼容入口），format 仅作配置标识与 UI 展示。
 */
export interface ProviderConfig {
  /** uuid（保存时 id 空串=新增） */
  id: string
  /** 显示名（列表/任务选择下拉用） */
  name: string
  /** 端点协议标识（anthropic=官方或兼容直连；openai=网关侧为 chat completions 格式） */
  format: 'anthropic' | 'openai'
  /** Anthropic 协议端点根（如 https://open.bigmodel.cn/api/anthropic）；无尾斜杠，main 侧归一 */
  baseUrl: string
  /** API Key 属凭据——仅存本机 userData/providers.json，不入仓库、不上传（红线，照 notify.json 先例） */
  apiKey: string
  /** 鉴权头形态：auth_token=ANTHROPIC_AUTH_TOKEN（Bearer，缺省，cc-switch 同款）；api_key=ANTHROPIC_API_KEY（x-api-key） */
  apiKeyType?: 'auth_token' | 'api_key'
  /** 预设模型列表（任务级下拉候选；空列表允许——纯手填） */
  models: string[]
  /**
   * v1.4.1 每模型声明：支持 1M 长上下文（设置页单行勾选；[1m] 类命名自动预勾）。
   * 仅本机标记展示（模型行/下拉候选提示），不改变 spawn 注入的模型名。
   */
  models1M?: string[]
  /** 该 provider 的缺省模型（任务未指定 model 时注入 ANTHROPIC_MODEL） */
  defaultModel?: string
  /**
   * 网络代理（v1.4，照搬 cc-switch：Anthropic 原生格式直连官方 api.anthropic.com 需开代理）。
   * 非空时 spawn 注入 HTTP_PROXY/HTTPS_PROXY（大小写双写）+ NO_PROXY=127.0.0.1,localhost
   * （本机 hooks 回调豁免，防代理劫持工作台自身链路）；国内直连端点留空。
   */
  proxyUrl?: string
  /**
   * 档位映射（v1.4，Anthropic 格式）：claude CLI 按档位（Sonnet/Opus/Fable/Haiku）选模型时
   * 落到对应具体模型——注入 ANTHROPIC_DEFAULT_SONNET/OPUS/FABLE/HAIKU_MODEL。
   * 任务级"固定模型"（ANTHROPIC_MODEL）优先于档位映射；"CLI 自主"时档位映射仍生效。
   */
  slotModels?: {
    sonnet?: string
    opus?: string
    fable?: string
    haiku?: string
  }
}

/** providers 持久化整体状态【providers.json 的文件形状】 */
export interface ProviderRegistryState {
  providers: ProviderConfig[]
  /** 默认（当前）provider；未配置任何默认时缺省（任务与全局回退：不注入，行为与 v1.3 前一致） */
  defaultProviderId?: string
}

export interface RemoveTaskOptions {
  /** true 时连带清理 .cwb-worktrees/<taskId>（git worktree remove） */
  deleteWorktree: boolean
}

/**
 * window.cwb —— preload 暴露给 renderer 的完整 API（34 法）
 * 生产者：S2（main 侧 handler）+ S1.5（preload 桥接映射）；消费者：S3（renderer）
 */
export interface CWBApi {
  /** 运行平台（'win32' | 'linux' | 'darwin'；v1.3 跨平台适配——UI 据此分支：
   *  默认字体/claude 安装命令展示/windowsPty 终端选项/更新角标门禁） */
  readonly platform: string

  // ── projects（4）─────────────────────────────
  /** 全部项目 */
  listProjects(): Promise<ProjectRecord[]>
  /** 打开目录注册项目（git 检测、按 dir 查重，重复则返回既有记录） */
  addProject(dir: string): Promise<ProjectRecord>
  /** 移除项目记录（不删磁盘目录；其任务一并停止并移除记录，worktree 保留由用户手清） */
  removeProject(id: string): Promise<void>
  /** 重命名项目（仅显示名） */
  renameProject(id: string, name: string): Promise<ProjectRecord>

  // ── tasks（6）────────────────────────────────
  /** 任务列表（projectId 省略=全部） */
  listTasks(projectId?: string): Promise<TaskRecord[]>
  /**
   * 新建任务并 spawn claude（--session-id <新uuid> -n <name>；cwd 由 isolation 决定）
   * isolation 经 UI 人工确认后传入（git 项目 worktree 需用户在对话框确认）
   */
  createTask(projectId: string, name: string, opts: CreateTaskOptions): Promise<TaskRecord>
  /** 恢复任务：spawn claude --resume <sessionId> -n <当前name>（cwd 不变）；仅 stopped 状态可恢复 */
  resumeTask(taskId: string): Promise<TaskRecord>
  /** 停止任务：kill PTY → status='stopped' + onTaskUpdate 推送 */
  stopTask(taskId: string): Promise<void>
  /** 删除任务（opts.deleteWorktree=true 时连带清理 worktree） */
  removeTask(taskId: string, opts: RemoveTaskOptions): Promise<void>
  /** 重命名任务（仅元数据 name） */
  renameTask(taskId: string, name: string): Promise<TaskRecord>
  /**
   * 切换"跳过权限确认"（仅元数据；下次 spawn 生效）并广播 TaskUpdate。
   * 【v0.3.1 契约变更·第 17 法】
   */
  setTaskSkipPermissions(taskId: string, on: boolean): Promise<TaskRecord>

  // ── pty（2）──────────────────────────────────
  /** 写入终端（用户键入） */
  ptyWrite(taskId: string, data: string): void
  /** 终端尺寸变化联动 */
  ptyResize(taskId: string, cols: number, rows: number): void

  // ── events（3）────────────────────────────────
  /** PTY 输出订阅；返回显式退订函数（任务删除/组件卸载必调用） */
  onPtyData(cb: (e: PtyDataEvent) => void): Unsubscribe
  /** 任务记录变更订阅；返回显式退订函数 */
  onTaskUpdate(cb: (t: TaskUpdateEvent) => void): Unsubscribe
  /**
   * 任务活动状态订阅（v3.2 事件驱动：busy 黄转圈/awaiting 红/idle 绿）。
   * 源=claude CLI hooks（PermissionRequest/UserPromptSubmit/Stop 族经 localhost HTTP）
   * + 本地合成（Esc 中断、字节兜底）；持久 status 仍走 onTaskUpdate。
   * 【v3.2 契约变更·第 18 法】
   */
  onTaskActivity(cb: (e: TaskActivityEvent) => void): Unsubscribe

  // ── dialog（1）───────────────────────────────
  /** 原生目录选择框（main 侧 dialog.showOpenDialog）；取消返回 null */
  pickDirectory(): Promise<string | null>


  // ── skills（3，v0.5③）──────────────────────
  /** 全部 skill（用户级+项目级；项目级需先有项目记录） */
  listSkills(cid?: string): Promise<SkillInfo[]>
  /** 导入本地 skill 文件夹（复制到目标 scope；同名冲突报错） */
  importSkillFolder(fromDir: string, target: { scope: 'user' | 'project'; projectId?: string }, cid?: string): Promise<SkillInfo>
  /** 移除 skill（回收站 shell.trashItem；main 做 realpath 归属校验） */
  removeSkill(skill: SkillInfo, cid?: string): Promise<void>

  // ── cli 执行（3，v0.5③）────────────────────
  /**
   * 校验并启动 claude CLI 命令（独立隐藏 PTY；白名单 {plugin,update,upgrade,mcp}）→ commandId。
   * M10（SSH 远程，S1 加法签名）：可选 connectionId——指定时命令经 SSH 在该连接的
   * VM 内执行（S5 路由实现）；缺省=本机执行（既有调用零改动零行为变化）。
   */
  runCliCommand(command: string, connectionId?: string): Promise<{ commandId: string }>
  /** CLI 输出订阅（disposer 模式同 onPtyData） */
  onCliOutput(cb: (e: CliOutputEvent) => void): Unsubscribe
  /** 终止 CLI 命令（弹窗关闭防孤儿） */
  killCliCommand(commandId: string): void

  // ── claude 版本/更新/安装（3，v0.5⑤）───────
  /** 当前 claude CLI 版本+实际路径（version='' 表示未安装） */
  getClaudeVersionInfo(cid?: string): Promise<{ version: string; path: string }>
  /** 检查更新（npm registry 对比；无 node 环境 degraded=true） */
  checkClaudeUpdate(cid?: string): Promise<{ current: string; latest: string; upToDate: boolean; degraded?: boolean }>
  /** 下载安装 claude CLI（固定模板：native=官方安装器 / npm=npm install -g；输出走 onCliOutput） */
  installClaudeCli(method: 'native' | 'npm', cid?: string): Promise<{ commandId: string }>

  // ── 应用设置（2，v0.9）─────────────────────
  /** 读取 main 侧应用设置（关闭行为/自启） */
  getAppSettings(): Promise<AppSettings>
  /** 保存应用设置（patch 合并），返回保存后全量 */
  setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  // ── 会话导入（1，v0.9 追加）───────────────
  /** 扫描该目录的 claude CLI 历史会话→生成可恢复任务（幂等，跳过已导入）；返回新增列表 */
  importTasksFromSessions(projectId: string): Promise<TaskRecord[]>

  // ── 字体扫描（1，v0.9.4）──────────────────
  /** 本机已安装等宽字体（字形宽度实测判定，图标字体过滤，结果缓存）；失败返回 [] */
  getInstalledMonoFonts(): Promise<string[]>

  // ── 外部链接（1，v1.0.8）───────────────────
  /**
   * 用系统默认浏览器打开 URL（shell.openExternal）。
   * main 侧协议白名单 http/https（file:、javascript: 等一律拒绝返回 false）——
   * 终端输出属不可信内容，OSC 8/WebLinks 链接必须经此出口而非 window.open。
   */
  openExternal(url: string): Promise<boolean>

  // ── 应用自更新（3+1 事件，v1.1.0）──────────
  /**
   * 检查自身更新（GitHub Releases 清单 + CHANGELOG 更新说明；网络失败逐项降级）。
   * v1.2.1：非 force 时复用 main 侧缓存/进行中的检查（启动自动检查与手动检查不重复请求）。
   */
  checkAppUpdate(force?: boolean): Promise<AppUpdateInfo>
  /** 下载安装包并 sha256 校验（进度走 onAppUpdateProgress）；需先 checkAppUpdate */
  downloadAppUpdate(): Promise<{ ok: boolean; error?: string }>
  /** 退出并替换重启（写更新器脚本 → 杀 PTY 树正常退出 → 覆盖安装 → 拉起新版） */
  installAppUpdate(): Promise<{ ok: boolean; error?: string }>
  /** 自更新进度订阅（disposer 模式同 onPtyData） */
  onAppUpdateProgress(cb: (e: AppUpdateProgressEvent) => void): Unsubscribe

  // ── claude CLI 更新说明（1，v1.1.0）─────────
  /**
   * claude CLI 新版本更新说明（官方仓库 CHANGELOG 区间解析；raw Range 请求 +
   * releases.atom 兜底，双路失败返回 error）。参数取 checkClaudeUpdate 结果。
   */
  getClaudeChangelog(
    current: string,
    latest: string
  ): Promise<{ notes: AppChangelogEntry[]; error?: string }>

  // ── Skill 市场（3，v1.2.0）─────────────────
  /** 从本机已配置 marketplace 目录搜索 skill（空 query = 按安装量排序的推荐列表） */
  searchSkillMarket(query: string, marketplace?: string, limit?: number, cid?: string): Promise<SkillMarketEntry[]>
  /** 已配置的 marketplace 概要（名称 + 条目数；用于过滤器） */
  listSkillMarketplaces(cid?: string): Promise<SkillMarketplaceInfo[]>
  /**
   * 安装市场 skill：`claude plugin install <name>@<marketplace> -y`
   * （经 CLI 受控模板执行；返回 commandId 供弹窗挂 onCliOutput 展示进度）
   */
  installMarketSkill(
    installId: string,
    cid?: string
  ): Promise<{ ok: boolean; commandId?: string; error?: string }>
  /** 刷新所有 marketplace 目录（`claude plugin marketplace update`，走 CLI 网络/凭据策略） */
  refreshSkillMarket(cid?: string): Promise<{ ok: boolean; commandId?: string; error?: string }>
  /**
   * v1.2.1 启用/停用插件（`claude plugin enable|disable <id> -s user`）。
   * pluginId 必须来自已安装记录（main 侧白名单校验），否则直接返回错误不启动进程。
   */
  setSkillPluginEnabled(
    pluginId: string,
    enabled: boolean,
    cid?: string
  ): Promise<{ ok: boolean; commandId?: string; error?: string }>

  // ── webhook 通知（3，v0.5④N）───────────────
  /** 读取通知配置（默认 {url:'', enabled:false}） */
  getNotifyConfig(cid?: string): Promise<NotifyConfig>
  /** 保存 webhook 配置 */
  setNotifyWebhook(url: string, enabled: boolean, cid?: string): Promise<NotifyConfig>
  /** 立即推送测试消息 */
  sendTestNotify(cid?: string): Promise<{ ok: boolean; error?: string }>

  // ── 模型服务 provider（5，v1.4）─────────────
  /** 全部 provider 档案 + 默认 id（设置中心「模型服务」与新建任务选择的数据源） */
  listProviders(cid?: string): Promise<ProviderRegistryState>
  /**
   * 新增/编辑 provider（id 空串=新增）；main 侧校验（名称/baseUrl 非空、format 合法、
   * baseUrl 为 http(s)）拒绝抛带原因 Error。返回保存后记录（含分配的 id）。
   */
  saveProvider(provider: ProviderConfig, cid?: string): Promise<ProviderConfig>
  /**
   * 删除 provider（引用它的任务不级联清理——回退默认链）；被删者恰为默认时默认清空。
   * 不存在返回错误。
   */
  removeProvider(id: string, cid?: string): Promise<void>
  /** 设默认 provider（id 空串=取消默认）；不存在返回错误 */
  setDefaultProvider(id: string, cid?: string): Promise<void>
  /**
   * v1.4 模型列表探测：GET {baseUrl}/v1/models（Anthropic/OpenAI 同形响应 {data:[{id}]}）；
   * provider 配了代理时走代理出口。失败返回 ok:false + error（网络/鉴权）。
   */
  probeProviderModels(id: string, cid?: string): Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** v1.7.0 provider 跨作用域复制（源/目标：{kind:'local'} 或 {kind:'remote',id:连接id}；源侧重分配 id） */
  copyProvider(source: { kind: 'local' } | { kind: 'remote'; id: string }, target: { kind: 'local' } | { kind: 'remote'; id: string }, providerId: string): Promise<ProviderConfig>
  /* ── v2.0 远程文件管理 ──────────────────────────────────────────── */
  /** 目录清单（缺省=远端 home；realpath 解析后返回） */
  listRemoteFiles(cid: string, path?: string): Promise<FilesBrowseResult>
  mkdirRemote(cid: string, path: string): Promise<void>
  renameRemote(cid: string, from: string, to: string): Promise<void>
  /** 删除（v2.0.1 用户指令：直接删除不进回收站）：文件=unlink；目录=递归 rm -rf */
  deleteRemote(cid: string, path: string, isDir: boolean): Promise<void>
  /** 小文本文件双击本机打开（文本扩展白名单 + <10MB；返回本机临时路径） */
  peekRemoteFile(cid: string, remotePath: string): Promise<string>
  /** 本机选择上传源（多选；files=true 含文件 / dirs=true 含目录） */
  pickLocalForUpload(files: boolean, dirs: boolean): Promise<string[] | null>
  /** 上传入队（冲突按 policy；返回条目与冲突清单——skip 由调用方对冲突项 cancel） */
  uploadRemoteFiles(cid: string, localPaths: string[], remoteDir: string, policy: 'overwrite' | 'skip' | 'rename'): Promise<{ items: TransferItem[]; conflicts: Array<{ remotePath: string; renameTo?: string }> }>
  /** 下载（main 按下载设置解析落位；ask 模式弹保存框，取消返回 null） */
  downloadRemoteFile(cid: string, remotePath: string, suggestedName?: string): Promise<TransferItem | null>
  /** 传输清单（跨连接合并，新→旧） */
  listTransfers(): Promise<TransferItem[]>
  cancelTransfer(id: string): Promise<void>
  retryTransfer(id: string): Promise<void>
  /** 传输进度订阅（节流 ~100ms；disposer 模式） */
  onTransfersProgress(cb: (items: TransferItem[]) => void): () => void
  /**
   * v1.4 任务级 provider/model 事后修改（照 setTaskSkipPermissions 第 17 法先例）：
   * 仅元数据，下次 spawn/resume 生效；undefined/空串=清除该项（回退默认链）；
   * modelMode:'auto'=CLI 自主选择（不注入 ANTHROPIC_MODEL）。
   */
  setTaskProvider(
    taskId: string,
    opts: { providerId?: string; model?: string; modelMode?: 'auto' | '' }
  ): Promise<TaskRecord>

  // ── 本地代理（3，v1.4）──────────────────────
  /** 代理状态（运行中含端口/启动时刻/统计） */
  getProxyStatus(): Promise<LocalProxyStatus>
  /** 启动（幂等；端口被占自动 +1；失败 reject 带原因） */
  startProxy(): Promise<LocalProxyStatus>
  /** 停止（幂等；活跃连接自然排空） */
  stopProxy(): Promise<LocalProxyStatus>

  // ── SSH 远程连接（12+1 改，S1 批0 契约；handler 归属见 ipc-channels 注释）──
  /** 全部连接档案（设置中心「远程连接」与侧栏服务器节点的数据源）【S2】 */
  listConnections(): Promise<ConnectionRecord[]>
  /**
   * 新增/编辑连接档案（id 空串=新增，main 侧校验+分配 uuid；密码字段经
   * safeStorage 加密落盘，回读不返回明文）【S2】
   */
  saveConnection(connection: ConnectionRecord): Promise<ConnectionRecord>
  /**
   * 删除连接档案（3.9=A 级联语义：仅删客户端记录与档案，不删 VM 内任何文件；
   * 其远程项目记录的处理由 S2 定）【S2】
   */
  removeConnection(id: string): Promise<void>
  /** 只读连通性测试（不改变连接状态；失败返回 ok:false + 分级文案 error；kind/指纹/自检清单为 S2 实际返回超集，契约 v2.2 升格）【S2】 */
  testConnection(id: string): Promise<ConnectionTestResult>
  /** 建立连接（懒连接 2.5=a；状态迁移经 onConnectionState 推送）【S2】 */
  connectConnection(id: string): Promise<void>
  /** 断开连接（幂等；5.9=b：断开不杀远端会话，server 保活）【S2】 */
  disconnectConnection(id: string): Promise<void>
  /** SFTP 目录浏览（path 缺省=远端 home；远程项目注册对话框路径选择用，3.1=C）【S2】 */
  browseRemoteDir(connectionId: string, path?: string): Promise<SftpBrowseResult>
  /**
   * 首连推送/升级 cwb-server（6.7=A；进度经 onRemoteServerLog 展示，安装确认
   * 弹窗 UI 归 S6，本方法为 main 侧 promise 接口）【S7】
   */
  installRemoteServer(connectionId: string): Promise<{ ok: boolean; error?: string }>
  /** 连接状态订阅（disposer 模式同 onPtyData；唯一产生者=S2，A2 权属） */
  onConnectionState(cb: (e: ConnectionStateChangedEvent) => void): Unsubscribe
  /** 远程 server 日志订阅（disposer 模式；server.log 帧脱敏元数据桥接，8.1=A） */
  onRemoteServerLog(cb: (e: RemoteServerLogEvent) => void): Unsubscribe
  /** VM 侧代理状态（6.4=c；经 server 协议 proxy.status 透出）【S4】 */
  getRemoteProxyStatus(connectionId: string): Promise<RemoteProxyStatus>
  /**
   * VM 侧代理配置写入并返回保存后全量（A5 回环验收：set→get 一致；
   * 设置页「远程代理」用）【S4】
   */
  setRemoteProxyConfig(
    connectionId: string,
    patch: Partial<RemoteProxyConfig>
  ): Promise<RemoteProxyConfig>
  /** VM 侧代理启动（v1.6.1：server 帧 proxy.start；返回启动后状态） */
  startRemoteProxy(connectionId: string): Promise<RemoteProxyStatus>
  /** VM 侧代理停止（v1.6.1：server 帧 proxy.stop） */
  stopRemoteProxy(connectionId: string): Promise<RemoteProxyStatus>

  // ── smoke（1，测试专用）──────────────────────
  /** S4 冒烟回执：renderer 收到 PTY 数据后回报 main */
  /** v2.0 拖拽文件 → 本机绝对路径（webUtils；Electron 44 File.path 已废） */
  getPathForFile(file: File): string | undefined
  reportSmoke(payload: string): void
}
