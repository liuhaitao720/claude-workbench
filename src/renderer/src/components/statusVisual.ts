import { useEffect, useState } from 'react'
import type { TaskActivityEvent, TaskRecord } from '../../../shared/types'
import { getLastDataAt } from '../store'

/**
 * v3.2 任务视觉状态（事件驱动，四视觉态）：
 * - busy 🟡 黄色转圈：执行中（UserPromptSubmit hook；兜底=PTY 字节活跃）
 * - awaiting 🔴 红：待答复（PermissionRequest/AskUserQuestion/ExitPlanMode/Elicitation）
 * - idle 🟢 绿：空闲就绪（spawn/resume/Stop/Esc——默认态）
 * - stopped 🟢 绿：已停止（可恢复）——与 idle 同色不同 tooltip（data-visual 保留两值）
 * - exited ○ 灰空心环：会话自行退出
 *
 * running 任务优先取 activityMap（main 侧裁决广播：hooks + 本地合成 + 字节兜底）；
 * 无条目时回退字节启发（黄/绿 only——兜底永不产生红）。
 */
export type VisualState = 'busy' | 'awaiting' | 'idle' | 'stopped' | 'exited' | 'closed'

/** 字节启发兜底：最近有 PTY 输出 → busy，否则 idle */
const BYTE_ACTIVE_WINDOW_MS = 4_000

export function visualStateOf(
  task: TaskRecord,
  activity?: TaskActivityEvent['activity'],
  tabOpen = true,
  now = Date.now()
): VisualState {
  // exited（灰空心环）优先于 closed——会话已终结的信息不受 tab 开合影响
  if (task.status === 'exited') return 'exited'
  // v0.4.5：任务终端 tab 未打开（或已从标题栏关闭）→ 灰色（无视图不展示活动色）
  if (!tabOpen) return 'closed'
  if (task.status !== 'running') return 'stopped' // 已停止（可恢复）→ 绿
  if (activity !== undefined) return activity // v3.2 事件驱动裁决优先
  const lastDataAt = getLastDataAt(task.id)
  return lastDataAt !== undefined && now - lastDataAt < BYTE_ACTIVE_WINDOW_MS ? 'busy' : 'idle'
}

export const VISUAL_TITLES: Record<VisualState, string> = {
  busy: '正在执行',
  awaiting: '等待答复（权限/选项确认）',
  idle: '空闲就绪',
  stopped: '已停止（可恢复）',
  exited: '已退出',
  closed: '未打开终端'
}

/** 周期性自刷新的时钟（兜底字节启发的时间迁移：黄→绿）；activityMap 驱动的变迁
 *  走 store 订阅不依赖此时钟；卸载自清理 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
