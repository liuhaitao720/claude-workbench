import type { TaskRecord } from '../shared/types'

/**
 * 「仍有任务在运行」的真值源（托盘 tooltip 与退出确认共用）。
 *
 * v1.1.0：不只信 tasks.json 的 status==='running'，还要求 PTY 句柄确实存活——
 * 用户反馈「关了开发任务窗口，退出时仍提示还有任务在运行」。根因有两层：
 * ① tab 的 × 以前只关视图不停任务（已改为关闭即停止）；
 * ② 异常/崩溃残留的 running 记录（PTY 早已不在）也会被计入。
 * 双层保险后，幽灵记录不会再触发退出确认。
 */
export function countLiveRunningTasks(
  tasks: readonly TaskRecord[],
  isRunning: (taskId: string) => boolean
): number {
  return tasks.filter((t) => t.status === 'running' && isRunning(t.id)).length
}