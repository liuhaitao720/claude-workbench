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
  const projects = useAppStore((s) => s.projects)
  // v2.1.0 SSH 纯终端虚拟 tab（单槽；三方互斥互切——openTask/setActive 落 sshActive=false）
  const sshConsoleCid = useAppStore((s) => s.sshConsoleCid)
  const sshActive = useAppStore((s) => s.sshActive)
  const connections = useAppStore((s) => s.connections)
  const activateSshConsole = useAppStore((s) => s.activateSshConsole)
  const closeSshConsole = useAppStore((s) => s.closeSshConsole)
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * 关 tab：运行中先停任务再关视图（停止失败也关视图——后台孤儿会话不该占着 tab；
   * 任务行仍可「恢复」）。非 running（stopped/exited）只需关视图。
   */
  const closeTabAndStop = (task: TaskRecord): void => {
    closeTab(task.id)
    if (task.status === 'running') void stopTaskFlow(task.id)
  }

  const openTasks: TaskRecord[] = []
  for (const id of openTaskIds) {
    const t = tasks.find((x) => x.id === id)
    if (t) openTasks.push(t)
  }

  // v2.1.0 F3（评审）：零任务但开着虚拟 tab（审查/SSH）时 tab 栏仍渲染——
  // SSH 纯终端的主打场景就是「不建任务」，此前整栏早退=无 tab 可切/无 × 可关
  if (openTasks.length === 0 && reviewState === null && sshConsoleCid === null) return null

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
          <span className="tab-name">{t.name}</span>
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
      {/* v2.0.2 审查虚拟 tab：diff 图标(菱形◆) + 项目名 + 改动数角标；
          与任务 tab 同排，roving tabindex 链尾——键盘 ←→ 可达 */}
      {reviewState !== null && (
        <div
          role="tab"
          aria-selected={reviewActive && !sshActive}
          className={reviewActive && !sshActive ? 'tab review-tab active' : 'tab review-tab'}
          data-testid="review-tab"
          tabIndex={reviewActive || (openTasks.length === 0 && sshConsoleCid === null) ? 0 : -1}
          onClick={() => activateReview()}
          onKeyDown={(e) => onTabKeyDown(e, openTasks.length)}
          title={reviewState.cwd}
        >
          <span className="review-tab-icon" aria-hidden="true">
            ◆
          </span>
          <span className="tab-name">
            {tr('review.tabLabel', { name: projects.find((p) => p.id === reviewState.projectId)?.name ?? '' })}
          </span>
          <span className="review-tab-count" aria-label={tr('review.tabCountAria', { count: reviewState.files.length })}>
            {reviewState.files.length}
          </span>
          <button
            type="button"
            className="tab-close"
            title={tr('review.close')}
            onClick={(e) => {
              e.stopPropagation()
              closeReview()
            }}
          >
            ×
          </button>
        </div>
      )}
      {/* v2.1.0 SSH 纯终端虚拟 tab：▣ 图标 + 连接名；× 关台断 shell
          （Esc 不关——shell 按键须直通远端）；三方互斥互切 */}
      {sshConsoleCid !== null && (
        <div
          role="tab"
          aria-selected={sshActive}
          className={sshActive ? 'tab ssh-tab active' : 'tab ssh-tab'}
          data-testid="ssh-tab"
          tabIndex={sshActive || (openTasks.length === 0 && reviewState === null) ? 0 : -1}
          onClick={() => activateSshConsole()}
          onKeyDown={(e) => onTabKeyDown(e, openTasks.length + (reviewState !== null ? 1 : 0))}
          title={
            connections.find((c) => c.id === sshConsoleCid)
              ? `${connections.find((c) => c.id === sshConsoleCid)!.user}@${connections.find((c) => c.id === sshConsoleCid)!.host}`
              : ''
          }
        >
          <span className="ssh-tab-icon" aria-hidden="true">
            ▣
          </span>
          <span className="tab-name">
            {tr('ssh.tabLabel', {
              name: connections.find((c) => c.id === sshConsoleCid)?.name ?? ''
            })}
          </span>
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
