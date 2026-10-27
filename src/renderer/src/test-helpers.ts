import { vi } from 'vitest'
import type {
  AppSettings,
  AppUpdateProgressEvent,
  CliOutputEvent,
  CreateTaskOptions,
  CWBApi,
  NotifyConfig,
  ProjectRecord,
  PtyDataEvent,
  SkillInfo,
  TaskActivityEvent,
  TaskRecord,
  TaskUpdateEvent
} from '../../shared/types'

let idCounter = 0

export function makeProject(p: Partial<ProjectRecord> = {}): ProjectRecord {
  idCounter += 1
  const now = new Date().toISOString()
  return {
    id: p.id ?? `p-${idCounter}`,
    name: p.name ?? `项目${idCounter}`,
    dir: p.dir ?? `D:\\proj-${idCounter}`,
    isGit: p.isGit ?? true,
    createdAt: p.createdAt ?? now
  }
}

export function makeTask(t: Partial<TaskRecord> = {}): TaskRecord {
  idCounter += 1
  const now = new Date().toISOString()
  const id = t.id ?? `t-${idCounter}`
  return {
    id,
    projectId: t.projectId ?? 'p-1',
    name: t.name ?? `任务${idCounter}`,
    sessionId: id,
    cwd: t.cwd ?? 'D:\\proj-1',
    worktreePath: t.worktreePath,
    ...(t.skipPermissions ? { skipPermissions: true } : {}),
    status: t.status ?? 'stopped',
    createdAt: t.createdAt ?? now,
    lastActiveAt: t.lastActiveAt ?? now
  }
}

export type CwbApiMock = CWBApi & {
  /** 捕获的 onPtyData 回调（App mount 后由 initListeners 注册） */
  ptyCallbacks: Array<(e: PtyDataEvent) => void>
  /** 捕获的 onTaskUpdate 回调 */
  taskUpdateCallbacks: Array<(t: TaskUpdateEvent) => void>
  /** 捕获的 onTaskActivity 回调（v3.2） */
  activityCallbacks: Array<(e: TaskActivityEvent) => void>
  /** 捕获的 onCliOutput 回调（v0.5③：CliOutputView 订阅；测试注入输出事件用） */
  cliOutputCallbacks: Array<(e: CliOutputEvent) => void>
  /** 捕获的 onAppUpdateProgress 回调（v1.1.0：设置中心订阅；注入下载进度用） */
  appUpdateProgressCallbacks: Array<(e: AppUpdateProgressEvent) => void>
  /** onPtyData 返回的退订函数（unmount 时应被调用） */
  ptyDisposer: ReturnType<typeof vi.fn>
  /** onTaskUpdate 返回的退订函数 */
  taskDisposer: ReturnType<typeof vi.fn>
  /** onTaskActivity 返回的退订函数（v3.2） */
  activityDisposer: ReturnType<typeof vi.fn>
  /** onCliOutput 返回的退订函数（v0.5③） */
  cliOutputDisposer: ReturnType<typeof vi.fn>
}

/** 安装 window.cwb 全量 mock（18 法），返回带回调捕获与退订句柄的 mock */
export function installCwbMock(opts: { projects?: ProjectRecord[]; tasks?: TaskRecord[] } = {}): CwbApiMock {
  const projects = opts.projects ?? []
  const tasks = opts.tasks ?? []
  const ptyCallbacks: Array<(e: PtyDataEvent) => void> = []
  const taskUpdateCallbacks: Array<(t: TaskUpdateEvent) => void> = []
  const activityCallbacks: Array<(e: TaskActivityEvent) => void> = []
  const ptyDisposer = vi.fn()
  const cliOutputCallbacks: Array<(e: CliOutputEvent) => void> = []
  const appUpdateProgressCallbacks: Array<(e: AppUpdateProgressEvent) => void> = []
  const cliOutputDisposer = vi.fn()
  const taskDisposer = vi.fn()
  const activityDisposer = vi.fn()

  const api: CwbApiMock = {
    ptyCallbacks,
    taskUpdateCallbacks,
    activityCallbacks,
    cliOutputCallbacks,
    appUpdateProgressCallbacks,
    ptyDisposer,
    taskDisposer,
    activityDisposer,
    cliOutputDisposer,
    listProjects: vi.fn(async () => projects),
    addProject: vi.fn(async (dir: string) => makeProject({ dir, isGit: true })),
    removeProject: vi.fn(async (_id: string) => {}),
    renameProject: vi.fn(async (id: string, name: string) => makeProject({ id, name })),
    listTasks: vi.fn(async () => tasks),
    createTask: vi.fn(async (projectId: string, name: string, o: CreateTaskOptions) =>
      makeTask({
        projectId,
        name,
        status: 'running',
        worktreePath: o.isolation === 'worktree' ? 'D:\\cwb-worktrees\\wt' : undefined,
        ...(o.skipPermissions ? { skipPermissions: true } : {})
      })
    ),
    // 返回记录保留原任务的 projectId/name 等字段（真实 API 返回完整记录；
    // S6 起侧栏「最近」区块按 projectId 关联项目，孤儿记录会污染断言）
    resumeTask: vi.fn(async (taskId: string) => {
      const orig = tasks.find((x) => x.id === taskId)
      return makeTask({ ...orig, id: taskId, status: 'running' })
    }),
    stopTask: vi.fn(async (_taskId: string) => {}),
    removeTask: vi.fn(async (_taskId: string, _opts: { deleteWorktree: boolean }) => {}),
    renameTask: vi.fn(async (taskId: string, name: string) => {
      const orig = tasks.find((x) => x.id === taskId)
      return makeTask({ ...orig, id: taskId, name })
    }),
    setTaskSkipPermissions: vi.fn(async (taskId: string, on: boolean) => {
      // 关闭时须显式剔除原 flag（spread 不会移除既有字段）
      const { skipPermissions: _prev, ...orig } = tasks.find((x) => x.id === taskId) ?? {}
      return makeTask({ ...orig, id: taskId, ...(on ? { skipPermissions: true } : {}) })
    }),
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
    onPtyData: vi.fn((cb: (e: PtyDataEvent) => void) => {
      ptyCallbacks.push(cb)
      return ptyDisposer
    }),
    onTaskUpdate: vi.fn((cb: (t: TaskUpdateEvent) => void) => {
      taskUpdateCallbacks.push(cb)
      return taskDisposer
    }),
    onTaskActivity: vi.fn((cb: (e: TaskActivityEvent) => void) => {
      activityCallbacks.push(cb)
      return activityDisposer
    }),
    pickDirectory: vi.fn(async () => null),
    importTasksFromSessions: vi.fn(async () => [] as TaskRecord[]),
    getInstalledMonoFonts: vi.fn(async () => ['Cascadia Mono', 'Consolas', 'SimSun-ExtB'] as string[]),
    // v1.0.8 外部链接出口（终端链接 → 系统浏览器；具体用例可覆写断言白名单行为）
    openExternal: vi.fn(async () => true),
    // v1.1.0 应用自更新（默认已是最新+空说明；具体用例可覆写）
    checkAppUpdate: vi.fn(async () => ({
      current: '1.1.0',
      latest: '1.1.0',
      upToDate: true,
      notes: []
    })),
    downloadAppUpdate: vi.fn(async () => ({ ok: true })),
    installAppUpdate: vi.fn(async () => ({ ok: true })),
    onAppUpdateProgress: vi.fn((cb: (e: AppUpdateProgressEvent) => void) => {
      appUpdateProgressCallbacks.push(cb)
      return () => {}
    }),
    // v1.1.0 claude CLI 更新说明（默认空；CLI 检查更新用例覆写）
    getClaudeChangelog: vi.fn(async () => ({ notes: [], error: undefined })),
    getAppSettings: vi.fn(async () => ({ closeToTray: true, launchAtLogin: false } as AppSettings)),
    setAppSettings: vi.fn(async (patch: Partial<AppSettings>) => ({ closeToTray: true, launchAtLogin: false, ...patch } as AppSettings)),
    // v0.5 契约第 19-30 法 mock（骨架默认；具体用例可 vi.mocked 覆写返回值）
    listSkills: vi.fn(async () => [] as SkillInfo[]),
    importSkillFolder: vi.fn(async () => {
      throw new Error('NotImplemented（测试中覆写）')
    }),
    removeSkill: vi.fn(async () => {}),
    runCliCommand: vi.fn(async () => ({ commandId: 'cmd-test' })),
    onCliOutput: vi.fn((cb: (e: CliOutputEvent) => void) => {
      cliOutputCallbacks.push(cb)
      return cliOutputDisposer
    }),
    killCliCommand: vi.fn(),
    // 路径须转义反斜杠（'C:\claude.cmd' 的 \c 会被吞成 'C:claude.cmd'，失真）
    getClaudeVersionInfo: vi.fn(async () => ({ version: '2.1.301', path: 'C:\\claude.cmd' })),
    checkClaudeUpdate: vi.fn(async () => ({ current: '2.1.301', latest: '2.1.304', upToDate: false })),
    installClaudeCli: vi.fn(async () => ({ commandId: 'install-test' })),
    getNotifyConfig: vi.fn(async () => ({ url: '', enabled: false, channel: 'wecom' } as NotifyConfig)),
    setNotifyWebhook: vi.fn(async (url: string, enabled: boolean) => ({ url, enabled, channel: 'wecom' } as NotifyConfig)),
    sendTestNotify: vi.fn(async () => ({ ok: true })),
    reportSmoke: vi.fn()
  }

  window.cwb = api
  return api
}
