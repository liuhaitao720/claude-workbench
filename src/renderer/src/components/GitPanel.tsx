import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type {
  DiffFileDetail,
  GitActionPayload,
  GitCommitFileInfo,
  GitCommitInfo,
  GitRepoStatus
} from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { DiffReview } from './DiffReview'
import { SidebarMenu } from './SidebarMenu'

/**
 * v2.2.5 Git 工作台（用户需求 2026-11-23，IDEA Git 工具窗式；合并原代码审查窗口——
 * 用户指令：审查窗口移除，工作区变更为本面板的一个模式）。
 *
 * 结构：
 * - GitFrame：主区前台容器（TerminalPanel 挂载，三方互斥：任务/Git/SSH）——
 *   顶栏（模式切换 工作区|历史 + 当前分支↑↓ + Stash/远程/⟳/拉取/推送）+ 内容；
 *   工作区模式=嵌入 DiffReview（reviewState 机器原样复用）；历史模式=GitHistory。
 * - GitHistory：左分支栏（本地/远程 + 行右键动作）+ 中提交时间线（git --graph
 *   ASCII 前缀逐字符渲染，保留分叉/合并曲线）+ 右提交详情（变更文件 → diff 弹窗）。
 * - 动作弹窗：合并/拉取模式选择（--ff-only|--no-ff|--rebase）、推送（-f 确认）、
 *   新建分支、Stash 面板、远程 URL 管理。全走 gitAction IPC（git 自带命令）。
 */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 相对时间（IDEA log 式）：今天=时:分，今年=月-日，往年=yyyy-mm-dd */
function relTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const md = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return md
  return `${d.getFullYear()}-${md}`
}

// ══════════════════════════ GitFrame（前台容器）══════════════════════════

export function GitFrame() {
  const t = useI18n()
  const projects = useAppStore((s) => s.projects)
  const reviewState = useAppStore((s) => s.reviewState)
  const reviewActive = useAppStore((s) => s.reviewActive)
  const gitPanel = useAppStore((s) => s.gitPanel)
  const openReview = useAppStore((s) => s.openReview)
  const openGitPanel = useAppStore((s) => s.openGitPanel)
  const activateReview = useAppStore((s) => s.activateReview)
  const activateGit = useAppStore((s) => s.activateGit)
  const refreshReview = useAppStore((s) => s.refreshReview)

  const projectId = gitPanel?.projectId ?? reviewState?.projectId ?? null
  const project = projectId !== null ? projects.find((p) => p.id === projectId) : undefined
  const mode: 'worktree' | 'history' = reviewActive ? 'worktree' : 'history'

  /** 仓库状态（当前分支/徽记/stash 数——顶栏展示；两模式共用） */
  const [status, setStatus] = useState<GitRepoStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)
  /** 拉取/合并等动作后的轻提示（任务区 toast 语义；3s 自清） */
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef<number | null>(null)

  const loadStatus = useCallback(
    (pid: string) => {
      void window.cwb
        .gitStatus(pid)
        .then((r) => {
          if (r.ok) {
            setStatus(r.status)
            setStatusError('')
          } else {
            setStatus(null)
            setStatusError(r.error)
          }
        })
        .catch((err: unknown) => setStatusError(errMsg(err)))
    },
    []
  )
  useEffect(() => {
    if (projectId !== null) loadStatus(projectId)
  }, [projectId, loadStatus])

  /** 统一动作入口：执行 → 提示 → 状态/审查/日志全刷新 */
  const runAction = useCallback(
    async (action: GitActionPayload): Promise<boolean> => {
      if (projectId === null) return false
      setBusy(true)
      try {
        const r = await window.cwb.gitAction(projectId, action)
        if (!r.ok) {
          setNotice(r.error ?? 'git action failed')
          return false
        }
        setNotice(t('git.actionOk'))
        loadStatus(projectId)
        if (mode === 'worktree') void refreshReview()
        window.dispatchEvent(new CustomEvent('cwb-git-refresh'))
        return true
      } catch (err) {
        setNotice(errMsg(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    [projectId, loadStatus, mode, refreshReview, t]
  )

  useEffect(() => {
    if (notice === '') return
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000)
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    }
  }, [notice])

  const cur = status?.current ?? ''
  const curBranch = status?.branches.find((b) => b.name === cur)
  /** 远程分支名 → 本地同名（检出远程=建跟踪分支） */
  const localOf = (name: string): string => name.split('/').slice(1).join('/') || name

  if (projectId === null || project === undefined) return null

  const switchMode = (m: 'worktree' | 'history'): void => {
    if (m === 'worktree') {
      if (reviewState !== null && reviewState.projectId === projectId) activateReview()
      else void openReview(projectId, project.dir)
      return
    }
    if (gitPanel !== null && gitPanel.projectId === projectId) activateGit()
    else openGitPanel(projectId)
  }

  return (
    <div className="git-frame" data-testid="git-frame">
      <div className="git-head">
        <b>⑂ Git</b>
        <span className="git-proj" title={project.dir}>
          {project.name}
        </span>
        <div className="git-mode" role="tablist" aria-label={t('git.modeAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'worktree'}
            className={mode === 'worktree' ? 'git-mode-btn on' : 'git-mode-btn'}
            data-testid="git-mode-worktree"
            onClick={() => switchMode('worktree')}
          >
            {t('git.mode.worktree')}
            {reviewState?.projectId === projectId && reviewState.files.length > 0 ? ` (${reviewState.files.length})` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'history'}
            className={mode === 'history' ? 'git-mode-btn on' : 'git-mode-btn'}
            data-testid="git-mode-history"
            onClick={() => switchMode('history')}
          >
            {t('git.mode.history')}
          </button>
        </div>
        <span className="git-branch-cur" title={cur}>
          {cur !== '' && `⑂ ${cur}`}
          {curBranch?.ahead !== undefined && curBranch.ahead > 0 && <span className="badge ahead">↑{curBranch.ahead}</span>}
          {curBranch?.behind !== undefined && curBranch.behind > 0 && <span className="badge behind">↓{curBranch.behind}</span>}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn small"
          title={t('git.stashTitle')}
          disabled={busy}
          onClick={() => setDialog({ kind: 'stash' })}
        >
          ◫ {t('git.stashBtn')}{status !== null && status.stashes.length > 0 ? ` (${status.stashes.length})` : ''}
        </button>
        <button type="button" className="btn small" disabled={busy} title={t('git.remoteTitle')} onClick={() => setDialog({ kind: 'remotes' })}>
          ⚙ {t('git.remoteBtn')}
        </button>
        <button
          type="button"
          className="btn small"
          title={t('git.refresh')}
          disabled={busy}
          onClick={() => {
            loadStatus(projectId)
            if (mode === 'worktree') void refreshReview()
            window.dispatchEvent(new CustomEvent('cwb-git-refresh'))
          }}
        >
          ⟳
        </button>
        <button
          type="button"
          className="btn small"
          disabled={busy}
          title={t('git.pullTitle')}
          onClick={() => setDialog({ kind: 'pull' })}
        >
          ⇩ {t('git.pullBtn')}
        </button>
        <button
          type="button"
          className="btn small"
          disabled={busy}
          title={t('git.pushTitle')}
          onClick={() => setDialog({ kind: 'push' })}
        >
          ⇪ {t('git.pushBtn')}
        </button>
      </div>
      {statusError !== '' && <p className="inline-error git-status-err" role="alert">{statusError}</p>}
      {notice !== '' && (
        <p className="git-notice" role="status" data-testid="git-notice">
          {notice}
        </p>
      )}
      <div className="git-body">
        {mode === 'worktree' ? (
          <DiffReview />
        ) : (
          <GitHistory projectId={projectId} status={status} statusError={statusError} busy={busy} runAction={runAction} openDialog={setDialog} localOf={localOf} onOpenWorktree={() => switchMode('worktree')} />
        )}
      </div>
      {dialog !== null && (
        <GitDialog
          state={dialog}
          projectId={projectId}
          status={status}
          close={() => setDialog(null)}
          runAction={runAction}
          reloadStatus={() => loadStatus(projectId)}
        />
      )}
    </div>
  )
}

// ══════════════════════════ GitHistory（历史模式）══════════════════════════

interface GitHistoryProps {
  projectId: string
  status: GitRepoStatus | null
  statusError: string
  busy: boolean
  runAction: (a: GitActionPayload) => Promise<boolean>
  openDialog: (d: DialogState) => void
  localOf: (remoteName: string) => string
  /** v2.2.6（用户实测：历史模式缺未提交变更入口）：点击工作区卡片 → 切工作区模式 */
  onOpenWorktree: () => void
}

function GitHistory(props: GitHistoryProps) {
  const t = useI18n()
  const { projectId, status, statusError, busy, runAction, openDialog, localOf, onOpenWorktree } = props
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [logError, setLogError] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ hash: string; message: string; author: string; date: string; files: GitCommitFileInfo[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  /** v2.2.5：详情加载失败显性化（此前静默空面板——用户无从得知原因） */
  const [detailError, setDetailError] = useState('')
  const [fileDiff, setFileDiff] = useState<{ hash: string; path: string; detail: DiffFileDetail } | null>(null)
  const [ctxBranch, setCtxBranch] = useState<{ x: number; y: number; name: string; isRemote: boolean } | null>(null)
  const [ctxCommit, setCtxCommit] = useState<{ x: number; y: number; hash: string } | null>(null)
  const nullBtnRef = useRef<HTMLButtonElement>(null)

  const loadLog = useCallback((): void => {
    setLoading(true)
    void window.cwb
      .gitLog(projectId)
      .then((r) => {
        if (r.ok) {
          setCommits(r.commits)
          setLogError('')
          // v2.2.5（用户实测反馈：右栏要立即可见）——进入即自动选中首个提交，
          // 详情/变更文件/diff 入口不再藏 behind 空提示；刷新保留原选中
          setSel((prev) => prev ?? r.commits[0]?.hash ?? null)
        } else setLogError(r.error)
      })
      .catch((err: unknown) => setLogError(errMsg(err)))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(loadLog, [loadLog])
  useEffect(() => {
    const h = (): void => loadLog()
    window.addEventListener('cwb-git-refresh', h)
    return () => window.removeEventListener('cwb-git-refresh', h)
  }, [loadLog])

  useEffect(() => {
    if (sel === null) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    void window.cwb
      .gitCommitDetail(projectId, sel)
      .then((r) => {
        if (r.ok) {
          setDetailError('')
          setDetail({ hash: sel, message: r.message, author: r.author, date: r.date, files: r.files })
        } else {
          setDetailError(r.error)
          setDetail({ hash: sel, message: '', author: '', date: '', files: [] })
        }
      })
      .catch((e: unknown) => {
        setDetailError(errMsg(e))
        setDetail({ hash: sel, message: '', author: '', date: '', files: [] })
      })
      .finally(() => setDetailLoading(false))
  }, [sel, projectId])

  const openFileDiff = (hash: string, path: string): void => {
    void window.cwb.gitCommitFileDiff(projectId, hash, path).then((r) => {
      if (r.ok) setFileDiff({ hash, path, detail: r.detail })
    })
  }

  const localBranches = status?.branches.filter((b) => !b.isRemote) ?? []
  const remoteBranches = status?.branches.filter((b) => b.isRemote) ?? []
  const kw = filter.trim().toLowerCase()
  const shown = commits.filter(
    (c) => kw === '' || c.subject.toLowerCase().includes(kw) || c.author.toLowerCase().includes(kw) || c.short.includes(kw)
  )

  /** 分支行菜单（IDEA branches popup 项集） */
  const branchItems = (name: string, isRemote: boolean): Array<{ label: string; danger?: boolean; onClick: () => void }> => {
    const current = status?.current === name
    const out: Array<{ label: string; danger?: boolean; onClick: () => void }> = []
    if (!current) {
      out.push({
        label: t('git.checkout'),
        onClick: () => {
          if (isRemote) {
            void runAction({ op: 'switchTrack', local: localOf(name), remoteRef: name })
          } else {
            void runAction({ op: 'switch', branch: name })
          }
        }
      })
    }
    out.push({
      label: t('git.newBranchFrom'),
      onClick: () => openDialog({ kind: 'newBranch', base: isRemote ? name : name })
    })
    if (!isRemote && !current) {
      out.push({
        label: t('git.mergeInto'),
        onClick: () => openDialog({ kind: 'merge', branch: name })
      })
    }
    out.push({ label: t('git.pull'), onClick: () => openDialog({ kind: 'pull' }) })
    out.push({ label: t('git.pushBtn'), onClick: () => openDialog({ kind: 'push' }) })
    if (!isRemote && !current) {
      out.push({
        label: t('git.deleteBranch'),
        danger: true,
        onClick: () => {
          const unmerged = window.confirm(t('git.deleteUnmerged', { name }))
          void runAction({ op: 'deleteBranch', branch: name, force: unmerged })
        }
      })
    }
    return out
  }

  return (
    <div className="git-history" data-testid="git-history">
      {/* 左：分支 */}
      <div className="git-branches">
        <div className="git-pane-head">
          <span style={{ flex: 1 }}>{t('git.branches')}</span>
          <button type="button" className="btn small" onClick={() => openDialog({ kind: 'newBranch' })}>
            ＋ {t('git.newBranch')}
          </button>
        </div>
        <div className="git-branch-list">
          {statusError !== '' && <p className="inline-error">{statusError}</p>}
          <div className="git-branch-group">{t('git.groupLocal')}</div>
          {localBranches.map((b) => (
            <div
              key={b.name}
              className={status?.current === b.name ? 'git-branch-row current' : 'git-branch-row'}
              data-testid="git-branch"
              data-branch={b.name}
              onClick={() => setSel(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxBranch({ x: e.clientX, y: e.clientY, name: b.name, isRemote: b.isRemote })
              }}
            >
              {status?.current === b.name && <span className="git-cur-dot" aria-label={t('git.currentAria')}>●</span>}
              <span className="git-branch-name" title={`${b.name}${b.short !== '' ? ` · ${b.short}` : ''}`}>
                {b.name}
              </span>
              {b.ahead !== undefined && b.ahead > 0 && <span className="badge ahead">↑{b.ahead}</span>}
              {b.behind !== undefined && b.behind > 0 && <span className="badge behind">↓{b.behind}</span>}
            </div>
          ))}
          <div className="git-branch-group">{t('git.groupRemote')}</div>
          {remoteBranches.map((b) => (
            <div
              key={b.name}
              className="git-branch-row"
              data-testid="git-branch"
              data-branch={b.name}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxBranch({ x: e.clientX, y: e.clientY, name: b.name, isRemote: b.isRemote })
              }}
            >
              <span className="git-branch-name" title={b.name}>
                {b.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 中：提交时间线 */}
      <div className="git-log">
        <div className="git-pane-head">
          <input
            className="git-log-filter"
            placeholder={t('git.filterPh')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('git.filterPh')}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            {status?.current ?? ''} · {commits.length}
          </span>
        </div>
        <div className="git-log-list">
          {/* v2.2.6 原型还原：工作区未提交变更卡——点击直达工作区模式（文件修改点+diff） */}
          {status !== null && status.wcCount > 0 && (
            <button type="button" className="git-wc-card" data-testid="git-wc-card" onClick={onOpenWorktree}>
              <span className="git-wc-icon" aria-hidden="true">⚙</span>
              <span className="git-wc-text">{t('git.wcCard')}</span>
              <span className="git-wc-count">{t('git.wcCount', { n: String(status.wcCount) })}</span>
              <span className="muted git-wc-hint">{t('git.wcOpen')}</span>
            </button>
          )}
          {loading && <p className="muted git-hint">{t('common.loading')}</p>}
          {!loading && logError !== '' && <p className="inline-error">{logError}</p>}
          {!loading && logError === '' && shown.length === 0 && <p className="muted git-hint">{t('git.emptyLog')}</p>}
          {shown.map((c) => (
            <div
              key={c.hash}
              className={sel === c.hash ? 'git-commit-row sel' : 'git-commit-row'}
              data-testid="git-commit"
              data-hash={c.short}
              onClick={() => setSel(c.hash)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxCommit({ x: e.clientX, y: e.clientY, hash: c.hash })
              }}
            >
              <span className="git-graph" aria-hidden="true">
                {c.graph.split('').map((ch, i) => (
                  <span key={i} className={ch === '*' ? 'g-dot' : ch === '|' ? 'g-line' : ch === '\\' || ch === '/' ? 'g-curve' : ch === '_' || ch === '.' ? 'g-line' : undefined}>
                    {ch === '*' ? '●' : ch === '\\' ? '╲' : ch === '/' ? '╱' : ch === ' ' ? ' ' : ch === '_' ? '─' : ch === '.' ? '·' : ch}
                  </span>
                ))}
              </span>
              <span className="git-commit-hash">{c.short}</span>
              {c.refs !== undefined && c.refs.includes('HEAD') && <span className="git-ref-tag">HEAD</span>}
              <span className="git-commit-msg" title={c.subject}>
                {c.subject}
              </span>
              <span className="git-commit-meta">
                {c.author} · {relTime(c.date)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 右：提交详情 */}
      <div className="git-detail">
        {detail === null ? (
          <p className="muted git-hint">{t('git.detailHint')}</p>
        ) : (
          <>
            <div className="git-detail-head">
              <p className="git-detail-msg">{detail.message || t('git.noMessage')}</p>
              <div className="git-detail-meta">
                <code>{detail.hash.slice(0, 12)}</code>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void window.cwb.clipboardWriteText(detail.hash).catch(() => {})}
                >
                  {t('git.copyHash')}
                </button>
                <span>
                  {detail.author} · {relTime(detail.date)}
                </span>
              </div>
            </div>
            <div className="git-detail-files">
              {detailError !== '' && (
                <p className="inline-error" role="alert" data-testid="git-detail-error">
                  {detailError}
                </p>
              )}
              {detailLoading && <p className="muted git-hint">{t('common.loading')}</p>}
              {!detailLoading && detail.files.length === 0 && <p className="muted git-hint">{t('git.noFiles')}</p>}
              {detail.files.map((f) => (
                <button
                  type="button"
                  key={`${f.status}-${f.path}`}
                  className="git-file-row"
                  title={f.oldPath !== undefined ? `${f.oldPath} → ${f.path}` : f.path}
                  onClick={() => openFileDiff(detail.hash, f.path)}
                >
                  <span className={`git-st ${f.status}`}>{f.status}</span>
                  <span className="git-file-path">{f.oldPath !== undefined ? `${f.oldPath} → ${f.path}` : f.path}</span>
                  <span className="git-file-num">
                    {f.add !== undefined && <span className="add">+{f.add}</span>} {f.del !== undefined && <span className="del">-{f.del}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 分支/提交右键菜单 */}
      {ctxBranch !== null && (
        <SidebarMenu
          triggerRef={nullBtnRef}
          anchor={{ x: ctxBranch.x, y: ctxBranch.y }}
          onClose={() => setCtxBranch(null)}
          items={branchItems(ctxBranch.name, ctxBranch.isRemote)}
        />
      )}
      {ctxCommit !== null && (
        <SidebarMenu
          triggerRef={nullBtnRef}
          anchor={{ x: ctxCommit.x, y: ctxCommit.y }}
          onClose={() => setCtxCommit(null)}
          items={[
            {
              label: t('git.cherryPick'),
              onClick: () => {
                if (window.confirm(t('git.cherryPickConfirm', { hash: ctxCommit.hash.slice(0, 8) }))) {
                  void runAction({ op: 'cherryPick', hash: ctxCommit.hash })
                }
              }
            },
            { label: t('git.copyShortHash'), onClick: () => void window.cwb.clipboardWriteText(ctxCommit.hash.slice(0, 8)).catch(() => {}) },
            { label: t('git.copyHash'), onClick: () => void window.cwb.clipboardWriteText(ctxCommit.hash).catch(() => {}) }
          ]}
        />
      )}

      {/* 提交文件 diff 弹窗（DiffFileDetail——审查视图同款数据） */}
      {fileDiff !== null && (
        <div className="git-dialog-overlay" role="dialog" aria-label={fileDiff.path}>
          <div className="git-dialog-card git-filediff-card">
            <p className="git-dialog-title">
              <code>{fileDiff.hash.slice(0, 8)}</code> · {fileDiff.path}
            </p>
            <div className="git-filediff-body">
              {fileDiff.detail.binary ? (
                <p className="muted git-hint">{t('review.binary')}</p>
              ) : fileDiff.detail.hunks.length === 0 ? (
                <p className="muted git-hint">{t('git.noDiff')}</p>
              ) : (
                fileDiff.detail.hunks.map((h, i) => (
                  <pre key={i} className="git-hunk">
                    <span className="dl-hunk">{h.header}
{'\n'}</span>
                    {h.lines.map((l, j) => (
                      <span key={j} className={l.type === 'add' ? 'dl-add' : l.type === 'del' ? 'dl-del' : 'dl-ctx'}>
                        {l.text}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                ))
              )}
            </div>
            <div className="git-dialog-actions">
              <button type="button" className="btn" onClick={() => setFileDiff(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
      {busy && <p className="git-busy" role="status">{t('git.busy')}</p>}
    </div>
  )
}

// ══════════════════════════ 操作弹窗 ═══════════════════════════

type DialogState =
  | null
  | { kind: 'pull' }
  | { kind: 'push' }
  | { kind: 'merge'; branch: string }
  | { kind: 'newBranch'; base?: string }
  | { kind: 'stash' }
  | { kind: 'remotes' }

interface GitDialogProps {
  state: Exclude<DialogState, null>
  projectId: string
  status: GitRepoStatus | null
  close: () => void
  runAction: (a: GitActionPayload) => Promise<boolean>
  reloadStatus: () => void
}

function GitDialog(props: GitDialogProps) {
  const t = useI18n()
  const { state, close, runAction, status, reloadStatus } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 模式单选（合并/拉取） */
  const [mergeMode, setMergeMode] = useState<'default' | 'ff-only' | 'no-ff'>('default')
  const [pullMode, setPullMode] = useState<'default' | 'rebase' | 'ff-only'>('default')
  const [pushForce, setPushForce] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [branchBase, setBranchBase] = useState('')
  const [stashMsg, setStashMsg] = useState('')
  const [remoteName, setRemoteName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteEdit, setRemoteEdit] = useState<{ name: string; url: string } | null>(null)

  const act = async (a: GitActionPayload, after?: () => void): Promise<void> => {
    setBusy(true)
    setError('')
    const ok = await runAction(a)
    setBusy(false)
    if (ok) {
      after?.()
      close()
    } else {
      setError(t('git.actionFailed'))
    }
  }

  const title = (s: string): ReactElement => <p className="git-dialog-title">{s}</p>
  const actions = (confirmLabel: string, onConfirm: () => void, danger?: boolean): ReactElement => (
    <div className="git-dialog-actions">
      <button type="button" className="btn" disabled={busy} onClick={close}>
        {t('common.cancel')}
      </button>
      <button type="button" className={danger === true ? 'btn danger' : 'btn primary'} disabled={busy} onClick={onConfirm}>
        {busy ? t('git.busy') : confirmLabel}
      </button>
    </div>
  )
  const errBar = error !== '' ? <p className="inline-error" role="alert">{error}</p> : null

  switch (state.kind) {
    case 'pull':
      return (
        <GitOverlay onClose={close} label={t('git.pullTitle')}>
          {title(t('git.pullTitle'))}
          <div className="git-radio" role="radiogroup" aria-label={t('git.pullModeLabel')}>
            {(['default', 'rebase', 'ff-only'] as const).map((m) => (
              <label key={m}>
                <input type="radio" name="pull-mode" checked={pullMode === m} onChange={() => setPullMode(m)} />
                {t(`git.pullMode.${m}`)}
              </label>
            ))}
          </div>
          {errBar}
          {actions(t('git.pullConfirm'), () => void act({ op: 'pull', mode: pullMode }))}
        </GitOverlay>
      )
    case 'push':
      return (
        <GitOverlay onClose={close} label={t('git.pushTitle')}>
          {title(t('git.pushTitle'))}
          <p className="muted git-dialog-hint">{t('git.pushHint')}</p>
          <label className="git-check">
            <input type="checkbox" checked={pushForce} onChange={(e) => setPushForce(e.target.checked)} data-testid="git-push-force" />
            {t('git.pushForce')}
          </label>
          {pushForce && <p className="inline-error" role="alert">{t('git.pushForceWarn')}</p>}
          {errBar}
          {actions(t('git.pushConfirm'), () => {
            if (pushForce && !window.confirm(t('git.pushForceConfirm'))) return
            const cur = status?.current ?? ''
            const curInfo = status?.branches.find((b) => b.name === cur)
            const firstRemote = status?.remotes[0]?.name
            void act({
              op: 'push',
              force: pushForce,
              remote: curInfo?.upstream !== undefined || firstRemote === undefined ? undefined : firstRemote,
              branch: curInfo?.upstream !== undefined ? undefined : cur,
              setUpstream: curInfo?.upstream === undefined && firstRemote !== undefined && cur !== ''
            })
          }, pushForce)}
        </GitOverlay>
      )
    case 'merge':
      return (
        <GitOverlay onClose={close} label={t('git.mergeTitle', { name: state.branch })}>
          {title(t('git.mergeTitle', { name: state.branch }))}
          <div className="git-radio" role="radiogroup" aria-label={t('git.mergeModeLabel')}>
            {(['default', 'ff-only', 'no-ff'] as const).map((m) => (
              <label key={m}>
                <input type="radio" name="merge-mode" checked={mergeMode === m} onChange={() => setMergeMode(m)} data-testid={`git-merge-${m}`} />
                {t(`git.mergeMode.${m}`)}
              </label>
            ))}
          </div>
          {errBar}
          {actions(t('git.mergeConfirm'), () => void act({ op: 'merge', branch: state.branch, mode: mergeMode }))}
        </GitOverlay>
      )
    case 'newBranch':
      return (
        <GitOverlay onClose={close} label={t('git.newBranchTitle')}>
          {title(t('git.newBranchTitle'))}
          <label className="git-field-label" htmlFor="git-new-branch-name">{t('git.branchNameLabel')}</label>
          <input
            id="git-new-branch-name"
            className="git-dialog-input"
            autoFocus
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            data-testid="git-new-branch-name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && branchName.trim() !== '') void act({ op: 'createBranch', name: branchName.trim(), base: branchBase.trim() === '' ? undefined : branchBase.trim() })
            }}
          />
          <label className="git-field-label" htmlFor="git-new-branch-base">{t('git.branchBaseLabel')}</label>
          <input
            id="git-new-branch-base"
            className="git-dialog-input"
            placeholder={state.base ?? status?.current ?? ''}
            value={branchBase}
            onChange={(e) => setBranchBase(e.target.value)}
          />
          {errBar}
          {actions(t('git.newBranchConfirm'), () => void act({ op: 'createBranch', name: branchName.trim(), base: branchBase.trim() === '' ? (state.base ?? undefined) : branchBase.trim() }))}
        </GitOverlay>
      )
    case 'stash':
      return (
        <GitOverlay onClose={close} label={t('git.stashTitle')}>
          {title(t('git.stashTitle'))}
          <div className="git-stash-list">
            {(status?.stashes ?? []).map((st) => (
              <div key={st.index} className="git-stash-row" data-testid="git-stash-row">
                <span className="git-commit-hash">{`stash@{${st.index}}`}</span>
                <span className="git-commit-msg" title={st.message}>
                  {st.message}
                </span>
                <button type="button" className="btn small" disabled={busy} onClick={() => void act({ op: 'stashPop', index: st.index })}>
                  {t('git.stashPop')}
                </button>
                <button type="button" className="btn small" disabled={busy} onClick={() => void act({ op: 'stashPop', index: st.index, apply: true })}>
                  {t('git.stashApply')}
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t('git.stashDropConfirm', { n: String(st.index) }))) void act({ op: 'stashDrop', index: st.index })
                  }}
                >
                  {t('common.remove')}
                </button>
              </div>
            ))}
            {(status?.stashes ?? []).length === 0 && <p className="muted git-hint">{t('git.stashEmpty')}</p>}
          </div>
          <label className="git-field-label" htmlFor="git-stash-msg">{t('git.stashMsgLabel')}</label>
          <div className="git-stash-push">
            <input id="git-stash-msg" className="git-dialog-input" value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} data-testid="git-stash-msg" />
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void act({ op: 'stashPush', message: stashMsg.trim() === '' ? undefined : stashMsg.trim() }, reloadStatus)}
            >
              {t('git.stashPush')}
            </button>
          </div>
          {errBar}
        </GitOverlay>
      )
    case 'remotes':
      return (
        <GitOverlay onClose={close} label={t('git.remoteTitle')}>
          {title(t('git.remoteTitle'))}
          <div className="git-remote-list">
            {(status?.remotes ?? []).map((r) => (
              <div key={r.name} className="git-remote-row" data-testid="git-remote-row">
                <b className="git-remote-name">{r.name}</b>
                <code className="git-remote-url" title={`${r.fetchUrl}${r.pushUrl !== undefined ? ` · push: ${r.pushUrl}` : ''}`}>
                  {r.fetchUrl}
                </code>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setRemoteEdit({ name: r.name, url: r.fetchUrl })
                    setRemoteName(r.name)
                    setRemoteUrl(r.fetchUrl)
                  }}
                >
                  {t('common.edit')}
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t('git.remoteRemoveConfirm', { name: r.name }))) void act({ op: 'remoteRemove', name: r.name }, reloadStatus)
                  }}
                >
                  {t('common.remove')}
                </button>
              </div>
            ))}
            {(status?.remotes ?? []).length === 0 && <p className="muted git-hint">{t('git.remoteEmpty')}</p>}
          </div>
          <div className="git-remote-form">
            <input
              className="git-dialog-input"
              placeholder={t('git.remoteNamePh')}
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
              aria-label={t('git.remoteNamePh')}
            />
            <input
              className="git-dialog-input"
              placeholder="https://github.com/user/repo.git"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              aria-label={t('git.remoteUrlPh')}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || remoteName.trim() === '' || remoteUrl.trim() === ''}
              onClick={() => {
                const isEdit = remoteEdit !== null && remoteEdit.name === remoteName.trim()
                void act(
                  isEdit
                    ? { op: 'remoteSetUrl', name: remoteName.trim(), url: remoteUrl.trim() }
                    : { op: 'remoteAdd', name: remoteName.trim(), url: remoteUrl.trim() },
                  reloadStatus
                )
              }}
            >
              {remoteEdit !== null && remoteEdit.name === remoteName.trim() ? t('common.save') : t('git.remoteAdd')}
            </button>
          </div>
          {errBar}
        </GitOverlay>
      )
  }
}

/** 弹窗外壳：Esc 关闭 + overlay 点击关闭（busy 时锁） */
function GitOverlay({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }): ReactElement {
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
  }
  return (
    <div className="git-dialog-overlay" role="dialog" aria-label={label} onKeyDown={onKeyDown}>
      <div className="git-dialog-card">{children}</div>
    </div>
  )
}
