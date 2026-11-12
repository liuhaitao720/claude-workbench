import { vi } from 'vitest'
import type { ConnectionTestResult,
  AppSettings,
  AppUpdateProgressEvent,
  CliOutputEvent,
  ConnectionRecord,
  ConnectionStateChangedEvent,
  CreateTaskOptions,
  CWBApi,
  NotifyConfig,
  ProjectRecord,
  ProviderConfig,
  PtyDataEvent,
  RemoteProxyConfig,
  RemoteServerLogEvent,
  ReviewHintEvent,
  SkillInfo,
  SshClosedEvent,
  SshDataEvent,
  SkillMarketEntry,
  SkillMarketplaceInfo,
  TaskActivityEvent,
  TaskRecord,
  TaskUpdateEvent,
  TransferItem
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
    // S6（7.1）：远程项目归属连接档案 id——显式传入才落键（本地项目保持无键）
    ...(p.connectionId ? { connectionId: p.connectionId } : {}),
    createdAt: p.createdAt ?? now
  }
}

/** S6：SSH 连接档案测试工厂（字段缺省值=典型 VMware NAT 场景） */
export function makeConnection(c: Partial<ConnectionRecord> = {}): ConnectionRecord {
  idCounter += 1
  const now = new Date().toISOString()
  return {
    id: c.id ?? `c-${idCounter}`,
    name: c.name ?? `服务器${idCounter}`,
    host: c.host ?? '192.168.80.128',
    port: c.port ?? 22,
    user: c.user ?? 'dev',
    authMethod: c.authMethod ?? 'key',
    ...(c.keyPath !== undefined ? { keyPath: c.keyPath } : {}),
    ...(c.passwordEncrypted !== undefined
      ? { passwordEncrypted: c.passwordEncrypted }
      : {}),
    ...(c.lastHostKeyFingerprint !== undefined
      ? { lastHostKeyFingerprint: c.lastHostKeyFingerprint }
      : {}),
    createdAt: c.createdAt ?? now
  }
}

/**
 * S2 testConnection 返回超集（TestConnectionOutcome：kind/hostKeyFingerprint/checks；
 * shared 契约面仍是 {ok,error}，mock 侧先行宽类型——与真实 handler 输出同形）。
 */
export type ConnTestResultMock = ConnectionTestResult

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
    lastActiveAt: t.lastActiveAt ?? now,
    // v1.4：透传任务级 provider/model（Partial 里给什么带什么——undefined 不落键）
    ...(t.providerId !== undefined && t.providerId !== '' ? { providerId: t.providerId } : {}),
    ...(t.model !== undefined && t.model !== '' ? { model: t.model } : {}),
    ...(t.modelMode === 'auto' ? { modelMode: 'auto' as const } : {})
  }
}

/**
 * CwbApiMock：CWBApi 全量 mock + 回调捕获数组。addProject 在 S6 起接受可选
 * connectionId（远程项目注册流；真实契约扩展归 S5——见 store.ts 的接线桩注释），
 * 故以 Omit 重组类型放宽该签名。
 */
export type CwbApiMock = Omit<CWBApi, 'addProject' | 'testConnection'> & {
  /** 远程项目注册（第二参=连接档案 id；S6 mock 侧支持，真实 main 侧由 S5 接线） */
  addProject: (dir: string, connectionId?: string) => Promise<ProjectRecord>
  /** 只读连通测试（S2 超集：kind/fingerprint/checks 结构化自检清单） */
  testConnection: (id: string) => Promise<ConnTestResultMock>
  /** 捕获的 onPtyData 回调（App mount 后由 initListeners 注册） */
  ptyCallbacks: Array<(e: PtyDataEvent) => void>
  /** v2.0 捕获的 onTransfersProgress 回调（测试注入进度用） */
  transfersProgressCallbacks: Array<(items: TransferItem[]) => void>
  /** v2.0.1 捕获的 onNotifyTrail 回调（通知留痕事件） */
  notifyTrailCallbacks: Array<(e: never) => void>
  /** 捕获的 onTaskUpdate 回调 */
  taskUpdateCallbacks: Array<(t: TaskUpdateEvent) => void>
  /** 捕获的 onTaskActivity 回调（v3.2） */
  activityCallbacks: Array<(e: TaskActivityEvent) => void>
  /** 捕获的 onCliOutput 回调（v0.5③：CliOutputView 订阅；测试注入输出事件用） */
  cliOutputCallbacks: Array<(e: CliOutputEvent) => void>
  /** 捕获的 onAppUpdateProgress 回调（v1.1.0：设置中心订阅；注入下载进度用） */
  appUpdateProgressCallbacks: Array<(e: AppUpdateProgressEvent) => void>
  /** 捕获的 onConnectionState 回调（S6：initListeners 注册；注入连接状态迁移用） */
  connectionStateCallbacks: Array<(e: ConnectionStateChangedEvent) => void>
  /** 捕获的 onRemoteServerLog 回调（S6：安装弹窗进度/环形日志用） */
  remoteServerLogCallbacks: Array<(e: RemoteServerLogEvent) => void>
  /** onPtyData 返回的退订函数（unmount 时应被调用） */
  ptyDisposer: ReturnType<typeof vi.fn>
  /** onTaskUpdate 返回的退订函数 */
  taskDisposer: ReturnType<typeof vi.fn>
  /** onTaskActivity 返回的退订函数（v3.2） */
  activityDisposer: ReturnType<typeof vi.fn>
  /** onCliOutput 返回的退订函数（v0.5③） */
  cliOutputDisposer: ReturnType<typeof vi.fn>
  /** onConnectionState 返回的退订函数（S6） */
  connectionStateDisposer: ReturnType<typeof vi.fn>
  /** onRemoteServerLog 返回的退订函数（S6） */
  remoteServerLogDisposer: ReturnType<typeof vi.fn>
}

/** 安装 window.cwb 全量 mock，返回带回调捕获与退订句柄的 mock。
 *  v1.4：providers/defaultProviderId 预置模型服务档案（loadAll mount 即拉取——
 *  事后覆写 mock 来不及，必须经 opts 在 render 前注入）。
 *  S6：connections/appSettings 同理预置（侧栏分组树与持久化键消费）。 */
const transfersProgressCbs: Array<(items: TransferItem[]) => void> = []
const notifyTrailCbs: Array<(e: never) => void> = []
/** v2.1.0 SSH 纯终端回调捕获 */
const sshDataCallbacks: Array<(e: SshDataEvent) => void> = []
const sshClosedCallbacks: Array<(e: SshClosedEvent) => void> = []

export function installCwbMock(
  opts: {
    projects?: ProjectRecord[]
    tasks?: TaskRecord[]
    providers?: ProviderConfig[]
    defaultProviderId?: string
    /** S6：连接档案（侧栏服务器节点/注册对话框数据源） */
    connections?: ConnectionRecord[]
    /** S6：getAppSettings 返回的持久化键（sidebarWidth 等；与默认值浅合并） */
    appSettings?: Partial<AppSettings>
  } = {}
): CwbApiMock {
  const projects = opts.projects ?? []
  const tasks = opts.tasks ?? []
  const connections = opts.connections ?? []
  const presetSettings = opts.appSettings ?? {}
  const ptyCallbacks: Array<(e: PtyDataEvent) => void> = []
  const taskUpdateCallbacks: Array<(t: TaskUpdateEvent) => void> = []
  const activityCallbacks: Array<(e: TaskActivityEvent) => void> = []
  const ptyDisposer = vi.fn()
  const cliOutputCallbacks: Array<(e: CliOutputEvent) => void> = []
  const appUpdateProgressCallbacks: Array<(e: AppUpdateProgressEvent) => void> = []
  const connectionStateCallbacks: Array<(e: ConnectionStateChangedEvent) => void> = []
  const remoteServerLogCallbacks: Array<(e: RemoteServerLogEvent) => void> = []
  const cliOutputDisposer = vi.fn()
  const taskDisposer = vi.fn()
  const activityDisposer = vi.fn()
  const connectionStateDisposer = vi.fn()
  const remoteServerLogDisposer = vi.fn()

  const api: CwbApiMock = {
    // v1.3：CWBApi 新增 platform——mock 钉死 'win32'（组件按平台分支的行为在
    // 测试里保持 Windows 语义，跨平台分支由 platform.test.ts 单测覆盖）
    platform: 'win32',
    ptyCallbacks,
    taskUpdateCallbacks,
    activityCallbacks,
    cliOutputCallbacks,
    appUpdateProgressCallbacks,
    connectionStateCallbacks,
    remoteServerLogCallbacks,
    ptyDisposer,
    taskDisposer,
    activityDisposer,
    cliOutputDisposer,
    connectionStateDisposer,
    remoteServerLogDisposer,
    listProjects: vi.fn(async () => projects),
    // S6：第二可选参 connectionId——远程项目注册（返回记录带 connectionId/isGit 检测）
    addProject: vi.fn(async (dir: string, connectionId?: string) => {
      const base = makeProject({ dir, isGit: true })
      return connectionId !== undefined && connectionId !== ''
        ? { ...base, connectionId }
        : base
    }),
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
    getAppSettings: vi.fn(async () =>
      ({ closeToTray: true, launchAtLogin: false, ...presetSettings } as AppSettings)
    ),
    setAppSettings: vi.fn(async (patch: Partial<AppSettings>) =>
      ({ closeToTray: true, launchAtLogin: false, ...patch } as AppSettings)
    ),
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
    // v1.4 模型服务 provider（默认空注册表；具体用例经 installCwbMock opts 或 vi.mocked 覆写）
    listProviders: vi.fn(async () => ({
      providers: opts.providers ?? [],
      ...(opts.defaultProviderId !== undefined ? { defaultProviderId: opts.defaultProviderId } : {})
    })),
    saveProvider: vi.fn(async (p: ProviderConfig) => p),
    removeProvider: vi.fn(async () => {}),
    setDefaultProvider: vi.fn(async () => {}),
    probeProviderModels: vi.fn(async (_id: string) => ({ ok: true, models: ['glm-4.6'] })),
    setTaskProvider: vi.fn(async (_taskId: string, opts: { providerId?: string; model?: string }) =>
      makeTask({ providerId: opts.providerId, model: opts.model })
    ),
    // v1.4 本地代理（默认停止态；状态卡用例覆写）
    getProxyStatus: vi.fn(async () => ({ running: false, stats: { total: 0, active: 0, direct: 0, viaProxy: 0 } })),
    startProxy: vi.fn(async () => ({
      running: true,
      port: 12700,
      startedAt: '2026-11-05T10:00:00.000Z',
      stats: { total: 0, active: 0, direct: 0, viaProxy: 0 }
    })),
    stopProxy: vi.fn(async () => ({ running: false, stats: { total: 0, active: 0, direct: 0, viaProxy: 0 } })),
    // v1.2.0 skill 市场（默认空结果；SkillsDialog 在线搜索用例覆写）
    searchSkillMarket: vi.fn(async () => [] as SkillMarketEntry[]),
    listSkillMarketplaces: vi.fn(async () => [] as SkillMarketplaceInfo[]),
    installMarketSkill: vi.fn(async () => ({ ok: true, commandId: 'skill-install-test' })),
    refreshSkillMarket: vi.fn(async () => ({ ok: true, commandId: 'skill-refresh-test' })),
    // v1.2.1 插件 skill 启用/停用（默认成功；用例可覆写断言）
    setSkillPluginEnabled: vi.fn(async (_pluginId: string, _enabled: boolean) => ({
      ok: true,
      commandId: 'skill-plugin-toggle-test'
    })),
    // SSH 远程连接（S1 批0 桩 + S6 起注入真实 mock 行为，mock 驱动开发）：
    // 档案/状态订阅/浏览可用；installRemoteServer 留 NotImplemented 默认（成功路径
    // 按用例覆写）；testConnection=S2 超集默认全通过清单（server=unknown 不阻断）
    listConnections: vi.fn(async () => connections),
    saveConnection: vi.fn(async (connection: ConnectionRecord) =>
      connection.id === '' ? makeConnection({ ...connection, id: undefined }) : connection
    ),
    removeConnection: vi.fn(async (_id: string) => {}),
    testConnection: vi.fn(
      async (_id: string): Promise<ConnTestResultMock> => ({
        ok: true,
        hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        checks: [
          { id: 'sshd', status: 'ok' },
          { id: 'claude', status: 'ok', detail: '2.1.301' },
          { id: 'node', status: 'ok', detail: 'v22.14.0' },
          { id: 'server', status: 'unknown' }
        ]
      })
    ),
    connectConnection: vi.fn(async (_id: string) => {}),
    disconnectConnection: vi.fn(async (_id: string) => {}),
    browseRemoteDir: vi.fn(async (_connectionId: string, path?: string) => ({
      ok: true as const,
      path: path ?? '/home/dev',
      entries: [
        { name: 'projects', isDir: true },
        { name: 'README.md', isDir: false }
      ]
    })),
    installRemoteServer: vi.fn(async () => ({ ok: false, error: 'NotImplemented（测试中覆写）' })),
    onConnectionState: vi.fn((cb: (e: ConnectionStateChangedEvent) => void) => {
      connectionStateCallbacks.push(cb)
      return connectionStateDisposer
    }),
    onRemoteServerLog: vi.fn((cb: (e: RemoteServerLogEvent) => void) => {
      remoteServerLogCallbacks.push(cb)
      return remoteServerLogDisposer
    }),
    getRemoteProxyStatus: vi.fn(async () => ({
      running: false,
      stats: { total: 0, active: 0, direct: 0, viaProxy: 0 }
    })),
    setRemoteProxyConfig: vi.fn(async (_id: string, patch: Partial<RemoteProxyConfig>) => ({
      ...patch
    })),
    startRemoteProxy: vi.fn(async () => ({
      running: true,
      port: 12700,
      stats: { total: 0, active: 0, direct: 0, viaProxy: 0 }
    })),
    stopRemoteProxy: vi.fn(async () => ({
      running: false,
      stats: { total: 0, active: 0, direct: 0, viaProxy: 0 }
    })),
    copyProvider: vi.fn(
      async (
        _source: { kind: 'local' } | { kind: 'remote'; id: string },
        _target: { kind: 'local' } | { kind: 'remote'; id: string },
        _providerId: string
      ): Promise<ProviderConfig> => ({
        id: 'copied-1',
        name: 'copied',
        format: 'anthropic',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-x',
        models: []
      })
    ),
    listRemoteFiles: vi.fn(async () => ({ ok: true, path: '/home/dev', entries: [] })),
    mkdirRemote: vi.fn(async () => undefined),
    renameRemote: vi.fn(async () => undefined),
    deleteRemote: vi.fn(async () => undefined),
    peekRemoteFile: vi.fn(async () => '/tmp/peek.txt'),
    pickLocalForUpload: vi.fn(async () => null),
    uploadRemoteFiles: vi.fn(async () => ({ items: [], conflicts: [] })),
    downloadRemoteFile: vi.fn(async () => null),
    listTransfers: vi.fn(async () => []),
    cancelTransfer: vi.fn(async () => undefined),
    retryTransfer: vi.fn(async () => undefined),
    transfersProgressCallbacks: transfersProgressCbs,
    notifyTrailCallbacks: notifyTrailCbs,
    getNotifyTrail: vi.fn(async () => ({ trail: [], localEnabled: true })),
    onNotifyTrail: vi.fn((cb: (e: never) => void) => {
      notifyTrailCbs.push(cb)
      return () => {}
    }),
    onTransfersProgress: vi.fn((cb: (items: TransferItem[]) => void) => {
      transfersProgressCbs.push(cb)
      return () => {}
    }),
    getPathForFile: vi.fn(() => undefined),
    openLocalPath: vi.fn(async () => ({ ok: true })),
    // v2.0.2 git diff 审查（默认空清单；用例经 vi.mocked 覆写）
    listDiff: vi.fn(async () => ({ base: 'HEAD' as const, files: [] })),
    diffFile: vi.fn(async () => ({
      path: '',
      status: 'M' as const,
      binary: false,
      truncated: false,
      hunks: []
    })),
    onReviewHint: vi.fn((_cb: (e: ReviewHintEvent) => void) => () => {}),
    // v2.1.0 SSH 纯终端（回调捕获数组同先例；默认 open 成功）
    openSshShell: vi.fn(async () => ({ ok: true })),
    writeSshShell: vi.fn(),
    resizeSshShell: vi.fn(),
    closeSshShell: vi.fn(async () => {}),
    onSshData: vi.fn((cb: (e: SshDataEvent) => void) => {
      sshDataCallbacks.push(cb)
      return () => {}
    }),
    onSshClosed: vi.fn((cb: (e: SshClosedEvent) => void) => {
      sshClosedCallbacks.push(cb)
      return () => {}
    }),
    reportSmoke: vi.fn()
  }

  window.cwb = api
  return api
}
