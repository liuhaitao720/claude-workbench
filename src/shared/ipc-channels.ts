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
  SettingsSet: 'cwb:settings:set'
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
  CliOutput: 'cwb:event:cli-output'
} as const

export const IpcChannels = { ...HANDLE, ...SEND, ...EVENT } as const

/** ipcMain.handle 频道全集（S2 注册完整性断言用） */
export const HANDLE_CHANNELS: readonly string[] = Object.values(HANDLE)

/** ipcMain.on 频道全集（S2 注册完整性断言用） */
export const SEND_CHANNELS: readonly string[] = Object.values(SEND)

/** webContents.send 事件频道全集 */
export const EVENT_CHANNELS: readonly string[] = Object.values(EVENT)
