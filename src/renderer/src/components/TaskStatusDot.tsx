import type { TaskRecord } from '../../../shared/types'
import { connectionStateOfTask, useAppStore } from '../store'
import { useI18n } from '../i18n'
import { connStateText, useNow, visualStateOf, VISUAL_TITLE_KEYS } from './statusVisual'

/**
 * 任务状态点（v0.3.3 统一组件：任务行/Tab/最近区块行共用；v3.2 改事件驱动）。
 * data-status=持久状态（running/stopped/exited，语义与测试锚定）；
 * data-visual=视觉状态（busy/awaiting/idle/stopped/exited，配色见 styles.css）——
 * running 时优先 activityMap（onTaskActivity 广播），无条目回退字节启发。
 * S6 5.5：远程任务叠加连接态着色（data-conn；非 connected 时加环+title 后缀）。
 * title 随界面语言（v1.2.0）。
 */
export function TaskStatusDot({ task }: { task: TaskRecord }) {
  useNow(1_000) // 兜底字节启发的时间迁移（黄→绿）；行级组件数量有限可接受
  const t = useI18n()
  const activity = useAppStore((s) => s.activityMap[task.id])
  // v0.4.5：tab 未打开（含从标题栏关闭）→ 灰色 closed 态
  const tabOpen = useAppStore((s) => s.openTaskIds.includes(task.id))
  const connEntry = useAppStore((s) => connectionStateOfTask(s, task))
  const visual = visualStateOf(task, activity, tabOpen)
  const connState = connEntry?.state
  const title =
    connState !== undefined && connState !== 'connected'
      ? `${t(VISUAL_TITLE_KEYS[visual])} · ${connStateText(t, connState, connEntry?.attempt)}`
      : t(VISUAL_TITLE_KEYS[visual])
  return (
    <span
      className="status-dot"
      data-status={task.status}
      data-visual={visual}
      data-conn={connState}
      title={title}
    />
  )
}
