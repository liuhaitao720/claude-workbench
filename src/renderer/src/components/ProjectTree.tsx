import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ProjectRecord, TaskRecord } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { TaskStatusDot } from './TaskStatusDot'
import { SidebarMenu } from './SidebarMenu'
import type { MenuItemDef } from './SidebarMenu'

/** 时间分组阈值（S6-C）：项目内任务数 > 该值才启用分组，≤3 平铺（可调常量） */
const TASK_GROUP_THRESHOLD = 3

/** 溢出菜单互斥（S6-B）：全树同一时刻至多一个菜单开着——点其他行 ⋯ 自动换开 */
const MenuOpenCtx = createContext<{ openKey: string | null; setOpenKey: (k: string | null) => void }>(
  { openKey: null, setOpenKey: () => {} }
)

/**
 * 项目树（S6 v0.3 ChatGPT 式改版）：
 * - 行单行化（B）：项目=caret+名称+git 徽标（dir→tooltip）；任务=状态点+名称（cwd→tooltip）
 * - hover 单「⋯」溢出菜单（B）；双击行名=重命名，单击任务行=开 tab
 * - 时间分组（C）：任务数 > TASK_GROUP_THRESHOLD 时按 今天/昨天/近 7 天/更早 分组
 * - 搜索过滤（A）：命中项目名/dir/cwd 子串（不区分大小写）；命中任务自动展开父项目；
 *   搜索态分组禁用（命中平铺），强制展开只覆盖 display 不动 collapsed 集——清空恢复原状
 * - 折叠仍用 CSS 隐藏保挂载（v0.1.2 评审 F5）：重命名草稿/删除勾选不因折叠丢失
 */
export function ProjectTree({
  query,
  onNewTask
}: {
  query: string
  /** 项目菜单「新建任务」入口：预选中该项目并打开顶部新建对话框（见 ProjectSidebar） */
  onNewTask: (projectId: string) => void
}) {
  const t = useI18n()
  const projects = useAppStore((s) => s.projects)
  const tasks = useAppStore((s) => s.tasks)
  /** 折叠集（默认空集=全部展开；新增项目天然展开） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [openKey, setOpenKey] = useState<string | null>(null)

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 搜索过滤：项目名/dir 命中→整树保留；仅任务命中→父项目保留+只显示命中任务
  const q = query.trim().toLowerCase()
  const visible = projects
    .map((p): { project: ProjectRecord; tasks: TaskRecord[] } | null => {
      const all = tasks.filter((t) => t.projectId === p.id)
      if (!q) return { project: p, tasks: all }
      const projectHit =
        p.name.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q)
      if (projectHit) return { project: p, tasks: all }
      const taskHit = all.filter(
        (t) => t.name.toLowerCase().includes(q) || t.cwd.toLowerCase().includes(q)
      )
      if (taskHit.length > 0) return { project: p, tasks: taskHit }
      return null
    })
    .filter((x): x is { project: ProjectRecord; tasks: TaskRecord[] } => x !== null)

  return (
    <MenuOpenCtx.Provider value={{ openKey, setOpenKey }}>
      {q !== '' && visible.length === 0 ? (
        <div className="search-empty">{t('tree.noMatch')}</div>
      ) : (
        <ul className="project-list">
          {visible.map(({ project, tasks: pTasks }) => (
            <ProjectNode
              key={project.id}
              project={project}
              tasks={pTasks}
              /* 搜索态强制展开（仅视觉），不动 collapsed 集——清空即恢复 */
              expanded={q !== '' ? true : !collapsed.has(project.id)}
              searching={q !== ''}
              onToggle={() => toggle(project.id)}
              onNewTask={onNewTask}
            />
          ))}
        </ul>
      )}
    </MenuOpenCtx.Provider>
  )
}

function ProjectNode({
  project,
  tasks,
  expanded,
  searching,
  onToggle,
  onNewTask
}: {
  project: ProjectRecord
  tasks: TaskRecord[]
  expanded: boolean
  searching: boolean
  onToggle: () => void
  onNewTask: (projectId: string) => void
}) {
  const t = useI18n()
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const selectProject = useAppStore((s) => s.selectProject)
  const removeProjectFlow = useAppStore((s) => s.removeProjectFlow)
  const renameProjectFlow = useAppStore((s) => s.renameProjectFlow)
  const { openKey, setOpenKey } = useContext(MenuOpenCtx)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const menuKey = `project:${project.id}`
  const menuOpen = openKey === menuKey

  const commitRename = () => {
    const name = draft.trim()
    if (name && name !== project.name) void renameProjectFlow(project.id, name)
    setRenaming(false)
  }

  const menuItems: MenuItemDef[] = [
    { label: t('tree.newTask'), onClick: () => onNewTask(project.id) },
    { label: t('tree.rename'), onClick: () => setRenaming(true) },
    {
      label: t('tree.remove'),
      danger: true,
      onClick: () => {
        if (window.confirm(t('tree.removeConfirm', { name: project.name }))) {
          void removeProjectFlow(project.id)
        }
      }
    }
  ]

  return (
    <li
      className={project.id === selectedProjectId ? 'project-row selected' : 'project-row'}
      data-project-id={project.id}
    >
      <div className="project-node-main">
        <button
          type="button"
          className="tree-caret"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('tree.collapseTasks', { name: project.name })
              : t('tree.expandTasks', { name: project.name })
          }
          title={expanded ? t('tree.collapse') : t('tree.expand')}
        >
          {expanded ? '▾' : '▸'}
        </button>
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <>
            {/* 单行项目行（B）：名称+git 徽标；dir 移 tooltip；双击=重命名 */}
            <button
              type="button"
              className="project-main"
              onClick={() => selectProject(project.id)}
              onDoubleClick={() => setRenaming(true)}
              title={project.dir}
            >
              <span className="project-name">{project.name}</span>
              {project.isGit && <span className="git-badge">git</span>}
            </button>
            <RowMenuButton
              ref={menuBtnRef}
              ariaLabel={t('tree.projectActions')}
              open={menuOpen}
              onToggle={() => setOpenKey(menuOpen ? null : menuKey)}
            />
          </>
        )}
      </div>
      {menuOpen && (
        <SidebarMenu triggerRef={menuBtnRef} items={menuItems} onClose={() => setOpenKey(null)} />
      )}
      {/* 折叠用 CSS 隐藏而非条件卸载（v0.1.2 评审 F5）：保留子树本地状态——
          重命名草稿/删除确认勾选不因误点折叠丢失 */}
      <div className="project-children" style={expanded ? undefined : { display: 'none' }}>
        {/* v0.9.1 用户指令：移除非 git 项目的常驻提示横幅（原"共享目录模式——建议 git init"） */}
        {/* 搜索命中平铺（分组仅常规态启用，评审 F12） */}
        {searching ? (
          <TaskFlatList tasks={tasks} />
        ) : (
          <TaskGroups tasks={tasks} />
        )}
        {tasks.length === 0 && <div className="task-empty">{t('tree.noTasks')}</div>}
      </div>
    </li>
  )
}

// ── 任务列表：平铺 / 时间分组（S6-C） ────────────────────────────────────

type GroupKey = 'today' | 'yesterday' | 'week' | 'older'

const GROUP_ORDER: readonly GroupKey[] = ['today', 'yesterday', 'week', 'older']
const GROUP_LABEL_KEYS: Readonly<Record<GroupKey, MessageKey>> = {
  today: 'tree.groupToday',
  yesterday: 'tree.groupYesterday',
  week: 'tree.groupWeek',
  older: 'tree.groupOlder'
}

/** now 往前 days 个日历日的 00:00（日历算术，避开毫秒减法的午夜/DST 偏差） */
function startOfDayShifted(now: number, days: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 近 7 天=含今天共 7 个日历日窗口（today-6..today）中非今天/昨天部分 */
function bucketOf(lastActiveAt: string, now: number): GroupKey {
  const t = Date.parse(lastActiveAt)
  if (Number.isNaN(t)) return 'older' // 防御：坏时间戳归「更早」
  if (t >= startOfDayShifted(now, 0)) return 'today'
  if (t >= startOfDayShifted(now, 1)) return 'yesterday'
  if (t >= startOfDayShifted(now, 6)) return 'week'
  return 'older'
}

function byLastActiveDesc(a: TaskRecord, b: TaskRecord): number {
  return Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)
}

function TaskFlatList({ tasks }: { tasks: TaskRecord[] }) {
  const sorted = [...tasks].sort(byLastActiveDesc)
  return (
    <ul className="task-rows">
      {sorted.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </ul>
  )
}

function TaskGroups({ tasks }: { tasks: TaskRecord[] }) {
  const t = useI18n()
  /** 组折叠集（默认全展开；同 F5 原则用 display 隐藏保挂载） */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<GroupKey>>(new Set())

  if (tasks.length <= TASK_GROUP_THRESHOLD) return <TaskFlatList tasks={tasks} />

  const now = Date.now()
  const groups = GROUP_ORDER.map((key) => ({
    key,
    list: tasks.filter((t) => bucketOf(t.lastActiveAt, now) === key).sort(byLastActiveDesc)
  })).filter((g) => g.list.length > 0)

  const toggleGroup = (key: GroupKey) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <>
      {groups.map(({ key, list }) => {
        const folded = collapsedGroups.has(key)
        return (
          <div key={key} className="task-group" data-group={key}>
            <button
              type="button"
              className="task-group-header"
              aria-expanded={!folded}
              onClick={() => toggleGroup(key)}
            >
              <span className="task-group-caret">{folded ? '▸' : '▾'}</span>
              {GROUP_LABEL_KEYS[key] !== undefined && t(GROUP_LABEL_KEYS[key])}
              <span className="task-group-count">{list.length}</span>
            </button>
            <ul className="task-rows" style={folded ? { display: 'none' } : undefined}>
              {list.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}

// ── 任务行（单行化 + ⋯ 菜单 + 双击重命名 + active 高亮） ────────────────

function TaskRow({ task }: { task: TaskRecord }) {
  const t = useI18n()
  const openTaskAutoResume = useAppStore((s) => s.openTaskAutoResume)
  const stopTaskFlow = useAppStore((s) => s.stopTaskFlow)
  const resumeTaskFlow = useAppStore((s) => s.resumeTaskFlow)
  const removeTaskFlow = useAppStore((s) => s.removeTaskFlow)
  const renameTaskFlow = useAppStore((s) => s.renameTaskFlow)
  const setTaskSkipPermissionsFlow = useAppStore((s) => s.setTaskSkipPermissionsFlow)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const { openKey, setOpenKey } = useContext(MenuOpenCtx)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState(task.name)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  /** 单击开 tab 的延迟判别计时器（评审 F1）：双击时取消，卸载时清理 */
  const clickTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    }
  }, [])
  const menuKey = `task:${task.id}`
  const menuOpen = openKey === menuKey

  const commitRename = () => {
    const name = draft.trim()
    if (name && name !== task.name) void renameTaskFlow(task.id, name)
    setRenaming(false)
  }

  const menuItems: MenuItemDef[] = [
    // v0.5①：移除「打开」——与单击任务行完全重复（v0.4.1 后单击即开+自动恢复）
    task.status === 'running'
      ? { label: t('tree.stop'), onClick: () => void stopTaskFlow(task.id) }
      : { label: t('tree.resume'), onClick: () => void resumeTaskFlow(task.id) },
    { label: t('tree.rename'), onClick: () => setRenaming(true) },
    {
      // 单任务"跳过权限确认"切换（v0.3.1）：显示当前状态；仅元数据，下次 spawn（恢复）生效
      label: t(task.skipPermissions ? 'tree.skipPermsOn' : 'tree.skipPermsOff'),
      onClick: () => void setTaskSkipPermissionsFlow(task.id, task.skipPermissions !== true)
    },
    {
      label: t('tree.copySessionId'),
      onClick: () => {
        // renderer 权限内（spec v0.3 约束）：jsdom/未聚焦场景无 clipboard 时静默跳过
        void navigator.clipboard?.writeText(task.sessionId)
      }
    },
    { label: t('tree.delete'), danger: true, onClick: () => setDeleting(true) }
  ]

  return (
    <li
      className={task.id === activeTaskId ? 'task-row active' : 'task-row'}
      data-task-id={task.id}
    >
      <TaskStatusDot task={task} />
      {renaming ? (
        <input
          className="rename-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <>
          {/* 单行任务行（B）：名称；cwd 移 tooltip；单击=开 tab，双击=重命名。
              评审 F1：单击延迟 250ms 判别双击——双击重命名不再先触发两次 openTask
              把终端 tab 抢先打开并置为 active */}
          <button
            type="button"
            className="task-main"
            onClick={() => {
              if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
              clickTimerRef.current = window.setTimeout(() => {
                clickTimerRef.current = null
                openTaskAutoResume(task.id)
              }, 250)
            }}
            onDoubleClick={() => {
              if (clickTimerRef.current !== null) {
                window.clearTimeout(clickTimerRef.current)
                clickTimerRef.current = null
              }
              setRenaming(true)
            }}
            title={task.cwd}
          >
            <span className="task-name">{task.name}</span>
            <ElapsedChip status={task.status} since={task.lastActiveAt} />
            {task.skipPermissions === true && (
              <span
                className="skip-perm-badge"
                title={t('tree.skipPermsBadge')}
              >
                ⚡
              </span>
            )}
          </button>
          <RowMenuButton
            ref={menuBtnRef}
            ariaLabel={t('tree.taskActions')}
            open={menuOpen}
            onToggle={() => setOpenKey(menuOpen ? null : menuKey)}
          />
        </>
      )}
      {menuOpen && (
        <SidebarMenu triggerRef={menuBtnRef} items={menuItems} onClose={() => setOpenKey(null)} />
      )}
      {deleting && (
        <DeleteTaskDialog
          name={task.name}
          hasWorktree={task.worktreePath !== undefined}
          onClose={() => setDeleting(false)}
          onConfirm={(deleteWorktree) => {
            setDeleting(false)
            void removeTaskFlow(task.id, { deleteWorktree })
          }}
        />
      )}
    </li>
  )
}

/** 删除确认弹窗（独立组件：仅 deleting 时挂载——Escape 监听随挂载增减，A1） */
function DeleteTaskDialog({
  name,
  hasWorktree,
  onClose,
  onConfirm
}: {
  name: string
  hasWorktree: boolean
  onClose: () => void
  onConfirm: (deleteWorktree: boolean) => void
}) {
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  const t = useI18n()
  // A1：document 级 Escape + 遮罩空白点击关闭（对齐 About/Skills/新建任务基线）
  useEscapeClose(onClose)

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-label={t('tree.deleteAria')}>
        <p className="dialog-title">{t('tree.deleteTitle', { name })}</p>
        {hasWorktree && (
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={deleteWorktree}
              onChange={(e) => setDeleteWorktree(e.target.checked)}
            />
            {t('tree.deleteWorktree')}
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn danger" onClick={() => onConfirm(deleteWorktree)}>
            {t('tree.confirmDelete')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 「⋯」按钮（hover 露出，CSS 控制；jsdom 无 CSS 不影响测试可达性） ─────

function RowMenuButton({
  ref,
  ariaLabel,
  open,
  onToggle
}: {
  ref: RefObject<HTMLButtonElement | null>
  ariaLabel: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="row-more"
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={open}
      title={ariaLabel}
      onClick={onToggle}
    >
      ⋯
    </button>
  )
}

// ── v0.3.2/3.3 状态辅助 ────────────────────────────────────────────────

/** 运行时长（v0.3.2）：running 任务行显示 Xm / Xh Ym；自 lastActiveAt（spawn/resume 时刷新）起算，30s 自刷新 */
function ElapsedChip({ status, since }: { status: TaskRecord['status']; since: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (status !== 'running') return
    const timer = window.setInterval(() => tick((v) => v + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [status])
  if (status !== 'running') return null
  const ms = Date.now() - Date.parse(since)
  if (!Number.isFinite(ms) || ms < 60_000) return null
  const mins = Math.floor(ms / 60_000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return <span className="task-elapsed">{h > 0 ? `${h}h ${m}m` : `${m}m`}</span>
}
