import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { RefObject } from 'react'
import type { ConnectionRecord, ConnectionRuntimeState } from '../../../shared/types'
import {
  SIDEBAR_WIDTH_DEFAULT,
  clampSidebarWidth,
  useAppStore
} from '../store'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useI18n } from '../i18n'
import { SidebarMenu } from './SidebarMenu'
import type { MenuItemDef } from './SidebarMenu'
import { connStateText } from './statusVisual'
import { focusActiveTerminal } from './TerminalPanel'
import { SshConnectionDialog } from './SshConnectionDialog'

/**
 * v2.1.2 ①：SSH 视图左侧「SSH 服务器」列表（sshActive 时整栏替代 ProjectSidebar，
 * 零项目元素——无项目树/最近任务/作用域 chips）。设计基准：
 * design/ssh-server-sidebar-v1.html 页 1。
 * - 展开态复用 .sidebar 外壳与 .sidebar-resizer 宽度拖拽惯例
 *   （uiSettings.sidebarCollapsedPersist/sidebarWidth + setSidebarCollapsed）
 * - header：标题 + ＋（新建纯 SSH，弹 SshConnectionDialog）+ ⚙（设置中心）
 * - 过滤输入（.search-input）：按名称/host/user 过滤两组
 * - 分组 1「纯 SSH 连接」（kind==='ssh'）；分组 2「开发服务器」（其余，组头
 *   带小字提示）；组头 ×N 计数
 * - 服务器行：状态点（.ssh-srv-dot data-state）+ 名称 + user@host:port（mono
 *   小字）+ ⋯ 菜单（SidebarMenu/MenuItemDef，用法对齐 ProjectTree ServerNode）；
 *   行点击=openSshConsole(cid)（离线懒连接由 store 保证）；当前 sshConsoleCid
 *   行高亮（左缘 accent 条 + aria-current="true"）
 * - 折叠 rail：🔍 展开+聚焦搜索 / 服务器首字母头像（当前 cid 高亮，右下状态
 *   角标对齐 .rail-server-dot 用法）/ ⚙ / ☰ 展开
 * - 快捷键：本组件挂载期间 ProjectSidebar 已卸载（其 window keydown 随之消失）
 *   ——必须自挂 Ctrl+B 折叠、Ctrl+F 展开并聚焦搜索；isTypingTarget 守卫照抄
 *   ProjectSidebar 并把终端宿主判定扩展到 .term-host 与 .ssh-term-host
 */
export function SshServerSidebar() {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const connectionStates = useAppStore((s) => s.connectionStates)
  const sshConsoleCid = useAppStore((s) => s.sshConsoleCid)
  const openSshConsole = useAppStore((s) => s.openSshConsole)
  const openSettings = useAppStore((s) => s.openSettings)
  const railCollapsed = useAppStore((s) => s.uiSettings.sidebarCollapsedPersist === true)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)
  const sidebarWidthPref = useAppStore((s) => s.uiSettings.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const sidebarWidth = dragWidth ?? clampSidebarWidth(sidebarWidthPref ?? SIDEBAR_WIDTH_DEFAULT)

  const [query, setQuery] = useState('')
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /** 纯 SSH 连接对话框：null=关；undefined 值仅出现在 state 类型（新建态） */
  const [dialogInitial, setDialogInitial] = useState<ConnectionRecord | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  /** 溢出菜单互斥：全栏同一时刻至多一个 ⋯ 菜单开着 */
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ConnectionRecord | null>(null)

  // ── 宽度拖拽（照抄 ProjectSidebar 惯例：mousedown 记起点 → move 本地即时
  //    反馈 → up 一次性持久化 sidebarWidth）──
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

  // 折叠态点 🔍（或 Ctrl+F）先展开再落聚焦——展开后的下一帧聚焦搜索框
  useEffect(() => {
    if (!railCollapsed && pendingSearchFocus) {
      searchRef.current?.focus()
      setPendingSearchFocus(false)
    }
  }, [railCollapsed, pendingSearchFocus])

  // ── 快捷键：Ctrl+B 折叠 / Ctrl+F 展开并聚焦搜索（ProjectSidebar 已卸载，
  //    本组件自挂 window keydown）。焦点在输入框/可编辑区或终端宿主
  //    （.term-host 任务终端 / .ssh-term-host 纯 SSH 终端）内不劫持 ──
  useEffect(() => {
    const isTypingTarget = (e: KeyboardEvent): boolean => {
      const el = e.target
      if (!(el instanceof HTMLElement)) return false
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true
      return el.closest('.term-host') !== null || el.closest('.ssh-term-host') !== null
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (isTypingTarget(e)) return
      const k = e.key.toLowerCase()
      if (k === 'b') {
        setSidebarCollapsed(useAppStore.getState().uiSettings.sidebarCollapsedPersist !== true)
      } else if (k === 'f') {
        e.preventDefault() // 拦下浏览器查找
        setSidebarCollapsed(false)
        setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSidebarCollapsed])

  // ── 过滤与分组 ──
  const q = query.trim().toLowerCase()
  const match = (c: ConnectionRecord): boolean =>
    q === '' ||
    c.name.toLowerCase().includes(q) ||
    c.host.toLowerCase().includes(q) ||
    c.user.toLowerCase().includes(q)
  const pureConns = connections.filter((c) => c.kind === 'ssh' && match(c))
  const devConns = connections.filter((c) => c.kind !== 'ssh' && match(c))
  const noMatch = q !== '' && pureConns.length === 0 && devConns.length === 0

  const openNewDialog = (): void => {
    setDialogInitial(null)
    setDialogOpen(true)
  }
  const openEditDialog = (c: ConnectionRecord): void => {
    setDialogInitial(c)
    setDialogOpen(true)
  }
  const closeDialog = (): void => {
    setDialogOpen(false)
    setDialogInitial(null)
    // 对话框关闭把键盘焦点还给活跃终端（对齐 ProjectSidebar 对话框关闭惯例）
    focusActiveTerminal()
  }

  const stateOf = (c: ConnectionRecord): ConnectionRuntimeState =>
    connectionStates[c.id]?.state ?? 'offline'

  return (
    <>
      {/* 折叠双态保挂载（对齐 ProjectSidebar 评审 F2）：rail 与展开态都常驻
          DOM，display 切换——Ctrl+B 不卸载列表丢过滤词/菜单开合 */}
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
        <div className="rail-projects">
          {connections.map((c) => {
            const st = stateOf(c)
            return (
              <button
                key={c.id}
                type="button"
                className={c.id === sshConsoleCid ? 'rail-avatar selected' : 'rail-avatar'}
                data-connection-id={c.id}
                title={`${c.name} · ${c.user}@${c.host}:${c.port}`}
                onClick={() => void openSshConsole(c.id)}
              >
                {initialsOf(c.name)}
                {/* 头像右下状态角标（定位对齐 .rail-server-dot 用法；颜色按连接态） */}
                <span className="ssh-rail-dot" data-state={st} />
              </button>
            )
          })}
        </div>
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
      {/* ── 展开态：header + 过滤输入 + 两组服务器列表 ── */}
      <aside
        className="sidebar"
        aria-hidden={railCollapsed}
        style={{
          ...(railCollapsed ? { display: 'none' as const } : {}),
          width: `${sidebarWidth}px`
        }}
      >
        <div className="sidebar-resizer" role="separator" aria-orientation="vertical" onMouseDown={onResizerDown} />
        <div className="sidebar-header">
          <div className="sidebar-title-row">
            <h1>{t('ssh.serverTitle')}</h1>
            <span className="sidebar-icon-group">
              <button
                type="button"
                className="btn-icon"
                title={t('ssh.connDialogTitleNew')}
                aria-label={t('ssh.connDialogTitleNew')}
                data-testid="ssh-srv-new"
                onClick={openNewDialog}
              >
                ＋
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
          <input
            ref={searchRef}
            className="search-input"
            type="text"
            placeholder={t('ssh.serverSearch')}
            aria-label={t('ssh.serverSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="ssh-srv-body">
          {connections.length === 0 ? (
            /* 空态：虚线框提示 + 「新建连接」按钮 */
            <div className="ssh-srv-empty">
              <span>{t('ssh.serverEmpty')}</span>
              <button type="button" className="btn small" onClick={openNewDialog}>
                ＋ {t('ssh.serverNew')}
              </button>
            </div>
          ) : noMatch ? (
            <div className="search-empty">{t('tree.noMatch')}</div>
          ) : (
            <>
              {pureConns.length > 0 && (
                <div className="ssh-srv-group" data-group="pure">
                  <div className="ssh-srv-group-title">
                    {t('ssh.serverGroupPure')} <span className="ssh-srv-count">×{pureConns.length}</span>
                  </div>
                  <ServerRows
                    conns={pureConns}
                    sshConsoleCid={sshConsoleCid}
                    stateOf={stateOf}
                    openMenuKey={openMenuKey}
                    setOpenKey={setOpenMenuKey}
                    onOpen={openEditDialog}
                    setDeleting={setDeleting}
                  />
                </div>
              )}
              {devConns.length > 0 && (
                <div className="ssh-srv-group" data-group="dev">
                  <div className="ssh-srv-group-title">
                    {t('ssh.serverGroupDev')} <span className="ssh-srv-count">×{devConns.length}</span>
                    <span className="ssh-srv-group-hint">{t('ssh.serverGroupDevHint')}</span>
                  </div>
                  <ServerRows
                    conns={devConns}
                    sshConsoleCid={sshConsoleCid}
                    stateOf={stateOf}
                    openMenuKey={openMenuKey}
                    setOpenKey={setOpenMenuKey}
                    onOpen={openEditDialog}
                    setDeleting={setDeleting}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </aside>
      {dialogOpen && <SshConnectionDialog initial={dialogInitial ?? undefined} onClose={closeDialog} />}
      {deleting !== null && <DeleteConnDialog connection={deleting} onClose={() => setDeleting(null)} />}
    </>
  )
}

/** 一组服务器行（两组共用；⋯ 菜单项随 kind 与连接态分支） */
function ServerRows({
  conns,
  sshConsoleCid,
  stateOf,
  openMenuKey,
  setOpenKey,
  onOpen,
  setDeleting
}: {
  conns: ConnectionRecord[]
  sshConsoleCid: string | null
  stateOf: (c: ConnectionRecord) => ConnectionRuntimeState
  openMenuKey: string | null
  setOpenKey: (k: string | null) => void
  onOpen: (c: ConnectionRecord) => void
  setDeleting: (c: ConnectionRecord | null) => void
}) {
  return (
    <ul className="ssh-srv-list">
      {conns.map((c) => (
        <ServerRow
          key={c.id}
          conn={c}
          active={c.id === sshConsoleCid}
          state={stateOf(c)}
          menuOpen={openMenuKey === `ssh-srv:${c.id}`}
          onToggleMenu={() => setOpenKey(openMenuKey === `ssh-srv:${c.id}` ? null : `ssh-srv:${c.id}`)}
          onCloseMenu={() => setOpenKey(null)}
          onEdit={onOpen}
          setDeleting={setDeleting}
        />
      ))}
    </ul>
  )
}

/** 单服务器行：状态点 + 名称/地址 + ⋯ 菜单（视觉对齐 ProjectTree .server-row 惯例） */
function ServerRow({
  conn,
  active,
  state,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onEdit,
  setDeleting
}: {
  conn: ConnectionRecord
  active: boolean
  state: ConnectionRuntimeState
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  onEdit: (c: ConnectionRecord) => void
  setDeleting: (c: ConnectionRecord | null) => void
}) {
  const t = useI18n()
  const openSshConsole = useAppStore((s) => s.openSshConsole)
  const connectFlow = useAppStore((s) => s.connectFlow)
  const disconnectFlow = useAppStore((s) => s.disconnectFlow)
  const openSettings = useAppStore((s) => s.openSettings)
  const menuBtnRef = useRef<HTMLButtonElement>(null)

  const menuItems: MenuItemDef[] = [
    {
      label: t('ssh.serverOpenTerminal'),
      onClick: () => void openSshConsole(conn.id)
    },
    state === 'connected'
      ? { label: t('conn.menu.disconnect'), onClick: () => void disconnectFlow(conn.id) }
      : { label: t('conn.menu.connect'), onClick: () => void connectFlow(conn.id) },
    // 纯 SSH 行=本视图专属对话框编辑；开发服务器行仍走设置中心（连接与自检）
    conn.kind === 'ssh'
      ? { label: t('ssh.serverEditSsh'), onClick: () => onEdit(conn) }
      : { label: t('conn.menu.edit'), onClick: () => openSettings('connections', conn.id) },
    {
      label: t('tree.delete'),
      danger: true,
      onClick: () => setDeleting(conn)
    }
  ]

  return (
    <li
      className={active ? 'ssh-srv-row active' : 'ssh-srv-row'}
      data-connection-id={conn.id}
      aria-current={active ? 'true' : undefined}
    >
      <span
        className="ssh-srv-dot"
        data-state={state}
        title={connStateText(t, state)}
      />
      <button
        type="button"
        className="ssh-srv-main"
        title={`${conn.user}@${conn.host}:${conn.port}`}
        onClick={() => void openSshConsole(conn.id)}
      >
        <span className="ssh-srv-name">
          {conn.name}
          {conn.kind !== 'ssh' && <span className="ssh-srv-kind">DEV</span>}
        </span>
        <span className="ssh-srv-addr">
          {conn.user}@{conn.host}:{conn.port}
        </span>
      </button>
      <RowMenuButton
        ref={menuBtnRef}
        ariaLabel={t('s6.serverActions')}
        open={menuOpen}
        onToggle={onToggleMenu}
      />
      {menuOpen && (
        <SidebarMenu
          triggerRef={menuBtnRef}
          items={menuItems}
          onClose={onCloseMenu}
        />
      )}
    </li>
  )
}

/** 「⋯」按钮（hover 露出由 CSS 控制；复用 .row-more 惯例，对齐 ProjectTree） */
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

/** 删除确认小对话框（照抄 ProjectTree DeleteServerDialog 惯例） */
function DeleteConnDialog({
  connection,
  onClose
}: {
  connection: ConnectionRecord
  onClose: () => void
}) {
  const t = useI18n()
  const removeConnectionFlow = useAppStore((s) => s.removeConnectionFlow)
  useEscapeClose(onClose)
  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-label={t('s6.removeServerTitle', { name: connection.name })}>
        <p className="dialog-title">{t('s6.removeServerTitle', { name: connection.name })}</p>
        <p className="dialog-hint">{t('ssh.serverDeleteConfirm')}</p>
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

/** rail 头像缩写（对齐 ProjectSidebar.initialsOf：去空白取前两字） */
function initialsOf(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 2)
}

/** 齿轮（内联 SVG，stroke=currentColor 双主题自适配——对齐 ProjectSidebar IconSettings） */
function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
