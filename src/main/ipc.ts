import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { EVENT_CHANNELS, IpcChannels } from '../shared/ipc-channels'
import { translate } from '../shared/i18n'
import type {
  AppSettings,
  CliOutputEvent,
  ConnectionStateChangedEvent,
  CreateTaskOptions,
  NotifyConfig,
  ProjectRecord,
  ProviderConfig,
  ProviderRegistryState,
  PtyDataEvent,
  RemoteProxyConfig,
  RemoteProxyStatus,
  RemoteServerLogEvent,
  RemoveTaskOptions,
  SkillInfo,
  TaskActivityEvent,
  TaskRecord
} from '../shared/types'
import { checkClaudeUpdate, fetchClaudeChangelog, getClaudeVersionInfo, installClaudeCli } from './claude-version'
import { AppUpdater } from './app-updater'
import {
  CliRunner,
  checkClaudeUpdateRemote,
  installClaudeCliRemote,
  posixQuote,
  remoteClaudeVersion
} from './cli-runner'
import { isGitRepo, worktreeAdd, worktreeRemove } from './isolation'
import { countLiveRunningTasks } from './running-count'
import { AppSettingsStore } from './settings-store'
import { FontScanner } from './font-scan'
import { NotifyService } from './notify'
import { ProjectStore } from './project-store'
import { ProviderStore } from './providers-store'
import {
  probeRemoteModels,
  readRemoteProviders,
  removeRemoteProvider,
  saveRemoteProvider,
  setRemoteDefault
} from './remote-providers'
import { readRemoteNotify, writeRemoteNotify } from './remote-notify'
import { importRemoteSkillFolder, removeRemoteSkill } from './remote-skills'
import { createModelsProbe, type ModelsProbeResult } from './provider-models'
import { createLocalProxy, type LocalProxyHandle } from './local-proxy'
import { mainLanguage, setMainLanguage } from './language'
import { PtyManager, buildNewSessionArgs, buildResumeArgs } from './pty-manager'
import type { PtyBackend } from './pty-backend'
import { RemotePtyHub } from './remote-pty'
import {
  createRemoteSessionReader,
  importTasksFromSessionsImpl,
  type ListSessionsOptions
} from './session-import'
import { SkillsStore } from './skills-store'
import { PluginSkills, isValidPluginId, openRemoteClaudeHome } from './plugin-skills'
import { SkillMarket, validateInstallTarget } from './skill-market'
import { startTaskActivityServer, type TaskActivityHandle } from './task-activity'
import { TaskStore } from './task-store'
import { StubConnectionManager, type ConnectionManager } from './ssh/connection-manager'
import {
  ConnectionsStore,
  connectionMessage,
  electronSafeStorage,
  parseConnectionInput
} from './connections-store'
import { testConnectionRecord } from './ssh/test-connection'
import { ConnectionError } from './ssh/errors'
import { browseRemoteDir } from './ssh/manager'
import { ensureServer } from './server-installer'

/** main→renderer 推送：广播到全部窗口 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * SSH 远程模式事件外发（S1 挂钩，A2 权属）：
 * - ConnectionStateChanged 由 S2 唯一产生（ConnectionManager.onStateChange →
 *   broadcastConnectionState → EVENT 广播；S6 侧栏消费）；
 * - RemoteServerLog 由 S4 桥接 server.log 帧产生（S2 连接层日志同路）。
 * EVENT_CHANNELS 常量驱动成员校验：通道必须登记在 EVENT 契约全集内
 * （防手滑外发到 HANDLE/SEND 通道）。
 */
const BROADCAST_EVENT_CHANNELS: ReadonlySet<string> = new Set(EVENT_CHANNELS)

function broadcastEvent(channel: string, payload: unknown): void {
  if (!BROADCAST_EVENT_CHANNELS.has(channel)) {
    throw new Error(`broadcastEvent: ${channel} 不在 EVENT_CHANNELS 契约全集内`)
  }
  broadcast(channel, payload)
}

/** 连接状态变迁 → cwb:event:connection-state-changed【S2 唯一产生 / S6 消费】 */
export function broadcastConnectionState(e: ConnectionStateChangedEvent): void {
  broadcastEvent(IpcChannels.ConnectionStateChanged, e)
}

/** 远程 server 日志 → cwb:event:remote-server-log【S4 桥接（S2 连接层同路）/ S6 消费】 */
/**
 * v1.7.0 远程通知配置缓存（模块级：createAppContext 触发分流与 registerIpcHandlers
 * 写穿失效共用）。v1.7.7：加 60s TTL——配置可在 VM 侧直接编辑（如运维排障），
 * 仅靠 App 内保存写穿失效会让客户端无限期持有旧值（实测：VM 侧启用后推送仍不触
 * 发，根因即此）。TTL 过期后下次 awaiting 事件重读。
 */
const remoteNotifyCache = new Map<string, { cfg: NotifyConfig | null; at: number }>()
const REMOTE_NOTIFY_CACHE_TTL_MS = 60_000

export function broadcastRemoteServerLog(e: RemoteServerLogEvent): void {
  broadcastEvent(IpcChannels.RemoteServerLog, e)
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
 * v1.4 provider 入参校验（IPC 边界，纯函数单测覆盖）：unknown → 归一化 ProviderConfig，
 * 非法拒绝抛带 i18n 文案 Error（renderer catch 后直接展示）。
 * 归一化：name/models 逐项 trim、baseUrl 去尾斜杠、models 上限 50 项。
 * apiKey 允许空串（内网免鉴权网关合法形态）；id 空串=新增语义（save 分配 uuid）。
 */
export function validateProviderInput(lang: 'zh' | 'en', raw: unknown): ProviderConfig {
  const t = (key: Parameters<typeof translate>[1]): string => translate(lang, key)
  if (typeof raw !== 'object' || raw === null) throw new Error(t('provider.errShape'))
  const o = raw as Record<string, unknown>

  const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
  if (name === '' || name.length > 64) throw new Error(t('provider.errName'))

  if (o['format'] !== 'anthropic' && o['format'] !== 'openai') throw new Error(t('provider.errFormat'))

  const rawUrl = typeof o['baseUrl'] === 'string' ? o['baseUrl'].trim() : ''
  if (!isSafeExternalUrl(rawUrl) || rawUrl.length > 512) throw new Error(t('provider.errBaseUrl'))
  const baseUrl = rawUrl.replace(/\/+$/, '')

  const apiKey = typeof o['apiKey'] === 'string' ? o['apiKey'] : ''
  if (apiKey.length > 512) throw new Error(t('provider.errShape'))
  const apiKeyType = o['apiKeyType'] === undefined ? undefined : o['apiKeyType']
  if (apiKeyType !== undefined && apiKeyType !== 'auth_token' && apiKeyType !== 'api_key') {
    throw new Error(t('provider.errShape'))
  }

  let models: string[] = []
  if (o['models'] !== undefined) {
    if (!Array.isArray(o['models']) || o['models'].length > 50) throw new Error(t('provider.errModels'))
    models = (o['models'] as unknown[]).map((m) => (typeof m === 'string' ? m.trim() : ''))
    if (models.some((m) => m === '' || m.length > 128)) throw new Error(t('provider.errModels'))
  }
  // v1.4.1 1M 声明（可选；字符串数组，归一为 models 内子集去重）
  let models1M: string[] | undefined
  if (o['models1M'] !== undefined) {
    if (!Array.isArray(o['models1M'])) throw new Error(t('provider.errModels'))
    const declared = (o['models1M'] as unknown[])
      .map((m) => (typeof m === 'string' ? m.trim() : ''))
      .filter((m) => m !== '' && m.length <= 128 && models.includes(m))
    models1M = [...new Set(declared)]
  }
  let defaultModel: string | undefined
  if (o['defaultModel'] !== undefined) {
    if (typeof o['defaultModel'] !== 'string' || o['defaultModel'].length > 128) {
      throw new Error(t('provider.errShape'))
    }
    defaultModel = o['defaultModel'].trim() || undefined
  }

  const id = typeof o['id'] === 'string' ? o['id'] : ''
  if (id.length > 64) throw new Error(t('provider.errShape'))

  // v1.4 档位映射（可选；对象且值为 ≤128 字符字符串，空白归一为未设置）
  let slotModels: ProviderConfig['slotModels'] | undefined
  if (o['slotModels'] !== undefined) {
    if (typeof o['slotModels'] !== 'object' || o['slotModels'] === null) {
      throw new Error(t('provider.errSlots'))
    }
    const raw = o['slotModels'] as Record<string, unknown>
    const slots: NonNullable<ProviderConfig['slotModels']> = {}
    let any = false
    for (const key of ['sonnet', 'opus', 'fable', 'haiku'] as const) {
      const v = raw[key]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.trim().length > 128) throw new Error(t('provider.errSlots'))
      const trimmed = v.trim()
      if (trimmed !== '') {
        slots[key] = trimmed
        any = true
      }
    }
    if (any) slotModels = slots
  }

  // v1.4 网络代理（可选；非空须为 http(s) URL）
  let proxyUrl: string | undefined
  if (o['proxyUrl'] !== undefined) {
    if (typeof o['proxyUrl'] !== 'string') throw new Error(t('provider.errProxy'))
    proxyUrl = o['proxyUrl'].trim() || undefined
    if (proxyUrl !== undefined && (!isSafeExternalUrl(proxyUrl) || proxyUrl.length > 512)) {
      throw new Error(t('provider.errProxy'))
    }
  }

  return {
    id,
    name,
    format: o['format'],
    baseUrl,
    apiKey,
    ...(apiKeyType !== undefined ? { apiKeyType } : {}),
    models,
    ...(models1M !== undefined && models1M.length > 0 ? { models1M } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(slotModels !== undefined ? { slotModels } : {}),
    ...(proxyUrl !== undefined ? { proxyUrl } : {})
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
  /**
   * PTY 后端（S4 路由）：按 task→project.connectionId 分派 Local（PtyManager）/
   * Remote（RemotePtyManager，经 RemotePtyHub per-connection 懒建）——renderer
   * 通道面零改动（4.1=A：PtyWrite/PtyResize 等经此自动路由）。
   */
  readonly pty: PtyBackend
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
  /**
   * 注册项目（S5 远程化 3.1=C/7.1）：connectionId 缺省=本机路径（行为逐字节不变）；
   * 非空=远程注册——已连接则远端存在性/git 检测（test -d）+ 立即会话导入，
   * 未连接则登记挂起（连接成功事件补跑，3.12=a）。
   */
  addProject(dir: string, connectionId?: string): Promise<ProjectRecord>
  removeProject(id: string): Promise<void>
  renameProject(id: string, name: string): Promise<ProjectRecord>
  createTask(projectId: string, name: string, opts: CreateTaskOptions): Promise<TaskRecord>
  resumeTask(taskId: string): Promise<TaskRecord>
  stopTask(taskId: string): Promise<void>
  removeTask(taskId: string, opts: RemoveTaskOptions): Promise<void>
  renameTask(taskId: string, name: string): Promise<TaskRecord>
  /** 切换"跳过权限确认"（v0.3.1 契约第 17 法）：仅元数据，下次 spawn 生效 */
  setTaskSkipPermissions(taskId: string, on: boolean): Promise<TaskRecord>
  /** v1.4 任务级 provider/model 事后修改：仅元数据，下次 spawn/resume 生效 */
  setTaskProvider(
    taskId: string,
    opts: { providerId?: string; model?: string; modelMode?: 'auto' | '' }
  ): Promise<TaskRecord>
  /** v1.4 模型列表探测（GET {baseUrl}/v1/models；官方端点经 provider 代理出口） */
  probeProviderModels(id: string): Promise<ModelsProbeResult>
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
  /** v1.4 模型服务 provider 档案（providers.json；createTask/resumeTask 解析注入 env） */
  readonly providers: ProviderStore
  /** v1.4 本地代理（纯隧道；运行期间任务 HTTP_PROXY 统一指向它，按端点域名路由） */
  readonly localProxy: LocalProxyHandle
  /** v1.4 provider 解析（任务 providerId > 默认 > 不注入）→ ANTHROPIC_* env；测试直接调用 */
  resolveProviderEnv: (providerId: string | undefined, model: string | undefined) => Record<string, string> | undefined
  /**
   * SSH 远程连接管理器（S1 批0 接线桩注入 StubConnectionManager 占位；
   * S2 以真实 ssh2 实现替换——A0=S1 桩+S2 实）。连接档案 CRUD/懒连接/断开/
   * exec/sftp/forwardOut/forwardIn 经它承载。
   */
  readonly connection: ConnectionManager
  /**
   * S4 远程 PTY 枢纽：per-connection RemotePtyManager（协议帧驱动的远程 PTY
   * 生命周期）+ hooks 反向转发接线（forwardIn→task-activity 接收端）+ 代理帧
   * 透传（proxy.* 三通道）+ 连接流程健康检查（needInstall 判定）。
   */
  readonly remotePty: RemotePtyHub
}

export interface AppContextOptions {
  /** PTY 输出旁路观察者（S4 smoke/recovery 编排用；在广播之外追加调用，不影响 broadcast 行为） */
  onPtyData?: (event: PtyDataEvent) => void
  /** 任务记录变更旁路（v0.5⑥ 托盘 tooltip 运行数刷新——同 onPtyData 注入缝先例） */
  onTaskUpdate?: (record: TaskRecord) => void
  /** v1.2.0 应用设置变更旁路（托盘菜单/退出确认文案随语言切换刷新） */
  onSettingsChange?: (settings: AppSettings) => void
  /**
   * SSH 远程连接管理器注入缝（S1 批0）：组合根（main.ts）传入；缺省=
   * StubConnectionManager 桩（全方法抛「S2 未实现」——registerIpcHandlers
   * 无参路径/测试可用，接线完整性先行）。
   */
  connection?: ConnectionManager
}

/** S4 远程任务 settings 落点（VM 侧；4.6=A 单轨——客户端构造+SFTP 写入） */
const REMOTE_SETTINGS_DIR = '.cwb-server/task-settings'

/**
 * S4 路由 PTY 后端：按 task→project.connectionId 分派 Local（PtyManager）/ Remote
 * （RemotePtyManager，hub per-connection 懒建）——4.1=A：renderer 通道面零改动
 * （PtyWrite/PtyResize/stopTask 等经 ctx.pty 自动路由）。
 *
 * spawn/spawnClaude 的远程分支不经此（createTask 时任务记录尚未落盘、且需 SFTP
 * 写 settings 的参数化路径——ipc 显式走 remotePtyHub.managerFor）；本类按已落盘
 * 记录路由（resume 后的 write/resize/kill 等全在记录存在后发生）。
 */
export class RoutingPtyManager implements PtyBackend {
  constructor(
    private readonly local: PtyBackend,
    private readonly hub: RemotePtyHub,
    private readonly connectionIdOf: (taskId: string) => string | undefined
  ) {}

  private backendFor(taskId: string): PtyBackend {
    const cid = this.connectionIdOf(taskId)
    return cid !== undefined ? this.hub.managerFor(cid) : this.local
  }

  async spawnClaude(
    taskId: string,
    claudeArgs: string[],
    cwd: string,
    providerEnv?: Record<string, string>
  ): Promise<void> {
    await this.backendFor(taskId).spawnClaude(taskId, claudeArgs, cwd, providerEnv)
  }

  spawn(
    taskId: string,
    file: string,
    args: string[],
    cwd: string,
    providerEnv?: Record<string, string>
  ): void {
    this.backendFor(taskId).spawn(taskId, file, args, cwd, providerEnv)
  }

  write(taskId: string, data: string): void {
    this.backendFor(taskId).write(taskId, data)
  }

  resize(taskId: string, cols: number, rows: number): void {
    this.backendFor(taskId).resize(taskId, cols, rows)
  }

  kill(taskId: string): void {
    this.backendFor(taskId).kill(taskId)
  }

  isRunning(taskId: string): boolean {
    return this.backendFor(taskId).isRunning(taskId)
  }

  pid(taskId: string): number | undefined {
    return this.backendFor(taskId).pid(taskId)
  }

  /**
   * 双语义分发（H2 契约）：Local=定点杀树（退出清理）；Remote=detach-only
   * （5.9=b server 保活，禁杀）——各自后端实现自己的语义。
   */
  killAllTrees(): void {
    this.local.killAllTrees()
    this.hub.detachAll()
  }

  currentSize(taskId: string): { cols: number; rows: number } | undefined {
    return this.backendFor(taskId).currentSize(taskId)
  }

  forget(taskId: string): void {
    this.backendFor(taskId).forget(taskId)
  }
}

/** 创建 app 上下文（含启动归一化 running→stopped）；registerIpcHandlers 默认调它 */
export function createAppContext(options: AppContextOptions = {}): AppContext {
  const baseDir = app.getPath('userData')
  const projects = new ProjectStore(baseDir)
  const tasks = new TaskStore(baseDir)
  // 应用重启归一：本地任务 PTY 已死 → stopped；远程任务不归一（5.9=b server 保活，
  // 保持 running 语义——重连后 5.6 自动恢复视图，M11 分流）
  tasks.normalizeOnStartup((t) => {
    const cid = projects.get(t.projectId)?.connectionId
    return cid !== undefined && cid !== ''
  })

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
   * 随 productName "SSH Workbench" 含空格（实测 --settings 值本身的引号由 node-pty
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
  // v1.4 模型服务 provider 档案：userData/providers.json（apiKey 属凭据仅存本地）
  const providers = new ProviderStore(baseDir)
  // v1.4 本地代理：路由表 = provider 端点 host → 该 provider 的外部代理（无=直连）。
  // 每连接现取——provider 增删/改代理配置即时生效，无需重启代理
  const localProxy = createLocalProxy({
    resolveRouting: () =>
      providers.list().flatMap((p) => {
        try {
          return [{ host: new URL(p.baseUrl).hostname, ...(p.proxyUrl ? { upstream: p.proxyUrl } : {}) }]
        } catch {
          return []
        }
      })
  })
  // 随应用启动（缺省不开——测试环境零副作用；显式用例再开）
  if (appSettings.get().proxyAutoStart === true) void localProxy.start()
  // v1.4 模型列表探测：官方端点经 provider 代理出口（Electron net.fetch + 独立 partition
  // session setProxy）；测试 mock 无 net/session 时降级直连（probe 内部容错）
  const probeProviderModels = createModelsProbe({
    sessionFetch: async (proxyUrl) => {
      if (typeof net?.fetch !== 'function' || typeof session?.fromPartition !== 'function') {
        return undefined
      }
      const s = session.fromPartition('cwb-probe-models', { cache: false })
      await s.setProxy({ proxyRules: proxyUrl, proxyBypassRules: '127.0.0.1,localhost' })
      // session 级 fetch（走该 session 的代理规则；net.fetch 的 RequestInit 不收 session）
      return ((url: string | URL, init?: RequestInit) =>
        s.fetch(typeof url === 'string' ? url : url.toString(), init)) as typeof fetch
    }
  })
  const probeProviderModelsById = async (id: string): Promise<ModelsProbeResult> => {
    const provider = providers.get(id)
    if (provider === undefined) {
      return { ok: false, error: translate(mainLanguage(), 'provider.errNotFound', { id }) }
    }
    return probeProviderModels(provider)
  }
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
      // 它只承载 stopped/exited 终态；推送内部吞错不阻塞状态机）。
      // v1.7.0：routeNotifyActivity 按任务归属分流本地/远程（VM ~/.cwb/notify.json）配置
      routeNotifyActivity(e)
    }
  })
  // R8 启动孤儿清扫：settings 目录下不在 tasks.json 的文件删除（崩溃残留/spawn 失败遗留）
  activity.cleanupOrphans(tasks.list().map((t) => t.id))

  // SSH 远程连接（S1 桩占位 / S2 真实 ssh2 实现——注入缝见 AppContextOptions.connection；
  // 状态/日志事件由组合根 main.ts 经 broadcastConnectionState/broadcastRemoteServerLog 挂钩外送）
  const connection = options.connection ?? new StubConnectionManager()

  // PTY 输出/退出外送（Local 与 Remote 同源——noteBytes 字节兜底、broadcast、
  // markStatus 终态迁移链路完全一致；远程 task.exit 帧驱动 onExit，H6）
  const ptyOnData = (event: PtyDataEvent): void => {
    activity.noteBytes(event.taskId) // v3.2 字节兜底信号（先记时间戳再广播）
    broadcast(IpcChannels.PtyData, event)
    options.onPtyData?.(event)
  }
  const ptyOnExit = (taskId: string): void => {
    markStatus(taskId, 'exited')
  }
  const localPty = new PtyManager({
    onData: ptyOnData,
    onExit: ptyOnExit
  })

  // S4 远程 PTY 枢纽：per-connection RemotePtyManager（协议帧生命周期）+ hooks
  // forwardIn 接线（入站流 pipe 回 task-activity 接收端）+ server.log 帧桥
  const remotePty = new RemotePtyHub({
    connection,
    callbacks: { onData: ptyOnData, onExit: ptyOnExit },
    onServerLog: broadcastRemoteServerLog,
    // claude 裸名（server 侧登录 PATH 解析 nvm shim）；CWB_REMOTE_CLAUDE_BIN 测试注入缝
    claudeBin: process.env['CWB_REMOTE_CLAUDE_BIN'] ?? 'claude',
    hookSink: async () => {
      await activity.ready()
      return { host: '127.0.0.1', port: activity.port }
    }
  })
  /** task→project.connectionId 路由解析（远程=指向 hub 的 per-connection manager） */
  const connectionIdOfTask = (taskId: string): string | undefined => {
    const task = tasks.get(taskId)
    if (task === undefined) return undefined
    const cid = projects.get(task.projectId)?.connectionId
    return cid !== undefined && cid !== '' ? cid : undefined
  }

  // v1.7.0 远程通知分流（用户指令：本地和远程都要 webhook 通知）：远程任务的
  // awaiting 事件取 VM 侧 ~/.cwb/notify.json 触发（缓存+写穿失效；远端无配置=
  // 不推送，绝不回落本地配置——两侧配置语义隔离）；本地任务走本地配置（不变）。
  function routeNotifyActivity(e: TaskActivityEvent): void {
    if (e.activity !== 'awaiting') return
    const cid = connectionIdOfTask(e.taskId)
    if (cid === undefined) {
      notify.onActivityEvent(e)
      return
    }
    const cached = remoteNotifyCache.get(cid)
    if (cached !== undefined && Date.now() - cached.at < REMOTE_NOTIFY_CACHE_TTL_MS) {
      notify.onActivityEvent(e, cached.cfg ?? { url: '', enabled: false, channel: 'generic' })
      return
    }
    void readRemoteNotify(connection, cid)
      .then((cfg) => {
        remoteNotifyCache.set(cid, { cfg, at: Date.now() })
        notify.onActivityEvent(e, cfg)
      })
      .catch(() => {
        remoteNotifyCache.set(cid, { cfg: null, at: Date.now() })
      })
  }
  // ctx.pty = 路由后端（本地/远程按 connectionId 分派；spawn 前的显式远程分支
  // 直接用 remotePty.managerFor——记录未落盘时路由查不到归属）
  const pty: PtyBackend = new RoutingPtyManager(localPty, remotePty, connectionIdOfTask)

  /**
   * S4 远程任务 settings（4.6=A 单轨）：
   * 1) hooks URL base=VM 侧 forwardIn 转发口（hub 接线，入站流回本机接收端）；
   * 2) 文件经 SFTP 写 VM ~/.cwb-server/task-settings/<taskId>.json（exec 预建目录+
   *    取 $HOME，一次往返；taskId 为 uuid 无注入面）；返回远端路径作 --settings 参数。
   * epoch 顺序照本地先例：调用方先 activity.noteSpawn 再调本函数（捕获新 epoch）。
   */
  /**
   * 远程任务 settings 构造（S4 hooks 载体；v1.6.0 增 provider env 注入缝）：
   * env 非空时并入 settings JSON 的 env 段（claude 启动时应用——与本地 spawn env
   * 等效；值源自 VM 侧 ~/.cwb/providers.json 解析，非客户端本地配置）。
   */
  async function buildRemoteSettings(
    connectionId: string,
    taskId: string,
    env?: Record<string, string>
  ): Promise<string> {
    const hookPort = await remotePty.hookPortFor(connectionId)
    const prep = await connection.exec(
      connectionId,
      `h=$(printf %s "$HOME"); mkdir -p "$h/${REMOTE_SETTINGS_DIR}" && printf %s "$h"`
    )
    if (prep.code !== 0) throw new Error(`remote settings dir prepare failed (exit ${prep.code})`)
    const home = prep.stdout.trim().split('\n').pop() ?? ''
    if (home === '') throw new Error('remote HOME unavailable')
    const path = `${home}/${REMOTE_SETTINGS_DIR}/${taskId}.json`
    const sftp = await connection.sftp(connectionId)
    return activity.buildSettings(taskId, {
      urlBase: `http://127.0.0.1:${hookPort}`,
      sink: { path, write: (content) => sftp.writeFile(path, content) },
      ...(env !== undefined ? { env } : {})
    })
  }

  /**
   * v1.6.0 远程任务的 provider env 解析：注册表读 VM `~/.cwb/providers.json`
   * （缺失/损坏=空注册表=不注入——与本地容错同语义）。任何读取失败（SSH 异常/
   * 桩 exec 未支持等）一律降级为不注入——模型配置解析绝不阻断任务创建/恢复。
   * S5 的 3.3=A 边界（远程不注入 ANTHROPIC_*）就此升级：配置与任务同侧（VM），
   * 注入值全部源自 VM 文件，客户端本地配置不再参与远程任务。
   */
  async function resolveRemoteProviderEnv(
    connectionId: string,
    providerId: string | undefined,
    model: string | undefined,
    modelMode: 'auto' | undefined
  ): Promise<Record<string, string> | undefined> {
    try {
      const registry = await readRemoteProviders(connection, connectionId)
      return resolveProviderEnvFrom(registry, providerId, model, modelMode, 'remote')
    } catch {
      return undefined
    }
  }

  // v1.2.0 skill 市场 / v1.2.1 插件 skill 的注入缝（同 CWB_SKILLS_USER_ROOT 先例，防读真实 ~/.claude）
  const skillMarketHome = process.env['CWB_SKILL_MARKET_HOME']

  // v0.5③ skill 管理（只读扫描用户级+项目级；v1.2.1 增加插件级；移除走回收站+realpath 归属校验）
  const pluginSkills = new PluginSkills(skillMarketHome ? { home: () => skillMarketHome } : {})
  // S5：远程项目目录在 VM——本机 fs 扫描其 .claude/skills 无意义（开发机同路径会读到
  // 错误一侧），本机扫描只含本地项目；远程上下文的 skills 展示走 SkillsStore.listRemote
  const skills = new SkillsStore({
    projects: () =>
      projects.list().filter((p) => p.connectionId === undefined || p.connectionId === ''),
    pluginSkills
  })

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
   * S5 6.2=a：远程项目（project.connectionId 非空）自动换远端数据源
   * （createRemoteSessionReader：SFTP 语义经 exec find/head 实现，HOME 根解析）——
   * 解析/落库/广播链路同本机。
   */
  async function importTasksFromSessions(projectId: string): Promise<TaskRecord[]> {
    const project = projects.get(projectId)
    const remoteCid =
      project?.connectionId !== undefined && project.connectionId !== ''
        ? project.connectionId
        : undefined
    let opts: ListSessionsOptions = {}
    if (remoteCid !== undefined) {
      opts = {
        reader: createRemoteSessionReader(connection, remoteCid),
        resolveProjectsRoot: async () => {
          const r = await connection.exec(remoteCid, `printf %s "$HOME"`)
          const home = r.stdout
            .trim()
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '')
            .pop() ?? ''
          if (home === '') throw new Error('remote HOME unavailable')
          return `${home}/.claude/projects`
        }
      }
    }
    const added = await importTasksFromSessionsImpl(projectId, projects, tasks, opts)
    for (const record of added) broadcastTaskUpdate(record)
    return added
  }

  /**
   * S5 3.12=a 远程会话导入的挂起/补跑：项目记录即挂起登记（带 connectionId 的项目
   * 天然构成 deferredImports——重启不丢），连接成功事件统一触发幂等增量补跑
   * （每次连接成功可再增量刷新；importTasksFromSessionsImpl 按 sessionId 全局查重）。
   * in-flight 去重防同连接并发补跑。
   */
  const importingConnections = new Set<string>()
  const runDeferredImports = async (connectionId: string): Promise<void> => {
    if (importingConnections.has(connectionId)) return
    importingConnections.add(connectionId)
    try {
      for (const project of projects.list()) {
        if (project.connectionId !== connectionId) continue
        try {
          await importTasksFromSessions(project.id)
        } catch {
          // 单项目扫描失败不阻断其余（连接恢复后下次连接成功可再补）
        }
      }
    } finally {
      importingConnections.delete(connectionId)
    }
  }
  // 仅在注入真实/mock 连接时订阅（缺省 StubConnectionManager 桩不支持订阅——S1 语义）
  if (options.connection !== undefined) {
    connection.onStateChange((e) => {
      if (e.state === 'connected') void runDeferredImports(e.connectionId)
    })
  }

  /**
   * S5 3.1=C 远端目录检测命令：一次往返取存在性（printf x）与 git（printf g）双标记。
   * bash -ic 包装（任务书口径；test 为 shell 内建本无 PATH 依赖——包装保持与
   * S2/S4 探测面一致，stderr 交互噪音由标记解析免疫）。
   */
  const remoteDirProbeCommand = (dir: string): string => {
    const script = `d=${posixQuote(dir)}; test -d "$d" && printf x; test -d "$d/.git" && printf g`
    return `bash -ic ${posixQuote(script)}`
  }

  async function addProject(dir: string, connectionId?: string): Promise<ProjectRecord> {
    // 本机路径（无参/空参）——行为逐字节不变
    if (connectionId === undefined || connectionId === '') {
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
    // S5 远程注册（3.1=C + 7.1 + 3.12=a）：未连接先尽力懒连接（失败不阻断注册——
    // 检测与导入推迟到连接成功事件补跑）
    const lang = mainLanguage()
    let online = connection.getState(connectionId) === 'connected'
    if (!online) {
      try {
        await connection.connect(connectionId)
        online = connection.getState(connectionId) === 'connected'
      } catch {
        online = false // VM 未启/认证错/TOFU 未确认——注册照常，检测/导入挂起
      }
    }
    let isGit = false
    if (online) {
      let probe
      try {
        probe = await connection.exec(connectionId, remoteDirProbeCommand(dir))
      } catch (err) {
        throw new Error(
          translate(lang, 'conn.proj.probeFailed', {
            detail: err instanceof Error ? err.message : String(err)
          })
        )
      }
      if (!probe.stdout.includes('x')) {
        throw new Error(translate(lang, 'conn.proj.dirMissing', { dir }))
      }
      isGit = probe.stdout.includes('g')
    }
    const record = projects.add(dir, isGit, connectionId)
    if (online) {
      try {
        await importTasksFromSessions(record.id) // 注册即导入（已连接分支）
      } catch {
        // 同本机语义：尽力而为
      }
    }
    return record
  }

  async function removeProject(id: string): Promise<void> {
    // 其任务逐个停止并删记录；worktree 保留磁盘，由用户手清（spec 约定）。
    // S4：远程项目经 hub 定向后端清理（kill=协议 task.kill；本地任务照旧杀树）
    const remoteCid = projects.get(id)?.connectionId
    for (const task of tasks.list(id)) {
      if (remoteCid !== undefined && remoteCid !== '') {
        const m = remotePty.managerFor(remoteCid)
        if (m.isRunning(task.id)) m.kill(task.id)
        m.forget(task.id)
      } else {
        if (pty.isRunning(task.id)) pty.kill(task.id)
        pty.forget(task.id)
      }
      tasks.remove(task.id)
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
    // S4 远程路由（project.connectionId 非空 → RemotePtyManager）：argv=Linux 形态
    // （claude 裸名，server 侧登录 PATH 解析）、settings SFTP 写 VM、hooks URL 指向
    // VM 侧 forwardIn 转发口、不注入任何 ANTHROPIC_*（3.3=A，providerEnv 不解析）。
    // 远程项目暂不支持 worktree 隔离（本地 git worktree 操作不适用于 VM 路径——S5 域）。
    const remoteCid =
      project.connectionId !== undefined && project.connectionId !== ''
        ? project.connectionId
        : undefined
    let cwd = project.dir
    let worktreePath: string | undefined
    if (opts.isolation === 'worktree') {
      // S5：远程显式拒绝（校验前移——先于任何 worktree 磁盘操作抛出；正式文案 i18n）
      if (remoteCid !== undefined) {
        throw new Error(translate(mainLanguage(), 'task.errWorktreeRemote'))
      }
      if (!project.isGit) throw new Error(`worktree isolation requires a git project: ${project.dir}`)
      worktreePath = await worktreeAdd(project.dir, taskId)
      cwd = worktreePath
    }
    // v3.2：epoch+1（作废旧 PTY 迟到 hook）+ 本地合成 idle（绿）——本地/远程同序：
    // 先 noteSpawn 拿新 epoch 再构造 settings（URL 捕获该 epoch）
    activity.noteSpawn(taskId)
    try {
      if (remoteCid !== undefined) {
        // settings 写 VM 入 try：失败与 spawn 失败同路径清理（评审 #5 同语义）。
        // v1.6.0：provider env 自 VM 侧注册表解析并入 settings（用户指令——远程
        // 模型配置存 VM；S5 3.3=A 的「不注入」升级为「注入值源自 VM 文件」）
        const remoteEnv = await resolveRemoteProviderEnv(
          remoteCid,
          opts.providerId,
          opts.model,
          opts.modelMode
        )
        const settingsPath = await buildRemoteSettings(remoteCid, taskId, remoteEnv)
        await remotePty.managerFor(remoteCid).spawnClaude(
          taskId,
          buildNewSessionArgs(taskId, name, {
            skipPermissions: opts.skipPermissions,
            settingsPath
          }),
          cwd
        )
      } else {
        // settings 写盘入 try：失败与 spawn 失败同路径清理 worktree/states（评审 #5）
        const settingsPath = await activity.buildSettings(taskId)
        // v1.4：任务指定 provider/model/modelMode（缺省走默认链）→ spawn env 注入
        const providerEnv = resolveProviderEnv(opts.providerId, opts.model, opts.modelMode)
        await pty.spawnClaude(
          taskId,
          buildNewSessionArgs(taskId, name, {
            skipPermissions: opts.skipPermissions,
            settingsPath
          }),
          cwd,
          providerEnv
        )
      }
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
      ...(opts.providerId !== undefined && opts.providerId !== ''
        ? { providerId: opts.providerId }
        : {}),
      ...(opts.model !== undefined && opts.model !== '' ? { model: opts.model } : {}),
      ...(opts.modelMode === 'auto' ? { modelMode: 'auto' as const } : {}),
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
    // S4：远程任务的 resume 语义=5.9=b 保活恢复——server 侧仍存活则 re-attach（不
    // 重复 spawn，RemotePtyManager 内 task.list 对账），已消亡则正常重 spawn
    const remoteCid = connectionIdOfTask(taskId)
    // stop 后 PTY 异步 teardown（onExit 才清句柄）而状态是同步广播——恢复按钮立即可点。
    // 短暂等待句柄释放，关闭"点恢复撞上半退出态 → spawn 抛 already running → 静默失败"窗口（评审 F1）
    for (let waited = 0; pty.isRunning(taskId) && waited < 3000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (pty.isRunning(taskId)) throw new Error(`task ${taskId} PTY still tearing down, retry shortly`)
    // v3.2：resume 同路径——epoch+1 + 本地合成 idle + settings 重写（捕获新 epoch）
    activity.noteSpawn(task.id)
    try {
      if (remoteCid !== undefined) {
        // v1.6.0：resume 同 createTask——远程 provider env 解析并入 settings 重写
        const remoteEnv = await resolveRemoteProviderEnv(
          remoteCid,
          task.providerId,
          task.model,
          task.modelMode
        )
        const settingsPath = await buildRemoteSettings(remoteCid, task.id, remoteEnv)
        await remotePty.managerFor(remoteCid).spawnClaude(
          task.id,
          buildResumeArgs(task.sessionId, task.name, {
            skipPermissions: task.skipPermissions === true,
            settingsPath
          }),
          task.cwd
        )
      } else {
        const settingsPath = await activity.buildSettings(task.id)
        // v1.4：沿用任务记录的 provider/model 元数据（与 skipPermissions 同语义——切换在下次恢复生效）
        const providerEnv = resolveProviderEnv(task.providerId, task.model, task.modelMode)
        await pty.spawnClaude(
          task.id,
          buildResumeArgs(task.sessionId, task.name, {
            skipPermissions: task.skipPermissions === true,
            settingsPath
          }),
          task.cwd,
          providerEnv
        )
      }
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
    // S4：远程任务经 hub 定向后端（记录删除前解析归属——路由查 store 会落空）
    const remoteCid = connectionIdOfTask(taskId)
    if (remoteCid !== undefined) {
      const m = remotePty.managerFor(remoteCid)
      if (m.isRunning(taskId)) m.kill(taskId)
      m.forget(taskId)
    } else {
      if (pty.isRunning(taskId)) pty.kill(taskId)
      pty.forget(taskId)
    }
    tasks.remove(taskId)
    activity.forget(taskId) // v3.2 R8：settings 文件 + 内存态清理（远端文件留置——见 S4 concerns）
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

  /**
   * v1.4 任务级 provider/model 事后修改（照 setTaskSkipPermissions 第 17 法先例）：
   * 仅元数据——下次 spawn/resume 生效（运行中会话不受影响）；空串=清除该字段回退默认链。
   * providerId 允许指向不存在的档案（删除后回退语义由 resolveProviderEnv 兜底）；
   * modelMode:'auto'=CLI 自主选择（清除 model），''/undefined=清除 auto 回到 model 链。
   */
  async function setTaskProvider(
    taskId: string,
    opts: { providerId?: string; model?: string; modelMode?: 'auto' | '' }
  ): Promise<TaskRecord> {
    const task = tasks.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    const providerId =
      opts.providerId !== undefined && opts.providerId !== '' ? opts.providerId : undefined
    const modelMode = opts.modelMode === 'auto' ? ('auto' as const) : undefined
    const model = modelMode === 'auto' ? undefined : opts.model !== undefined && opts.model !== '' ? opts.model : undefined
    const updated = tasks.upsert({
      ...task,
      providerId,
      model,
      modelMode,
      lastActiveAt: new Date().toISOString()
    })
    broadcastTaskUpdate(updated)
    return updated
  }

  async function pickDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  /**
   * v1.4.2 1M 声明 → Claude Code `[1m]` 后缀（设置页「1M 上下文」勾选的模型注入前追加）。
   * 依据官方 model-config 文档：给模型 ID 追加 [1m] 后，CLI 按 1M 记账、请求前剥离后缀
   * （网关收到的仍是原模型名），同时显式开启 1m beta 头；200K 未识别警告随之消失。
   * 比对用去后缀形式：声明写成 glm-5.3 或 glm-5.3[1m] 均命中；模型本身已有后缀不重复追加。
   */
  function with1mSuffix(model: string, provider: ProviderConfig): string {
    const declared = provider.models1M
    if (declared === undefined || declared.length === 0) return model
    if (/\[1m\]/i.test(model)) return model
    const bare = (m: string): string => m.replace(/\[1m\]/gi, '').trim()
    return declared.some((d) => bare(d) === bare(model)) ? `${model}[1m]` : model
  }

  /**
   * v1.4 provider 解析 → spawn 注入 env。
   * 解析链（用户确认的语义）：任务 providerId > 默认 provider > 不注入（v1.3 前
   * 行为——继承 env 原样透传）；任务引用的 provider 已删除 → 回退默认链。
   * 只做 API 配置注入（协议兼容由 claude CLI 与网关承担）。
   * v1.4：modelMode='auto'（CLI 自主选择）不注入 ANTHROPIC_MODEL；档位映射
   * slotModels → ANTHROPIC_DEFAULT_*_MODEL 照常注入（auto 与固定主模型下均生效）。
   */
  function resolveProviderEnv(
    providerId: string | undefined,
    model: string | undefined,
    modelMode?: 'auto'
  ): Record<string, string> | undefined {
    return resolveProviderEnvFrom(providers.state(), providerId, model, modelMode, 'local')
  }

  /**
   * v1.6.0 抽出（远程任务经 VM 侧 ~/.cwb/providers.json 解析——与本地同一条逻辑）：
   * proxyMode='local' 走本地代理分支（运行中优先）；'remote' 只认 provider.proxyUrl
   * （VM 侧无客户端本地代理概念——端点由 VM 的 claude 消费，代理可达性以 VM 视角为准）。
   */
  function resolveProviderEnvFrom(
    registry: ProviderRegistryState,
    providerId: string | undefined,
    model: string | undefined,
    modelMode: 'auto' | undefined,
    proxyMode: 'local' | 'remote'
  ): Record<string, string> | undefined {
    const provider =
      (providerId !== undefined && providerId !== ''
        ? registry.providers.find((p) => p.id === providerId)
        : undefined) ??
      (registry.defaultProviderId !== undefined
        ? registry.providers.find((p) => p.id === registry.defaultProviderId)
        : undefined)
    if (provider === undefined) return undefined
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: provider.baseUrl }
    if (provider.apiKey !== '') {
      env[provider.apiKeyType === 'api_key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] =
        provider.apiKey
    }
    // 任务模型：auto=CLI 自主（跳过 ANTHROPIC_MODEL，档位映射/供应商默认接管）
    if (modelMode !== 'auto') {
      const effectiveModel = model !== undefined && model !== '' ? model : provider.defaultModel
      if (effectiveModel !== undefined && effectiveModel !== '') {
        env['ANTHROPIC_MODEL'] = with1mSuffix(effectiveModel, provider)
      }
    }
    // 档位映射（Anthropic 格式）：CLI 按档位选模型时落到具体模型
    const slots = provider.slotModels
    if (slots !== undefined) {
      if (slots.sonnet !== undefined && slots.sonnet !== '') {
        env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = with1mSuffix(slots.sonnet, provider)
      }
      if (slots.opus !== undefined && slots.opus !== '') {
        env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = with1mSuffix(slots.opus, provider)
      }
      if (slots.fable !== undefined && slots.fable !== '') {
        env['ANTHROPIC_DEFAULT_FABLE_MODEL'] = with1mSuffix(slots.fable, provider)
      }
      if (slots.haiku !== undefined && slots.haiku !== '') {
        env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = with1mSuffix(slots.haiku, provider)
      }
    }
    // v1.4 网络代理（照搬 cc-switch：Anthropic 原生格式直连官方需代理）：
    // 大小写双写（Node/undici 与常见 CLI 读法不同），NO_PROXY 豁免本机回调——
    // hooks 活动上报走 127.0.0.1，经代理会被劫持（cc-switch issue #1264 同源问题）。
    // 本地代理运行期间：统一指向本地代理（路由由代理按端点 host 决定直连/外部代理），
    // 不再直注 provider.proxyUrl——provider 代理配置改动即时生效（无需重 spawn）
    const applyProxy = (p: string): void => {
      env['HTTP_PROXY'] = p
      env['HTTPS_PROXY'] = p
      env['http_proxy'] = p
      env['https_proxy'] = p
      env['NO_PROXY'] = '127.0.0.1,localhost'
      env['no_proxy'] = '127.0.0.1,localhost'
    }
    if (proxyMode === 'local') {
      const local = localProxy.status()
      if (local.running && local.port !== undefined) {
        applyProxy(`http://127.0.0.1:${local.port}`)
      } else if (provider.proxyUrl !== undefined && provider.proxyUrl !== '') {
        applyProxy(provider.proxyUrl)
      }
    } else if (provider.proxyUrl !== undefined && provider.proxyUrl !== '') {
      applyProxy(provider.proxyUrl)
    }
    return env
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
    providers,
    localProxy,
    resolveProviderEnv,
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
    setTaskProvider,
    probeProviderModels: probeProviderModelsById,
    pickDirectory,
    importTasksFromSessions,
    appSettings,
    fontScanner,
    appUpdate,
    connection,
    remotePty
  }
}

/**
 * 注册全部 IPC handler（S2 实现；S4 起接受可选注入的 AppContext 并将其返回，
 * 供 --smoke/--smoke-recovery 编排复用同一真实路径）。
 * handler 参数签名即跨进程调用契约（见 preload/index.ts 与 shared/types.ts），不得改动。
 */
export function registerIpcHandlers(ctx: AppContext = createAppContext()): AppContext {
  const { projects, tasks, pty, activity, smokeReports } = ctx

  // S2 连接档案存储（S5 起为远程上下文裁定/远端 sudo 密码解析的前置依赖——创建前移）
  const connectionsStore = new ConnectionsStore(app.getPath('userData'), electronSafeStorage())
  /**
   * S5 远程上下文（6.1/6.3/6.5）：「当前默认/最后使用连接」的 main 侧裁定——
   * v1 单服务器无歧义；多档案取第一个已连接者（多于一个时 UI 显式选择归后续迭代，
   * 任务书授权 main 侧取第一个已连接）。返回的 SkillInfo/市场条目携带 VM 绝对
   * 路径——来源由路径形态标注（契约 SkillInfo 无连接字段，禁碰）。
   */
  // handle（renderer invoke，带返回值）
  ipcMain.handle(IpcChannels.ProjectsList, () => projects.list())
  ipcMain.handle(IpcChannels.ProjectsAdd, (_e, dir: string, connectionId?: string) =>
    // S5：第二参 connectionId（契约 v2.2/preload 已透传）非空=远程注册（3.1=C/7.1）
    ctx.addProject(dir, typeof connectionId === 'string' && connectionId !== '' ? connectionId : undefined)
  )
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
  // v0.5③ skills（SkillInfo 归 renderer 弹窗消费；removeSkill 的归属校验在 main）。
  // S5 6.1=a：远程上下文（活跃连接）展示 VM 侧 ~/.claude/skills+插件清单
  // （listRemote；读失败返回空——不回落本机数据防跨机混淆）。
  ipcMain.handle(IpcChannels.SkillsList, async (_e, cid: unknown) => {
    const c = asCid(cid)
    if (c !== undefined) {
      try {
        return await ctx.skills.listRemote(ctx.connection, c)
      } catch {
        return [] // 连接中途掉线等——空清单（连接态另由侧栏呈现）
      }
    }
    return ctx.skills.list()
  })
  ipcMain.handle(
    IpcChannels.SkillsImport,
    async (
      _e,
      cid: unknown,
      fromDir: string,
      target: { scope: 'user' | 'project'; projectId?: string }
    ) => {
      // v1.7.0 作用域化：cid 显式参数——远程=本机目录递归 SFTP 上传到 VM
      // ~/.claude/skills/<basename>（project 范围远程不支持——VM 侧项目目录不归
      // 客户端管理，与本地语义对齐拒绝）；本机=原逻辑。
      const c = asCid(cid)
      if (c !== undefined) {
        if (target.scope !== 'user') {
          throw new Error(translate(mainLanguage(), 'skills.errRemoteWrite'))
        }
        const dest = await importRemoteSkillFolder(ctx.connection, c, fromDir)
        return {
          name: dest.split('/').pop() ?? '',
          description: '',
          source: 'user',
          dir: dest
        } as SkillInfo
      }
      return ctx.skills.importSkillFolder(fromDir, target)
    }
  )
  ipcMain.handle(IpcChannels.SkillsRemove, async (_e, cid: unknown, skill: SkillInfo) => {
    // v1.7.0 作用域化：远程=VM 侧 mv 到 ~/.claude/.skills-trash（客户端回收站
    // 不适用 VM 路径——错侧）；本机=原回收站逻辑
    const c = asCid(cid)
    if (c !== undefined) {
      await removeRemoteSkill(ctx.connection, c, skill.dir)
      return
    }
    return ctx.skills.removeSkill(skill)
  })
  // v1.2.0 skill 市场：搜索只读本机目录；安装/刷新走 CLI 受控执行面（输出经 CliOutput 广播）。
  // S5 6.1/6.5：远程上下文读 VM 侧 marketplace 目录；安装/刷新经 SSH 远端执行。
  ipcMain.handle(
    IpcChannels.SkillSearch,
    async (_e, cid: unknown, query: unknown, marketplace: unknown, limit: unknown) => {
      const q = typeof query === 'string' ? query : ''
      const m = typeof marketplace === 'string' && marketplace !== '' ? marketplace : undefined
      const l = typeof limit === 'number' && Number.isFinite(limit) ? limit : 50
      const c = asCid(cid)
      if (c !== undefined) {
        try {
          const reader = await openRemoteClaudeHome(ctx.connection, c)
          return await ctx.skillMarket.searchRemote(reader, q, m, l)
        } catch {
          return []
        }
      }
      return ctx.skillMarket.search(q, m, l)
    }
  )
  ipcMain.handle(IpcChannels.SkillMarketplaces, async (_e, cid: unknown) => {
    const c = asCid(cid)
    if (c !== undefined) {
      try {
        const reader = await openRemoteClaudeHome(ctx.connection, c)
        return await ctx.skillMarket.listMarketplacesRemote(reader)
      } catch {
        return []
      }
    }
    return ctx.skillMarket.listMarketplaces()
  })
  ipcMain.handle(
    IpcChannels.SkillMarketInstall,
    async (_e, cid: unknown, installId: unknown) => {
    const lang = mainLanguage()
    if (typeof installId !== 'string') {
      return { ok: false, error: translate(lang, 'skill.errParam') }
    }
    const invalid = validateInstallTarget(installId, lang)
    if (invalid !== null) return { ok: false, error: invalid }
    try {
      // S5：远程上下文经 SSH 在 VM 内执行（6.5=B 全部远端化）；v1.7.0 显式 cid
      const c = asCid(cid)
      const { commandId } =
        c !== undefined
          ? await ctx.cli.runPluginRemote(ctx.connection, c, ['plugin', 'install', installId, '-y'])
          : await ctx.cli.runPlugin(['plugin', 'install', installId, '-y'])
      return { ok: true, commandId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IpcChannels.SkillMarketRefresh, async (_e, cid: unknown) => {
    try {
      const c = asCid(cid)
      const { commandId } =
        c !== undefined
          ? await ctx.cli.runPluginRemote(ctx.connection, c, ['plugin', 'marketplace', 'update'])
          : await ctx.cli.runPlugin(['plugin', 'marketplace', 'update'])
      return { ok: true, commandId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // v1.2.1 插件 skill 启用/停用：`claude plugin enable|disable <id> -s user`
  // id 必须来自真实安装记录（白名单）——不接受任意字符串进命令行
  ipcMain.handle(
    IpcChannels.SkillPluginSetEnabled,
    async (_e, cid: unknown, pluginId: unknown, enabled: unknown) => {
      const lang = mainLanguage()
      if (typeof pluginId !== 'string' || !isValidPluginId(pluginId)) {
        return { ok: false, error: translate(lang, 'skill.errIdFormat') }
      }
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: translate(lang, 'skill.errParam') }
      }
      // S5：远程上下文白名单取 VM 侧安装记录（installedIdsRemote）；v1.7.0 显式 cid
      const c = asCid(cid)
      const installed =
        c !== undefined
          ? await ctx.pluginSkills
              .installedIdsRemote(await openRemoteClaudeHome(ctx.connection, c))
              .catch(() => [] as string[])
          : ctx.pluginSkills.installedIds()
      if (!installed.includes(pluginId)) {
        return { ok: false, error: translate(lang, 'skill.errNotInstalled', { id: pluginId }) }
      }
      try {
        const { commandId } =
          c !== undefined
            ? await ctx.cli.runPluginRemote(ctx.connection, c, [
                'plugin',
                enabled ? 'enable' : 'disable',
                pluginId,
                '-s',
                'user'
              ])
            : await ctx.cli.runPlugin([
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
  // v0.5③ CLI 执行（校验+spawn 即返 commandId；拒绝抛带原因 Error）。
  // S5 M10 路由：第二参 connectionId 非空 → SSH 远端执行（bash -ic+输出回投+exit 事件）；
  // 空 → 本机现行为不变。
  ipcMain.handle(IpcChannels.CliRun, (_e, command: string, connectionId?: string) => {
    if (typeof connectionId === 'string' && connectionId !== '') {
      return ctx.cli.runRemote(ctx.connection, connectionId, command)
    }
    return ctx.cli.run(command)
  })
  // v0.5⑤ 版本/更新/安装（安装为固定模板，完成钩子失效 claudePathCache）。
  // S5 6.3/6.6：远程上下文（活跃连接）→ VM 内探测/更新/安装；本机模式不变。
  // v1.7.0：cid 显式参数（undefined=本机）——设置中心作用域化，弃 activeConnectionId 隐式路由
  ipcMain.handle(IpcChannels.VersionGet, async (_e, cid: unknown) => {
    const c = asCid(cid)
    if (c !== undefined) {
      const version = await remoteClaudeVersion(ctx.connection, c).catch(() => '')
      return { version, path: `ssh:${c}` } // 远端无本机路径概念——path 标注来源连接
    }
    return getClaudeVersionInfo()
  })
  ipcMain.handle(IpcChannels.UpdateCheck, async (_e, cid: unknown) => {
    const c = asCid(cid)
    if (c !== undefined) return checkClaudeUpdateRemote(ctx.connection, c)
    return checkClaudeUpdate()
  })
  ipcMain.handle(IpcChannels.InstallCli, async (_e, cid: unknown, method: 'native' | 'npm') => {
    const c = asCid(cid)
    if (c !== undefined) {
      // 6.6=B：npm 全局形态 sudo -S 复用连接密码（密码经 revealSecret 解出、只走
      // SFTP 临时文件+stdin 重定向，不进命令串/argv/日志——见 cli-runner 实现注）
      const record = connectionsStore.get(c)
      let password: string | undefined
      if (record !== undefined && record.authMethod !== 'key') {
        const secret = connectionsStore.revealSecret(record)
        password = secret.password
      }
      return installClaudeCliRemote(ctx.cli, ctx.connection, c, method, {
        password,
        language: mainLanguage
      })
    }
    return installClaudeCli(ctx.cli, method)
  })
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
  // v0.5④N webhook 通知（v1.7.0 作用域化：cid 显式参数——undefined=本机
  // userData/notify.json；有值=VM ~/.cwb/notify.json 经 SSH read-modify-write，
  // 与本地同校验同容错；写穿失效远程缓存——触发分流见 routeNotifyActivity）
  ipcMain.handle(IpcChannels.NotifyGet, async (_e, cid: unknown) => {
    const c = asCid(cid)
    return c !== undefined ? readRemoteNotify(ctx.connection, c) : ctx.notify.getConfig()
  })
  ipcMain.handle(
    IpcChannels.NotifySet,
    async (_e, cid: unknown, url: unknown, enabled: unknown) => {
      const u = typeof url === 'string' ? url : ''
      const c = asCid(cid)
      if (c !== undefined) {
        const cfg = await writeRemoteNotify(ctx.connection, c, u, enabled === true, mainLanguage())
        remoteNotifyCache.delete(c)
        return cfg
      }
      return ctx.notify.setWebhook(u, enabled === true)
    }
  )
  ipcMain.handle(IpcChannels.NotifyTest, async (_e, cid: unknown) => {
    const c = asCid(cid)
    if (c !== undefined) {
      const cfg = await readRemoteNotify(ctx.connection, c)
      return ctx.notify.sendTestWith(cfg)
    }
    return ctx.notify.sendTest()
  })
  // v1.4 模型服务 provider：档案 CRUD + 默认切换（入参校验拒绝即 invoke reject，renderer 展示错误）
  // v1.7.0（用户指令：本地/远程配置隔离）：模型服务的存储/读取/修改源由 renderer
  // 传显式 connectionId 指定（undefined=本机）——设置中心作用域化后不再依赖
  // activeConnectionId 隐式路由（"不知道在编辑哪侧"的结构性根源）。
  const asCid = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined
  ipcMain.handle(IpcChannels.ProvidersList, async (_e, cid: unknown) => {
    const c = asCid(cid)
    return c !== undefined ? readRemoteProviders(ctx.connection, c) : ctx.providers.state()
  })
  ipcMain.handle(IpcChannels.ProvidersSave, async (_e, cid: unknown, raw: unknown) => {
    const input = validateProviderInput(mainLanguage(), raw)
    const c = asCid(cid)
    if (c !== undefined) return saveRemoteProvider(ctx.connection, c, input)
    return ctx.providers.save(input)
  })
  ipcMain.handle(IpcChannels.ProvidersRemove, async (_e, cid: unknown, id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error(translate(mainLanguage(), 'provider.errShape'))
    }
    const c = asCid(cid)
    if (c !== undefined) {
      await removeRemoteProvider(ctx.connection, c, id)
      return
    }
    if (!ctx.providers.remove(id)) {
      throw new Error(translate(mainLanguage(), 'provider.errNotFound', { id }))
    }
  })
  ipcMain.handle(IpcChannels.ProvidersSetDefault, async (_e, cid: unknown, id: unknown) => {
    if (typeof id !== 'string') {
      throw new Error(translate(mainLanguage(), 'provider.errShape'))
    }
    const c = asCid(cid)
    if (c !== undefined) {
      await setRemoteDefault(ctx.connection, c, id)
      return
    }
    if (!ctx.providers.setDefault(id)) {
      throw new Error(translate(mainLanguage(), 'provider.errNotFound', { id }))
    }
  })
  ipcMain.handle(IpcChannels.ProvidersProbeModels, async (_e, cid: unknown, id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error(translate(mainLanguage(), 'provider.errShape'))
    }
    const c = asCid(cid)
    if (c !== undefined) {
      // VM 侧探测（curl 经 exec）：消费端点的正是 VM 的 claude——VM 视角可达性为真相
      const state = await readRemoteProviders(ctx.connection, c)
      const provider = state.providers.find((p) => p.id === id)
      if (provider === undefined) {
        throw new Error(translate(mainLanguage(), 'provider.errNotFound', { id }))
      }
      return probeRemoteModels(ctx.connection, c, provider)
    }
    return ctx.probeProviderModels(id)
  })
  // v1.7.0 provider 跨作用域复制（用户指令：远程 provider 支持本地和远程共享）：
  // 读源注册表 → 剥 id（目标侧重分配防冲突）→ 写目标。source/target 的 kind：
  // 'local' | 'remote'（remote 时 id=connectionId）。
  ipcMain.handle(
    IpcChannels.ProvidersCopy,
    async (
      _e,
      source: unknown,
      target: unknown,
      providerId: unknown
    ): Promise<ProviderConfig> => {
      const parseScope = (v: unknown): { kind: 'local' | 'remote'; id?: string } | null => {
        if (typeof v !== 'object' || v === null) return null
        const o = v as Record<string, unknown>
        if (o['kind'] === 'local') return { kind: 'local' }
        if (o['kind'] === 'remote' && typeof o['id'] === 'string' && o['id'] !== '')
          return { kind: 'remote', id: o['id'] }
        return null
      }
      const src = parseScope(source)
      const dst = parseScope(target)
      if (src === null || dst === null || typeof providerId !== 'string' || providerId === '') {
        throw new Error(translate(mainLanguage(), 'provider.errShape'))
      }
      if (src.kind === dst.kind && src.id === dst.id) {
        throw new Error(translate(mainLanguage(), 'provider.copySameScope'))
      }
      const readState = async (): Promise<ProviderRegistryState> =>
        src.kind === 'local'
          ? ctx.providers.state()
          : await readRemoteProviders(ctx.connection, src.id!)
      const state = await readState()
      const origin = state.providers.find((p) => p.id === providerId)
      if (origin === undefined) {
        throw new Error(translate(mainLanguage(), 'provider.errNotFound', { id: providerId }))
      }
      const stripped: ProviderConfig = { ...origin, id: '' }
      return dst.kind === 'local'
        ? ctx.providers.save(stripped)
        : await saveRemoteProvider(ctx.connection, dst.id!, stripped)
    }
  )
  ipcMain.handle(
    IpcChannels.TasksSetProvider,
    (_e, taskId: string, opts: { providerId?: string; model?: string; modelMode?: 'auto' | '' }) =>
      ctx.setTaskProvider(taskId, opts)
  )
  // v1.4 本地代理：状态/启动/停止（start 失败即 reject——端口全占等，UI 显示错误）
  ipcMain.handle(IpcChannels.ProxyStatus, () => ctx.localProxy.status())
  ipcMain.handle(IpcChannels.ProxyStart, () => ctx.localProxy.start())
  ipcMain.handle(IpcChannels.ProxyStop, () => ctx.localProxy.stop())
  // ── SSH 远程模式（S2 连接层已实现；S4/S7 通道仍为桩，见各自注释）────────
  // S2：连接档案 CRUD（connections-store：userData/connections.json 原子写 +
  // safeStorage 密文，明文 password 仅在 main 侧出现一次即加密丢弃）。
  // CRUD/Test 不经 ctx.connection（桩注入下也可用）；Connect/Disconnect/SftpBrowse
  // 委托 ctx.connection（RealConnectionManager——懒连接/TOFU/自检/重连状态机）。
  ipcMain.handle(IpcChannels.ConnectionsList, () => connectionsStore.list())
  ipcMain.handle(IpcChannels.ConnectionsSave, (_e, raw: unknown) => {
    const parsed = parseConnectionInput(mainLanguage(), raw)
    return connectionsStore.save(parsed.record, parsed.plainPassword)
  })
  ipcMain.handle(IpcChannels.ConnectionsDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    if (!connectionsStore.remove(id)) {
      throw new Error(connectionMessage(mainLanguage(), 'notFound'))
    }
  })
  // 只读测试（一次性连接 + 自检清单，分级错误文案；TOFU 未确认 → kind=hostKeyConfirm + 指纹）
  ipcMain.handle(IpcChannels.ConnectionsTest, async (_e, id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      return { ok: false, error: connectionMessage(mainLanguage(), 'shape') }
    }
    const record = connectionsStore.get(id)
    if (record === undefined) return { ok: false, error: connectionMessage(mainLanguage(), 'notFound') }
    return testConnectionRecord(record, { store: connectionsStore, language: mainLanguage })
  })
  // 用户显式连接控制（手动重试=重连循环中再次 connect 即清退避立即重连）。
  // S4：SSH 连接成功后做 cwb-server 健康检查（WS+真实协议 ping，O6 语义）——
  // SSH 通而 server 不可达 → [cwb:need-server-install] token 错误上抛（S6
  // connectFlow 的 NEED_INSTALL_RE 命中 → 安装弹窗；S7 装完重连即通）。
  // SSH 层失败（VM 未启/认证错）仍是 S2 分级错误——不误触安装弹窗。
  ipcMain.handle(IpcChannels.ConnectionsConnect, async (_e, id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    try {
      await ctx.connection.connect(id)
    } catch (err) {
      // TOFU 首连（hostKeyConfirm）：需 UI 确认指纹后锁定重连。IPC 错误只保
      // message（自定义字段不穿越序列化），故照 needInstall token 先例在
      // message 前缀 [cwb:host-key-confirm] 供 renderer connectFlow 分流弹窗；
      // 指纹已在 ConnectionError.message 的（SHA256:xxx）括号段内。
      if (err instanceof ConnectionError && err.kind === 'hostKeyConfirm') {
        throw new Error(`[cwb:host-key-confirm] ${err.message}`)
      }
      throw err
    }
    // S4 健康检查（SSH 已通前提下）：不可达 → needInstall token 错误（见上方注释）
    await ctx.remotePty.ensureConnected(id)
  })
  ipcMain.handle(IpcChannels.ConnectionsDisconnect, (_e, id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    return ctx.connection.disconnect(id)
  })
  // S2：SFTP 目录浏览（3.1=C 注册对话框；payload {connectionId, path?}；缺省=远端 home）
  ipcMain.handle(IpcChannels.SftpBrowse, (_e, connectionId: unknown, path?: unknown) => {
    if (typeof connectionId !== 'string' || connectionId === '') {
      return Promise.resolve({ ok: false, error: connectionMessage(mainLanguage(), 'shape') })
    }
    return browseRemoteDir(
      ctx.connection,
      connectionId,
      typeof path === 'string' && path !== '' ? path : undefined
    )
  })
  // S7：首连推送/升级 cwb-server（6.7=A；确认弹窗 UI=S6，本通道为 main 侧 promise 接口）。
  // mode='install'=用户已在弹窗确认 → 推送/升级全流程；进度经 broadcastRemoteServerLog
  // → S6 安装弹窗日志区（onRemoteServerLog）；返回对齐 preload 声明 {ok,error?}
  ipcMain.handle(IpcChannels.ServerInstall, async (_e, connectionId: unknown) => {
    if (typeof connectionId !== 'string' || connectionId === '') {
      return { ok: false, error: connectionMessage(mainLanguage(), 'shape') }
    }
    try {
      const r = await ensureServer(ctx.connection, connectionId, {
        mode: 'install',
        onProgress: (p) =>
          broadcastRemoteServerLog({
            connectionId,
            level: p.stage === 'error' ? 'error' : p.stage === 'health' ? 'warn' : 'info',
            message: p.message
          })
      })
      return r.ok ? { ok: true } : { ok: false, error: r.message }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // S4：远程代理三通道（6.4=c；经 server 协议 proxy.* 帧转发——hub.proxyRequest
  // 先建立 server-client 再透传帧；payload 形状=server 侧终态。不可达时错误带
  // [cwb:need-server-install]（ensureConnected 同源判定），renderer 设置页展示）
  const requireConnectionId = (v: unknown): string => {
    if (typeof v !== 'string' || v === '') {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    return v
  }
  ipcMain.handle(IpcChannels.RemoteProxyStatus, (_e, connectionId: unknown) =>
    ctx.remotePty.proxyRequest<RemoteProxyStatus>(
      requireConnectionId(connectionId),
      { type: 'proxy.status' }
    )
  )
  // v1.6.1：VM 侧代理启停（server 帧 proxy.start/stop——S6 面板期只接了 status/config，
  // 启停缺口补齐后远程代理才真正可从客户端启用）
  ipcMain.handle(IpcChannels.RemoteProxyStart, (_e, connectionId: unknown) =>
    ctx.remotePty.proxyRequest<RemoteProxyStatus>(
      requireConnectionId(connectionId),
      { type: 'proxy.start' }
    )
  )
  ipcMain.handle(IpcChannels.RemoteProxyStop, (_e, connectionId: unknown) =>
    ctx.remotePty.proxyRequest<RemoteProxyStatus>(
      requireConnectionId(connectionId),
      { type: 'proxy.stop' }
    )
  )
  ipcMain.handle(IpcChannels.RemoteProxyConfigGet, (_e, connectionId: unknown) =>
    ctx.remotePty.proxyRequest<RemoteProxyConfig>(
      requireConnectionId(connectionId),
      { type: 'proxy.config.get' }
    )
  )
  ipcMain.handle(IpcChannels.RemoteProxyConfigSet, (_e, connectionId: unknown, patch: unknown) => {
    const id = requireConnectionId(connectionId)
    // 白名单字段过滤（契约只有 proxyUrl；server 侧 ConfigStore 二次过滤兜底）
    if (typeof patch !== 'object' || patch === null) {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    const raw = patch as Record<string, unknown>
    if (raw['proxyUrl'] !== undefined && typeof raw['proxyUrl'] !== 'string') {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    if (typeof raw['proxyUrl'] === 'string' && raw['proxyUrl'].length > 512) {
      throw new Error(connectionMessage(mainLanguage(), 'shape'))
    }
    const clean: Partial<RemoteProxyConfig> =
      typeof raw['proxyUrl'] === 'string' ? { proxyUrl: raw['proxyUrl'].trim() } : {}
    return ctx.remotePty.proxyRequest<RemoteProxyConfig>(id, {
      type: 'proxy.config.set',
      patch: clean
    })
  })
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
