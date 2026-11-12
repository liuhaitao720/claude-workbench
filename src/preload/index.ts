import { contextBridge, ipcRenderer , webUtils } from 'electron'
import type {
  AppChangelogEntry,
  AppSettings,
  AppUpdateInfo,
  AppUpdateProgressEvent,
  ConnectionRecord,
  ConnectionStateChangedEvent,
  CWBApi,
  CliOutputEvent,
  DiffFileDetail,
  DiffListResult,
  LocalProxyStatus,
  NotifyConfig,
  ProviderConfig,
  ProviderRegistryState,
  RemoteProxyConfig,
  RemoteProxyStatus,
  RemoteServerLogEvent,
  ReviewHintEvent,
  SftpBrowseResult,
  SkillInfo,
  SkillMarketEntry,
  SkillMarketplaceInfo,
  TaskActivityEvent,
  ProjectRecord,
  PtyDataEvent,
  TaskRecord,
  TaskUpdateEvent,
  TransferItem,
  FilesBrowseResult
} from '../shared/types'
import { IpcChannels } from '../shared/ipc-channels'

/**
 * S1.5 契约桥接：CWBApi 17 法的完整 preload 映射（纯接线，无业务逻辑）。
 * 事件订阅必须显式返回 disposer——不得透传 ipcRenderer.on 的返回值
 * （其返回 ipcRenderer 自身，无法穿过 contextBridge）。
 */
const api: CWBApi = {
  // v1.3 运行平台（renderer 按平台分支：默认字体/安装命令/windowsPty/更新角标门禁）
  platform: process.platform,
  // projects
  listProjects: () => ipcRenderer.invoke(IpcChannels.ProjectsList) as Promise<ProjectRecord[]>,
  addProject: (dir: string, connectionId?: string) =>
    (ipcRenderer.invoke(IpcChannels.ProjectsAdd, dir, connectionId) as Promise<ProjectRecord>), // connectionId=S5 实装
  removeProject: (id) => ipcRenderer.invoke(IpcChannels.ProjectsRemove, id) as Promise<void>,
  renameProject: (id, name) =>
    ipcRenderer.invoke(IpcChannels.ProjectsRename, id, name) as Promise<ProjectRecord>,
  // tasks
  listTasks: (projectId) => ipcRenderer.invoke(IpcChannels.TasksList, projectId) as Promise<TaskRecord[]>,
  createTask: (projectId, name, opts) =>
    ipcRenderer.invoke(IpcChannels.TasksCreate, projectId, name, opts) as Promise<TaskRecord>,
  resumeTask: (taskId) => ipcRenderer.invoke(IpcChannels.TasksResume, taskId) as Promise<TaskRecord>,
  stopTask: (taskId) => ipcRenderer.invoke(IpcChannels.TasksStop, taskId) as Promise<void>,
  removeTask: (taskId, opts) =>
    ipcRenderer.invoke(IpcChannels.TasksRemove, taskId, opts) as Promise<void>,
  renameTask: (taskId, name) =>
    ipcRenderer.invoke(IpcChannels.TasksRename, taskId, name) as Promise<TaskRecord>,
  setTaskSkipPermissions: (taskId, on) =>
    ipcRenderer.invoke(IpcChannels.TasksSetSkipPermissions, taskId, on) as Promise<TaskRecord>,
  // pty（void 方法走 send）
  ptyWrite: (taskId, data) => {
    void ipcRenderer.send(IpcChannels.PtyWrite, taskId, data)
  },
  ptyResize: (taskId, cols, rows) => {
    void ipcRenderer.send(IpcChannels.PtyResize, taskId, cols, rows)
  },
  // events
  onPtyData: (cb) => {
    const listener = (_e: unknown, ev: PtyDataEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.PtyData, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.PtyData, listener as never)
  },
  onTaskUpdate: (cb) => {
    const listener = (_e: unknown, ev: TaskUpdateEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.TaskUpdate, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.TaskUpdate, listener as never)
  },
  onTaskActivity: (cb) => {
    const listener = (_e: unknown, ev: TaskActivityEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.TaskActivity, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.TaskActivity, listener as never)
  },
  // dialog
  pickDirectory: () => ipcRenderer.invoke(IpcChannels.DialogPickDirectory) as Promise<string | null>,
  // smoke
  // skills（v0.5③）
  listSkills: (cid?: string) => ipcRenderer.invoke(IpcChannels.SkillsList, cid) as Promise<SkillInfo[]>,
  importSkillFolder: (fromDir, target, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillsImport, cid, fromDir, target) as Promise<SkillInfo>,
  removeSkill: (skill, cid?) =>
    ipcRenderer.invoke(IpcChannels.SkillsRemove, cid, skill) as Promise<void>,
  // cli 执行（v0.5③；M10 增可选 connectionId——缺省本机执行，既有调用零改动）
  runCliCommand: (command, connectionId) =>
    ipcRenderer.invoke(IpcChannels.CliRun, command, connectionId) as Promise<{ commandId: string }>,
  onCliOutput: (cb) => {
    const listener = (_e: unknown, ev: CliOutputEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.CliOutput, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.CliOutput, listener as never)
  },
  killCliCommand: (commandId) => {
    void ipcRenderer.send(IpcChannels.CliKill, commandId)
  },
  // claude 版本/更新/安装（v0.5⑤）
  getClaudeVersionInfo: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.VersionGet, cid) as Promise<{ version: string; path: string }>,
  checkClaudeUpdate: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.UpdateCheck, cid) as Promise<
      { current: string; latest: string; upToDate: boolean; degraded?: boolean }
    >,
  installClaudeCli: (method: 'native' | 'npm', cid?: string) =>
    ipcRenderer.invoke(IpcChannels.InstallCli, cid, method) as Promise<{ commandId: string }>,
  // 应用设置（v0.9）
  getAppSettings: () => ipcRenderer.invoke(IpcChannels.SettingsGet) as Promise<AppSettings>,
  getInstalledMonoFonts: () =>
    ipcRenderer.invoke(IpcChannels.FontsInstalled) as Promise<string[]>,
  // v1.0.8 外部链接（终端链接 → 系统浏览器，main 协议白名单）
  openExternal: (url) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenExternal, url) as Promise<boolean>,
  // v1.1.0 应用自更新
  checkAppUpdate: (force) =>
    ipcRenderer.invoke(IpcChannels.AppUpdateCheck, force === true) as Promise<AppUpdateInfo>,
  downloadAppUpdate: () =>
    ipcRenderer.invoke(IpcChannels.AppUpdateDownload) as Promise<{ ok: boolean; error?: string }>,
  installAppUpdate: () =>
    ipcRenderer.invoke(IpcChannels.AppUpdateInstall) as Promise<{ ok: boolean; error?: string }>,
  onAppUpdateProgress: (cb) => {
    const listener = (_e: unknown, ev: AppUpdateProgressEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.AppUpdateProgress, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.AppUpdateProgress, listener as never)
  },
  // v1.1.0 claude CLI 更新说明（检查更新结果 → 官方 CHANGELOG 区间）
  getClaudeChangelog: (current, latest) =>
    ipcRenderer.invoke(IpcChannels.ClaudeChangelogGet, current, latest) as Promise<{
      notes: AppChangelogEntry[]
      error?: string
    }>,
  importTasksFromSessions: (projectId) =>
    ipcRenderer.invoke(IpcChannels.TasksImportFromSessions, projectId) as Promise<TaskRecord[]>,
  // v1.2.0 skill 市场（搜索本机 marketplace 目录；安装/刷新走 CLI 受控执行面）
  searchSkillMarket: (query, marketplace, limit, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillSearch, cid, query, marketplace, limit) as Promise<
      SkillMarketEntry[]
    >,
  listSkillMarketplaces: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillMarketplaces, cid) as Promise<SkillMarketplaceInfo[]>,
  installMarketSkill: (installId, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillMarketInstall, cid, installId) as Promise<{
      ok: boolean
      commandId?: string
      error?: string
    }>,
  refreshSkillMarket: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillMarketRefresh, cid) as Promise<{
      ok: boolean
      commandId?: string
      error?: string
    }>,
  // v1.2.1 插件 skill 启用/停用（claude plugin enable|disable <id> -s user）
  setSkillPluginEnabled: (pluginId, enabled, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.SkillPluginSetEnabled, cid, pluginId, enabled) as Promise<{
      ok: boolean
      commandId?: string
      error?: string
    }>,
  setAppSettings: (patch) =>
    ipcRenderer.invoke(IpcChannels.SettingsSet, patch) as Promise<AppSettings>,
  // webhook 通知（v0.5④N）
  getNotifyConfig: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.NotifyGet, cid) as Promise<NotifyConfig>,
  setNotifyWebhook: (url: string, enabled: boolean, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.NotifySet, cid, url, enabled) as Promise<NotifyConfig>,
  getNotifyTrail: () =>
    ipcRenderer.invoke(IpcChannels.NotifyTrailGet) as Promise<{
      trail: Array<{ at: string; taskId: string; status: string; detail?: string }>
      localEnabled: boolean
    }>,
  onNotifyTrail: (cb: (e: { at: string; taskId: string; status: string; detail?: string }) => void) => {
    const listener = (_e: unknown, ev: { at: string; taskId: string; status: string; detail?: string }): void => cb(ev)
    ipcRenderer.on(IpcChannels.NotifyTrailEvent, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.NotifyTrailEvent, listener as never)
  },
  sendTestNotify: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.NotifyTest, cid) as Promise<{ ok: boolean; error?: string }>,
  // v1.4 模型服务 provider（参考 cc-switch：档案 CRUD + 默认切换；仅配置注入）
  listProviders: (cid?: string) =>
    ipcRenderer.invoke(IpcChannels.ProvidersList, cid) as Promise<ProviderRegistryState>,
  saveProvider: (provider, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.ProvidersSave, cid, provider) as Promise<ProviderConfig>,
  removeProvider: (id, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.ProvidersRemove, cid, id) as Promise<void>,
  setDefaultProvider: (id, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.ProvidersSetDefault, cid, id) as Promise<void>,
  probeProviderModels: (id, cid?: string) =>
    ipcRenderer.invoke(IpcChannels.ProvidersProbeModels, cid, id) as Promise<{
      ok: boolean
      models?: string[]
      error?: string
    }>,
  copyProvider: (source, target, providerId) =>
    ipcRenderer.invoke(IpcChannels.ProvidersCopy, source, target, providerId) as Promise<ProviderConfig>,
  // ── v2.0 远程文件管理 ──────────────────────────────────────────────
  listRemoteFiles: (cid, path?) =>
    ipcRenderer.invoke(IpcChannels.FilesList, cid, path) as Promise<FilesBrowseResult>,
  mkdirRemote: (cid, path) => ipcRenderer.invoke(IpcChannels.FilesMkdir, cid, path) as Promise<void>,
  renameRemote: (cid, from, to) =>
    ipcRenderer.invoke(IpcChannels.FilesRename, cid, from, to) as Promise<void>,
  deleteRemote: (cid, path, isDir) =>
    ipcRenderer.invoke(IpcChannels.FilesDelete, cid, path, isDir) as Promise<void>,
  /** v2.0.1 小文本双击本机打开（<10MB 白名单扩展；main 下载临时目录+系统打开） */
  peekRemoteFile: (cid, remotePath) =>
    ipcRenderer.invoke(IpcChannels.FilesPeek, cid, remotePath) as Promise<string>,
  pickLocalForUpload: (files, dirs) =>
    ipcRenderer.invoke(IpcChannels.FilesPickUpload, files, dirs) as Promise<string[] | null>,
  uploadRemoteFiles: (cid, localPaths, remoteDir, policy) =>
    ipcRenderer.invoke(IpcChannels.FilesUpload, cid, localPaths, remoteDir, policy) as Promise<{
      items: TransferItem[]
      conflicts: Array<{ remotePath: string; renameTo?: string }>
    }>,
  downloadRemoteFile: (cid, remotePath, suggestedName?) =>
    ipcRenderer.invoke(IpcChannels.FilesDownload, cid, remotePath, suggestedName) as Promise<TransferItem | null>,
  listTransfers: () => ipcRenderer.invoke(IpcChannels.TransfersList) as Promise<TransferItem[]>,
  cancelTransfer: (id) => ipcRenderer.invoke(IpcChannels.TransferCancel, id) as Promise<void>,
  retryTransfer: (id) => ipcRenderer.invoke(IpcChannels.TransferRetry, id) as Promise<void>,
  onTransfersProgress: (cb) => {
    const listener = (_e: unknown, items: TransferItem[]): void => cb(items)
    ipcRenderer.on(IpcChannels.TransfersProgress, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.TransfersProgress, listener as never)
  },
  setTaskProvider: (taskId, opts) =>
    ipcRenderer.invoke(IpcChannels.TasksSetProvider, taskId, opts) as Promise<TaskRecord>,
  // v1.4 本地代理（纯隧道）
  getProxyStatus: () =>
    ipcRenderer.invoke(IpcChannels.ProxyStatus) as Promise<LocalProxyStatus>,
  startProxy: () => ipcRenderer.invoke(IpcChannels.ProxyStart) as Promise<LocalProxyStatus>,
  stopProxy: () => ipcRenderer.invoke(IpcChannels.ProxyStop) as Promise<LocalProxyStatus>,
  // SSH 远程连接（S1 契约桥接；handler 归属见 ipc-channels.ts 注释——S2/S4/S7）
  listConnections: () =>
    ipcRenderer.invoke(IpcChannels.ConnectionsList) as Promise<ConnectionRecord[]>,
  saveConnection: (connection) =>
    ipcRenderer.invoke(IpcChannels.ConnectionsSave, connection) as Promise<ConnectionRecord>,
  removeConnection: (id) =>
    ipcRenderer.invoke(IpcChannels.ConnectionsDelete, id) as Promise<void>,
  testConnection: (id) =>
    ipcRenderer.invoke(IpcChannels.ConnectionsTest, id) as Promise<{ ok: boolean; error?: string }>,
  connectConnection: (id) =>
    ipcRenderer.invoke(IpcChannels.ConnectionsConnect, id) as Promise<void>,
  disconnectConnection: (id) =>
    ipcRenderer.invoke(IpcChannels.ConnectionsDisconnect, id) as Promise<void>,
  browseRemoteDir: (connectionId, path) =>
    ipcRenderer.invoke(IpcChannels.SftpBrowse, connectionId, path) as Promise<SftpBrowseResult>,
  installRemoteServer: (connectionId) =>
    ipcRenderer.invoke(IpcChannels.ServerInstall, connectionId) as Promise<{
      ok: boolean
      error?: string
    }>,
  onConnectionState: (cb) => {
    const listener = (_e: unknown, ev: ConnectionStateChangedEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.ConnectionStateChanged, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.ConnectionStateChanged, listener as never)
  },
  onRemoteServerLog: (cb) => {
    const listener = (_e: unknown, ev: RemoteServerLogEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.RemoteServerLog, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.RemoteServerLog, listener as never)
  },
  getRemoteProxyStatus: (connectionId) =>
    ipcRenderer.invoke(IpcChannels.RemoteProxyStatus, connectionId) as Promise<RemoteProxyStatus>,
  setRemoteProxyConfig: (connectionId, patch) =>
    ipcRenderer.invoke(
      IpcChannels.RemoteProxyConfigSet,
      connectionId,
      patch
    ) as Promise<RemoteProxyConfig>,
  startRemoteProxy: (connectionId) =>
    ipcRenderer.invoke(IpcChannels.RemoteProxyStart, connectionId) as Promise<RemoteProxyStatus>,
  stopRemoteProxy: (connectionId) =>
    ipcRenderer.invoke(IpcChannels.RemoteProxyStop, connectionId) as Promise<RemoteProxyStatus>,
  /** v2.0 拖拽文件 → 本机绝对路径（Electron 44 File.path 已废——webUtils 官方口） */
  openLocalPath: (target) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenPath, target) as Promise<{ ok: boolean; error?: string }>,
  getPathForFile: (file: File): string | undefined =>
    webUtils?.getPathForFile?.(file) ?? (file as File & { path?: string }).path,
  // v2.0.2 git diff 审查
  listDiff: (projectId, cwd) =>
    ipcRenderer.invoke(IpcChannels.DiffList, projectId, cwd) as Promise<DiffListResult>,
  diffFile: (projectId, cwd, path, status) =>
    ipcRenderer.invoke(
      IpcChannels.DiffFile,
      projectId,
      cwd,
      path,
      status
    ) as Promise<DiffFileDetail>,
  onReviewHint: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, hint: ReviewHintEvent): void => cb(hint)
    ipcRenderer.on(IpcChannels.ReviewHint, listener)
    return () => ipcRenderer.removeListener(IpcChannels.ReviewHint, listener)
  },
  reportSmoke: (payload) => {
    void ipcRenderer.send(IpcChannels.SmokeReport, payload)
  }
}

contextBridge.exposeInMainWorld('cwb', api)

// v0.5⑥：Electron 44 起 renderer 的 window.close() 直接销毁窗口且不触发 BrowserWindow
// 'close' 事件（托盘拦截被绕过，最小实验实证）。contextIsolation 下 preload 隔离世界
// 动不了页面全局——须 exposeInMainWorld 覆盖页面 window.close，重定向主进程 win.close()
contextBridge.exposeInMainWorld('__cwbClose', (): void => {
  void ipcRenderer.send(IpcChannels.WindowClose)
})
