import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DiffHunk } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { focusActiveTerminal } from './TerminalPanel'

/**
 * v2.0.2 主区审查模式（git diff）：文件列表 + 统一 diff 双栏，覆盖终端区渲染
 * （终端 DOM 常驻仅 display 隐藏——xterm 实例与滚动位置不丢）。
 *
 * 键盘模型（焦点决定 ↑/↓ 语义）：
 * - 文件列表聚焦：↑/↓ 换文件（选中即预览），Home/End 首末文件；
 * - diff 视图聚焦：↑/↓ 上/下一个修改点（hunk），滚到视口中央；越过文件尾
 *   自动进入下一文件首个 hunk（连续审查流）；Home/End 首/末 hunk；
 * - Tab 两栏与工具栏轮转；Esc 关闭审查（回上一个任务终端）。
 * hunk 游标为组件本地态（切文件重置为 0）。
 */
export function DiffReview() {
  const t = useI18n()
  const reviewState = useAppStore((s) => s.reviewState)
  const projects = useAppStore((s) => s.projects)
  const selectReviewFile = useAppStore((s) => s.selectReviewFile)
  const refreshReview = useAppStore((s) => s.refreshReview)
  const closeReview = useAppStore((s) => s.closeReview)
  const openTaskAutoResume = useAppStore((s) => s.openTaskAutoResume)
  const [hunkIndex, setHunkIndex] = useState(0)
  const [focusPane, setFocusPane] = useState<'list' | 'diff'>('list')
  const listRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<HTMLDivElement>(null)
  const hunkRefs = useRef<Array<HTMLDivElement | null>>([])

  const project = projects.find((p) => p.id === reviewState?.projectId)
  const files = reviewState?.files ?? []
  const detail = reviewState?.detail ?? null
  const selected = files.find((f) => f.path === reviewState?.selectedPath) ?? null

  // 首个带详情的文件自动选中（打开/刷新后免一次点击）
  useEffect(() => {
    if (reviewState === null) return
    if (reviewState.selectedPath === null && files.length > 0) {
      const first = files.find((f) => f.status !== 'U') ?? files[0]!
      void selectReviewFile(first.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅清单到位时补选首文件
  }, [reviewState?.projectId, reviewState?.cwd, files])

  // 切文件重置 hunk 游标
  useEffect(() => {
    setHunkIndex(0)
  }, [reviewState?.selectedPath])

  // hunk 跳转：滚到视口中央 + 播报（aria-live 在计数器节点上）。
  // scrollIntoView 可选调用（jsdom 无此 API——测试环境不因缺实现炸树）
  useEffect(() => {
    hunkRefs.current[hunkIndex]?.scrollIntoView?.({ block: 'center' })
  }, [hunkIndex, reviewState?.selectedPath])

  const hunks = detail?.hunks ?? []
  const hunkCount = hunks.length

  /** 连续审查：dir=±1 hunk；越界则换文件（下一/上一文件的首/末 hunk） */
  const navHunk = (dir: 1 | -1): void => {
    const next = hunkIndex + dir
    if (next >= 0 && next < hunkCount) {
      setHunkIndex(next)
      return
    }
    const idx = files.findIndex((f) => f.path === reviewState?.selectedPath)
    if (idx < 0) return
    // 跳过未跟踪文件（无 hunk 可看）
    for (let i = idx + dir; i >= 0 && i < files.length; i += dir) {
      if (files[i]!.status !== 'U') {
        void selectReviewFile(files[i]!.path)
        setHunkIndex(dir === 1 ? 0 : -1) // -1=待详情到位后取末 hunk
        return
      }
    }
  }
  // 详情到位后取末 hunk（-1 哨兵）
  useEffect(() => {
    if (hunkIndex === -1 && hunkCount > 0) setHunkIndex(hunkCount - 1)
  }, [hunkIndex, hunkCount])

  /** 文件列表键盘：↑/↓ 换文件（跳过未跟踪）、Home/End 首末 */
  const onListKeyDown = (e: ReactKeyboardEvent): void => {
    const cur = files.findIndex((f) => f.path === reviewState?.selectedPath)
    const step = (dir: 1 | -1, from?: number): void => {
      for (let i = (from ?? cur) + dir; i >= 0 && i < files.length; i += dir) {
        if (files[i]!.status !== 'U') {
          void selectReviewFile(files[i]!.path)
          return
        }
      }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      step(1, -1)
    } else if (e.key === 'End') {
      e.preventDefault()
      step(-1, files.length)
    }
  }

  const onDiffKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      navHunk(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      navHunk(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHunkIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      if (hunkCount > 0) setHunkIndex(hunkCount - 1)
    }
  }

  // Esc 关审查（焦点在两栏内时）；关闭后焦点还终端
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || useAppStore.getState().reviewState === null) return
      // 弹窗类场景不抢（对话框自身处理 Esc）——简单起见仅审查前台时响应
      if (!useAppStore.getState().reviewActive) return
      closeReview()
      focusActiveTerminal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeReview])

  // 自动选中后列表滚动跟随（可选调用——jsdom 兼容）
  useEffect(() => {
    const idx = files.findIndex((f) => f.path === reviewState?.selectedPath)
    if (idx >= 0) {
      listRef.current
        ?.querySelector(`[data-diff-file="${idx}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 选中文件变化时跟随
  }, [reviewState?.selectedPath])

  const total = useMemo(
    () => ({
      add: files.reduce((n, f) => n + (f.add ?? 0), 0),
      del: files.reduce((n, f) => n + (f.del ?? 0), 0)
    }),
    [files]
  )

  if (reviewState === null) return null
  const isWorktree = reviewState.cwd !== project?.dir
  const title = `${project?.name ?? ''}${isWorktree ? ' · worktree' : ''}`

  return (
    <div className="diff-review" data-testid="diff-review" role="region" aria-label={t('review.title')}>
      {/* 工具栏：标题 + 汇总 + 刷新/关闭 */}
      <div className="diff-toolbar">
        <span className="diff-title mono" title={`${reviewState.cwd} (${t('review.base')})`}>
          {t('review.title')} · {title}
        </span>
        {files.length > 0 && (
          <span className="diff-summary">
            {t('review.summary', { files: files.length })}
            <span className="diff-add"> +{total.add}</span>
            <span className="diff-del"> −{total.del}</span>
          </span>
        )}
        <span className="diff-toolbar-acts">
          <button
            type="button"
            className="btn small"
            disabled={reviewState.loading}
            onClick={() => void refreshReview()}
          >
            {reviewState.loading ? t('common.detecting') : t('review.refresh')}
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              const back = useAppStore.getState().activeTaskId
              closeReview()
              if (back !== null) openTaskAutoResume(back)
            }}
            title={t('review.closeHint')}
          >
            × {t('common.close')}
          </button>
        </span>
      </div>

      <div className="diff-body">
        {/* 文件列表栏 */}
        <div
          ref={listRef}
          className={`diff-files${focusPane === 'list' ? ' focused' : ''}`}
          role="listbox"
          aria-label={t('review.filesAria')}
          tabIndex={0}
          onFocus={() => setFocusPane('list')}
          onKeyDown={onListKeyDown}
        >
          {reviewState.loading && files.length === 0 && (
            <div className="diff-empty">{t('common.detecting')}</div>
          )}
          {!reviewState.loading && reviewState.error !== '' && (
            <div className="diff-error">
              <p>{reviewState.error}</p>
              <button type="button" className="btn small" onClick={() => void refreshReview()}>
                {t('review.refresh')}
              </button>
            </div>
          )}
          {!reviewState.loading && reviewState.error === '' && files.length === 0 && (
            <div className="diff-empty">{t('review.clean')}</div>
          )}
          {files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              role="option"
              aria-selected={f.path === reviewState.selectedPath}
              className={`diff-file-row${f.path === reviewState.selectedPath ? ' selected' : ''}`}
              data-diff-file={i}
              data-status={f.status}
              title={f.oldPath !== undefined ? `${f.oldPath} → ${f.path}` : f.path}
              onClick={() => void selectReviewFile(f.path)}
            >
              <span className="diff-status-chip" data-status={f.status} aria-hidden="true">
                {f.status === 'U' ? '?' : f.status}
              </span>
              <span className="diff-file-path">
                {basePath(f.path)}
                <span className="diff-file-dir">{dirPath(f.path)}</span>
              </span>
              {(f.add !== undefined || f.del !== undefined) && (
                <span className="diff-file-counts">
                  <span className="diff-add">{f.add !== undefined ? `+${f.add}` : ''}</span>{' '}
                  <span className="diff-del">{f.del !== undefined ? `−${f.del}` : ''}</span>
                </span>
              )}
            </button>
          ))}
        </div>

        {/* diff 视图栏 */}
        <div
          ref={diffRef}
          className={`diff-view${focusPane === 'diff' ? ' focused' : ''}`}
          role="region"
          aria-label={selected !== null ? selected.path : t('review.viewAria')}
          tabIndex={0}
          onFocus={() => setFocusPane('diff')}
          onKeyDown={onDiffKeyDown}
        >
          {selected === null ? (
            <div className="diff-empty">{t('review.pickFile')}</div>
          ) : selected.status === 'U' ? (
            <div className="diff-empty">
              <p className="mono">{selected.path}</p>
              <p>{t('review.untracked')}</p>
            </div>
          ) : reviewState.detailLoading ? (
            <div className="diff-empty">{t('common.detecting')}</div>
          ) : detail === null || detail.hunks.length === 0 ? (
            <div className="diff-empty">
              <p className="mono">{selected.path}</p>
              <p>{detail?.binary === true ? t('review.binary') : t('review.noChanges')}</p>
            </div>
          ) : (
            <>
              <div className="diff-file-header mono" title={selected.path}>
                {selected.path}
                <span className="diff-file-counts">
                  <span className="diff-add">+{selected.add ?? 0}</span>{' '}
                  <span className="diff-del">−{selected.del ?? 0}</span>
                </span>
                {detail.truncated && <span className="diff-truncated">{t('review.truncated')}</span>}
              </div>
              <div className="diff-lines mono">
                {detail.hunks.map((h, hi) => (
                  <HunkBlock
                    key={hi}
                    hunk={h}
                    active={hi === hunkIndex}
                    refEl={(el) => {
                      hunkRefs.current[hi] = el
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* hunk 计数器（可点 ‹ ›；aria-live 播报跳转） */}
      {selected !== null && selected.status !== 'U' && hunkCount > 0 && (
        <div className="diff-hunk-nav">
          <button type="button" className="btn btn-mini" onClick={() => navHunk(-1)} aria-label={t('review.prevHunk')}>
            ‹
          </button>
          <span className="diff-hunk-count" role="status" aria-live="polite">
            {t('review.hunkOf', { current: Math.max(hunkIndex, 0) + 1, total: hunkCount })}
          </span>
          <button type="button" className="btn btn-mini" onClick={() => navHunk(1)} aria-label={t('review.nextHunk')}>
            ›
          </button>
          <span className="diff-hunk-hint">{t('review.hunkHint')}</span>
        </div>
      )}
    </div>
  )
}

/** 单个 hunk 块：@@ 头 + 行序列；active=当前修改点（左缘 accent 竖条） */
function HunkBlock({
  hunk,
  active,
  refEl
}: {
  hunk: DiffHunk
  active: boolean
  refEl: (el: HTMLDivElement | null) => void
}) {
  return (
    <div ref={refEl} className={`diff-hunk${active ? ' active' : ''}`} data-hunk-active={active}>
      <div className="diff-hunk-header">{hunk.header}</div>
      {hunk.lines.map((l, i) => (
        <div key={i} className="diff-line" data-type={l.type}>
          <span className="diff-no diff-no-old">{l.oldNo ?? ''}</span>
          <span className="diff-no diff-no-new">{l.newNo ?? ''}</span>
          <span className="diff-sign" aria-hidden="true">
            {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
          </span>
          <span className="diff-text">{l.text}</span>
        </div>
      ))}
    </div>
  )
}

/** 任务结束审查提示 toast（ReviewHint 事件驱动；10s 自动收起） */
export function ReviewHintToast() {
  const t = useI18n()
  const hint = useAppStore((s) => s.reviewHint)
  const dismiss = useAppStore((s) => s.dismissReviewHint)
  const openReview = useAppStore((s) => s.openReview)
  const projects = useAppStore((s) => s.projects)

  useEffect(() => {
    if (hint === null) return
    const timer = window.setTimeout(() => dismiss(), 10_000)
    return () => window.clearTimeout(timer)
  }, [hint, dismiss])

  if (hint === null) return null
  const project = projects.find((p) => p.id === hint.projectId)
  if (project === undefined) return null
  return (
    <div className="review-hint-toast" role="status" data-testid="review-hint-toast">
      <span>
        {t('review.hintBody', {
          project: project.name,
          files: hint.files,
          add: hint.add ?? 0,
          del: hint.del ?? 0
        })}
      </span>
      <span className="diff-toolbar-acts">
        <button
          type="button"
          className="btn small primary"
          onClick={() => {
            void openReview(hint.projectId, hint.cwd)
            dismiss()
          }}
        >
          {t('review.hintOpen')}
        </button>
        <button type="button" className="btn small" onClick={dismiss}>
          {t('common.close')}
        </button>
      </span>
    </div>
  )
}

function basePath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? (path.slice(idx + 1) || path) : path
}

function dirPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : ''
}
