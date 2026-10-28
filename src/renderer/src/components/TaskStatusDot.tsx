import type { TaskRecord } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useNow, visualStateOf, VISUAL_TITLE_KEYS } from './statusVisual'

/**
 * 任务状态点（v0.3.3 统一组件：任务行/Tab/最近区块行共用；v3.2 改事件驱动）。
 * data-status=持久状态（running/stopped/exited，语义与测试锚定）；
 * data-visual=视觉状态（busy/awaiting/idle/stopped/exited，配色见 styles.css）——
 * running 时优先 activityMap（onTaskActivity 广播），无条目回退字节启发。
 * title 随界面语言（v1.2.0）。
 */
export function TaskStatusDot({ task }: { task: TaskRecord }) {
  useNow(1_000) // 兜底字节启发的时间迁移（黄→绿）；行级组件数量有限可接受
  const t = useI18n()
  const activity = useAppStore((s) => s.activityMap[task.id])
  // v0.4.5：tab 未打开（含从标题栏关闭）→ 灰色 closed 态
  const tabOpen = useAppStore((s) => s.openTaskIds.includes(task.id))
  const visual = visualStateOf(task, activity, tabOpen)
  return (
    <span
      className="status-dot"
      data-status={task.status}
      data-visual={visual}
      title={t(VISUAL_TITLE_KEYS[visual])}
    />
  )
}