import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectRecord, ProviderRegistryState, TaskRecord } from '../../../shared/types'
import {
  SIDEBAR_WIDTH_DEFAULT,
  clampSidebarWidth,
  useAppStore
} from '../store'
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
 * 左侧栏（S6 v0.3 ChatGPT 式改版 + SSH 远程模式 3.7/3.10/3.11）：
 * - 顶部操作区（A）：☰ 折叠开关 + 标题 + 打开目录；「＋ 新建任务」主按钮
 *   （当前选中项目；无选中时禁用+tooltip，定夺见 A16）+ 搜索框实时过滤项目树
 * - 最近区块（C）：搜索框下方，跨项目按 lastActiveAt 取前 5，点击开 tab
 * - 折叠图标栏（D）：48px rail（＋/🔍/项目首字母圆形标+git 角标/底部 ☰）；
 *   3.10=A：折叠态持久化（sidebarCollapsedPersist，经 setAppSettings——推翻 A17）；
 *   远程项目沿用首字母圆标+服务器归属角标（rail-server-dot）
 * - 3.7=A：右缘拖拽调宽 240–480px（拖拽中本地 state 即时反馈，松手落
 *   sidebarWidth 持久化；clamp 见 store.clampSidebarWidth）
 * - 快捷键（F）：Ctrl+N 新建 / Ctrl+F 聚焦搜索 / Ctrl+B 折叠——window 级监听，
 *   焦点在输入框/终端宿主时不劫持
 * - 新建任务对话框（A）：自旧每项目内联 NewTaskForm 迁移（三选/git 分支逻辑不变），
 *   顶部按钮 / 项目菜单 / Ctrl+N 三入口共用；入口触发时自动展开侧栏
 */
export function ProjectSidebar() {
  const t = useI18n()
  const projects = useAppStore((s) => s.projects)
  const tasks = useAppStore((s) => s.tasks)
  const connections = useAppStore((s) => s.connections)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const openProjectFlow = useAppStore((s) => s.openProjectFlow)
  const selectProject = useAppStore((s) => s.selectProject)
  const openTaskAutoResume = useAppStore((s) => s.openTaskAutoResume)
  const openSkills = useAppStore((s) => s.openSkills)
  // 3.10=A 整栏折叠态持久化（消费 settings.sidebarCollapsedPersist；A17 推翻）
  const railCollapsed = useAppStore((s) => s.uiSettings.sidebarCollapsedPersist === true)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)
  // 3.7=A 宽度持久化（settings.sidebarWidth；拖拽中的即时值走本地 state）
  const sidebarWidthPref = useAppStore((s) => s.uiSettings.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const sidebarWidth = dragWidth ?? clampSidebarWidth(sidebarWidthPref ?? SIDEBAR_WIDTH_DEFAULT)
  // v1.1.0 更新角标数据源（null=未检查/已是最新/检查失败）；
  // v1.3：平台不支持自动升级（linux，platformSupported=false）不亮角标——
  // 角标引导的是应用内下载/升级链路，该链路在 linux 被门禁禁用
  const appUpdateInfo = useAppStore((s) => s.appUpdateInfo)
  const hasUpdate =
    appUpdateInfo !== null && !appUpdateInfo.upToDate && appUpdateInfo.platformSupported !== false
  const openSettings = useAppStore((s) => s.openSettings)

  const [query, setQuery] = useState('')
  /** 新建对话框目标项目（null=关闭）——项目菜单入口会预选中该项目 */
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null)
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /** 3.11 悬停预览（peek）：远程项目头像悬停 400ms 后的浮层锚点（null=关） */
  const [peek, setPeek] = useState<{ projectId: string; top: number; left: number } | null>(null)
  const peekTimer = useRef<number | null>(null)
  const openPeek = (p: ProjectRecord, el: HTMLElement): void => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
    const rect = el.getBoundingClientRect()
    peekTimer.current = window.setTimeout(() => {
      setPeek({ projectId: p.id, top: rect.top, left: rect.right + 10 })
    }, 400)
  }
  const closePeek = (): void => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current)
      peekTimer.current = null
    }
    setPeek(null)
  }
  useEffect(() => {
    // 卸载清理 peek 计时器（对齐 clickTimer 先例）
    return () => {
      if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
    }
  }, [])

  /** 三入口共用的打开动作：预选中项目 + 展开侧栏 + 开对话框 */
  const openNewTask = (projectId: string) => {
    selectProject(projectId)
    setSidebarCollapsed(false)
    setNewTaskProjectId(projectId)
  }

  // ── 3.7=A 宽度拖拽：mousedown 记起点 → mousemove 即时反馈（本地 state）→
  //    mouseup 松手一次性持久化（store 内部再去抖合并 setAppSettings 写盘）──
  const onResizerDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    const onMove = (ev: MouseEvent): void => {
      setDragWidth(clampSidebarWidth(startWidth + ev.clientX - startX))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDragWidth(null)
      setSidebarWidth(clampSidebarWidth(startWidth + ev.clientX - startX))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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
        // 3.10=A：折叠态经 store 落 sidebarCollapsedPersist（读 getState 防闭包过期）
        setSidebarCollapsed(useAppStore.getState().uiSettings.sidebarCollapsedPersist !== true)
      } else if (k === 'n') {
        if (selectedProjectId !== null) openNewTask(selectedProjectId)
      } else if (k === 'f') {
        e.preventDefault() // 拦下浏览器查找
        setSidebarCollapsed(false)
        setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedProjectId, setSidebarCollapsed])

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
              setSidebarCollapsed(false)
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
                data-remote={p.connectionId !== undefined ? '1' : undefined}
                title={
                  p.connectionId !== undefined
                    ? `${p.name} · ${connections.find((c) => c.id === p.connectionId)?.name ?? ''}`
                    : p.name
                }
                onClick={() => {
                  selectProject(p.id)
                  setSidebarCollapsed(false)
                }}
                /* 3.11 悬停预览（peek）：远程项目头像悬停 400ms → 浮层看服务器归属与任务状态 */
                onMouseEnter={(e) => {
                  if (p.connectionId !== undefined) openPeek(p, e.currentTarget)
                }}
                onMouseLeave={closePeek}
              >
                {initialsOf(p.name)}
                {p.isGit && <span className="rail-git-dot" title={t('sidebar.gitProject')} />}
                {/* 3.10 备注落地：rail 上远程项目=首字母圆标+服务器归属角标 */}
                {p.connectionId !== undefined && (
                  <span
                    className="rail-server-dot"
                    title={connections.find((c) => c.id === p.connectionId)?.name ?? ''}
                  />
                )}
              </button>
            ))}
          </div>
          {/* v0.5③ Skills；v0.9 设置——置 ☰ 上方；v1.2.1 起删除 ⓘ（关于并入设置中心左栏，
              无需独立入口）。v1.2.2 图标改为内联 SVG（用户指令：常用风格、易识别、
              比原先的 emoji 大）——线宽 1.8 的 stroke 图标对齐主流 UI 图标观感，
              双主题经 currentColor 自动适配 */}
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.skills')}
            data-icon="skills"
            onClick={openSkills}
          >
            <IconSkills />
          </button>
          <button
            type="button"
            className="rail-btn"
            title={t('sidebar.settings')}
            data-icon="settings"
            onClick={() => openSettings()}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            className="rail-btn rail-expand"
            title={t('sidebar.expand')}
            onClick={() => setSidebarCollapsed(false)}
          >
            ☰
          </button>
        </aside>
        {/* ── 展开态：头部 + 顶部操作区 + 最近 + 项目树（双态保挂载，display 切换） ── */}
        <aside
          className="sidebar"
          aria-hidden={railCollapsed}
          style={{
            ...(railCollapsed ? { display: 'none' as const } : {}),
            width: `${sidebarWidth}px`
          }}
        >
          {/* 3.7=A 宽度拖拽手柄：右缘 4px 热区（css :hover 高亮），拖拽改宽 240–480 */}
          <div className="sidebar-resizer" role="separator" aria-orientation="vertical" onMouseDown={onResizerDown} />
          {/* v1.2.1 用户指令：版本号改为纯文本（不再开弹窗）；Skills / 设置
              两个入口收敛为图标按钮，紧跟版本号之后——头部一行解决，不再单独占
              「Skills | 设置」一整行（腾出的空间给项目树）。
              ⓘ 已删除（用户指令：只保留 Skills 和设置两个）——关于仍在设置左栏末项。 */}
          <div className="sidebar-header">
            <div className="sidebar-title-row">
              <h1>SSH Workbench</h1>
              <span className="version-text" title={t('sidebar.versionTitle', { version: APP_VERSION })}>
                v{APP_VERSION}
                {/* v1.1.0 有新版本角标（启动静默检查/手动检查落 store） */}
                {hasUpdate && (
                  <span
                    className="ver-update-dot"
                    title={t('sidebar.newVersion', { version: appUpdateInfo.latest })}
                  />
                )}
              </span>
              <span className="sidebar-icon-group">
                <button
                  type="button"
                  className="btn-icon"
                  title={t('sidebar.skills')}
                  aria-label={t('sidebar.skillsLabel')}
                  data-icon="skills"
                  onClick={openSkills}
                >
                  <IconSkills />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title={t('sidebar.settings')}
                  aria-label={t('sidebar.settings')}
                  data-icon="settings"
                  onClick={() => openSettings()}
                >
                  <IconSettings />
                </button>
              </span>
            </div>
          </div>
          <div className="sidebar-actions">
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
        {peek !== null && (
          <RailPeek projectId={peek.projectId} top={peek.top} left={peek.left} onClose={closePeek} />
        )}
    </>
  )
}

/**
 * 3.11 悬停预览（peek）：折叠 rail 上远程项目头像悬停 → 浮层显示服务器归属 +
 * 该项目任务状态点（最多 5 条，按最近活跃）。portal 挂 body；离开头像/浮层关闭。
 */
function RailPeek({
  projectId,
  top,
  left,
  onClose
}: {
  projectId: string
  top: number
  left: number
  onClose: () => void
}) {
  const tr = useI18n()
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId))
  const connections = useAppStore((s) => s.connections)
  // 注意选择器须返回稳定引用：tasks 取原数组，过滤在渲染期做（新建数组会无限重渲）
  const tasks = useAppStore((s) => s.tasks)
  if (project === undefined) return null
  const server = connections.find((c) => c.id === project.connectionId)
  const list = tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
    .slice(0, 5)
  return createPortal(
    <div className="rail-peek" style={{ top, left }} role="tooltip" onMouseLeave={onClose}>
      <div className="rail-peek-title">{project.name}</div>
      {server !== undefined && <div className="rail-peek-server">{server.name}</div>}
      {list.length === 0 ? (
        <div className="rail-peek-empty">{tr('tree.noTasks')}</div>
      ) : (
        list.map((t) => (
          <div key={t.id} className="rail-peek-task">
            <TaskStatusDot task={t} />
            <span className="rail-peek-task-name">{t.name}</span>
          </div>
        ))
      )}
    </div>,
    document.body
  )
}

/** rail 头像缩写：去空白取前两字（中文名两字内/英文名取首两字母） */
function initialsOf(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 2)
}

/** 单任务"跳过权限确认"勾选（v0.3.1）——危险项琥珀色；默认关闭（安全默认） */
// ── v1.4 新建任务：模型服务选择（折叠行，缺省"跟随默认"零负担） ──────────

/** 任务级 provider/model 选择值（undefined = 跟随默认；modelMode:'auto'=CLI 自主选择） */
export interface TaskProviderPick {
  providerId?: string
  model?: string
  modelMode?: 'auto'
}

/** 选择模式派生：auto 显式标记；model 有值（含空串中间态）=固定；否则跟随缺省 */
function pickMode(pick: TaskProviderPick): 'default' | 'fixed' | 'auto' {
  if (pick.modelMode === 'auto') return 'auto'
  if (pick.model !== undefined) return 'fixed'
  return 'default'
}

function providerPickLabel(
  t: ReturnType<typeof useI18n>,
  pick: TaskProviderPick,
  providers: ProviderRegistryState
): string {
  const label = t('newTask.providerLabel')
  if (pick.providerId === undefined) {
    const def = providers.providers.find((p) => p.id === providers.defaultProviderId)
    const tail =
      def !== undefined
        ? t('newTask.providerFollowWith', { name: def.name })
        : t('newTask.providerFollowNone')
    return `${label}：${tail}`
  }
  const p = providers.providers.find((x) => x.id === pick.providerId)
  const name = p?.name ?? pick.providerId
  const mode = pickMode(pick)
  const tail =
    mode === 'auto'
      ? t('common.modelModeAuto')
      : mode === 'fixed' && pick.model !== undefined && pick.model !== ''
        ? pick.model
        : mode === 'fixed'
          ? t('common.modelModeFixed')
          : p?.defaultModel !== undefined && p.defaultModel !== ''
            ? t('newTask.providerModelPlaceholder', { model: p.defaultModel })
            : t('common.modelModeDefault')
  return `${label}：${name} · ${tail}`
}

function ProviderPick({
  value,
  onChange
}: {
  value: TaskProviderPick
  onChange: (v: TaskProviderPick) => void
}) {
  const t = useI18n()
  const providers = useAppStore((s) => s.providers)
  const [expanded, setExpanded] = useState(false)
  const selected = providers.providers.find((p) => p.id === value.providerId)

  if (!expanded) {
    return (
      <button
        type="button"
        className="provider-pick"
        onClick={() => setExpanded(true)}
        title={t('newTask.providerLabel')}
      >
        {providerPickLabel(t, value, providers)}
      </button>
    )
  }
  return (
    <div className="provider-pick expanded">
      <div className="provider-options" role="radiogroup" aria-label={t('newTask.providerLabel')}>
        <button
          type="button"
          role="radio"
          aria-checked={value.providerId === undefined}
          className={value.providerId === undefined ? 'on' : ''}
          onClick={() => onChange({ providerId: undefined, model: undefined })}
        >
          {t('newTask.providerFollow')}
        </button>
        {providers.providers.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={value.providerId === p.id}
            className={value.providerId === p.id ? 'on' : ''}
            onClick={() => onChange({ providerId: p.id, model: undefined })}
          >
            {p.name}
          </button>
        ))}
      </div>
      {value.providerId !== undefined && (
        <>
          {/* v1.4 模型三态：跟随缺省 / 固定模型 / CLI 自主选择 */}
          <div role="radiogroup" aria-label={t('common.modelModeLabel')} className="provider-options">
            <button
              type="button"
              role="radio"
              aria-checked={pickMode(value) === 'default'}
              className={pickMode(value) === 'default' ? 'on' : ''}
              onClick={() => onChange({ providerId: value.providerId, model: undefined, modelMode: undefined })}
            >
              {t('common.modelModeDefault')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={pickMode(value) === 'fixed'}
              className={pickMode(value) === 'fixed' ? 'on' : ''}
              onClick={() => onChange({ ...value, modelMode: undefined, model: '' })}
            >
              {t('common.modelModeFixed')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={pickMode(value) === 'auto'}
              className={pickMode(value) === 'auto' ? 'on' : ''}
              onClick={() => onChange({ providerId: value.providerId, model: undefined, modelMode: 'auto' })}
            >
              {t('common.modelModeAuto')}
            </button>
          </div>
          {pickMode(value) === 'fixed' && (
            <>
              <input
                className="provider-model-input"
                type="text"
                list="cwb-newtask-models"
                aria-label={t('newTask.providerModelLabel')}
                placeholder={
                  selected?.defaultModel !== undefined && selected.defaultModel !== ''
                    ? t('newTask.providerModelPlaceholder', { model: selected.defaultModel })
                    : t('newTask.providerModelPlaceholderNone')
                }
                value={value.model ?? ''}
                onChange={(e) => onChange({ ...value, model: e.target.value.trim() })}
              />
              <datalist id="cwb-newtask-models">
                {(selected?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}
        </>
      )}
      <button type="button" className="btn small" onClick={() => setExpanded(false)}>
        {t('common.close')}
      </button>
    </div>
  )
}

function SkipPermsCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const t = useI18n()
  return (
    <label className="dialog-check dialog-check-danger" title={t('sidebar.skipPermsTitle')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {t('sidebar.skipPermsLabel')}
    </label>
  )
}

// ── v1.2.2 侧栏图标（内联 SVG，stroke=currentColor 双主题自适配） ──────────
// 用户指令：简单、显眼、常用风格、易识别。取 Lucide/Feather 线型图标（业界通用形）：
// Skills=拼图块（沿用"skill=能力模块"的既有心智）；Settings=齿轮（全球通用语义）。
// 原 emoji（🧩⚙）在各平台渲染大小不一、Windows 下偏小且彩色抢焦点——统一线型更稳。

/** 拼图块（Lucide puzzle 图形，尺寸 16px、线宽 1.8） */
function IconSkills() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.878.289z" />
      <path d="M13.5 6.5 9.5 10.5" />
    </svg>
  )
}

/** 齿轮（Lucide settings 形，尺寸 16px、线宽 1.8） */
function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
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
  /** v1.4 任务级 provider/model（缺省=跟随默认；名称阶段选定，三选阶段沿用） */
  const [providerPick, setProviderPick] = useState<TaskProviderPick>({})

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
        ...(skipPerms ? { skipPermissions: true } : {}), // 缺省=关闭（安全默认），false 不入参
        ...(providerPick.providerId !== undefined ? { providerId: providerPick.providerId } : {}),
        ...(providerPick.modelMode === 'auto' ? { modelMode: 'auto' as const } : {}),
        ...(providerPick.modelMode !== 'auto' && providerPick.model !== undefined && providerPick.model !== ''
          ? { model: providerPick.model }
          : {})
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
        ...(skipPerms ? { skipPermissions: true } : {}),
        ...(providerPick.providerId !== undefined ? { providerId: providerPick.providerId } : {}),
        ...(providerPick.modelMode === 'auto' ? { modelMode: 'auto' as const } : {}),
        ...(providerPick.modelMode !== 'auto' && providerPick.model !== undefined && providerPick.model !== ''
          ? { model: providerPick.model }
          : {})
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
            <ProviderPick value={providerPick} onChange={setProviderPick} />
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
            <ProviderPick value={providerPick} onChange={setProviderPick} />
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
