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

  if (openTasks.length === 0) return null

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
          aria-selected={t.id === activeTaskId}
          className={t.id === activeTaskId ? 'tab active' : 'tab'}
          data-task-id={t.id}
          tabIndex={t.id === activeTaskId || (activeIdx === -1 && i === 0) ? 0 : -1}
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
    </div>
  )
}
