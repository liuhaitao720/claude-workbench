import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppChangelogEntry,
  AppSettings,
  AppUpdateInfo,
  AppUpdateProgressEvent,
  CWBApi,
  CliOutputEvent,
  NotifyConfig,
  SkillInfo,
  SkillMarketEntry,
  SkillMarketplaceInfo,
  TaskActivityEvent,
  ProjectRecord,
  PtyDataEvent,
  TaskRecord,
  TaskUpdateEvent
} from '../shared/types'
import { IpcChannels } from '../shared/ipc-channels'

/**
 * S1.5 契约桥接：CWBApi 17 法的完整 preload 映射（纯接线，无业务逻辑）。
 * 事件订阅必须显式返回 disposer——不得透传 ipcRenderer.on 的返回值
 * （其返回 ipcRenderer 自身，无法穿过 contextBridge）。
 */
const api: CWBApi = {
  // projects
  listProjects: () => ipcRenderer.invoke(IpcChannels.ProjectsList) as Promise<ProjectRecord[]>,
  addProject: (dir) => ipcRenderer.invoke(IpcChannels.ProjectsAdd, dir) as Promise<ProjectRecord>,
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
  listSkills: () => ipcRenderer.invoke(IpcChannels.SkillsList) as Promise<SkillInfo[]>,
  importSkillFolder: (fromDir, target) =>
    ipcRenderer.invoke(IpcChannels.SkillsImport, fromDir, target) as Promise<SkillInfo>,
  removeSkill: (skill) => ipcRenderer.invoke(IpcChannels.SkillsRemove, skill) as Promise<void>,
  // cli 执行（v0.5③）
  runCliCommand: (command) =>
    ipcRenderer.invoke(IpcChannels.CliRun, command) as Promise<{ commandId: string }>,
  onCliOutput: (cb) => {
    const listener = (_e: unknown, ev: CliOutputEvent): void => cb(ev)
    ipcRenderer.on(IpcChannels.CliOutput, listener as never)
    return () => ipcRenderer.removeListener(IpcChannels.CliOutput, listener as never)
  },
  killCliCommand: (commandId) => {
    void ipcRenderer.send(IpcChannels.CliKill, commandId)
  },
  // claude 版本/更新/安装（v0.5⑤）
  getClaudeVersionInfo: () =>
    ipcRenderer.invoke(IpcChannels.VersionGet) as Promise<{ version: string; path: string }>,
  checkClaudeUpdate: () =>
    ipcRenderer.invoke(IpcChannels.UpdateCheck) as Promise<
      { current: string; latest: string; upToDate: boolean; degraded?: boolean }
    >,
  installClaudeCli: (method) =>
    ipcRenderer.invoke(IpcChannels.InstallCli, method) as Promise<{ commandId: string }>,
  // 应用设置（v0.9）
  getAppSettings: () => ipcRenderer.invoke(IpcChannels.SettingsGet) as Promise<AppSettings>,
  getInstalledMonoFonts: () =>
    ipcRenderer.invoke(IpcChannels.FontsInstalled) as Promise<string[]>,
  // v1.0.8 外部链接（终端链接 → 系统浏览器，main 协议白名单）
  openExternal: (url) =>
    ipcRenderer.invoke(IpcChannels.ShellOpenExternal, url) as Promise<boolean>,
  // v1.1.0 应用自更新
  checkAppUpdate: () => ipcRenderer.invoke(IpcChannels.AppUpdateCheck) as Promise<AppUpdateInfo>,
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
  searchSkillMarket: (query, marketplace, limit) =>
    ipcRenderer.invoke(IpcChannels.SkillSearch, query, marketplace, limit) as Promise<
      SkillMarketEntry[]
    >,
  listSkillMarketplaces: () =>
    ipcRenderer.invoke(IpcChannels.SkillMarketplaces) as Promise<SkillMarketplaceInfo[]>,
  installMarketSkill: (installId) =>
    ipcRenderer.invoke(IpcChannels.SkillMarketInstall, installId) as Promise<{
      ok: boolean
      commandId?: string
      error?: string
    }>,
  refreshSkillMarket: () =>
    ipcRenderer.invoke(IpcChannels.SkillMarketRefresh) as Promise<{
      ok: boolean
      commandId?: string
      error?: string
    }>,
  setAppSettings: (patch) =>
    ipcRenderer.invoke(IpcChannels.SettingsSet, patch) as Promise<AppSettings>,
  // webhook 通知（v0.5④N）
  getNotifyConfig: () => ipcRenderer.invoke(IpcChannels.NotifyGet) as Promise<NotifyConfig>,
  setNotifyWebhook: (url, enabled) =>
    ipcRenderer.invoke(IpcChannels.NotifySet, url, enabled) as Promise<NotifyConfig>,
  sendTestNotify: () =>
    ipcRenderer.invoke(IpcChannels.NotifyTest) as Promise<{ ok: boolean; error?: string }>,
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
