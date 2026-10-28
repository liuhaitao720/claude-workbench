import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectRecord, TaskRecord } from '../../../shared/types'
import { useAppStore } from '../store'
import { APP_VERSION } from '../app-info'
import { loadDefaultIsolation, persistDefaultIsolation } from '../default-isolation'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useI18n } from '../i18n'
import { ProjectTree } from './ProjectTree'
import { focusActiveTerminal } from './TerminalPanel'
import { TaskStatusDot } from './TaskStatusDot'

/** 「最近」区块条数（S6-C）：跨项目按 lastActiveAt 取前 N */
const RECENT_LIMIT = 5

/**
 * 左侧栏（S6 v0.3 ChatGPT 式改版）：
 * - 顶部操作区（A）：☰ 折叠开关 + 标题 + 打开目录；「＋ 新建任务」主按钮
 *   （当前选中项目；无选中时禁用+tooltip，定夺见 A16）+ 搜索框实时过滤项目树
 * - 最近区块（C）：搜索框下方，跨项目按 lastActiveAt 取前 5，点击开 tab
 * - 折叠图标栏（D）：48px rail（＋/🔍/项目首字母圆形标+git 角标/底部 ☰）；
 *   折叠态存组件内不持久化（定夺见 A17，刷新重置）
 * - 快捷键（F）：Ctrl+N 新建 / Ctrl+F 聚焦搜索 / Ctrl+B 折叠——window 级监听，
 *   焦点在输入框/终端宿主时不劫持
 * - 新建任务对话框（A）：自旧每项目内联 NewTaskForm 迁移（三选/git 分支逻辑不变），
 *   顶部按钮 / 项目菜单 / Ctrl+N 三入口共用；入口触发时自动展开侧栏
 */
export function ProjectSidebar() {
  const t = useI18n()
  const projects = useAppStore((s) => s.projects)
  const tasks = useAppStore((s) => s.tasks)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const openProjectFlow = useAppStore((s) => s.openProjectFlow)
  const selectProject = useAppStore((s) => s.selectProject)
  const openTaskAutoResume = useAppStore((s) => s.openTaskAutoResume)
  const openAbout = useAppStore((s) => s.openAbout)
  const openSkills = useAppStore((s) => s.openSkills)
  // v1.1.0 更新角标数据源（null=未检查/已是最新/检查失败）
  const appUpdateInfo = useAppStore((s) => s.appUpdateInfo)
  const hasUpdate = appUpdateInfo !== null && !appUpdateInfo.upToDate
  const openSettings = useAppStore((s) => s.openSettings)

  const [railCollapsed, setRailCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  /** 新建对话框目标项目（null=关闭）——项目菜单入口会预选中该项目 */
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null)
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)


  /** 三入口共用的打开动作：预选中项目 + 展开侧栏 + 开对话框 */
  const openNewTask = (projectId: string) => {
    selectProject(projectId)
    setRailCollapsed(false)
    setNewTaskProjectId(projectId)
  }

  // 折叠态点 ＋/🔍（或 Ctrl+N/F）先展开再落对应动作——展开后的下一帧聚焦搜索框
  useEffect(() => {
    if (!railCollapsed && pendingSearchFocus) {
      searchRef.current?.focus()
      setPendingSearchFocus(false)
    }
  }, [railCollapsed, pendingSearchFocus])

  // ── 快捷键（F）：window 级 keydown；焦点在 input/textarea/可编辑区或
  //    .term-host 宿主内（xterm 键入焦点）不劫持——终端 Ctrl+B/C/N 原样放行 ──
  useEffect(() => {
    const isTypingTarget = (e: KeyboardEvent): boolean => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return false
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return true
      return t.closest('.term-host') !== null
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (isTypingTarget(e)) return
      const k = e.key.toLowerCase()
      if (k === 'b') {
        setRailCollapsed((v) => !v)
      } else if (k === 'n') {
        if (selectedProjectId !== null) openNewTask(selectedProjectId)
      } else if (k === 'f') {
        e.preventDefault() // 拦下浏览器查找
        setRailCollapsed(false)
        setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedProjectId])

  // 「最近」区块数据（C）：跨项目 lastActiveAt 前 5（含项目名后缀）——
  // find 返回 undefined（非 null）——判 undefined，孤儿任务过滤掉；
  // 同 lastActiveAt 以 id 定序（评审 F8：不依赖 V8 稳定排序的数组序巧合）
  const recents = useMemo(() => {
    const pairs = tasks
      .map((task) => ({ task, project: projects.find((p) => p.id === task.projectId) }))
      .filter((x): x is { task: TaskRecord; project: ProjectRecord } => x.project !== undefined)
    pairs.sort(
      (a, b) =>
        Date.parse(b.task.lastActiveAt) - Date.parse(a.task.lastActiveAt) ||
        (a.task.id < b.task.id ? -1 : 1)
    )
    return pairs.slice(0, RECENT_LIMIT)
  }, [tasks, projects])

  const newTaskProject = projects.find((p) => p.id === newTaskProjectId) ?? null

  return (
    <>
      {/* 折叠双态保挂载（评审 F2）：rail 与展开态都常驻 DOM，display 切换——
          Ctrl+B 折叠不再卸载整棵树丢草稿/组折叠态/菜单开合（对齐 v0.1.2 F5 保护） */}
      <aside
        className="sidebar-rail"
        aria-label={t('sidebar.collapsed')}
        aria-hidden={!railCollapsed}
        style={railCollapsed ? undefined : { display: 'none' }}
      >
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.searchExpand')}
            onClick={() => {
              setRailCollapsed(false)
              setPendingSearchFocus(true)
            }}
          >
            🔍
          </button>
          {/* rail 零项目引导（评审 F14）：折叠态也保留"打开目录"入口 */}
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.openDir')}
            onClick={() => void openProjectFlow()}
          >
            📂
          </button>
          <div className="rail-projects">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === selectedProjectId ? 'rail-avatar selected' : 'rail-avatar'}
                data-project-id={p.id}
                title={p.name}
                onClick={() => {
                  selectProject(p.id)
                  setRailCollapsed(false)
                }}
              >
                {initialsOf(p.name)}
                {p.isGit && <span className="rail-git-dot" title={t('sidebar.gitProject')} />}
              </button>
            ))}
          </div>
          {/* v0.5③ Skills（🧩——勿用 ⚡，与 skipPermissions 徽标撞形）；v0.9 设置
              （⚙）；v0.5① 关于（ⓘ）——均置 ☰ 上方，⚙ 在 🧩 与 ⓘ 之间 */}
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.skills')}
            onClick={openSkills}
          >
            🧩
          </button>
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.settings')}
            onClick={openSettings}
          >
            ⚙
          </button>
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.about')}
            onClick={openAbout}
          >
            ⓘ
          </button>
          <button
            type="button"
            className="rail-btn rail-expand"
            title={t('sidebar.expand')}
            onClick={() => setRailCollapsed(false)}
          >
            ☰
          </button>
        </aside>
        {/* ── 展开态：头部 + 顶部操作区 + 最近 + 项目树（双态保挂载，display 切换） ── */}
        <aside
          className="sidebar"
          aria-hidden={railCollapsed}
          style={railCollapsed ? { display: 'none' } : undefined}
        >
          {/* v0.5.2 用户指令：标题与版本号同行（版本点击开 About）；📁 文件夹图标
              + 搜索栏同行；新建任务经项目 ⋯ 菜单 / Ctrl+N。v0.9 用户指令覆盖：
              Skills | 设置 并排一行（取代 v0.5.2 "Skills 独占一行"） */}
          <div className="sidebar-header">
            <div className="sidebar-title-row">
              <h1>Claude Workbench</h1>
              <button
                type="button"
                className="btn btn-header version-btn"
                onClick={openAbout}
                title={t('sidebar.about')}
              >
                v{APP_VERSION}
                {/* v1.1.0 有新版本角标（启动静默检查/手动检查落 store） */}
                {hasUpdate && (
                  <span
                    className="ver-update-dot"
                    title={t('sidebar.newVersion', { version: appUpdateInfo.latest })}
                  />
                )}
              </button>
            </div>
          </div>
          <div className="sidebar-actions">
            <div className="sidebar-dir-row">
              <button type="button" className="btn skills-btn" onClick={openSkills}>
                Skills
              </button>
              <button type="button" className="btn skills-btn" onClick={openSettings}>
                {t('sidebar.settings')}
              </button>
            </div>
            <div className="sidebar-dir-row">
              <button
                type="button"
                className="btn dir-icon-btn"
                title={t('sidebar.openDir')}
                aria-label={t('sidebar.openDir')}
                onClick={() => void openProjectFlow()}
              >
                📁
              </button>
              <input
                ref={searchRef}
                className="search-input"
                type="text"
                placeholder={t('sidebar.searchPlaceholder')}
                aria-label={t('sidebar.searchAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {/* 搜索态隐藏「最近」（评审 F5）：搜索聚焦树内结果，最近区块与词无关属噪音 */}
          <ProjectTree query={query} onNewTask={openNewTask} />
          {projects.length === 0 && (
            <div className="sidebar-empty">{t('sidebar.empty')}</div>
          )}
          {query.trim() === '' && recents.length > 0 && (
            <div className="recent-block">
              <div className="recent-title">{t('sidebar.recent')}</div>
              <ul className="recent-list">
                {recents.map(({ task, project }) => (
                  <li key={task.id} data-recent-task-id={task.id}>
                    <button
                      type="button"
                      className="recent-row"
                      title={`${task.name} · ${project.name} · ${task.cwd}`}
                      onClick={() => openTaskAutoResume(task.id)}
                    >
                      <TaskStatusDot task={task} />
                      <span className="recent-name">{task.name}</span>
                      <span className="recent-project">{project.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
        {newTaskProject && (
          <NewTaskDialog
            project={newTaskProject}
            onClose={() => {
              setNewTaskProjectId(null)
              // v0.4.3 焦点管理③：对话框关闭把键盘焦点还给活跃终端
              focusActiveTerminal()
            }}
            onCreated={() => setQuery('')} /* 评审 F4：过滤态创建的任务立即可见——清搜索词 */
          />
        )}
    </>
  )
}

/** rail 头像缩写：去空白取前两字（中文名两字内/英文名取首两字母） */
function initialsOf(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 2)
}

/** 单任务"跳过权限确认"勾选（v0.3.1）——危险项琥珀色；默认关闭（安全默认） */
function SkipPermsCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const t = useI18n()
  return (
    <label className="dialog-check dialog-check-danger" title={t('sidebar.skipPermsTitle')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {t('sidebar.skipPermsLabel')}
    </label>
  )
}

// ── 新建任务对话框（A）：自旧每项目内联 NewTaskForm 迁移，流程不变 ────────
// git：名称提交 → 三选（worktree/shared/取消——取消=返回名称输入，草稿保留）；
// 非 git：直接 {isolation:'shared'}。成功即关对话框（createTaskFlow 自动开 tab）。
// v0.9⑦：三选阶段高亮上次点过的选项（default-isolation.ts 持久化）——纯视觉
// 预选，不跳过确认（用户指令：记住的是"点过的选项"，非"下次自动执行"）。

function NewTaskDialog({
  project,
  onClose,
  onCreated
}: {
  project: ProjectRecord
  onClose: () => void
  /** 创建成功回调（评审 F4：调用方借此清搜索词，保新任务在树中立即可见） */
  onCreated?: () => void
}) {
  const createTaskFlow = useAppStore((s) => s.createTaskFlow)
  const t = useI18n()
  const [name, setName] = useState('')
  /** git 三选阶段待确认的任务名（null=名称输入阶段） */
  const [pending, setPending] = useState<string | null>(null)
  /** 单任务"跳过权限确认"（v0.3.1）：默认关（安全默认），两阶段均可勾选 */
  const [skipPerms, setSkipPerms] = useState(false)

  // A1：document 级 Escape——旧 overlay onKeyDown 依赖 autoFocus 焦点在弹窗内，
  // 焦点被点移到对话框空白处后失效；统一走 useEscapeClose
  useEscapeClose(onClose)

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (project.isGit) {
      setPending(trimmed) // git → 三选确认
    } else {
      onClose()
      onCreated?.()
      void createTaskFlow(project.id, trimmed, {
        isolation: 'shared',
        ...(skipPerms ? { skipPermissions: true } : {}) // 缺省=关闭（安全默认），false 不入参
      })
    }
  }

  const confirmCreate = (isolation: 'worktree' | 'shared') => {
    persistDefaultIsolation(isolation) // v0.9⑦：记住用户点过的选项（下次三选高亮）
    const taskName = pending
    setPending(null)
    if (taskName !== null) {
      onClose()
      onCreated?.()
      void createTaskFlow(project.id, taskName, {
        isolation,
        ...(skipPerms ? { skipPermissions: true } : {})
      })
    }
  }

  // 三选高亮：上次选择项用 primary 主按钮样式（默认无记录回 worktree，即既有观感）
  const lastIsolation = loadDefaultIsolation()

  return (
    // 评审 F11：遮罩空白点击 + Escape 关闭（对齐重命名 inline 的 Escape 基线）；
    // 三选阶段的"取消"按钮语义保留（返回名称输入，草稿不丢），overlay/Escape 才是整体关
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-label={t('newTask.aria')}>
        <p className="dialog-title">{t('newTask.title', { project: project.name })}</p>
        {pending === null ? (
          <>
            <input
              className="new-task-input"
              autoFocus
              placeholder={t('newTask.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            <SkipPermsCheck checked={skipPerms} onChange={setSkipPerms} />
            <div className="dialog-actions">
              <button type="button" className="btn primary" onClick={submit}>
                {t('newTask.create')}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                {t('newTask.cancel')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="dialog-hint">{t('newTask.isolationHint')}</p>
            <SkipPermsCheck checked={skipPerms} onChange={setSkipPerms} />
            <div className="dialog-actions">
              <button
                type="button"
                className={lastIsolation === 'worktree' ? 'btn primary' : 'btn'}
                onClick={() => confirmCreate('worktree')}
              >
                {t('newTask.worktree')}
              </button>
              <button
                type="button"
                className={lastIsolation === 'shared' ? 'btn primary' : 'btn'}
                onClick={() => confirmCreate('shared')}
              >
                {t('newTask.shared')}
              </button>
              <button type="button" className="btn" onClick={() => setPending(null)}>
                {t('newTask.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
