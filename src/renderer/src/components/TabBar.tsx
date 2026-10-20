import { useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TaskRecord } from '../../../shared/types'
import { useAppStore } from '../store'
import { TaskStatusDot } from './TaskStatusDot'

/**
 * 已打开任务 tab：名称 + 状态色；点击切换 active；× 仅关视图不停任务。
 * A4 键盘可达（roving tabindex）：active tab tabIndex=0、其余 -1；左右方向键
 * 切换相邻（wrap）；切换后焦点随 active 移动（rAF 等 DOM 更新后聚焦新 tab）。
 */
export function TabBar() {
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const tasks = useAppStore((s) => s.tasks)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const setActive = useAppStore((s) => s.setActive)
  const closeTab = useAppStore((s) => s.closeTab)
  const listRef = useRef<HTMLDivElement>(null)

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
            title="关闭 tab（不停止任务）"
            onClick={(e) => {
              e.stopPropagation()
              closeTab(t.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
