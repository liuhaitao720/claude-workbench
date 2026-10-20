import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRecord } from '../shared/types'

/**
 * 任务记录持久化：baseDir/tasks.json。
 * 原子写（.tmp + rename）；load 容错（缺失/损坏 → 空列表）。
 * 构造注入 baseDir，模块不触碰 electron API（可测性）。
 */
export class TaskStore {
  private readonly file: string

  constructor(baseDir: string) {
    this.file = join(baseDir, 'tasks.json')
  }

  /** projectId 省略 = 全部 */
  list(projectId?: string): TaskRecord[] {
    const all = this.load()
    return projectId === undefined ? all : all.filter((t) => t.projectId === projectId)
  }

  get(id: string): TaskRecord | undefined {
    return this.load().find((t) => t.id === id)
  }

  upsert(record: TaskRecord): TaskRecord {
    const all = this.load()
    const idx = all.findIndex((t) => t.id === record.id)
    if (idx >= 0) all[idx] = record
    else all.push(record)
    this.save(all)
    return record
  }

  remove(id: string): boolean {
    const all = this.load()
    const next = all.filter((t) => t.id !== id)
    if (next.length === all.length) return false
    this.save(next)
    return true
  }

  /** 仅改 name 字段；不存在返回 undefined（由调用方决定报错语义） */
  rename(id: string, name: string): TaskRecord | undefined {
    const task = this.get(id)
    if (!task) return undefined
    return this.upsert({ ...task, name })
  }

  /** 应用启动归一：全部 running → stopped（重启后 PTY 已死） */
  normalizeOnStartup(): void {
    const all = this.load()
    let changed = false
    for (const task of all) {
      if (task.status === 'running') {
        task.status = 'stopped'
        changed = true
      }
    }
    if (changed) this.save(all)
  }

  private load(): TaskRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as TaskRecord[]) : []
    } catch {
      return []
    }
  }

  private save(records: TaskRecord[]): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
