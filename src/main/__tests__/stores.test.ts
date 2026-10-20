import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from '../project-store'
import { TaskStore } from '../task-store'
import type { TaskRecord } from '../../shared/types'

function tempBase(): string {
  return mkdtempSync(join(tmpdir(), 'cwb-stores-'))
}

function makeTask(id: string, projectId: string, status: TaskRecord['status'] = 'stopped'): TaskRecord {
  return {
    id,
    projectId,
    name: `task-${id}`,
    sessionId: id,
    cwd: 'D:\\nowhere',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('ProjectStore（真实文件 CRUD）', () => {
  it('add→list：uuid/basename/isGit 落盘，原子写无 .tmp 残留', () => {
    const base = tempBase()
    try {
      const store = new ProjectStore(base)
      const rec = store.add('D:\\proj\\alpha', true)
      expect(rec.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(rec.name).toBe('alpha')
      expect(rec.isGit).toBe(true)
      expect(store.list()).toEqual([rec])

      expect(existsSync(join(base, 'projects.json'))).toBe(true)
      expect(existsSync(join(base, 'projects.json.tmp'))).toBe(false)
      expect(JSON.parse(readFileSync(join(base, 'projects.json'), 'utf8'))).toEqual([rec])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('按 dir 查重返回既有记录（不改写）', () => {
    const base = tempBase()
    try {
      const store = new ProjectStore(base)
      const first = store.add('D:\\proj\\beta', false)
      const second = store.add('D:\\proj\\beta', true)
      expect(second).toEqual(first)
      expect(store.list()).toHaveLength(1)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rename 仅改 name；remove 删记录；缺失 id 各自安全返回', () => {
    const base = tempBase()
    try {
      const store = new ProjectStore(base)
      const rec = store.add('D:\\proj\\gamma', false)
      const renamed = store.rename(rec.id, '新名字')
      expect(renamed?.name).toBe('新名字')
      expect(renamed?.dir).toBe(rec.dir)
      expect(store.rename('no-such-id', 'x')).toBeUndefined()

      expect(store.remove(rec.id)).toBe(true)
      expect(store.list()).toEqual([])
      expect(store.remove(rec.id)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('load 容错：文件缺失与非 JSON 损坏均得空列表', () => {
    const base = tempBase()
    try {
      expect(new ProjectStore(base).list()).toEqual([])
      writeFileSync(join(base, 'projects.json'), '{oops not json', 'utf8')
      expect(new ProjectStore(base).list()).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('TaskStore（真实文件 CRUD）', () => {
  it('upsert 插入与更新、list(projectId) 过滤、remove、rename', () => {
    const base = tempBase()
    try {
      const store = new TaskStore(base)
      const t1 = makeTask('id-1', 'p1')
      const t2 = makeTask('id-2', 'p2')
      store.upsert(t1)
      store.upsert(t2)
      expect(store.list().map((t) => t.id)).toEqual(['id-1', 'id-2'])
      expect(store.list('p1')).toEqual([t1])
      expect(store.list('p2')).toEqual([t2])
      expect(store.list('p3')).toEqual([])

      const updated = store.upsert({ ...t1, name: 'renamed' })
      expect(updated.name).toBe('renamed')
      expect(store.get('id-1')?.name).toBe('renamed')
      expect(store.list()).toHaveLength(2)

      const renamed = store.rename('id-2', 'task-two')
      expect(renamed?.name).toBe('task-two')
      expect(store.rename('no-such', 'x')).toBeUndefined()

      expect(store.remove('id-1')).toBe(true)
      expect(store.remove('id-1')).toBe(false)
      expect(store.list().map((t) => t.id)).toEqual(['id-2'])
      expect(existsSync(join(base, 'tasks.json.tmp'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('normalizeOnStartup：预置 running → 读出 stopped（且落盘）', () => {
    const base = tempBase()
    try {
      mkdirSync(base, { recursive: true })
      const seeded = [makeTask('a', 'p1', 'running'), makeTask('b', 'p1', 'stopped')]
      writeFileSync(join(base, 'tasks.json'), JSON.stringify(seeded), 'utf8')

      new TaskStore(base).normalizeOnStartup()

      const after = new TaskStore(base).list()
      expect(after.map((t) => t.status)).toEqual(['stopped', 'stopped'])
      // 二次归一幂等：不再改写（时间戳字段不变）
      const snapshot = readFileSync(join(base, 'tasks.json'), 'utf8')
      new TaskStore(base).normalizeOnStartup()
      expect(readFileSync(join(base, 'tasks.json'), 'utf8')).toBe(snapshot)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
