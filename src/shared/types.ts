/**
 * Claude Workbench 跨进程契约（S1.5 主控落骨架）
 * 唯一事实源：doc/design/spec-v1.md §5（v1.3）。契约变更须走主控编译红流程，子任务不得静默修改。
 */

/** 项目记录【S2 project-store 写 / S3 侧栏读】 */
export interface ProjectRecord {
  /** uuid */
  id: string
  /** 显示名——renameProject 仅改此字段，绝不改动磁盘目录名 */
  name: string
  /** 项目磁盘目录绝对路径（注册后不可变） */
  dir: string
  /** 注册时检测的 git 状态 */
  isGit: boolean
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
  /** user=用户级(~/.claude/skills，全局生效) | project=项目级(.claude/skills，仅该项目) */
  source: 'user' | 'project'
  projectId?: string
  /** skill 目录绝对路径（removeSkill 归属校验用） */
  dir: string
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
}

/** 应用自更新进度事件【v1.1.0：下载/校验/就绪/安装中/出错】 */
export type AppUpdateProgressEvent =
  | { phase: 'downloading'; percent: number }
  | { phase: 'verifying' }
  | { phase: 'ready' }
  | { phase: 'installing' }
  | { phase: 'error'; error: string }

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
  listSkills(): Promise<SkillInfo[]>
  /** 导入本地 skill 文件夹（复制到目标 scope；同名冲突报错） */
  importSkillFolder(fromDir: string, target: { scope: 'user' | 'project'; projectId?: string }): Promise<SkillInfo>
  /** 移除 skill（回收站 shell.trashItem；main 做 realpath 归属校验） */
  removeSkill(skill: SkillInfo): Promise<void>

  // ── cli 执行（3，v0.5③）────────────────────
  /** 校验并启动 claude CLI 命令（独立隐藏 PTY；白名单 {plugin,update,upgrade,mcp}）→ commandId */
  runCliCommand(command: string): Promise<{ commandId: string }>
  /** CLI 输出订阅（disposer 模式同 onPtyData） */
  onCliOutput(cb: (e: CliOutputEvent) => void): Unsubscribe
  /** 终止 CLI 命令（弹窗关闭防孤儿） */
  killCliCommand(commandId: string): void

  // ── claude 版本/更新/安装（3，v0.5⑤）───────
  /** 当前 claude CLI 版本+实际路径（version='' 表示未安装） */
  getClaudeVersionInfo(): Promise<{ version: string; path: string }>
  /** 检查更新（npm registry 对比；无 node 环境 degraded=true） */
  checkClaudeUpdate(): Promise<{ current: string; latest: string; upToDate: boolean; degraded?: boolean }>
  /** 下载安装 claude CLI（固定模板：native=官方安装器 / npm=npm install -g；输出走 onCliOutput） */
  installClaudeCli(method: 'native' | 'npm'): Promise<{ commandId: string }>

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
  /** 检查自身更新（GitHub Releases 清单 + CHANGELOG 更新说明；网络失败逐项降级） */
  checkAppUpdate(): Promise<AppUpdateInfo>
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
  searchSkillMarket(query: string, marketplace?: string, limit?: number): Promise<SkillMarketEntry[]>
  /** 已配置的 marketplace 概要（名称 + 条目数；用于过滤器） */
  listSkillMarketplaces(): Promise<SkillMarketplaceInfo[]>
  /**
   * 安装市场 skill：`claude plugin install <name>@<marketplace> -y`
   * （经 CLI 受控模板执行；返回 commandId 供弹窗挂 onCliOutput 展示进度）
   */
  installMarketSkill(
    installId: string
  ): Promise<{ ok: boolean; commandId?: string; error?: string }>
  /** 刷新所有 marketplace 目录（`claude plugin marketplace update`，走 CLI 网络/凭据策略） */
  refreshSkillMarket(): Promise<{ ok: boolean; commandId?: string; error?: string }>

  // ── webhook 通知（3，v0.5④N）───────────────
  /** 读取通知配置（默认 {url:'', enabled:false}） */
  getNotifyConfig(): Promise<NotifyConfig>
  /** 保存 webhook 配置 */
  setNotifyWebhook(url: string, enabled: boolean): Promise<NotifyConfig>
  /** 立即推送测试消息 */
  sendTestNotify(): Promise<{ ok: boolean; error?: string }>

  // ── smoke（1，测试专用）──────────────────────
  /** S4 冒烟回执：renderer 收到 PTY 数据后回报 main */
  reportSmoke(payload: string): void
}
