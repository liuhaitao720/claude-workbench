/**
 * IPC 频道契约（S1.5 主控落骨架，唯一事实源）
 * HANDLE 频道 = ipcMain.handle（renderer invoke，11 条，对应 CWBApi 返回 Promise 的方法）
 * SEND 频道  = ipcMain.on（renderer send，3 条，对应 CWBApi void 方法）
 * EVENT 频道 = webContents.send（main→renderer 推送，2 条）
 * S2 L2.5 验收：handle/on 注册集 === 对应全集（用 HANDLE_CHANNELS / SEND_CHANNELS 断言）。
 */
const HANDLE = {
  ProjectsList: 'cwb:projects:list',
  ProjectsAdd: 'cwb:projects:add',
  ProjectsRemove: 'cwb:projects:remove',
  ProjectsRename: 'cwb:projects:rename',
  TasksList: 'cwb:tasks:list',
  TasksCreate: 'cwb:tasks:create',
  TasksResume: 'cwb:tasks:resume',
  TasksStop: 'cwb:tasks:stop',
  TasksRemove: 'cwb:tasks:remove',
  TasksRename: 'cwb:tasks:rename',
  TasksSetSkipPermissions: 'cwb:tasks:set-skip-permissions',
  DialogPickDirectory: 'cwb:dialog:pick-dir',
  // v0.5（S8 实现）
  SkillsList: 'cwb:skills:list',
  SkillsImport: 'cwb:skills:import',
  SkillsRemove: 'cwb:skills:remove',
  CliRun: 'cwb:cli:run',
  CliKill: 'cwb:cli:kill',
  VersionGet: 'cwb:version:get',
  UpdateCheck: 'cwb:update:check',
  InstallCli: 'cwb:install:cli',
  NotifyGet: 'cwb:notify:get',
  NotifySet: 'cwb:notify:set',
  NotifyTest: 'cwb:notify:test',
  // v0.9 应用设置
  SettingsGet: 'cwb:settings:get',
  SettingsSet: 'cwb:settings:set',
  // v0.9 追加：会话导入
  TasksImportFromSessions: 'cwb:tasks:import-from-sessions',
  // v0.9.4 字体扫描
  FontsInstalled: 'cwb:fonts:installed',
  // v1.0.8 外部链接（终端链接点击 → 系统浏览器，main 侧协议白名单）
  ShellOpenExternal: 'cwb:shell:open-external',
  // v1.1.0 应用自更新
  AppUpdateCheck: 'cwb:app-update:check',
  AppUpdateDownload: 'cwb:app-update:download',
  AppUpdateInstall: 'cwb:app-update:install',
  // v1.1.0 claude CLI 更新说明（检查更新后拉取 GitHub CHANGELOG 区间）
  ClaudeChangelogGet: 'cwb:claude-changelog:get',
  // v1.2.0 skill 在线搜索/安装（读本机 marketplace 目录 + claude plugin install）
  SkillSearch: 'cwb:skill:search',
  SkillMarketplaces: 'cwb:skill:marketplaces',
  SkillMarketInstall: 'cwb:skill:market-install',
  SkillMarketRefresh: 'cwb:skill:market-refresh',
  // v1.2.1 插件 skill 启用/停用（已安装列表里插件条目切换状态）
  SkillPluginSetEnabled: 'cwb:skill:plugin-set-enabled',
  // v1.4 模型服务 provider 档案 CRUD + 默认切换（参考 cc-switch；仅配置注入，协议由 CLI/网关承担）
  ProvidersList: 'cwb:providers:list',
  ProvidersSave: 'cwb:providers:save',
  ProvidersRemove: 'cwb:providers:remove',
  ProvidersSetDefault: 'cwb:providers:set-default',
  // v1.4 模型列表探测（GET {baseUrl}/v1/models；官方端点经 provider 代理出口）
  ProvidersProbeModels: 'cwb:providers:probe-models',
  // v1.4 任务级 provider/model 事后修改（下次 spawn/resume 生效，照 set-skip-permissions 先例）
  TasksSetProvider: 'cwb:tasks:set-provider',
  // v1.4 本地代理（纯隧道）：状态/启动/停止
  ProxyStatus: 'cwb:proxy:status',
  ProxyStart: 'cwb:proxy:start',
  ProxyStop: 'cwb:proxy:stop',
  // SSH 远程模式（S1 批0 落通道契约；S1 先注册 NotImplemented 桩，实现归属如下注释）
  ConnectionsList: 'cwb:connections:list', // S2：连接档案读（connections-store）
  ConnectionsSave: 'cwb:connections:save', // S2：新增/编辑（safeStorage 加密落盘）
  ConnectionsDelete: 'cwb:connections:delete', // S2：删除档案（不删 VM 内文件）
  ConnectionsTest: 'cwb:connections:test', // S2：只读连通性测试（分级错误文案）
  ConnectionsConnect: 'cwb:connections:connect', // S2：懒连接（2.5）
  ConnectionsDisconnect: 'cwb:connections:disconnect', // S2：断开（5.9=b 不杀远端会话）
  SftpBrowse: 'cwb:sftp:browse', // S2：SFTP 目录浏览（3.1=C 注册对话框）
  ServerInstall: 'cwb:server:install', // S7：首连推送/升级 cwb-server（6.7）
  RemoteProxyStatus: 'cwb:remote-proxy:status', // S4：VM 侧代理状态（6.4=c 协议转发）
  RemoteProxyConfigGet: 'cwb:remote-proxy:config-get', // S4：VM 侧代理配置读
  RemoteProxyConfigSet: 'cwb:remote-proxy:config-set' // S4：VM 侧代理配置写（A5 回环）
} as const

const SEND = {
  PtyWrite: 'cwb:pty:write',
  PtyResize: 'cwb:pty:resize',
  SmokeReport: 'cwb:smoke:report',
  /** v0.5⑥：renderer window.close() 重定向（Electron 44 JS-close 直接销毁不走 close 事件） */
  WindowClose: 'cwb:window:close'
} as const

const EVENT = {
  PtyData: 'cwb:event:pty-data',
  TaskUpdate: 'cwb:event:task-update',
  TaskActivity: 'cwb:event:task-activity',
  CliOutput: 'cwb:event:cli-output',
  /** v1.1.0 应用自更新进度（downloading/verifying/ready/installing/error） */
  AppUpdateProgress: 'cwb:event:app-update-progress',
  /** SSH 远程连接状态变迁（S1 落通道：S2 唯一产生，经 ipc.ts broadcastConnectionState；S6 侧栏消费） */
  ConnectionStateChanged: 'cwb:event:connection-state-changed',
  /** 远程 server 日志（S1 落通道：S3 server.log 帧→S4 桥接 broadcastRemoteServerLog；脱敏元数据，8.1=A） */
  RemoteServerLog: 'cwb:event:remote-server-log'
} as const

export const IpcChannels = { ...HANDLE, ...SEND, ...EVENT } as const

/** ipcMain.handle 频道全集（S2 注册完整性断言用） */
export const HANDLE_CHANNELS: readonly string[] = Object.values(HANDLE)

/** ipcMain.on 频道全集（S2 注册完整性断言用） */
export const SEND_CHANNELS: readonly string[] = Object.values(SEND)

/** webContents.send 事件频道全集 */
export const EVENT_CHANNELS: readonly string[] = Object.values(EVENT)
