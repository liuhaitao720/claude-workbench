import { create } from 'zustand'
import type {
  AppUpdateInfo,
  ConnectionRecord,
  ConnectionRuntimeState,
  ConnectionStateChangedEvent,
  CreateTaskOptions,
  ProjectRecord,
  ProviderRegistryState,
  PtyDataEvent,
  RemoveTaskOptions,
  RemoteServerLogEvent,
  TaskActivityEvent,
  TaskRecord
} from '../../shared/types'
import {
  applyDomTheme,
  loadTermFollowsTheme,
  loadTheme,
  onSystemThemeChange,
  persistTermFollowsTheme,
  persistTheme,
  resolveTheme
} from './theme'
import type { EffectiveTheme, Theme } from './theme'

// ── PTY 数据轻量 pub-sub（高频流，不进 zustand）────────────────────────
// App mount 时经 initListeners 把 window.cwb.onPtyData 一次性接到 emitTaskData，
// TerminalPanel 按任务订阅 subscribeTaskData，避免每帧触发 React 渲染。

type TaskDataListener = (data: string) => void

const taskDataListeners = new Map<string, Set<TaskDataListener>>()

export function subscribeTaskData(taskId: string, cb: TaskDataListener): () => void {
  let set = taskDataListeners.get(taskId)
  if (!set) {
    set = new Set()
    taskDataListeners.set(taskId, set)
  }
  set.add(cb)
  return () => {
    const s = taskDataListeners.get(taskId)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) taskDataListeners.delete(taskId)
  }
}

export function emitTaskData(e: PtyDataEvent): void {
  taskLastDataAt.set(e.taskId, Date.now())
  const set = taskDataListeners.get(e.taskId)
  if (!set) return
  for (const cb of set) cb(e.data)
}

/** 各任务最近一次 PTY 输出时间戳（v3.2 activityMap 无条目时的字节启发兜底源） */
const taskLastDataAt = new Map<string, number>()

export function getLastDataAt(taskId: string): number | undefined {
  return taskLastDataAt.get(taskId)
}

// ── SSH 远程模式（S6）──────────────────────────────────────────────────

/** 连接运行时状态条目（5.4=A：独立运行时维度，不落盘；attempt=自动重连序号） */
export interface ConnectionStateEntry {
  state: ConnectionRuntimeState
  /** state='reconnecting' 时的自动重连尝试序号（5.7=A 指数退避） */
  attempt?: number
}

/** 侧栏持久化键（3.7/3.8/3.10；S1 批0 锁键——renderer 经 setAppSettings 写，main 仅存取） */
export interface SidebarPrefs {
  sidebarWidth?: number
  sidebarCollapsedPersist?: boolean
  serverNodesCollapsed?: Record<string, boolean>
}

/** 设置中心分类 id（v1.4 四分类 + S6「远程连接」）——store 侧定义供 openSettings 直达 */
export type SettingsSectionId = 'general' | 'connections' | 'providers' | 'cli' | 'about'

/** 侧栏宽度拖拽区间（3.7=A：240–480px） */
export const SIDEBAR_WIDTH_MIN = 240
export const SIDEBAR_WIDTH_MAX = 480
export const SIDEBAR_WIDTH_DEFAULT = 280

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)))
}

/**
 * 任务归属连接的运行时状态（本地任务=undefined）。
 * TaskStatusDot 连接态着色叠加（5.5）/ TerminalPanel 断连冻结层（5.3）共用。
 */
export function connectionStateOfTask(
  s: Pick<AppState, 'projects' | 'connectionStates'>,
  task: Pick<TaskRecord, 'projectId'>
): ConnectionStateEntry | undefined {
  const connId = s.projects.find((p) => p.id === task.projectId)?.connectionId
  return connId !== undefined ? s.connectionStates[connId] : undefined
}

/** 该任务此刻是否输入冻结（远程任务且连接态非 connected）——TerminalPanel 键入兜底用 */
export function isTaskInputFrozen(taskId: string): boolean {
  const s = useAppStore.getState()
  const task = s.tasks.find((t) => t.id === taskId)
  if (!task) return false
  const entry = connectionStateOfTask(s, task)
  return entry !== undefined && entry.state !== 'connected'
}

/**
 * S5 接线桩：远程项目注册。现契约 CWBApi.addProject(dir) 单参（本地注册语义）；
 * S5 将扩展可选 connectionId（契约变更走主控编译红流程）。桩期以宽签名调用——
 * mock（test-helpers）与 S5 落地后的 preload 均按 (dir, connectionId) 生效，
 * S5 前的真实 main 桩忽略第二参（差异即 NEEDS_CONTEXT，已随 S6 报告上报）。
 */
async function addProjectWithConnection(dir: string, connectionId: string): Promise<ProjectRecord> {
  const fn = window.cwb.addProject as unknown as (
    dir: string,
    connectionId?: string
  ) => Promise<ProjectRecord>
  return fn(dir, connectionId)
}

/**
 * connectFlow 失败 → 判定「需安装/升级 cwb-server」的错误信号：S2 未定形结构化
 * 错误码前以文案标记匹配（mock/真实实现统一在 message 带 'needInstall' 或
 * 'cwb-server' 字样，6.7=A 首连推送确认弹窗由此触发）；S2 联通后升级为结构化信号。
 */
const NEED_INSTALL_RE = /needinstall|cwb-server/i

/**
 * connectFlow 失败 → 判定「TOFU 首连待确认」的错误信号：main 侧 ConnectionsConnect
 * 对 hostKeyConfirm 类错误按 NEED_INSTALL_RE 先例在 message 前缀 [cwb:host-key-confirm]
 * （IPC 错误只保 message，ConnectionError 自定义字段不穿越序列化）。
 */
const HOST_KEY_CONFIRM_RE = /host-key-confirm/i

/** 错误文案中内嵌指纹的提取（SHA256:base64(32B)=43 字符无填充，与 ssh-keygen -lf 同源） */
const FINGERPRINT_RE = /(SHA256:[A-Za-z0-9+/]{43})/

/** server 日志环形缓冲上限（8.1=A：仅脱敏元数据，弹窗进度展示够用即可） */
const SERVER_LOG_CAP = 100

/** sidebarWidth 落盘去抖计时器（模块级——拖拽高频写只留最后一拍） */
let sidebarWidthPersistTimer: number | null = null

// ── app store ──────────────────────────────────────────────────────────

interface AppState {
  projects: ProjectRecord[]
  tasks: TaskRecord[]
  selectedProjectId: string | null
  /** 已打开终端 tab 的任务 id，按打开顺序 */
  openTaskIds: string[]
  activeTaskId: string | null
  /**
   * 任务活动状态（v3.2 事件驱动）：taskId→'busy'|'awaiting'|'idle'。
   * 经 onTaskActivity 订阅落地（低频推送，入 zustand 可接受）；running 任务视觉
   * 优先查此表，无条目回退字节启发（见 statusVisual）。
   */
  activityMap: Partial<Record<string, TaskActivityEvent['activity']>>

  /** v0.5①/③：Skills 弹窗开合 + v0.9 设置中心——折叠 rail、侧栏按钮多入口共用。
   *  v1.2.1：关于并入设置中心（同一弹窗的「关于」分类），不再有独立 aboutOpen；
   *  v1.2.2：ⓘ 入口删除（用户指令只保留 Skills 与设置）——关于仍可从设置左栏进入 */
  skillsOpen: boolean
  settingsOpen: boolean
  /** v1.0.8 面板内搜索浮层（作用于 activeTaskId 终端） */
  searchOpen: boolean

  /** v1.1.0 应用更新检查结果（启动静默检查/手动检查落地；侧栏版本按钮角标消费） */
  appUpdateInfo: AppUpdateInfo | null
  setAppUpdateInfo: (info: AppUpdateInfo | null) => void

  /** v0.5.3 主题：三态偏好（持久化）+ 解析后的生效值（system 跟随时随 OS 切换刷新） */
  theme: Theme
  effectiveTheme: EffectiveTheme
  setTheme: (t: Theme) => void
  /** 终端跟随界面主题（默认关：claude TUI ANSI 彩色在浅底上不可读，评审④-1） */
  termFollowsTheme: boolean
  setTermFollowsTheme: (on: boolean) => void

  loadAll: () => Promise<void>
  selectProject: (id: string) => void
  /** 打开目录流：pickDirectory→取消(null)则中止→addProject→选中 */
  openProjectFlow: () => Promise<void>
  removeProjectFlow: (id: string) => Promise<void>
  renameProjectFlow: (id: string, name: string) => Promise<void>

  createTaskFlow: (projectId: string, name: string, opts: CreateTaskOptions) => Promise<void>
  stopTaskFlow: (taskId: string) => Promise<void>
  resumeTaskFlow: (taskId: string) => Promise<void>
  removeTaskFlow: (taskId: string, opts: RemoveTaskOptions) => Promise<void>
  renameTaskFlow: (taskId: string, name: string) => Promise<void>
  /** 切换单任务"跳过权限确认"（v0.3.1）：仅元数据，下次 spawn 生效 */
  setTaskSkipPermissionsFlow: (taskId: string, on: boolean) => Promise<void>
  /** v1.4 任务级 provider/model 修改：仅元数据，下次 spawn/resume 生效；modelMode:'auto'=CLI 自主 */
  setTaskProviderFlow: (
    taskId: string,
    opts: { providerId?: string; model?: string; modelMode?: 'auto' | '' }
  ) => Promise<void>

  /** v1.4 模型服务档案（启动 loadAll 拉取；任务行徽标/新建选择/编辑弹窗共用） */
  providers: ProviderRegistryState
  reloadProviders: () => Promise<void>

  // ── SSH 远程模式（S6）─────────────────────────────────────────────────
  /** 连接档案（启动拉取；设置中心「远程连接」与侧栏服务器节点数据源） */
  connections: ConnectionRecord[]
  /** 连接运行时状态（onConnectionState 推送落地；5.4=A 独立维度不落 tasks.json） */
  connectionStates: Record<string, ConnectionStateEntry>
  /** 远程 server 日志环形缓冲（≤100 条；安装弹窗进度消费。8.1=A 仅脱敏元数据） */
  serverLogs: RemoteServerLogEvent[]
  /** 侧栏持久化键（getAppSettings 启动拉取；写入经 setAppSettings） */
  uiSettings: SidebarPrefs
  /** server 安装/升级确认弹窗目标（connectFlow 的 needInstall 信号触发，6.7=A） */
  pendingServerInstall: { connectionId: string } | null
  /**
   * TOFU 首连待确认（connectFlow 的 hostKeyConfirm 信号触发——main 侧 ConnectionsConnect
   * 以 [cwb:host-key-confirm] token 前缀标记；设置页「测试连接」路径已有同等确认 UI，
   * 此处补齐侧栏/终端等直连入口：确认后写档案锁定指纹并自动重连）
   */
  pendingHostKeyConfirm: { connectionId: string; fingerprint: string } | null
  /** 保存连接档案的具体错误文案（saveConnectionFlow 失败落值；设置表单在通用文案旁展示） */
  connectionSaveError: string
  /** 连接失败的具体错误（connectFlow 非 needInstall/hostKeyConfirm 失败；轻提示浮层消费） */
  connectError: { connectionId: string; message: string } | null

  loadConnectionsFlow: () => Promise<void>
  /** 侧栏持久化键拉取（getAppSettings → uiSettings；loadAll 独立调用） */
  loadSidebarPrefs: () => Promise<void>
  /** 新增/编辑连接档案；失败返回 null（具体错误文案落 connectionSaveError） */
  saveConnectionFlow: (input: ConnectionRecord) => Promise<ConnectionRecord | null>
  /**
   * 删除连接档案（3.9=A 级联语义：仅删客户端记录与档案，不删 VM 内任何文件）。
   * 删除后重拉 projects 对齐 tasks 视图——项目/任务记录级联去留以 S2/S5 落地为准。
   */
  removeConnectionFlow: (id: string) => Promise<void>
  /** 手动连接（懒连接 2.5=a 之外的显式入口；状态迁移经 onConnectionState 推送） */
  connectFlow: (id: string) => Promise<void>
  /** TOFU 确认（HostKeyConfirmDialog）：锁定指纹到档案 → 自动重连 */
  confirmHostKeyFlow: (fingerprint: string) => Promise<void>
  /** 关闭 TOFU 确认弹窗（不确认、不重连） */
  dismissHostKeyConfirm: () => void
  /** 关闭连接失败提示 */
  dismissConnectError: () => void
  /** 断开（5.9=b：断开不杀远端会话，server 保活） */
  disconnectFlow: (id: string) => Promise<void>
  /**
   * 注册远程项目（3.1=C：手输 VM 绝对路径）。远端存在性/git 检测由 main 侧
   * addProject 链完成（存在性反馈=返回记录 isGit / 失败 error）。
   */
  registerRemoteProjectFlow: (
    connectionId: string,
    dir: string
  ) => Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }>
  /** onConnectionState 推送落地；迁入 connected 时触发 5.6 重连自动恢复 */
  applyConnectionState: (e: ConnectionStateChangedEvent) => void
  /** onRemoteServerLog 推送落地（环形 ≤100 条） */
  appendServerLog: (e: RemoteServerLogEvent) => void
  /** 侧栏持久化键动作（setAppSettings patch 落盘，失败静默——仅本会话生效） */
  setSidebarWidth: (px: number) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleServerNodeCollapsed: (connectionId: string) => void
  /** 关闭 server 安装确认弹窗（取消路径） */
  dismissServerInstall: () => void

  openTask: (taskId: string) => void
  /** 打开 tab 且任务非 running 时自动恢复（用户 v3.2 确认：点击=加载上下文）；2s 节流防抖 */
  openTaskAutoResume: (taskId: string) => void
  closeTab: (taskId: string) => void
  setActive: (taskId: string) => void
  /** onTaskUpdate 推送落地（存在则替换，不存在则追加） */
  applyTaskUpdate: (t: TaskRecord) => void
  /** onTaskActivity 推送落地（v3.2） */
  applyTaskActivity: (taskId: string, activity: TaskActivityEvent['activity']) => void

  openSkills: () => void
  closeSkills: () => void
  /** 打开设置中心（v1.2.2：ⓘ 入口已删，无直达分类需求——一律从「外观」进；
   *  S6 起可选 section/editConnectionId 直达「远程连接」分类/编辑目标档案） */
  openSettings: (section?: SettingsSectionId, editConnectionId?: string) => void
  closeSettings: () => void
  /** 设置中心打开时展示的分类（openSettings 直达用；关闭后保留无副作用） */
  settingsOpenSection: SettingsSectionId
  /** openSettings 携带的连接档案编辑目标（SettingsDialog 消费一次后自行管理） */
  settingsEditConnectionId: string | null
  /** v1.0.8 面板内搜索浮层（作用于当前活跃终端；切换 tab 自动关） */
  openSearch: () => void
  closeSearch: () => void
}

/** openTaskAutoResume 的 2s 节流表（防连击重复 resume） */
const autoResumeAt = new Map<string, number>()

/** v0.5.3 主题初始化：store 创建时读持久化并落 DOM（FOUC 内联脚本已设过——幂等重申） */
const initialTheme = loadTheme()
const initialEffective = resolveTheme(initialTheme)
applyDomTheme(initialEffective)

function upsertTask(tasks: TaskRecord[], t: TaskRecord): TaskRecord[] {
  return tasks.some((x) => x.id === t.id) ? tasks.map((x) => (x.id === t.id ? t : x)) : [...tasks, t]
}

export const useAppStore = create<AppState>()((set, get) => ({
  projects: [],
  tasks: [],
  selectedProjectId: null,
  openTaskIds: [],
  activeTaskId: null,
  activityMap: {},
  skillsOpen: false,
  settingsOpen: false,
  searchOpen: false,
  appUpdateInfo: null,
  theme: initialTheme,
  effectiveTheme: initialEffective,
  termFollowsTheme: loadTermFollowsTheme(),

  setTheme: (t) => {
    const eff = resolveTheme(t)
    set({ theme: t, effectiveTheme: eff })
    persistTheme(t)
    applyDomTheme(eff)
  },

  setTermFollowsTheme: (on) => {
    set({ termFollowsTheme: on })
    persistTermFollowsTheme(on)
  },

  loadAll: async () => {
    // v1.4 注：providers 档案不并入本批 Promise.all——延长全量加载完成时机会放大
    // "启动加载迟到覆盖并发变更"竞态（如用户秒点打开目录后被全量 set 抹掉），
    // 独立拉取只写自己的字段，零竞态面。
    // S6：connections 同理独立拉取（并发起跑、只写 connections 字段——批1 真实
    // listConnections 仍是 NotImplemented 桩，失败仅丢服务器分组不炸 projects/tasks；
    // 并入主 Promise.all 会给其落定加一拍，实测会翻动上述竞态，App.test 打开目录流变红）
    const connP = get().loadConnectionsFlow()
    try {
      const [projects, tasks] = await Promise.all([
        window.cwb.listProjects(),
        window.cwb.listTasks()
      ])
      set((s) => ({
        projects,
        tasks,
        selectedProjectId:
          s.selectedProjectId && projects.some((p) => p.id === s.selectedProjectId)
            ? s.selectedProjectId
            : (projects[0]?.id ?? null)
      }))
    } catch (err) {
      console.error('[cwb] loadAll failed:', err)
    }
    void connP
    void get().reloadProviders()
    void get().loadSidebarPrefs()
  },

  loadConnectionsFlow: async () => {
    try {
      set({ connections: await window.cwb.listConnections() })
    } catch (err) {
      console.error('[cwb] loadConnections failed:', err)
    }
  },

  loadSidebarPrefs: async () => {
    try {
      const s = await window.cwb.getAppSettings()
      set({
        uiSettings: {
          sidebarWidth:
            typeof s.sidebarWidth === 'number' ? clampSidebarWidth(s.sidebarWidth) : undefined,
          sidebarCollapsedPersist: s.sidebarCollapsedPersist === true,
          serverNodesCollapsed: s.serverNodesCollapsed ?? {}
        }
      })
    } catch (err) {
      console.error('[cwb] loadSidebarPrefs failed:', err)
    }
  },

  saveConnectionFlow: async (input) => {
    try {
      const saved = await window.cwb.saveConnection(input)
      set({ connectionSaveError: '' })
      await get().loadConnectionsFlow()
      return saved
    } catch (err) {
      console.error('[cwb] saveConnection failed:', err)
      // 具体错误文案透传 UI（「详见运行日志」在打包态对用户不可达——DevTools 不开）
      set({ connectionSaveError: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  removeConnectionFlow: async (id) => {
    try {
      await window.cwb.removeConnection(id)
    } catch (err) {
      console.error('[cwb] removeConnection failed:', err)
      return
    }
    // 级联语义（3.9=A）：VM 内文件不动；客户端记录以删除后的 listProjects 为准对齐
    // （S2/S5 决定是否连带删项目记录——mock 侧 projects 保留，孤儿远程项目回根级平铺）
    let projects: ProjectRecord[]
    try {
      projects = await window.cwb.listProjects()
    } catch (err) {
      console.error('[cwb] listProjects failed:', err)
      projects = get().projects
    }
    void get().loadConnectionsFlow()
    set((s) => {
      const ids = new Set(projects.map((p) => p.id))
      const tasks = s.tasks.filter((t) => ids.has(t.projectId))
      const openTaskIds = s.openTaskIds.filter((tid) => tasks.some((t) => t.id === tid))
      const activityMap = { ...s.activityMap }
      for (const t of s.tasks) if (!ids.has(t.projectId)) delete activityMap[t.id]
      const connectionStates = { ...s.connectionStates }
      delete connectionStates[id]
      const nodesCollapsed = { ...(s.uiSettings.serverNodesCollapsed ?? {}) }
      delete nodesCollapsed[id]
      return {
        projects,
        tasks,
        openTaskIds,
        activityMap,
        connectionStates,
        uiSettings: { ...s.uiSettings, serverNodesCollapsed: nodesCollapsed },
        selectedProjectId:
          s.selectedProjectId !== null && ids.has(s.selectedProjectId)
            ? s.selectedProjectId
            : (projects[0]?.id ?? null),
        activeTaskId:
          s.activeTaskId !== null && openTaskIds.includes(s.activeTaskId)
            ? s.activeTaskId
            : (openTaskIds[openTaskIds.length - 1] ?? null)
      }
    })
  },

  connectFlow: async (id) => {
    try {
      await window.cwb.connectConnection(id)
      set({ connectError: null })
      // 状态迁移不在此落地——A2 权属：ConnectionStateChanged 由 S2 唯一产生（经订阅回填）
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (NEED_INSTALL_RE.test(message)) {
        // 6.7=A 首连推送：server 组件缺失/需升级 → 确认弹窗（installRemoteServer
        // 的 promise 形态由弹窗消费）
        set({ pendingServerInstall: { connectionId: id } })
        return
      }
      // TOFU 首连（main 侧 [cwb:host-key-confirm] token；指纹内嵌于错误文案）→
      // 确认弹窗（设置页测试连接路径的同等语义——侧栏/终端直连入口补齐）
      if (HOST_KEY_CONFIRM_RE.test(message)) {
        const fingerprint = FINGERPRINT_RE.exec(message)?.[1]
        if (fingerprint !== undefined) {
          set({ pendingHostKeyConfirm: { connectionId: id, fingerprint } })
          return
        }
      }
      console.error('[cwb] connectConnection failed:', err)
      // 其余失败（refused/timeout/auth/自检阻断…）：具体文案浮出（此前仅
      // console.error——用户侧表现为「点了没反应」）
      set({ connectError: { connectionId: id, message } })
    }
  },

  confirmHostKeyFlow: async (fingerprint) => {
    const pending = get().pendingHostKeyConfirm
    if (pending === null) return
    set({ pendingHostKeyConfirm: null })
    const existing = get().connections.find((c) => c.id === pending.connectionId)
    if (existing === undefined) return
    // 照设置页 confirmHostKey 先例：指纹写入档案锁定 → 自动重连
    const saved = await get().saveConnectionFlow({ ...existing, lastHostKeyFingerprint: fingerprint })
    if (saved !== null) void get().connectFlow(pending.connectionId)
  },

  dismissHostKeyConfirm: () => set({ pendingHostKeyConfirm: null }),

  dismissConnectError: () => set({ connectError: null }),

  disconnectFlow: async (id) => {
    try {
      await window.cwb.disconnectConnection(id)
    } catch (err) {
      console.error('[cwb] disconnectConnection failed:', err)
    }
  },

  registerRemoteProjectFlow: async (connectionId, dir) => {
    let project: ProjectRecord
    try {
      project = await addProjectWithConnection(dir, connectionId)
    } catch (err) {
      console.error('[cwb] registerRemoteProject failed:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id)
        ? s.projects.map((p) => (p.id === project.id ? project : p))
        : [...s.projects, project],
      selectedProjectId: project.id
    }))
    return { ok: true, project }
  },

  applyConnectionState: (e) => {
    const prev = get().connectionStates[e.connectionId]
    set((s) => ({
      connectionStates: {
        ...s.connectionStates,
        [e.connectionId]: { state: e.state, ...(e.attempt !== undefined ? { attempt: e.attempt } : {}) }
      }
    }))
    // 5.6=A 重连自动恢复：迁入 connected 时，该连接下「视作运行中」的任务（5.9=b
    // server 保活——断连期间 status 仍为 running，含应用重启后的远程 running 记录）
    // 批量恢复视图。openTaskAutoResume 对 running 任务只开 tab 不重复 resume。
    if (e.state === 'connected' && prev?.state !== 'connected') {
      // S8 遗留清理（S6 报告建议）：安装成功 → 自动重连 → connected 迁移即收安装
      // 弹窗（pendingServerInstall 只服务「待确认安装」这一瞬时状态）
      if (get().pendingServerInstall?.connectionId === e.connectionId) {
        set({ pendingServerInstall: null })
      }
      const s = get()
      const connProjectIds = new Set(
        s.projects.filter((p) => p.connectionId === e.connectionId).map((p) => p.id)
      )
      for (const task of s.tasks) {
        if (task.status === 'running' && connProjectIds.has(task.projectId)) {
          s.openTaskAutoResume(task.id)
        }
      }
    }
  },

  appendServerLog: (e) =>
    set((s) => {
      const logs = [...s.serverLogs, e]
      return { serverLogs: logs.length > SERVER_LOG_CAP ? logs.slice(logs.length - SERVER_LOG_CAP) : logs }
    }),

  setSidebarWidth: (px) => {
    const width = clampSidebarWidth(px)
    set((s) => ({ uiSettings: { ...s.uiSettings, sidebarWidth: width } }))
    // 拖拽期间高频触发——落盘去抖（300ms），拖完只写一次
    if (sidebarWidthPersistTimer !== null) window.clearTimeout(sidebarWidthPersistTimer)
    sidebarWidthPersistTimer = window.setTimeout(() => {
      sidebarWidthPersistTimer = null
      window.cwb.setAppSettings({ sidebarWidth: width }).catch(() => {})
    }, 300)
  },

  setSidebarCollapsed: (collapsed) => {
    set((s) => ({ uiSettings: { ...s.uiSettings, sidebarCollapsedPersist: collapsed } }))
    window.cwb.setAppSettings({ sidebarCollapsedPersist: collapsed }).catch(() => {})
  },

  toggleServerNodeCollapsed: (connectionId) => {
    const cur = get().uiSettings.serverNodesCollapsed ?? {}
    const serverNodesCollapsed = { ...cur, [connectionId]: !cur[connectionId] }
    set((s) => ({ uiSettings: { ...s.uiSettings, serverNodesCollapsed } }))
    window.cwb.setAppSettings({ serverNodesCollapsed }).catch(() => {})
  },

  dismissServerInstall: () => set({ pendingServerInstall: null }),

  selectProject: (id) => set({ selectedProjectId: id }),

  openProjectFlow: async () => {
    let dir: string | null
    try {
      dir = await window.cwb.pickDirectory()
    } catch (err) {
      console.error('[cwb] pickDirectory failed:', err)
      return
    }
    if (dir === null) return // 用户取消 → 中止
    try {
      const project = await window.cwb.addProject(dir)
      set((s) => ({
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects.map((p) => (p.id === project.id ? project : p))
          : [...s.projects, project],
        selectedProjectId: project.id
      }))
    } catch (err) {
      console.error('[cwb] addProject failed:', err)
    }
  },

  removeProjectFlow: async (id) => {
    try {
      await window.cwb.removeProject(id)
    } catch (err) {
      console.error('[cwb] removeProject failed:', err)
      return
    }
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id)
      const tasks = s.tasks.filter((t) => t.projectId !== id)
      const openTaskIds = s.openTaskIds.filter((tid) => tasks.some((t) => t.id === tid))
      const activityMap = { ...s.activityMap }
      for (const t of s.tasks) if (t.projectId === id) delete activityMap[t.id]
      return {
        projects,
        tasks,
        openTaskIds,
        activityMap,
        selectedProjectId: s.selectedProjectId === id ? (projects[0]?.id ?? null) : s.selectedProjectId,
        activeTaskId:
          s.activeTaskId && openTaskIds.includes(s.activeTaskId)
            ? s.activeTaskId
            : (openTaskIds[openTaskIds.length - 1] ?? null)
      }
    })
  },

  renameProjectFlow: async (id, name) => {
    try {
      const project = await window.cwb.renameProject(id, name)
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }))
    } catch (err) {
      console.error('[cwb] renameProject failed:', err)
    }
  },

  createTaskFlow: async (projectId, name, opts) => {
    let task: TaskRecord
    try {
      task = await window.cwb.createTask(projectId, name, opts)
    } catch (err) {
      console.error('[cwb] createTask failed:', err)
      return
    }
    set((s) => ({
      tasks: upsertTask(s.tasks, task),
      openTaskIds: s.openTaskIds.includes(task.id) ? s.openTaskIds : [...s.openTaskIds, task.id],
      activeTaskId: task.id
    }))
  },

  stopTaskFlow: async (taskId) => {
    try {
      await window.cwb.stopTask(taskId)
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: 'stopped' as const } : t))
      }))
    } catch (err) {
      console.error('[cwb] stopTask failed:', err)
    }
  },

  resumeTaskFlow: async (taskId) => {
    try {
      const task = await window.cwb.resumeTask(taskId)
      set((s) => ({ tasks: upsertTask(s.tasks, task) }))
      // v3.2：刚恢复的绿色就绪窗由 main 侧 noteSpawn 广播 idle 落地（activityMap）
    } catch (err) {
      console.error('[cwb] resumeTask failed:', err)
    }
  },

  removeTaskFlow: async (taskId, opts) => {
    try {
      await window.cwb.removeTask(taskId, opts)
    } catch (err) {
      console.error('[cwb] removeTask failed:', err)
      return
    }
    closeTabIn(set, taskId)
    set((s) => {
      const activityMap = { ...s.activityMap }
      delete activityMap[taskId]
      return { tasks: s.tasks.filter((t) => t.id !== taskId), activityMap }
    })
  },

  renameTaskFlow: async (taskId, name) => {
    try {
      const task = await window.cwb.renameTask(taskId, name)
      set((s) => ({ tasks: upsertTask(s.tasks, task) }))
    } catch (err) {
      console.error('[cwb] renameTask failed:', err)
    }
  },

  setTaskSkipPermissionsFlow: async (taskId, on) => {
    try {
      const task = await window.cwb.setTaskSkipPermissions(taskId, on)
      set((s) => ({ tasks: upsertTask(s.tasks, task) }))
    } catch (err) {
      console.error('[cwb] setTaskSkipPermissions failed:', err)
    }
  },

  setTaskProviderFlow: async (taskId, opts) => {
    try {
      const task = await window.cwb.setTaskProvider(taskId, opts)
      set((s) => ({ tasks: upsertTask(s.tasks, task) }))
    } catch (err) {
      console.error('[cwb] setTaskProvider failed:', err)
    }
  },

  providers: { providers: [] },
  connections: [],
  connectionStates: {},
  serverLogs: [],
  uiSettings: {},
  pendingServerInstall: null,
  pendingHostKeyConfirm: null,
  connectionSaveError: '',
  connectError: null,
  settingsOpenSection: 'general',
  settingsEditConnectionId: null,

  reloadProviders: async () => {
    try {
      set({ providers: await window.cwb.listProviders() })
    } catch {
      // 读取失败保持现值（调用方 UI 不被抖动清空）
    }
  },

  openTask: (taskId) =>
    set((s) => ({
      openTaskIds: s.openTaskIds.includes(taskId) ? s.openTaskIds : [...s.openTaskIds, taskId],
      activeTaskId: taskId
    })),

  openTaskAutoResume: (taskId) => {
    get().openTask(taskId)
    const task = get().tasks.find((t) => t.id === taskId)
    // S6 懒连接（2.5=a）：点开远程任务先确保 SSH 连接建立（幂等；实际状态迁移经
    // onConnectionState 事件回填；spawn/resume 的远程路由与 re-attach 由 S4 接管）
    if (task !== undefined) {
      const connId = get().projects.find((p) => p.id === task.projectId)?.connectionId
      if (connId !== undefined) {
        const st = get().connectionStates[connId]?.state
        if (st !== 'connected' && st !== 'connecting') void get().connectFlow(connId)
      }
    }
    // 用户确认（v3.2）：点击任务/最近记录时若无已加载上下文（非 running）→ 默认恢复操作
    if (!task || task.status === 'running') return
    const last = autoResumeAt.get(taskId) ?? 0
    if (Date.now() - last < 2_000) return // 节流：连击/竞态不重复 resume
    autoResumeAt.set(taskId, Date.now())
    void get().resumeTaskFlow(taskId)
  },

  closeTab: (taskId) => closeTabIn(set, taskId),

  setActive: (taskId) => set({ activeTaskId: taskId }),

  applyTaskUpdate: (t) => set((s) => ({ tasks: upsertTask(s.tasks, t) })),

  applyTaskActivity: (taskId, activity) =>
    set((s) => ({ activityMap: { ...s.activityMap, [taskId]: activity } })),

  openSkills: () => set({ skillsOpen: true }),
  closeSkills: () => set({ skillsOpen: false }),
  openSettings: (section, editConnectionId) =>
    set({
      settingsOpen: true,
      settingsOpenSection: section ?? 'general',
      settingsEditConnectionId: editConnectionId ?? null
    }),
  closeSettings: () => set({ settingsOpen: false }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  setAppUpdateInfo: (info) => set({ appUpdateInfo: info })
}))

// v0.5.3 系统主题切换：偏好为 system 时重算 effectiveTheme 并刷 DOM；
// 终端经 store 订阅（effectiveTheme 变化）自动跟随。模块级注册一次——
// 不依赖 App mount（smoke 模式等任意渲染路径都生效），jsdom 测试下
// matchMedia 为 no-op stub（test-setup），注册无副作用。
onSystemThemeChange(() => {
  const { theme } = useAppStore.getState()
  if (theme !== 'system') return
  const eff = resolveTheme('system')
  if (eff === useAppStore.getState().effectiveTheme) return
  useAppStore.setState({ effectiveTheme: eff })
  applyDomTheme(eff)
})

/** 关 tab（仅视图）：openTaskIds 移除；若关的是 active 则收敛到剩余尾项 */
function closeTabIn(
  set: (partial: (s: AppState) => Partial<AppState>) => void,
  taskId: string
): void {
  set((s) => {
    const openTaskIds = s.openTaskIds.filter((x) => x !== taskId)
    return {
      openTaskIds,
      activeTaskId:
        s.activeTaskId === taskId ? (openTaskIds[openTaskIds.length - 1] ?? null) : s.activeTaskId
    }
  })
}

// ── 全局事件监听（App mount 时调用一次）────────────────────────────────

/**
 * 接入 preload 事件：onPtyData → emitTaskData 分发器；onTaskUpdate → store 落地；
 * onTaskActivity → activityMap 落地（v3.2）。返回清理函数（unmount 时全部退订）。
 */
export function initListeners(): () => void {
  const offPty = window.cwb.onPtyData(emitTaskData)
  const offTask = window.cwb.onTaskUpdate((t) => {
    useAppStore.getState().applyTaskUpdate(t)
  })
  const offActivity = window.cwb.onTaskActivity((e) => {
    useAppStore.getState().applyTaskActivity(e.taskId, e.activity)
  })
  // S6（A2 装配消费侧）：连接状态由 S2 唯一产生（S1 挂钩 broadcast）→ 落 store；
  // server 日志（S3 产生/S4 桥接）→ 环形缓冲
  const offConnState = window.cwb.onConnectionState((e) => {
    useAppStore.getState().applyConnectionState(e)
  })
  const offServerLog = window.cwb.onRemoteServerLog((e) => {
    useAppStore.getState().appendServerLog(e)
  })
  return () => {
    offPty()
    offTask()
    offActivity()
    offConnState()
    offServerLog()
  }
}
