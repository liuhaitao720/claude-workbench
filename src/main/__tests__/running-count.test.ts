import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../../shared/types'
import { countLiveRunningTasks } from '../running-count'

/** 最小 TaskRecord（本文件只关心 status/id） */
function task(id: string, status: TaskRecord['status']): TaskRecord {
  const now = new Date().toISOString()
  return {
    id,
    projectId: 'p1',
    name: id,
    sessionId: id,
    cwd: 'C:\\tmp',
    status,
    createdAt: now,
    lastActiveAt: now
  }
}

/**
 * v1.1.0：用户反馈「关闭了开发任务窗口后，退出程序依然提示还有任务在运行」。
 * 退出确认/托盘 tooltip 的口径必须同时满足：status==='running' **且** PTY 仍存活。
 */
describe('countLiveRunningTasks（退出确认/托盘真值源）', () => {
  it('只统计 running 且 PTY 存活的（幽灵 running 记录不计入）', () => {
    const tasks = [
      task('live', 'running'),
      task('ghost', 'running'), // tasks.json 写了 running 但 PTY 已死
      task('stopped', 'stopped'),
      task('exited', 'exited')
    ]
    const alive = new Set(['live'])
    expect(countLiveRunningTasks(tasks, (id) => alive.has(id))).toBe(1)
  })

  it('全部 PTY 存活 → 全计入；全不存活 → 0（关窗停任务后应得 0）', () => {
    const tasks = [task('a', 'running'), task('b', 'running')]
    expect(countLiveRunningTasks(tasks, () => true)).toBe(2)
    expect(countLiveRunningTasks(tasks, () => false)).toBe(0)
  })

  it('stopped/exited 即使 PTY 句柄暂未清理也不计入（状态已是终态）', () => {
    const tasks = [task('s', 'stopped'), task('e', 'exited')]
    expect(countLiveRunningTasks(tasks, () => true)).toBe(0)
  })

  it('空列表 → 0', () => {
    expect(countLiveRunningTasks([], () => true)).toBe(0)
  })
})