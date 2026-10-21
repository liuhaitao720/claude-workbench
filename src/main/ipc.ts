import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IpcChannels } from '../shared/ipc-channels'
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
import { checkClaudeUpdate, getClaudeVersionInfo, installClaudeCli } from './claude-version'
import { CliRunner } from './cli-runner'
import { isGitRepo, worktreeAdd, worktreeRemove } from './isolation'
import { AppSettingsStore } from './settings-store'
import { NotifyService } from './notify'
import { ProjectStore } from './project-store'
import { PtyManager, buildNewSessionArgs, buildResumeArgs } from './pty-manager'
import { SkillsStore } from './skills-store'
import { startTaskActivityServer, type TaskActivityHandle } from './task-activity'
import { TaskStore } from './task-store'

/** main→renderer 推送：广播到全部窗口 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
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
  /** v0.9 应用设置（main settings.json：关闭行为/自启） */
  readonly appSettings: AppSettingsStore
}

export interface AppContextOptions {
  /** PTY 输出旁路观察者（S4 smoke/recovery 编排用；在广播之外追加调用，不影响 broadcast 行为） */
  onPtyData?: (event: PtyDataEvent) => void
  /** 任务记录变更旁路（v0.5⑥ 托盘 tooltip 运行数刷新——同 onPtyData 注入缝先例） */
  onTaskUpdate?: (record: TaskRecord) => void
}

/** 创建 app 上下文（含启动归一化 running→stopped）；registerIpcHandlers 默认调它 */
export function createAppContext(options: AppContextOptions = {}): AppContext {
  const baseDir = app.getPath('userData')
  const projects = new ProjectStore(baseDir)
  const tasks = new TaskStore(baseDir)
  // 应用重启后 PTY 已死：历史 running 一律归位 stopped
  tasks.normalizeOnStartup()

  const smokeReports: string[] = []
  const broadcastTaskUpdate = (record: TaskRecord): void => {
    broadcast(IpcChannels.TaskUpdate, record)
    options.onTaskUpdate?.(record) // v0.5⑥ 托盘 tooltip 运行数刷新旁路
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

  // v0.5④N webhook 推送：配置 userData/notify.json（URL 属凭据仅存本地）；推送文案带任务显示名
  const notify = new NotifyService({
    file: join(baseDir, 'notify.json'),
    taskNameOf: (taskId) => tasks.get(taskId)?.name
  })

  const appSettings = new AppSettingsStore(settingsFile)
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

  // v0.5③ skill 管理（只读扫描用户级+项目级；移除走回收站+realpath 归属校验）
  const skills = new SkillsStore({ projects: () => projects.list() })

  // v0.5③ CLI 命令执行器：独立隐藏 PTY，输出仅走 cwb:event:cli-output（不进 PtyData/noteBytes）
  const cli = new CliRunner({
    onData: (event: CliOutputEvent) => broadcast(IpcChannels.CliOutput, event),
    onExit: (commandId, exitCode) =>
      broadcast(IpcChannels.CliOutput, { commandId, type: 'exit', exitCode })
  })

  async function addProject(dir: string): Promise<ProjectRecord> {
    return projects.add(dir, isGitRepo(dir))
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
    appSettings
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
  // v0.5③ skills（SkillInfo 归 renderer 弹窗消费；removeSkill 的归属校验在 main）
  ipcMain.handle(IpcChannels.SkillsList, () => ctx.skills.list())
  ipcMain.handle(
    IpcChannels.SkillsImport,
    (_e, fromDir: string, target: { scope: 'user' | 'project'; projectId?: string }) =>
      ctx.skills.importSkillFolder(fromDir, target)
  )
  ipcMain.handle(IpcChannels.SkillsRemove, (_e, skill: SkillInfo) => ctx.skills.removeSkill(skill))
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
