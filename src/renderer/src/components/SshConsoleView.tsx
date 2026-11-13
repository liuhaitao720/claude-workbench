import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ConnectionRecord } from '../../../shared/types'
import { useAppStore, subscribeSshData } from '../store'
import { useI18n } from '../i18n'
import { loadFontSize } from '../font-size'
import { loadFontFamily } from '../font-family'
import { terminalThemeFor, type EffectiveTheme } from '../theme'
import {
  applyTermTheme,
  changeFontSize,
  focusActiveTerminal
} from './TerminalPanel'
import { RemoteFilesPanel } from './RemoteFilesPanel'
import { SidebarMenu } from './SidebarMenu'

/**
 * v2.1.0 SSH 纯终端（不启 claude CLI）：TabBar 虚拟「SSH」tab 的前台视图。
 * 上下分栏——上=裸 shell（xterm，ssh2 shell 通道），下=复用 RemoteFilesPanel。
 *
 * - 实例缓存 `sshTermCache`（键=cid）：后台切换留存复挂；会话随台关/换连接
 *   即弃（dispose，见下 cleanup）；会话死=连接断/远端 exit——冻结层给重开按钮。
 * - 分栏比例按连接记忆（uiSettings.sshSplit[cid]，clamp 0.2–0.75）；分隔条
 *   拖拽/双击复位 0.5/键盘 ↑↓ 40px 步进（WCAG 2.2 dragging-alternative）。
 * - Esc/Ctrl+D 等全部直通 shell——UI 不拦截任何终端按键（与审查视图不同）。
 */
const sshTermCache = new Map<string, Terminal>()
const sshFitCache = new Map<string, FitAddon>()

/** 分栏上下限（上半占比）与键盘步进 */
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.75
const SPLIT_KEY_STEP = 0.06

export function SshConsoleView({ connectionId }: { connectionId: string }) {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const connEntry = useAppStore((s) => s.connectionStates[connectionId])
  const sessionDead = useAppStore((s) => s.sshSessionDead)
  const openSshConsole = useAppStore((s) => s.openSshConsole)
  const connectFlow = useAppStore((s) => s.connectFlow)
  const uiSplit = useAppStore((s) => s.uiSettings.sshSplit?.[connectionId])
  const sshFollowEnabled = useAppStore((s) => s.sshFollowEnabled)
  const setSshFollowEnabled = useAppStore((s) => s.setSshFollowEnabled)
  const hostRef = useRef<HTMLDivElement>(null)
  const termHostRef = useRef<HTMLDivElement>(null)
  /** 拖拽中的即时值（null=用持久值） */
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  /** v2.1.3 Shift+右键菜单锚点（普通右键=智能复制/粘贴——对齐开发终端） */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sel: string } | null>(null)
  const nullBtnRef = useRef<HTMLButtonElement>(null)
  const split = dragSplit ?? clampSplit(uiSplit ?? 0.5)
  const connState = connEntry?.state ?? 'offline'
  const conn: ConnectionRecord | undefined = connections.find((c) => c.id === connectionId)
  const frozen = connState !== 'connected' || sessionDead

  // xterm 实例生命周期（cid 变化=换连接→旧实例留在缓存，新实例懒建）
  useEffect(() => {
    const host = termHostRef.current
    if (!host) return
    let term = sshTermCache.get(connectionId)
    if (term === undefined) {
      term = new Terminal({
        allowProposedApi: true,
        fontFamily: loadFontFamily(),
        fontSize: loadFontSize(),
        lineHeight: 1.2,
        letterSpacing: 0,
        cursorBlink: true,
        convertEol: false,
        scrollback: 8000,
        // v2.1.3 对齐 TerminalView：CJK 保真（宽字形缩放/ConPTY 补行启发按平台）
        rescaleOverlappingGlyphs: true,
        windowsPty:
          (window as unknown as { cwb?: { platform?: string } }).cwb?.platform === 'win32'
            ? { backend: 'conpty' }
            : undefined,
        linkHandler: {
          activate: (_e, uri) => {
            void window.cwb.openExternal(uri)
          }
        },
        theme: terminalThemeFor(termThemeNow())
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
      term.loadAddon(
        new WebLinksAddon((_e, uri) => {
          void window.cwb.openExternal(uri)
        })
      )
      sshTermCache.set(connectionId, term)
      sshFitCache.set(connectionId, fit)
      // v2.1.3（用户需求）：交互对齐开发终端——粘贴三键/智能 Ctrl+C 复制/
      // 恒复制键/字号 Ctrl+=/-（Shift+Enter 搜索等 claude 专属项不移植）
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true
        const t = sshTermCache.get(connectionId)
        if (t === undefined) return true
        if (
          (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'v') ||
          (ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === 'Insert')
        ) {
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text !== '' && sshTermCache.get(connectionId) === t) t.paste(text)
            })
            .catch(() => {})
          return false
        }
        const isCopyKey =
          (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') ||
          (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c' && t.hasSelection()) ||
          (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === 'Insert')
        if (isCopyKey) {
          const sel = t.getSelection()
          if (sel !== '') {
            void navigator.clipboard.writeText(sel).catch(() => {})
            return false
          }
          return true
        }
        if (!ev.ctrlKey || ev.metaKey || ev.altKey) return true
        if (ev.key === '=' || ev.key === '+') {
          changeFontSize(1)
          return false
        }
        if (ev.key === '-' || ev.key === '_') {
          changeFontSize(-1)
          return false
        }
        return true
      })
      term.onData((d) => window.cwb.writeSshShell(connectionId, d))
      // v2.1.1 目录跟随：PROMPT_COMMAND 注入的 OSC 7（file://host/path）——
      // 解析出 cwd，跟随开启时导航文件面板
      term.parser.registerOscHandler(7, (data) => {
        try {
          const path = decodeURIComponent(new URL(`file://x${data.split(';')[1] ?? ''}`).pathname)
          if (path !== '' && path !== '/') {
            const st = useAppStore.getState()
            if (st.sshFollowEnabled && st.sshConsoleCid === connectionId) {
              const cur = st.sshFollowDir
              if (cur === null || cur.path !== path || cur.connectionId !== connectionId) {
                st.setSshFollowDir(connectionId, path)
              }
            }
          }
        } catch {
          /* 非法 URI 忽略 */
        }
        return false // 不渲染进终端
      })
      term.open(host)
      // v2.1.3：WebGL 渲染器（失败/丢上下文静默回落 DOM——对齐 TerminalView）
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // jsdom/无 GPU——DOM 渲染器
      }
      applyTermTheme(term, termThemeNow())
    } else {
      term.open(host) // 复挂（隐藏期间 DOM 常驻则此路径少走；防御双挂载场景）
    }
    const fit = sshFitCache.get(connectionId)
    const raf = (): void => {
      fit?.fit()
      const r = term
      if (r !== undefined) window.cwb.resizeSshShell(connectionId, r.cols, r.rows)
    }
    requestAnimationFrame(raf)
    // 订阅 shell 输出（先冲放缓冲——openSshShell 首包竞态防护，1.7.5 先例）
    const off = subscribeSshData(connectionId, (d) => sshTermCache.get(connectionId)?.write(d))
    const observer = new ResizeObserver(() => {
      try {
        fit?.fit()
        const r = sshTermCache.get(connectionId)
        if (r !== undefined) window.cwb.resizeSshShell(connectionId, r.cols, r.rows)
      } catch {
        // fit 对不可见宿主可能抛错——忽略
      }
    })
    observer.observe(host)
    return () => {
      off()
      observer.disconnect()
      // 会话随台关/换连接即弃——dispose 防 DOM 复挂错位（shell 早已重建，scrollback 无保留意义）
      sshTermCache.get(connectionId)?.dispose()
      sshTermCache.delete(connectionId)
      sshFitCache.delete(connectionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 实例按 cid 生命周期管理
  }, [connectionId])

  /** v2.1.2 ③：死会话重开时清旧终端画面（新 shell 的 banner 干净进入） */
  const prevDeadRef = useRef(sessionDead)
  useEffect(() => {
    if (prevDeadRef.current && !sessionDead) sshTermCache.get(connectionId)?.reset()
    prevDeadRef.current = sessionDead
  }, [sessionDead, connectionId])

  /** 换连接下拉：openSshConsole 自带「关旧开新」语义 */
  const switchConn = (cid: string): void => {
    if (cid !== connectionId) void openSshConsole(cid)
  }

  const reopen = (): void => {
    if (connState !== 'connected' && conn !== undefined) {
      void connectFlow(connectionId)
    }
    void openSshConsole(connectionId) // open=重开 shell（后端关旧建新）
  }

  // ── 分栏拖拽（mousedown → move → up；对齐 sidebar-resizer 先例）────────
  const onSplitterDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const host = hostRef.current
    if (host === null) return
    const startY = e.clientY
    const total = host.clientHeight
    const startRatio = split
    const onMove = (ev: MouseEvent): void => {
      setDragSplit(clampSplit(startRatio + (ev.clientY - startY) / Math.max(total, 1)))
    }
    const onUp = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const finalRatio = clampSplit(startRatio + (ev.clientY - startY) / Math.max(total, 1))
      setDragSplit(null)
      persistSplit(connectionId, finalRatio)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const splitterKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    let next: number | null = null
    if (e.key === 'ArrowUp') next = clampSplit(split + SPLIT_KEY_STEP)
    else if (e.key === 'ArrowDown') next = clampSplit(split - SPLIT_KEY_STEP)
    else if (e.key === 'Home') next = SPLIT_MAX
    else if (e.key === 'End') next = SPLIT_MIN
    if (next === null) return
    e.preventDefault()
    persistSplit(connectionId, next)
  }

  return (
    <div className="ssh-console" data-testid="ssh-console" ref={hostRef}>
      {/* 工具栏：连接切换 + 目标信息 + 连接胶囊 + 会话态动作 */}
      <div className="ssh-toolbar">
        <span className="ssh-toolbar-title">SSH</span>
        <select
          className="settings-select ssh-conn-select"
          aria-label={t('ssh.connSelect')}
          value={connectionId}
          onChange={(e) => switchConn(e.target.value)}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.user}@{c.host}){c.kind === 'ssh' ? ` · ${t('ssh.kindPure')}` : ''}
            </option>
          ))}
        </select>
        {conn !== undefined && (
          <span className="provider-url mono" title={`${conn.user}@${conn.host}:${conn.port}`}>
            {conn.user}@{conn.host}:{conn.port}
          </span>
        )}
        {conn?.kind === 'ssh' && <span className="ssh-kind-badge">SSH</span>}
        <label className="ssh-follow-toggle" title={t('ssh.followHint')}>
          <input
            type="checkbox"
            checked={sshFollowEnabled}
            onChange={(e) => setSshFollowEnabled(e.target.checked)}
          />
          {t('ssh.follow')}
        </label>
        <span className="conn-pill" data-state={connState}>
          {connState}
        </span>
        <span className="ssh-toolbar-acts">
          {frozen && (
            <button type="button" className="btn small primary" onClick={reopen}>
              {sessionDead && connState === 'connected' ? t('ssh.reopen') : t('ssh.reconnect')}
            </button>
          )}
        </span>
      </div>

      {/* 上：裸 shell（xterm）；冻结层复用 term-frozen 视觉 */}
      <div
        className="ssh-term-wrap"
        style={{ height: `${Math.round(split * 1000) / 10}%` }}
        onMouseDown={() => sshTermCache.get(connectionId)?.focus()}
        onContextMenu={(e) => {
          e.preventDefault()
          const term = sshTermCache.get(connectionId)
          // v2.1.3 右键智能动作（Windows Terminal 语义）：无选中=粘贴，有选中=
          // 复制并清选中；Shift+右键=完整菜单（复制/粘贴/全选/清屏）——对齐开发终端
          if (!e.shiftKey) {
            if (term !== undefined && term.hasSelection()) {
              const sel = term.getSelection()
              if (sel !== '') void navigator.clipboard.writeText(sel).catch(() => {})
              term.clearSelection()
              term.focus()
              return
            }
            term?.focus()
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text !== '' && sshTermCache.get(connectionId) === term) term?.paste(text)
              })
              .catch(() => {})
            return
          }
          setCtxMenu({ x: e.clientX, y: e.clientY, sel: term?.getSelection() ?? '' })
        }}
      >
        <div ref={termHostRef} className="ssh-term-host" />
        {frozen && (
          <div className="term-frozen" role="status">
            <span className="term-frozen-msg">
              {sessionDead && connState === 'connected' ? t('ssh.deadMsg') : t('conn.frozen')}
            </span>
            <span className="ssh-frozen-sub">
              <button type="button" className="btn small primary" onClick={reopen}>
                {sessionDead && connState === 'connected' ? t('ssh.reopen') : t('ssh.reconnect')}
              </button>
            </span>
          </div>
        )}
      </div>

      {ctxMenu !== null && (
        <SidebarMenu
          triggerRef={nullBtnRef}
          anchor={{ x: ctxMenu.x, y: ctxMenu.y }}
          items={[
            ...(ctxMenu.sel !== ''
              ? [
                  {
                    label: t('term.copy'),
                    onClick: () =>
                      void navigator.clipboard.writeText(ctxMenu.sel).catch(() => {})
                  }
                ]
              : []),
            {
              label: t('term.paste'),
              onClick: () =>
                void navigator.clipboard
                  .readText()
                  .then((text) => {
                    if (text !== '') sshTermCache.get(connectionId)?.paste(text)
                  })
                  .catch(() => {})
                  .finally(() => sshTermCache.get(connectionId)?.focus())
            },
            {
              label: t('term.selectAll'),
              onClick: () => sshTermCache.get(connectionId)?.selectAll()
            },
            {
              label: t('term.clear'),
              onClick: () => sshTermCache.get(connectionId)?.clear()
            }
          ]}
          onClose={() => {
            setCtxMenu(null)
            focusActiveTerminal()
          }}
        />
      )}
      {/* 分隔条：拖拽调高 / 双击复位 / 键盘步进 */}
      <div
        className="ssh-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('ssh.splitterAria')}
        tabIndex={0}
        title={t('ssh.splitterHint')}
        onMouseDown={onSplitterDown}
        onDoubleClick={() => persistSplit(connectionId, 0.5)}
        onKeyDown={splitterKeyDown}
      />

      {/* 下：远程文件面板（复用；同连接） */}
      <div className="ssh-files-host" style={{ height: `${Math.round((1 - split) * 1000) / 10}%` }}>
        {connState === 'connected' ? (
          <RemoteFilesPanel connectionId={connectionId} />
        ) : (
          <div className="ssh-files-frozen">{t('ssh.filesFrozen')}</div>
        )}
      </div>
    </div>
  )
}

function termThemeNow(): EffectiveTheme {
  const s = useAppStore.getState()
  return s.termFollowsTheme ? s.effectiveTheme : 'dark'
}

function clampSplit(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) * 1000) / 1000
}

function persistSplit(connectionId: string, ratio: number): void {
  const cur = useAppStore.getState().uiSettings.sshSplit ?? {}
  const next = { ...cur, [connectionId]: ratio }
  useAppStore.setState((s) => ({ uiSettings: { ...s.uiSettings, sshSplit: next } }))
  window.cwb.setAppSettings({ sshSplit: next }).catch(() => {})
}
