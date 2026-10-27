import { create } from 'zustand'
import type {
  AppUpdateInfo,
  CreateTaskOptions,
  ProjectRecord,
  PtyDataEvent,
  RemoveTaskOptions,
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

  /** v0.5①/③：About / Skills 弹窗开合 + v0.9 设置中心——StatusBar、折叠 rail、侧栏按钮多入口共用 */
  aboutOpen: boolean
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

  openTask: (taskId: string) => void
  /** 打开 tab 且任务非 running 时自动恢复（用户 v3.2 确认：点击=加载上下文）；2s 节流防抖 */
  openTaskAutoResume: (taskId: string) => void
  closeTab: (taskId: string) => void
  setActive: (taskId: string) => void
  /** onTaskUpdate 推送落地（存在则替换，不存在则追加） */
  applyTaskUpdate: (t: TaskRecord) => void
  /** onTaskActivity 推送落地（v3.2） */
  applyTaskActivity: (taskId: string, activity: TaskActivityEvent['activity']) => void

  openAbout: () => void
  closeAbout: () => void
  openSkills: () => void
  closeSkills: () => void
  openSettings: () => void
  closeSettings: () => void
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
  aboutOpen: false,
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
  },

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

  openTask: (taskId) =>
    set((s) => ({
      openTaskIds: s.openTaskIds.includes(taskId) ? s.openTaskIds : [...s.openTaskIds, taskId],
      activeTaskId: taskId
    })),

  openTaskAutoResume: (taskId) => {
    get().openTask(taskId)
    const task = get().tasks.find((t) => t.id === taskId)
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

  openAbout: () => set({ aboutOpen: true }),
  closeAbout: () => set({ aboutOpen: false }),
  openSkills: () => set({ skillsOpen: true }),
  closeSkills: () => set({ skillsOpen: false }),
  openSettings: () => set({ settingsOpen: true }),
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
  return () => {
    offPty()
    offTask()
    offActivity()
  }
}
