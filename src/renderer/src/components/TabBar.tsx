import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TaskRecord } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { TaskStatusDot } from './TaskStatusDot'

/**
 * 已打开任务 tab：名称 + 状态色；点击切换 active；× 关闭（**运行中的任务一并停止**，
 * 与 Windows Terminal 关标签的直觉一致——v1.1.0 用户反馈「关了窗口退出仍提示有任务
 * 在运行」，根因是 × 只关视图、PTY 仍在后台跑）。
 * A4 键盘可达（roving tabindex）：active tab tabIndex=0、其余 -1；左右方向键
 * 切换相邻（wrap）；切换后焦点随 active 移动（rAF 等 DOM 更新后聚焦新 tab）。
 */
export function TabBar() {
  const tr = useI18n()
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const tasks = useAppStore((s) => s.tasks)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const setActive = useAppStore((s) => s.setActive)
  const closeTab = useAppStore((s) => s.closeTab)
  const stopTaskFlow = useAppStore((s) => s.stopTaskFlow)
  // v2.0.2 审查虚拟 tab（单槽：开着才出现；点击=激活审查，×=关闭）
  const reviewState = useAppStore((s) => s.reviewState)
  const reviewActive = useAppStore((s) => s.reviewActive)
  const activateReview = useAppStore((s) => s.activateReview)
  const closeReview = useAppStore((s) => s.closeReview)
  // v2.2.5 Git tab（合并审查 tab）
  const gitPanel = useAppStore((s) => s.gitPanel)
  const gitActive = useAppStore((s) => s.gitActive)
  const activateGit = useAppStore((s) => s.activateGit)
  const projects = useAppStore((s) => s.projects)
  // v2.1.0 SSH 纯终端虚拟 tab；v2.1.6：**每台（连接）一个 tab**（不再折叠成单 tab）
  const sshConsoleCid = useAppStore((s) => s.sshConsoleCid)
  const sshActive = useAppStore((s) => s.sshActive)
  const sshOpenCids = useAppStore((s) => s.sshOpenCids)
  const connections = useAppStore((s) => s.connections)
  const activateSshConsole = useAppStore((s) => s.activateSshConsole)
  const closeSshConsole = useAppStore((s) => s.closeSshConsole)
  const activateSshConsoleCid = useAppStore((s) => s.activateSshConsoleCid)
  const closeSshConsoleFor = useAppStore((s) => s.closeSshConsoleFor)
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * 关 tab：运行中先停任务再关视图（停止失败也关视图——后台孤儿会话不该占着 tab；
   * 任务行仍可「恢复」）。非 running（stopped/exited）只需关视图。
   * v2.2.2：quiet 停止——关窗口是用户本人在场的动作，「已停止」不推手机（2026-11-17 指令）。
   */
  const closeTabAndStop = (task: TaskRecord): void => {
    closeTab(task.id)
    if (task.status === 'running') void stopTaskFlow(task.id, { quiet: true })
  }

  const openTasks: TaskRecord[] = []
  for (const id of openTaskIds) {
    const t = tasks.find((x) => x.id === id)
    if (t) openTasks.push(t)
  }

  // v2.1.0 F3（评审）：零任务但开着虚拟 tab（审查/SSH）时 tab 栏仍渲染——
  // SSH 纯终端的主打场景就是「不建任务」，此前整栏早退=无 tab 可切/无 × 可关
  // v2.1.2：sshActive 空态（cid=null）也算开着——SSH 视图是一等前台
  if (openTasks.length === 0 && reviewState === null && sshOpenCids.length === 0 && !sshActive) {
    return null
  }

  const activeIdx = openTasks.findIndex((t) => t.id === activeTaskId)

  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, idx: number): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (openTasks.length < 2) return
    e.preventDefault()
    const delta = e.key === 'ArrowLeft' ? -1 : 1
    const next = openTasks[(idx + delta + openTasks.length) % openTasks.length]
    setActive(next.id)
    // roving：焦点随 active 移到新 tab（下一拍 DOM 已更新 tabIndex 后聚焦；
    // 用 setTimeout 而非 rAF——jsdom 未开 pretendToBeVisual 时 rAF 缺失）
    window.setTimeout(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-task-id="${next.id}"]`)
        ?.focus()
    }, 0)
  }

  return (
    <div className="tabbar" role="tablist" ref={listRef}>
      {openTasks.map((t, i) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeTaskId && !reviewActive && !sshActive}
          className={t.id === activeTaskId && !reviewActive && !sshActive ? 'tab active' : 'tab'}
          data-task-id={t.id}
          tabIndex={
            !reviewActive && !sshActive && (t.id === activeTaskId || (activeIdx === -1 && i === 0))
              ? 0
              : -1
          }
          onClick={() => setActive(t.id)}
          onKeyDown={(e) => onTabKeyDown(e, i)}
        >
          <TaskStatusDot task={t} />
          {/* v2.1.6：标题=项目名-任务名（项目缺失回落任务名） */}
          <span className="tab-name" title={t.name}>
            {(() => {
              const pn = projects.find((p) => p.id === t.projectId)?.name
              return pn !== undefined && pn !== '' ? `${pn}-${t.name}` : t.name
            })()}
          </span>
          <button
            type="button"
            className="tab-close"
            title={tr(t.status === 'running' ? 'tab.closeStop' : 'tab.close')}
            onClick={(e) => {
              e.stopPropagation()
              closeTabAndStop(t)
            }}
          >
            ×
          </button>
        </div>
      ))}
      {/* v2.2.5 Git 虚拟 tab（合并原审查 tab——用户指令：审查窗口移除并入 Git 面板）：
          工作区模式=变更文件数角标；点击=工作区模式（无 reviewState 则进历史）；
          × 同时关 reviewState 与 gitPanel。 */}
      {(reviewState !== null || gitPanel !== null) && (() => {
        const pid = gitPanel?.projectId ?? reviewState?.projectId ?? ''
        const tabActive = (reviewActive || gitActive) && !sshActive
        const wcCount = reviewState !== null && reviewState.projectId === pid ? reviewState.files.length : 0
        return (
          <div
            role="tab"
            aria-selected={tabActive}
            className={tabActive ? 'tab review-tab active' : 'tab review-tab'}
            data-testid="git-tab"
            tabIndex={tabActive || (openTasks.length === 0 && sshConsoleCid === null) ? 0 : -1}
            onClick={() => {
              if (reviewState !== null && reviewState.projectId === pid) activateReview()
              else if (gitPanel !== null) activateGit()
              else if (pid !== '') void useAppStore.getState().openGitPanel(pid)
            }}
            onKeyDown={(e) => onTabKeyDown(e, openTasks.length)}
            title={projects.find((p) => p.id === pid)?.dir ?? ''}
          >
            <span className="review-tab-icon" aria-hidden="true">
              ⑂
            </span>
            <span className="tab-name">
              {tr('git.tabLabel', { name: projects.find((p) => p.id === pid)?.name ?? '' })}
            </span>
            {wcCount > 0 && (
              <span className="review-tab-count" aria-label={tr('review.tabCountAria', { count: wcCount })}>
                {wcCount}
              </span>
            )}
            <button
              type="button"
              className="tab-close"
              title={tr('review.close')}
              onClick={(e) => {
                e.stopPropagation()
                closeReview()
                useAppStore.getState().closeGitPanel()
              }}
            >
              ×
            </button>
          </div>
        )
      })()}
      {/* v2.1.6 SSH 终端 tab：**每台（连接）一个**——▣ 图标 + 连接名，点击切台
          （不重开 shell），× 只关该台；关的是当前台由 store 切换/退出视图。
          v2.1.2 空态保留：零台但 SSH 视图前台（cid=null）时渲染单个占位 tab。 */}
      {sshOpenCids.map((cid, i) => {
        const conn = connections.find((c) => c.id === cid)
        const active = sshActive && sshConsoleCid === cid
        return (
          <div
            key={cid}
            role="tab"
            aria-selected={active}
            className={active ? 'tab ssh-tab active' : 'tab ssh-tab'}
            data-testid={sshConsoleCid === cid ? 'ssh-tab' : undefined}
            data-connection-id={cid}
            tabIndex={active ? 0 : -1}
            onClick={() => activateSshConsoleCid(cid)}
            onKeyDown={(e) =>
              onTabKeyDown(e, openTasks.length + (reviewState !== null ? 1 : 0) + i)
            }
            title={conn !== undefined ? `${conn.user}@${conn.host}:${conn.port}` : cid}
          >
            <span className="ssh-tab-icon" aria-hidden="true">
              ▣
            </span>
            <span className="tab-name">
              {tr('ssh.tabLabel', { name: conn?.name ?? cid })}
            </span>
            <button
              type="button"
              className="tab-close"
              title={tr('ssh.railToggleTitle')}
              onClick={(e) => {
                e.stopPropagation()
                closeSshConsoleFor(cid)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      {sshOpenCids.length === 0 && (sshConsoleCid !== null || sshActive) && (
        <div
          role="tab"
          aria-selected={sshActive}
          className={sshActive ? 'tab ssh-tab active' : 'tab ssh-tab'}
          data-testid="ssh-tab"
          tabIndex={sshActive || (openTasks.length === 0 && reviewState === null) ? 0 : -1}
          onClick={() => activateSshConsole()}
          onKeyDown={(e) =>
            onTabKeyDown(e, openTasks.length + (reviewState !== null ? 1 : 0))
          }
          title={tr('ssh.viewEmptyTitle')}
        >
          <span className="ssh-tab-icon" aria-hidden="true">
            ▣
          </span>
          <span className="tab-name">SSH</span>
          <button
            type="button"
            className="tab-close"
            title={tr('ssh.railToggleTitle')}
            onClick={(e) => {
              e.stopPropagation()
              closeSshConsole()
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
