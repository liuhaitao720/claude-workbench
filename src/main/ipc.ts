import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IpcChannels } from '../shared/ipc-channels'
import { translate } from '../shared/i18n'
import type {
  AppSettings,
  CliOutputEvent,
  CreateTaskOptions,
  ProjectRecord,
  PtyDataEvent,
  RemoveTaskOptions,
  SkillInfo,
  TaskRecord
} from '../shared/types'
import { checkClaudeUpdate, fetchClaudeChangelog, getClaudeVersionInfo, installClaudeCli } from './claude-version'
import { AppUpdater } from './app-updater'
import { CliRunner } from './cli-runner'
import { isGitRepo, worktreeAdd, worktreeRemove } from './isolation'
import { countLiveRunningTasks } from './running-count'
import { AppSettingsStore } from './settings-store'
import { FontScanner } from './font-scan'
import { NotifyService } from './notify'
import { ProjectStore } from './project-store'
import { mainLanguage, setMainLanguage } from './language'
import { PtyManager, buildNewSessionArgs, buildResumeArgs } from './pty-manager'
import { importTasksFromSessionsImpl } from './session-import'
import { SkillsStore } from './skills-store'
import { PluginSkills, isValidPluginId } from './plugin-skills'
import { SkillMarket, validateInstallTarget } from './skill-market'
import { startTaskActivityServer, type TaskActivityHandle } from './task-activity'
import { TaskStore } from './task-store'

/** main→renderer 推送：广播到全部窗口 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * v1.0.8 外部链接协议白名单（纯函数，单测覆盖）：仅 http/https 放行。
 * 终端输出（claude 回显、文件内容）属不可信输入——OSC 8 / WebLinks 拼出的链接
 * 可能是 javascript:、file: 或磁盘路径，shell.openExternal 一律拒绝非白名单协议。
 */
export function isSafeExternalUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/**
 * main 侧 app 上下文（S4 抽出）：stores + pty + 全部业务 action。
 * 抽出动机：--smoke/--smoke-recovery 编排（main.ts）需要走与 IPC handler 完全相同的
 * 真实路径（createTask/resumeTask/stopTask 等），不得绕过逻辑层另写一份。
 */
export interface AppContext {
  readonly projects: ProjectStore
  readonly tasks: TaskStore
  readonly pty: PtyManager
  /** 任务活动裁决器 + hooks HTTP 接收端（v3.2；ptyWrite Esc 检测等经此消费） */
  readonly activity: TaskActivityHandle
  /** v0.5③ skill 扫描/导入/移除（回收站） */
  readonly skills: SkillsStore
  /** v0.5③ CLI 命令执行器（独立隐藏 PTY，输出走 cwb:event:cli-output） */
  readonly cli: CliRunner
  /** v1.2.0 skill 市场（读本机 marketplace 目录；联网由 CLI 自身完成） */
  readonly skillMarket: SkillMarket
  /** v1.2.1 插件 skill 来源（读 ~/.claude/plugins 的安装记录与启用状态） */
  readonly pluginSkills: PluginSkills
  /** v0.5④N webhook 推送（awaiting 防抖推送；配置 userData/notify.json） */
  readonly notify: NotifyService
  /** smoke:report 回执累积（S4：renderer→main 冒烟回执；编排侧轮询消费） */
  readonly smokeReports: string[]
  addProject(dir: string): Promise<ProjectRecord>
  removeProject(id: string): Promise<void>
  renameProject(id: string, name: string): Promise<ProjectRecord>
  createTask(projectId: string, name: string, opts: CreateTaskOptions): Promise<TaskRecord>
  resumeTask(taskId: string): Promise<TaskRecord>
  stopTask(taskId: string): Promise<void>
  removeTask(taskId: string, opts: RemoveTaskOptions): Promise<void>
  renameTask(taskId: string, name: string): Promise<TaskRecord>
  /** 切换"跳过权限确认"（v0.3.1 契约第 17 法）：仅元数据，下次 spawn 生效 */
  setTaskSkipPermissions(taskId: string, on: boolean): Promise<TaskRecord>
  pickDirectory(): Promise<string | null>
  /**
   * v0.9 S13 会话导入（第 33 法）：扫描项目目录的 claude CLI 历史会话 → 生成可恢复任务
   * （幂等，跳过已导入 sessionId）；返回新增列表。addProject 完成后自动调用一次。
   */
  importTasksFromSessions(projectId: string): Promise<TaskRecord[]>
  /** v0.9 应用设置（main settings.json：关闭行为/自启） */
  readonly appSettings: AppSettingsStore
  /** v0.9.4 本机等宽字体扫描（缓存） */
  readonly fontScanner: FontScanner
  /** v1.1.0 应用自更新（检测/下载校验/退出替换；进度经 cwb:event:app-update-progress） */
  readonly appUpdate: AppUpdater
}

export interface AppContextOptions {
  /** PTY 输出旁路观察者（S4 smoke/recovery 编排用；在广播之外追加调用，不影响 broadcast 行为） */
  onPtyData?: (event: PtyDataEvent) => void
  /** 任务记录变更旁路（v0.5⑥ 托盘 tooltip 运行数刷新——同 onPtyData 注入缝先例） */
  onTaskUpdate?: (record: TaskRecord) => void
  /** v1.2.0 应用设置变更旁路（托盘菜单/退出确认文案随语言切换刷新） */
  onSettingsChange?: (settings: AppSettings) => void
}

/** 创建 app 上下文（含启动归一化 running→stopped）；registerIpcHandlers 默认调它 */
export function createAppContext(options: AppContextOptions = {}): AppContext {
  const baseDir = app.getPath('userData')
  const projects = new ProjectStore(baseDir)
  const tasks = new TaskStore(baseDir)
  // 应用重启后 PTY 已死：历史 running 一律归位 stopped
  tasks.normalizeOnStartup()

  const smokeReports: string[] = []
  /** v1.2.1：任务记录变更后的补钩（appUpdate 在下方创建，避免 TDZ；自动升级等任务结束时续上） */
  let onTaskUpdateHook: (() => void) | null = null
  const broadcastTaskUpdate = (record: TaskRecord): void => {
    broadcast(IpcChannels.TaskUpdate, record)
    options.onTaskUpdate?.(record) // v0.5⑥ 托盘 tooltip 运行数刷新旁路
    onTaskUpdateHook?.()
  }

  /**
   * 唯一的 running→终态迁移路径（显式 stop 与 PTY onExit 共用；幂等，防双写双播）。
   * v0.3.2：区分终态——stopTask 落 'stopped'，非显式停止的 onExit 落 'exited'（跟踪会话异常退出）。
   */
  const markStatus = (taskId: string, status: 'stopped' | 'exited'): void => {
    const task = tasks.get(taskId)
    if (!task || task.status !== 'running') return
    const updated = tasks.upsert({ ...task, status, lastActiveAt: new Date().toISOString() })
    broadcastTaskUpdate(updated)
  }

  /**
   * v3.2 hooks settings 目录：固定走 %LOCALAPPDATA%\cwb\cwb-settings——userData 路径
   * 随 productName "Claude Workbench" 含空格（实测 --settings 值本身的引号由 node-pty
   * argsToCommandLine 按 MSDN 规则处理不断裂；真正断裂点是 claude.cmd 自身路径含空格
   * 的既有暴露，见评审 #9）。LOCALAPPDATA 缺失（非 Windows/CI）回退 userData。
   * CWB_HOOK_SETTINGS_DIR 为测试注入缝（同 main.ts 的 CWB_USER_DATA 先例），
   * 防测试污染真实用户目录。
   */
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  const settingsDir =
    process.env['CWB_HOOK_SETTINGS_DIR'] ??
    join(process.env['LOCALAPPDATA'] ?? app.getPath('userData'), 'cwb', 'cwb-settings')

  // v1.2.0 语言变更：托盘菜单/退出确认文案随 AppSettings.language 刷新（onSettingsChange 旁路）
  // 同时写入 main 进程级语言（language.ts）——其余 main 模块的错误文案/推送文案读它
  const appSettings = new AppSettingsStore(settingsFile, (s) => {
    setMainLanguage(s.language === 'en' ? 'en' : 'zh')
    options.onSettingsChange?.(s)
    // v1.2.1 自动升级开关：关闭即取消挂起安装；重新打开则立即补跑一轮
    if (s.autoUpdate === false) appUpdate.cancelAutoInstall()
    else void appUpdate.runAutoUpdate()
  })
  setMainLanguage(appSettings.get().language === 'en' ? 'en' : 'zh')

  // v0.5④N webhook 推送：配置 userData/notify.json（URL 属凭据仅存本地）；推送文案带任务显示名
  const notify = new NotifyService({
    file: join(baseDir, 'notify.json'),
    taskNameOf: (taskId) => tasks.get(taskId)?.name,
    language: mainLanguage
  })
  const fontScanner = new FontScanner()
  // v1.1.0 应用自更新：落点 userData/updates；进度广播全部窗口（quit 走 app.quit 正常路径
  // ——before-quit 杀 PTY 树释放文件锁后更新器才动手，见 app-updater.ts 头注）
  const appUpdate = new AppUpdater({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    updateDir: join(baseDir, 'updates'),
    tempDir: app.getPath('temp'),
    onProgress: (e) => broadcast(IpcChannels.AppUpdateProgress, e),
    quit: () => app.quit(),
    // v1.2.1 自动升级：有任务在跑不打断，任务停完立即续上升级
    runningCount: () => countLiveRunningTasks(tasks.list(), (id) => pty.isRunning(id)),
    autoUpdate: () => appSettings.get().autoUpdate !== false
  })
  // v1.2.1：任务停下即重试自动安装（轮询是兜底——正常情况下最后一次 stop 就续上升级）
  onTaskUpdateHook = () => appUpdate.tryAutoInstall()
  const activity = startTaskActivityServer({
    settingsDir,
    onActivity: (e) => {
      broadcast(IpcChannels.TaskActivity, e)
      // v0.5④N 触发锚点：activity==='awaiting' 时防抖推送（终版评审高1——勿挂 markStatus，
      // 它只承载 stopped/exited 终态；推送内部吞错不阻塞状态机）
      notify.onActivityEvent(e)
    }
  })
  // R8 启动孤儿清扫：settings 目录下不在 tasks.json 的文件删除（崩溃残留/spawn 失败遗留）
  activity.cleanupOrphans(tasks.list().map((t) => t.id))

  const pty = new PtyManager({
    onData: (event: PtyDataEvent) => {
      activity.noteBytes(event.taskId) // v3.2 字节兜底信号（先记时间戳再广播）
      broadcast(IpcChannels.PtyData, event)
      options.onPtyData?.(event)
    },
    onExit: (taskId) => markStatus(taskId, 'exited')
  })

  // v1.2.0 skill 市场 / v1.2.1 插件 skill 的注入缝（同 CWB_SKILLS_USER_ROOT 先例，防读真实 ~/.claude）
  const skillMarketHome = process.env['CWB_SKILL_MARKET_HOME']

  // v0.5③ skill 管理（只读扫描用户级+项目级；v1.2.1 增加插件级；移除走回收站+realpath 归属校验）
  const pluginSkills = new PluginSkills(skillMarketHome ? { home: () => skillMarketHome } : {})
  const skills = new SkillsStore({ projects: () => projects.list(), pluginSkills })

  // v0.5③ CLI 命令执行器：独立隐藏 PTY，输出仅走 cwb:event:cli-output（不进 PtyData/noteBytes）
  const cli = new CliRunner({
    onData: (event: CliOutputEvent) => broadcast(IpcChannels.CliOutput, event),
    onExit: (commandId, exitCode) =>
      broadcast(IpcChannels.CliOutput, { commandId, type: 'exit', exitCode }),
    language: mainLanguage
  })

  // v1.2.0 skill 市场：只读本机 marketplace 目录（搜索/过滤）；安装与刷新复用 CLI 受控执行面
  const skillMarket = new SkillMarket(skillMarketHome ? { home: skillMarketHome } : {})

  /**
   * v0.9 S13 会话导入：持久化经 importTasksFromSessionsImpl，广播在此（renameTask 先例）。
   * renderer 任务列表经 onTaskUpdate 推送自动出现导入任务。
   */
  async function importTasksFromSessions(projectId: string): Promise<TaskRecord[]> {
    const added = await importTasksFromSessionsImpl(projectId, projects, tasks)
    for (const record of added) broadcastTaskUpdate(record)
    return added
  }

  async function addProject(dir: string): Promise<ProjectRecord> {
    const record = projects.add(dir, isGitRepo(dir))
    // v0.9 S13：打开目录（注册项目）即自动导入该目录的 claude 历史会话（幂等——重复
    // addProject 同 dir 返回既有记录，再导入亦零新增）。导入是尽力而为，失败不阻断注册
    // （可经 cwb:tasks:import-from-sessions 手动重试）。
    try {
      await importTasksFromSessions(record.id)
    } catch {
      // 扫描/读盘失败静默：项目注册是主路径，会话导入为增值功能
    }
    return record
  }

  async function removeProject(id: string): Promise<void> {
    // 其任务逐个停止并删记录；worktree 保留磁盘，由用户手清（spec 约定）
    for (const task of tasks.list(id)) {
      if (pty.isRunning(task.id)) pty.kill(task.id)
      tasks.remove(task.id)
      pty.forget(task.id)
      activity.forget(task.id)
    }
    projects.remove(id)
  }

  async function renameProject(id: string, name: string): Promise<ProjectRecord> {
    const record = projects.rename(id, name)
    if (!record) throw new Error(`project not found: ${id}`)
    return record
  }

  async function createTask(
    projectId: string,
    name: string,
    opts: CreateTaskOptions
  ): Promise<TaskRecord> {
    const project = projects.get(projectId)
    if (!project) throw new Error(`project not found: ${projectId}`)
    const taskId = randomUUID()
    let cwd = project.dir
    let worktreePath: string | undefined
    if (opts.isolation === 'worktree') {
      if (!project.isGit) throw new Error(`worktree isolation requires a git project: ${project.dir}`)
      worktreePath = await worktreeAdd(project.dir, taskId)
      cwd = worktreePath
    }
    // v3.2：epoch+1（作废旧 PTY 迟到 hook）+ 本地合成 idle（绿）
    activity.noteSpawn(taskId)
    try {
      // settings 写盘入 try：失败与 spawn 失败同路径清理 worktree/states（评审 #5）
      const settingsPath = await activity.buildSettings(taskId)
      await pty.spawnClaude(
        taskId,
        buildNewSessionArgs(taskId, name, {
          skipPermissions: opts.skipPermissions,
          settingsPath
        }),
        cwd
      )
    } catch (err) {
      // spawn 失败不留孤儿 worktree/settings（尽力清理）
      activity.forget(taskId)
      if (worktreePath) {
        try {
          await worktreeRemove(project.dir, taskId)
        } catch {
          // 清理失败原样抛出 spawn 错误
        }
      }
      throw err
    }
    const now = new Date().toISOString()
    const record: TaskRecord = {
      id: taskId,
      projectId,
      name,
      sessionId: taskId,
      cwd,
      ...(worktreePath ? { worktreePath } : {}),
      ...(opts.skipPermissions ? { skipPermissions: true } : {}),
      status: 'running',
      createdAt: now,
      lastActiveAt: now
    }
    const saved = tasks.upsert(record)
    broadcastTaskUpdate(saved)
    return saved
  }

  async function resumeTask(taskId: string): Promise<TaskRecord> {
    const task = tasks.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (task.status === 'running') throw new Error(`task ${taskId} is running, cannot resume`)
    // stop 后 PTY 异步 teardown（onExit 才清句柄）而状态是同步广播——恢复按钮立即可点。
    // 短暂等待句柄释放，关闭"点恢复撞上半退出态 → spawn 抛 already running → 静默失败"窗口（评审 F1）
    for (let waited = 0; pty.isRunning(taskId) && waited < 3000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (pty.isRunning(taskId)) throw new Error(`task ${taskId} PTY still tearing down, retry shortly`)
    // v3.2：resume 同路径——epoch+1 + 本地合成 idle + settings 重写（捕获新 epoch）
    activity.noteSpawn(task.id)
    try {
      const settingsPath = await activity.buildSettings(task.id)
      await pty.spawnClaude(
        task.id,
        buildResumeArgs(task.sessionId, task.name, {
          skipPermissions: task.skipPermissions === true,
          settingsPath
        }),
        task.cwd
      )
    } catch (err) {
      // spawn 失败清理 settings/内存态（评审 #4，与 createTask 对称）
      activity.forget(task.id)
      throw err
    }
    const updated = tasks.upsert({ ...task, status: 'running', lastActiveAt: new Date().toISOString() })
    broadcastTaskUpdate(updated)
    return updated
  }

  async function stopTask(taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    // 显式停止先落 'stopped' 再 kill——防 onExit 抢先标 'exited'（v0.3.2 终态区分）
    markStatus(taskId, 'stopped')
    pty.kill(taskId)
  }

  async function removeTask(taskId: string, opts: RemoveTaskOptions): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (pty.isRunning(taskId)) pty.kill(taskId)
    tasks.remove(taskId)
    pty.forget(taskId)
    activity.forget(taskId) // v3.2 R8：settings 文件 + 内存态清理
    if (opts.deleteWorktree && task.worktreePath) {
      const project = projects.get(task.projectId)
      if (project) await worktreeRemove(project.dir, taskId)
    }
  }

  async function renameTask(taskId: string, name: string): Promise<TaskRecord> {
    const record = tasks.rename(taskId, name)
    if (!record) throw new Error(`task not found: ${taskId}`)
    broadcastTaskUpdate(record)
    return record
  }

  /** 切换"跳过权限确认"（v0.3.1）：仅元数据，下次 spawn（恢复）生效；立即广播 */
  async function setTaskSkipPermissions(taskId: string, on: boolean): Promise<TaskRecord> {
    const task = tasks.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    const updated = tasks.upsert({ ...task, skipPermissions: on ? true : undefined })
    broadcastTaskUpdate(updated)
    return updated
  }

  async function pickDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  return {
    projects,
    tasks,
    pty,
    activity,
    skills,
    cli,
    skillMarket,
    pluginSkills,
    notify,
    smokeReports,
    addProject,
    removeProject,
    renameProject,
    createTask,
    resumeTask,
    stopTask,
    removeTask,
    renameTask,
    setTaskSkipPermissions,
    pickDirectory,
    importTasksFromSessions,
    appSettings,
    fontScanner,
    appUpdate
  }
}

/**
 * 注册全部 IPC handler（S2 实现；S4 起接受可选注入的 AppContext 并将其返回，
 * 供 --smoke/--smoke-recovery 编排复用同一真实路径）。
 * handler 参数签名即跨进程调用契约（见 preload/index.ts 与 shared/types.ts），不得改动。
 */
export function registerIpcHandlers(ctx: AppContext = createAppContext()): AppContext {
  const { projects, tasks, pty, activity, smokeReports } = ctx

  // handle（renderer invoke，带返回值）
  ipcMain.handle(IpcChannels.ProjectsList, () => projects.list())
  ipcMain.handle(IpcChannels.ProjectsAdd, (_e, dir: string) => ctx.addProject(dir))
  ipcMain.handle(IpcChannels.ProjectsRemove, (_e, id: string) => ctx.removeProject(id))
  ipcMain.handle(IpcChannels.ProjectsRename, (_e, id: string, name: string) => ctx.renameProject(id, name))
  ipcMain.handle(IpcChannels.TasksList, (_e, projectId?: string) => tasks.list(projectId))
  ipcMain.handle(IpcChannels.TasksCreate, (_e, projectId: string, name: string, opts: CreateTaskOptions) =>
    ctx.createTask(projectId, name, opts)
  )
  ipcMain.handle(IpcChannels.TasksResume, (_e, taskId: string) => ctx.resumeTask(taskId))
  ipcMain.handle(IpcChannels.TasksStop, (_e, taskId: string) => ctx.stopTask(taskId))
  ipcMain.handle(IpcChannels.TasksRemove, (_e, taskId: string, opts: RemoveTaskOptions) =>
    ctx.removeTask(taskId, opts)
  )
  ipcMain.handle(IpcChannels.TasksRename, (_e, taskId: string, name: string) => ctx.renameTask(taskId, name))
  ipcMain.handle(IpcChannels.TasksSetSkipPermissions, (_e, taskId: string, on: boolean) =>
    ctx.setTaskSkipPermissions(taskId, on)
  )
  ipcMain.handle(IpcChannels.DialogPickDirectory, () => ctx.pickDirectory())
  // v0.9 S13 会话导入（addProject 已自动调用；此为项目菜单手动触发/重扫入口）
  ipcMain.handle(IpcChannels.TasksImportFromSessions, (_e, projectId: string) =>
    ctx.importTasksFromSessions(projectId)
  )
  // v0.5③ skills（SkillInfo 归 renderer 弹窗消费；removeSkill 的归属校验在 main）
  ipcMain.handle(IpcChannels.SkillsList, () => ctx.skills.list())
  ipcMain.handle(
    IpcChannels.SkillsImport,
    (_e, fromDir: string, target: { scope: 'user' | 'project'; projectId?: string }) =>
      ctx.skills.importSkillFolder(fromDir, target)
  )
  ipcMain.handle(IpcChannels.SkillsRemove, (_e, skill: SkillInfo) => ctx.skills.removeSkill(skill))
  // v1.2.0 skill 市场：搜索只读本机目录；安装/刷新走 CLI 受控执行面（输出经 CliOutput 广播）
  ipcMain.handle(
    IpcChannels.SkillSearch,
    (_e, query: unknown, marketplace: unknown, limit: unknown) =>
      ctx.skillMarket.search(
        typeof query === 'string' ? query : '',
        typeof marketplace === 'string' && marketplace !== '' ? marketplace : undefined,
        typeof limit === 'number' && Number.isFinite(limit) ? limit : 50
      )
  )
  ipcMain.handle(IpcChannels.SkillMarketplaces, () => ctx.skillMarket.listMarketplaces())
  ipcMain.handle(IpcChannels.SkillMarketInstall, async (_e, installId: unknown) => {
    const lang = mainLanguage()
    if (typeof installId !== 'string') {
      return { ok: false, error: translate(lang, 'skill.errParam') }
    }
    const invalid = validateInstallTarget(installId, lang)
    if (invalid !== null) return { ok: false, error: invalid }
    try {
      const { commandId } = await ctx.cli.runPlugin(['plugin', 'install', installId, '-y'])
      return { ok: true, commandId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IpcChannels.SkillMarketRefresh, async () => {
    try {
      const { commandId } = await ctx.cli.runPlugin(['plugin', 'marketplace', 'update'])
      return { ok: true, commandId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // v1.2.1 插件 skill 启用/停用：`claude plugin enable|disable <id> -s user`
  // id 必须来自真实安装记录（白名单）——不接受任意字符串进命令行
  ipcMain.handle(
    IpcChannels.SkillPluginSetEnabled,
    async (_e, pluginId: unknown, enabled: unknown) => {
      const lang = mainLanguage()
      if (typeof pluginId !== 'string' || !isValidPluginId(pluginId)) {
        return { ok: false, error: translate(lang, 'skill.errIdFormat') }
      }
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: translate(lang, 'skill.errParam') }
      }
      if (!ctx.pluginSkills.installedIds().includes(pluginId)) {
        return { ok: false, error: translate(lang, 'skill.errNotInstalled', { id: pluginId }) }
      }
      try {
        const { commandId } = await ctx.cli.runPlugin([
          'plugin',
          enabled ? 'enable' : 'disable',
          pluginId,
          '-s',
          'user'
        ])
        return { ok: true, commandId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  // v0.5③ CLI 执行（校验+spawn 即返 commandId；拒绝抛带原因 Error）
  ipcMain.handle(IpcChannels.CliRun, (_e, command: string) => ctx.cli.run(command))
  // v0.5⑤ 版本/更新/安装（安装为固定模板，完成钩子失效 claudePathCache）
  ipcMain.handle(IpcChannels.VersionGet, () => getClaudeVersionInfo())
  ipcMain.handle(IpcChannels.UpdateCheck, () => checkClaudeUpdate())
  ipcMain.handle(IpcChannels.InstallCli, (_e, method: 'native' | 'npm') =>
    installClaudeCli(ctx.cli, method)
  )
  // v0.5④N webhook 通知
  // v0.9 应用设置
  ipcMain.handle(IpcChannels.FontsInstalled, () => ctx.fontScanner.getInstalledMonoFonts())
  // v1.1.0 应用自更新（检测/下载/退出替换；进度走 EVENT AppUpdateProgress 广播）
  // v1.2.1：启动自动检查+下载+等任务结束自动升级；手动检查 force=true 重新拉清单
  ipcMain.handle(IpcChannels.AppUpdateCheck, (_e, force?: unknown) =>
    ctx.appUpdate.checkAppUpdate(force === true)
  )
  ipcMain.handle(IpcChannels.AppUpdateDownload, async () => {
    const r = await ctx.appUpdate.download()
    // v1.2.1：手动下载成功后同样续接自动安装守卫（开关关闭时不接管）
    if (r.ok) ctx.appUpdate.continueAfterManualDownload()
    return r
  })
  ipcMain.handle(IpcChannels.AppUpdateInstall, () => ctx.appUpdate.install())
  // v1.1.0 claude CLI 更新说明（官方 CHANGELOG 区间；参数非法只报错不抛）
  ipcMain.handle(IpcChannels.ClaudeChangelogGet, (_e, current: unknown, latest: unknown) => {
    const cur = typeof current === 'string' ? current : ''
    const lat = typeof latest === 'string' ? latest : ''
    if (cur === '' || lat === '') return { notes: [], error: '参数缺失' }
    return fetchClaudeChangelog(cur, lat)
  })
  // v1.0.8 外部链接：白名单校验后交系统浏览器；拒绝（含 openExternal 失败）只返回 false 不抛错
  ipcMain.handle(IpcChannels.ShellOpenExternal, async (_e, url: string) => {
    if (!isSafeExternalUrl(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle(IpcChannels.SettingsGet, () => ctx.appSettings.get())
  ipcMain.handle(IpcChannels.SettingsSet, (_e, patch: Partial<AppSettings>) => ctx.appSettings.set(patch))
  ipcMain.handle(IpcChannels.NotifyGet, () => ctx.notify.getConfig())
  ipcMain.handle(IpcChannels.NotifySet, (_e, url: string, enabled: boolean) =>
    ctx.notify.setWebhook(url, enabled)
  )
  ipcMain.handle(IpcChannels.NotifyTest, () => ctx.notify.sendTest())
  // on（renderer send，无返回值）
  ipcMain.on(IpcChannels.PtyWrite, (_e, taskId: string, data: string) => {
    // v0.4.2 输入回显抑制：记录用户键入时刻（键入后 2s 内的 PTY 字节=TUI 重绘，不点亮 busy）
    activity.noteUserInput(taskId)
    pty.write(taskId, data)
    // v3.2 本地 Esc 中断检测：恰为单字符 \x1b（方向键 \x1b[A 等多字节序列因长度不等于 1 排除）；
    // 仅当前裁决 busy 时合成 idle——补官方 Stop hook 在 Esc 中断不触发的缺口
    if (data === '\x1b') activity.onEsc(taskId)
  })
  ipcMain.on(IpcChannels.PtyResize, (_e, taskId: string, cols: number, rows: number) => {
    pty.resize(taskId, cols, rows)
  })
  // v0.5⑥：renderer window.close() 重定向接收——走 win.close()（X 按钮同路径，触发 close 拦截）
  ipcMain.on(IpcChannels.WindowClose, () => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  })
  // S4 冒烟回执：renderer 收到 PTY 数据后回报，累积到 ctx.smokeReports（编排侧轮询断言）
  ipcMain.on(IpcChannels.SmokeReport, (_e, payload: string) => {
    smokeReports.push(payload)
  })
  // v0.5③ 终止 CLI 命令（弹窗关闭防孤儿）——preload 经 send 调用（照 ptyWrite 先例走 on）；
  // 契约把 CliKill 归入 HANDLE 全集，故同时注册 handle 兜底注册集完整性断言（kill 幂等，双路径无害）
  ipcMain.on(IpcChannels.CliKill, (_e, commandId: string) => {
    ctx.cli.kill(commandId)
  })
  ipcMain.handle(IpcChannels.CliKill, (_e, commandId: string) => {
    ctx.cli.kill(commandId)
  })
  return ctx
}
