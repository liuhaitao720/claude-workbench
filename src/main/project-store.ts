import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProjectRecord } from '../shared/types'

/**
 * 项目记录持久化：baseDir/projects.json。
 * 原子写（.tmp + rename）；load 容错（缺失/损坏 → 空列表）。
 * 构造注入 baseDir，模块不触碰 electron API（可测性）。
 */
export class ProjectStore {
  private readonly file: string

  constructor(baseDir: string) {
    this.file = join(baseDir, 'projects.json')
  }

  list(): ProjectRecord[] {
    return this.load()
  }

  get(id: string): ProjectRecord | undefined {
    return this.load().find((p) => p.id === id)
  }

  /** 按 dir 查重（Windows 大小写不敏感）返回既有记录；否则新建（uuid、name=目录 basename、isGit=注册时检测） */
  add(dir: string, isGit: boolean): ProjectRecord {
    const all = this.load()
    const existing = all.find((p) => p.dir.toLowerCase() === dir.toLowerCase())
    if (existing) return existing
    const record: ProjectRecord = {
      id: randomUUID(),
      name: basename(dir),
      dir,
      isGit,
      createdAt: new Date().toISOString()
    }
    this.save([...all, record])
    return record
  }

  remove(id: string): boolean {
    const all = this.load()
    const next = all.filter((p) => p.id !== id)
    if (next.length === all.length) return false
    this.save(next)
    return true
  }

  /** 仅改 name 字段；不存在返回 undefined（由调用方决定报错语义） */
  rename(id: string, name: string): ProjectRecord | undefined {
    const all = this.load()
    const idx = all.findIndex((p) => p.id === id)
    if (idx < 0) return undefined
    all[idx] = { ...all[idx], name }
    this.save(all)
    return all[idx]
  }

  private load(): ProjectRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as ProjectRecord[]) : []
    } catch {
      return []
    }
  }

  private save(records: ProjectRecord[]): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
