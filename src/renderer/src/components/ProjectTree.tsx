import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ConnectionRecord, ConnectionRuntimeState, ProjectRecord, TaskRecord } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { TaskStatusDot } from './TaskStatusDot'
import { SidebarMenu } from './SidebarMenu'
import type { MenuItemDef } from './SidebarMenu'
import { connStateText } from './statusVisual'
import { RemoteProjectDialog } from './RemoteProjectDialog'

/** 时间分组阈值（S6-C）：项目内任务数 > 该值才启用分组，≤3 平铺（可调常量） */
const TASK_GROUP_THRESHOLD = 3

/** 溢出菜单互斥（S6-B）：全树同一时刻至多一个菜单开着——点其他行 ⋯ 自动换开 */
const MenuOpenCtx = createContext<{ openKey: string | null; setOpenKey: (k: string | null) => void }>(
  { openKey: null, setOpenKey: () => {} }
)

/** 树条目：项目 + 过滤后任务（本地根级与服务器子级共用形状） */
interface TreeEntry {
  project: ProjectRecord
  tasks: TaskRecord[]
}

/**
 * 项目树（S6 v0.3 ChatGPT 式改版 + SSH 远程分组树 3.5/3.6/3.11=a）：
 * - 本机项目根级平铺（3.6=a：无远程配置时与现状完全一致）；服务器=轻分组头
 *   （小字号浅色行：名称+四态状态胶囊+⋯ 菜单），其远程项目沿用项目>任务树
 * - 断连（offline）时服务器节点置灰但子项目可管理（3.5：树从持久化元数据渲染）
 * - 服务器节点折叠态持久化到 serverNodesCollapsed（3.8=A，经 setAppSettings）；
 *   项目级折叠仍为会话内 state（原行为不变）
 * - 服务器双入口菜单（3.9=a：右键 + 悬浮 ⋯，复用 SidebarMenu 体系）
 * - 搜索过滤（A）：项目名/dir、任务名/cwd、服务器名/host 命中；命中服务器=整组保留
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
  const connections = useAppStore((s) => s.connections)
  // 注意不能写 `s.uiSettings.serverNodesCollapsed ?? {}`——选择器须返回稳定引用
  //（undefined 时每次新建 {} 会触发 zustand 无限重渲），缺省在用点处理
  const serverNodesCollapsed = useAppStore((s) => s.uiSettings.serverNodesCollapsed)
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
  const buildEntry = (p: ProjectRecord): TreeEntry | null => {
    const all = tasks.filter((task) => task.projectId === p.id)
    if (!q) return { project: p, tasks: all }
    const projectHit =
      p.name.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q)
    if (projectHit) return { project: p, tasks: all }
    const taskHit = all.filter(
      (task) => task.name.toLowerCase().includes(q) || task.cwd.toLowerCase().includes(q)
    )
    if (taskHit.length > 0) return { project: p, tasks: taskHit }
    return null
  }
  const keepNonNull = (x: TreeEntry | null): x is TreeEntry => x !== null

  // 根级=本机项目 + 孤儿远程项目（connectionId 指向已删档案——3.9 删除不级联时回根级兜底）
  const connIds = new Set(connections.map((c) => c.id))
  const localEntries = projects
    .filter((p) => p.connectionId === undefined || !connIds.has(p.connectionId))
    .map(buildEntry)
    .filter(keepNonNull)

  // 服务器分组：命中服务器名/host → 整组保留（子项目不再逐个过滤）
  const serverGroups = connections
    .map((conn) => {
      const serverHit = q !== '' && (conn.name.toLowerCase().includes(q) || conn.host.toLowerCase().includes(q))
      const entries = projects
        .filter((p) => p.connectionId === conn.id)
        .map((p) => (serverHit ? { project: p, tasks: tasks.filter((task) => task.projectId === p.id) } : buildEntry(p)))
        .filter(keepNonNull)
      if (q !== '' && !serverHit && entries.length === 0) return null
      return { conn, entries }
    })
    .filter((g): g is { conn: ConnectionRecord; entries: TreeEntry[] } => g !== null)

  const noMatch =
    q !== '' && localEntries.length === 0 && serverGroups.length === 0

  return (
    <MenuOpenCtx.Provider value={{ openKey, setOpenKey }}>
      {noMatch ? (
        <div className="search-empty">{t('tree.noMatch')}</div>
      ) : (
        <ul className="project-list">
          {localEntries.map(({ project, tasks: pTasks }) => (
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
          {serverGroups.map(({ conn, entries }) => (
            <ServerNode
              key={conn.id}
              connection={conn}
              entries={entries}
              expanded={q !== '' ? true : serverNodesCollapsed?.[conn.id] !== true}
              searching={q !== ''}
              onNewTask={onNewTask}
            />
          ))}
        </ul>
      )}
    </MenuOpenCtx.Provider>
  )
}

/**
 * 服务器节点（3.11=a 轻分组头）：小字号浅色行=折叠 caret+名称+四态状态胶囊+⋯；
 * 断连（offline）置灰（data-conn 驱动 CSS）但子项目可管理（3.5）。
 * 折叠态持久化经 store.toggleServerNodeCollapsed（3.8）。
 */
function ServerNode({
  connection,
  entries,
  expanded,
  searching,
  onNewTask
}: {
  connection: ConnectionRecord
  entries: TreeEntry[]
  expanded: boolean
  searching: boolean
  onNewTask: (projectId: string) => void
}) {
  const t = useI18n()
  const entry = useAppStore((s) => s.connectionStates[connection.id])
  const state: ConnectionRuntimeState = entry?.state ?? 'offline'
  const connectFlow = useAppStore((s) => s.connectFlow)
  const disconnectFlow = useAppStore((s) => s.disconnectFlow)
  const toggleServerNodeCollapsed = useAppStore((s) => s.toggleServerNodeCollapsed)
  const openSettings = useAppStore((s) => s.openSettings)
  const { openKey, setOpenKey } = useContext(MenuOpenCtx)
  const [deleting, setDeleting] = useState(false)
  const [registering, setRegistering] = useState(false)
  /** 组内项目折叠集（会话内 state，对齐根级项目折叠原行为） */
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set())
  /** 右键菜单光标锚点（null=由 ⋯ 按钮定位）——3.9=a 双入口 */
  const [ctxAnchor, setCtxAnchor] = useState<{ x: number; y: number } | null>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  /** 占位 ref：右键锚点模式下满足 SidebarMenu 的 triggerRef 契约（终端右键菜单先例） */
  const nullBtnRef = useRef<HTMLButtonElement>(null)
  const menuKey = `conn:${connection.id}`
  const menuOpen = openKey === menuKey

  const closeMenu = () => {
    setOpenKey(null)
    setCtxAnchor(null)
  }

  const menuItems: MenuItemDef[] = [
    state === 'connected'
      ? { label: t('conn.menu.disconnect'), onClick: () => void disconnectFlow(connection.id) }
      : { label: t('conn.menu.connect'), onClick: () => void connectFlow(connection.id) },
    {
      label: t('conn.menu.edit'),
      onClick: () => openSettings('connections', connection.id)
    },
    { label: t('conn.menu.newProject'), onClick: () => setRegistering(true) },
    {
      label: t('tree.delete'),
      danger: true,
      onClick: () => setDeleting(true)
    }
  ]

  return (
    <li
      className="server-node"
      data-connection-id={connection.id}
      data-conn={state}
    >
      <div
        className="server-row"
        onContextMenu={(e) => {
          e.preventDefault()
          setCtxAnchor({ x: e.clientX, y: e.clientY })
          setOpenKey(menuKey)
        }}
      >
        <button
          type="button"
          className="tree-caret"
          onClick={() => toggleServerNodeCollapsed(connection.id)}
          aria-expanded={expanded}
          aria-label={t(expanded ? 's6.collapseServer' : 's6.expandServer', { name: connection.name })}
          title={t(expanded ? 's6.collapseServer' : 's6.expandServer', { name: connection.name })}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="server-name" title={`${connection.user}@${connection.host}:${connection.port}`}>
          {connection.name}
        </span>
        <span className="conn-pill" data-state={state} title={connStateText(t, state, entry?.attempt)}>
          {connStateText(t, state, entry?.attempt)}
        </span>
        <RowMenuButton
          ref={menuBtnRef}
          ariaLabel={t('s6.serverActions')}
          open={menuOpen}
          onToggle={() => {
            if (menuOpen) closeMenu()
            else {
              setCtxAnchor(null)
              setOpenKey(menuKey)
            }
          }}
        />
      </div>
      {menuOpen && (
        <SidebarMenu
          triggerRef={ctxAnchor !== null ? nullBtnRef : menuBtnRef}
          anchor={ctxAnchor ?? undefined}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      {registering && (
        <RemoteProjectDialog
          presetConnectionId={connection.id}
          onClose={() => setRegistering(false)}
        />
      )}
      {deleting && (
        <DeleteServerDialog connection={connection} onClose={() => setDeleting(false)} />
      )}
      {/* 折叠用 CSS 隐藏而非条件卸载（对齐项目级折叠 F5 原则：子树本地状态不因折叠丢失） */}
      <div className="server-children" style={expanded ? undefined : { display: 'none' }}>
        {entries.map(({ project, tasks: pTasks }) => (
          <ProjectNode
            key={project.id}
            project={project}
            tasks={pTasks}
            expanded={!collapsedProjects.has(project.id)}
            searching={searching}
            onToggle={() =>
              setCollapsedProjects((prev) => {
                const next = new Set(prev)
                if (next.has(project.id)) next.delete(project.id)
                else next.add(project.id)
                return next
              })
            }
            onNewTask={onNewTask}
          />
        ))}
        {entries.length === 0 && <div className="task-empty">{t('tree.noTasks')}</div>}
      </div>
    </li>
  )
}

/**
 * 删除服务器级联确认（3.9=A）：文案显式承诺「仅删客户端记录与连接档案，不删
 * VM 内任何文件」，并列出将一并移除的客户端侧记录数（实际级联去留以 S2/S5 为准）。
 */
function DeleteServerDialog({
  connection,
  onClose
}: {
  connection: ConnectionRecord
  onClose: () => void
}) {
  const t = useI18n()
  const removeConnectionFlow = useAppStore((s) => s.removeConnectionFlow)
  const projects = useAppStore((s) => s.projects)
  const tasks = useAppStore((s) => s.tasks)
  useEscapeClose(onClose)

  const remoteProjects = projects.filter((p) => p.connectionId === connection.id)
  const remoteTaskCount = tasks.filter((task) =>
    remoteProjects.some((p) => p.id === task.projectId)
  ).length

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-label={t('s6.removeServerTitle', { name: connection.name })}>
        <p className="dialog-title">{t('s6.removeServerTitle', { name: connection.name })}</p>
        <p className="dialog-hint">{t('conn.menu.removeConfirm')}</p>
        <p className="dialog-hint">
          {t('s6.removeServerAffects', { projects: remoteProjects.length, tasks: remoteTaskCount })}
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              onClose()
              void removeConnectionFlow(connection.id)
            }}
          >
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
  /** v1.4 徽标文案：provider 名（档案已删则回退 id——语义仍是"指定了 provider"） */
  const providers = useAppStore((s) => s.providers)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const { openKey, setOpenKey } = useContext(MenuOpenCtx)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
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
      // v1.4 任务级 provider/model：弹小编辑框；仅元数据，下次 spawn（恢复）生效
      label: t('tree.setProvider'),
      onClick: () => setProviderOpen(true)
    },
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
            {task.providerId !== undefined && (
              <span
                className="provider-chip"
                title={t('tree.providerBadgeTitle', {
                  name: providers.providers.find((p) => p.id === task.providerId)?.name ?? task.providerId,
                  model: task.model !== undefined && task.model !== '' ? ` · ${task.model}` : ''
                })}
              >
                {providers.providers.find((p) => p.id === task.providerId)?.name ?? 'API'}
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
      {providerOpen && <TaskProviderDialog task={task} onClose={() => setProviderOpen(false)} />}
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
/**
 * v1.4 任务级模型服务编辑弹窗（菜单「模型服务…」）：provider 单选（含「跟随默认」）
 * + model datalist 手填；保存调 setTaskProviderFlow（仅元数据，下次 spawn 生效）。
 * 表单交互与新建任务 ProviderPick 同构（单选 pills + datalist），数据同源 store.providers。
 */
function TaskProviderDialog({
  task,
  onClose
}: {
  task: TaskRecord
  onClose: () => void
}) {
  const t = useI18n()
  const providers = useAppStore((s) => s.providers)
  const setTaskProviderFlow = useAppStore((s) => s.setTaskProviderFlow)
  const [providerId, setProviderId] = useState<string | undefined>(task.providerId)
  // v1.4 模型三态：'auto'=CLI 自主 / ''（mode 'fixed'）=固定 model / undefined=跟随缺省
  const [model, setModel] = useState(task.model ?? (task.modelMode === 'auto' ? undefined : ''))
  const [modelMode, setModelMode] = useState<'auto' | undefined>(task.modelMode)
  const [saved, setSaved] = useState(false)
  useEscapeClose(onClose)
  const selected = providers.providers.find((p) => p.id === providerId)
  const mode: 'default' | 'fixed' | 'auto' =
    modelMode === 'auto' ? 'auto' : model !== undefined ? 'fixed' : 'default'

  const save = () => {
    onClose()
    void setTaskProviderFlow(task.id, {
      providerId: providerId !== undefined && providerId !== '' ? providerId : '',
      model: mode === 'fixed' ? (model ?? '').trim() : '',
      modelMode: mode === 'auto' ? 'auto' : ''
    })
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-label={t('tree.providerDialogTitle')}>
        <p className="dialog-title">
          {t('tree.providerDialogTitle')} · {task.name}
        </p>
        <div className="provider-options" role="radiogroup" aria-label={t('newTask.providerLabel')}>
          <button
            type="button"
            role="radio"
            aria-checked={providerId === undefined}
            className={providerId === undefined ? 'on' : ''}
            onClick={() => {
              setProviderId(undefined)
              setModel('')
            }}
          >
            {t('tree.providerClearPick')}
          </button>
          {providers.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={providerId === p.id}
              className={providerId === p.id ? 'on' : ''}
              onClick={() => {
                setProviderId(p.id)
                setModel(undefined)
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        {/* v1.4 模型三态：跟随缺省 / 固定模型 / CLI 自主选择 */}
        <div role="radiogroup" aria-label={t('common.modelModeLabel')} className="provider-options">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'default'}
            className={mode === 'default' ? 'on' : ''}
            onClick={() => {
              setModelMode(undefined)
              setModel(undefined)
              setSaved(false)
            }}
          >
            {t('common.modelModeDefault')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'fixed'}
            className={mode === 'fixed' ? 'on' : ''}
            onClick={() => {
              setModelMode(undefined)
              setModel('')
              setSaved(false)
            }}
          >
            {t('common.modelModeFixed')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'auto'}
            className={mode === 'auto' ? 'on' : ''}
            onClick={() => {
              setModelMode('auto')
              setModel(undefined)
              setSaved(false)
            }}
          >
            {t('common.modelModeAuto')}
          </button>
        </div>
        {mode === 'fixed' && (
          <>
            <input
              className="provider-model-input"
              type="text"
              list="cwb-task-models"
              aria-label={t('newTask.providerModelLabel')}
              placeholder={
                selected?.defaultModel !== undefined && selected.defaultModel !== ''
                  ? t('newTask.providerModelPlaceholder', { model: selected.defaultModel })
                  : t('newTask.providerModelPlaceholderNone')
              }
              value={model ?? ''}
              onChange={(e) => {
                setModel(e.target.value)
                setSaved(false)
              }}
            />
            <datalist id="cwb-task-models">
              {(selected?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}
        <p className="hint-small">{t('tree.providerDialogHint')}</p>
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={save}>
            {t('common.save')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
        {saved && (
          <p className="muted ok" role="status">
            {t('tree.providerSaved')}
          </p>
        )}
      </div>
    </div>
  )
}

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
