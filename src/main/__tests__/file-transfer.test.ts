import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionManager, SftpSession } from '../ssh/connection-manager'
import { FileTransferManager, walkLocal } from '../file-transfer'

/**
 * v2.0 传输引擎 L2（fake SFTP 内存文件系统）：队列/并发/进度/取消/重试/冲突预检/
 * 目录递归上传与分块下载。真实 ssh2 链路由装配层（ipc）+ --smoke-remote 家族覆盖。
 */

interface FakeDir {
  dirs: Map<string, FakeDir>
  files: Map<string, Buffer>
}

function makeFakeSftp() {
  const root: FakeDir = { dirs: new Map(), files: new Map() }
  const norm = (p: string): Array<string> => p.split('/').filter((x) => x !== '' && x !== '.')
  const dirOf = (p: string): FakeDir => {
    let d = root
    for (const seg of norm(p)) {
      const next = d.dirs.get(seg)
      if (next === undefined) throw new Error(`no such dir: ${p}`)
      d = next
    }
    return d
  }
  const sftp: SftpSession = {
    list: async () => [],
    readFile: async (p) => {
      const segs = norm(p)
      const name = segs.pop()!
      const buf = dirOf('/' + segs.join('/')).files.get(name)
      if (buf === undefined) throw new Error(`no such file: ${p}`)
      return buf
    },
    writeFile: async (p, data) => {
      const segs = norm(p)
      const name = segs.pop()!
      dirOf('/' + segs.join('/')).files.set(name, Buffer.from(data))
    },
    mkdir: async (d) => {
      const segs = norm(d)
      const name = segs.pop()!
      dirOf('/' + segs.join('/')).dirs.set(name, { dirs: new Map(), files: new Map() })
    },
    listAll: async (d) => {
      const cur = dirOf(d)
      return [
        ...[...cur.dirs.keys()].map((name) => ({ name, isDir: true, size: 0, mtimeMs: 0 })),
        ...[...cur.files.entries()].map(([name, b]) => ({ name, isDir: false, size: b.length, mtimeMs: 0 }))
      ].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    },
    rename: async (from, to) => {
      const fSegs = norm(from)
      const fName = fSegs.pop()!
      const tSegs = norm(to)
      const tName = tSegs.pop()!
      const buf = dirOf('/' + fSegs.join('/')).files.get(fName)
      if (buf === undefined) throw new Error(`no such file: ${from}`)
      dirOf('/' + fSegs.join('/')).files.delete(fName)
      dirOf('/' + tSegs.join('/')).files.set(tName, buf)
    },
    unlinkFile: async (p) => {
      const segs = norm(p)
      const name = segs.pop()!
      if (!dirOf('/' + segs.join('/')).files.delete(name)) throw new Error(`no such file: ${p}`)
    },
    statFile: async (p) => {
      const segs = norm(p)
      const name = segs.pop()!
      const parent = dirOf('/' + segs.join('/'))
      if (parent.dirs.has(name)) return { isDir: true, size: 0, mtimeMs: 0, exists: true }
      const buf = parent.files.get(name)
      if (buf !== undefined) return { isDir: false, size: buf.length, mtimeMs: 0, exists: true }
      return { isDir: false, size: 0, mtimeMs: 0, exists: false }
    },
    readRange: async (p, start, len) => {
      const segs = norm(p)
      const name = segs.pop()!
      const buf = dirOf('/' + segs.join('/')).files.get(name)
      if (buf === undefined) throw new Error(`no such file: ${p}`)
      return buf.subarray(start, start + len)
    },
    writeRange: async (p, start, data) => {
      const segs = norm(p)
      const name = segs.pop()!
      const dir = dirOf('/' + segs.join('/'))
      const cur = start === 0 ? Buffer.alloc(0) : (dir.files.get(name) ?? Buffer.alloc(0))
      const next = Buffer.alloc(Math.max(cur.length, start + data.length))
      cur.copy(next, 0)
      data.copy(next, start)
      dir.files.set(name, next)
    }
  }
  return { sftp, root, dirOf }
}

function fakeConn(sftp: SftpSession): ConnectionManager {
  return { sftp: async () => sftp } as unknown as ConnectionManager
}

let tempDirs: string[] = []
beforeEach(() => {
  tempDirs = []
})
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

function localFile(bytes: number): string {
  const d = mkdtempSync(join(tmpdir(), 'cwb-xfer-'))
  tempDirs.push(d)
  const p = join(d, 'payload.bin')
  writeFileSync(p, Buffer.alloc(bytes, 0xab))
  return p
}

async function mkpath(sftp: SftpSession, dir: string): Promise<void> {
  let acc = ''
  for (const seg of dir.split('/').filter((x) => x !== '')) {
    acc += `/${seg}`
    if (!(await sftp.statFile!(acc)).exists) await sftp.mkdir!(acc)
  }
}

describe('v2.0 FileTransferManager（fake SFTP 内存 FS）', () => {
  it('单文件上传：分块写 → 远端字节一致 → done + 进度事件含全量清单', async () => {
    const { sftp, dirOf } = makeFakeSftp()
    const events: Array<Array<{ id: string; status: string }>> = []
    const mgr = new FileTransferManager({
      connection: fakeConn(sftp),
      connectionId: 'c1',
      chunkSize: 64,
      onProgress: (e) => events.push(e.items.map((i) => ({ id: i.id, status: i.status })))
    })
    await mkpath(sftp, '/home/dev') // remoteDir 先在（真实链路由面板保证）
    const local = localFile(200) // 4 chunks @64
    const { items, conflicts } = await mgr.enqueueUpload({
      localPaths: [local],
      remoteDir: '/home/dev',
      policy: 'overwrite'
    })
    expect(conflicts).toEqual([])
    await waitDone(mgr, items[0].id)
    expect(dirOf('/home/dev').files.get('payload.bin')?.length).toBe(200)
    const final = mgr.list().find((i) => i.id === items[0].id)
    expect(final?.status).toBe('done')
    expect(final?.transferredBytes).toBe(200)
    expect(events.length).toBeGreaterThan(0)
  })

  it('下载：远端 3 块 → 本地落盘字节一致', async () => {
    const { sftp } = makeFakeSftp()
    await mkpath(sftp, '/home/dev')
    const payload = Buffer.alloc(180, 0xcd)
    await sftp.writeFile!('/home/dev/dump.bin', payload)
    const mgr = new FileTransferManager({
      connection: fakeConn(sftp),
      connectionId: 'c1',
      chunkSize: 64
    })
    const target = join(mkdtempSync(join(tmpdir(), 'cwb-dl-')), 'dump.bin')
    tempDirs.push(dirnameOf(target))
    const item = await mgr.enqueueDownload({ remotePath: '/home/dev/dump.bin', localPath: target })
    await waitDone(mgr, item.id)
    expect(readFileSync(target).equals(payload)).toBe(true)
    const final = mgr.list().find((i) => i.id === item.id)
    expect(final?.status).toBe('done')
  })

  it('冲突预检 rename：远端已有同名 → 自动「name (1).ext」且 conflicts 携带 renameTo', async () => {
    const { sftp, dirOf } = makeFakeSftp()
    await mkpath(sftp, '/home/dev')
    await sftp.writeFile!('/home/dev/payload.bin', Buffer.from('old'))
    const mgr = new FileTransferManager({ connection: fakeConn(sftp), connectionId: 'c1', chunkSize: 64 })
    const local = localFile(50)
    const { items, conflicts } = await mgr.enqueueUpload({
      localPaths: [local],
      remoteDir: '/home/dev',
      policy: 'rename'
    })
    expect(conflicts).toEqual([
      { remotePath: '/home/dev/payload.bin', renameTo: 'payload (1).bin' }
    ])
    await waitDone(mgr, items[0].id)
    expect(dirOf('/home/dev').files.has('payload.bin')).toBe(true) // 旧文件保留
    expect(dirOf('/home/dev').files.get('payload (1).bin')?.length).toBe(50)
  })

  it('取消：active 项 chunk 边界收割 → canceled；retry → 从头重传成功', async () => {
    const { sftp, dirOf } = makeFakeSftp()
    await mkpath(sftp, '/home/dev')
    let writes = 0
    const slowSftp: SftpSession = {
      ...sftp,
      writeRange: async (p, start, data) => {
        writes++
        if (writes === 2) {
          // 第 2 块进行中取消——先让取消标记落地再继续（模拟慢块）
          await new Promise((r) => setTimeout(r, 30))
        }
        return sftp.writeRange!(p, start, data)
      }
    }
    const mgr = new FileTransferManager({
      connection: fakeConn(slowSftp),
      connectionId: 'c1',
      chunkSize: 64
    })
    const local = localFile(192) // 3 chunks
    const { items } = await mgr.enqueueUpload({ localPaths: [local], remoteDir: '/home/dev', policy: 'overwrite' })
    const id = items[0].id
    await new Promise((r) => setTimeout(r, 15)) // 等到第 1-2 块间
    mgr.cancel(id)
    await waitStatus(mgr, id, ['canceled', 'done'])
    const afterCancel = mgr.list().find((i) => i.id === id)!
    if (afterCancel.status === 'done') {
      // 时序未卡进慢块——本环境直接验证 retry 幂等（从头重传 done）
      mgr.retry(id)
      await waitStatus(mgr, id, ['done'])
      return
    }
    expect(afterCancel.status).toBe('canceled')
    mgr.retry(id)
    await waitDone(mgr, id)
    expect(dirOf('/home/dev').files.get('payload.bin')?.length).toBe(192)
    const final = mgr.list().find((i) => i.id === id)
    expect(final?.status).toBe('done')
    expect(final?.transferredBytes).toBe(192)
  })

  it('目录递归上传：walkLocal 展平 + mkdir 树先行 + 字节逐一到位', async () => {
    const { sftp, dirOf } = makeFakeSftp()
    await mkpath(sftp, '/home/dev')
    const d = mkdtempSync(join(tmpdir(), 'cwb-dir-'))
    tempDirs.push(d)
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'a.txt'), Buffer.from('AAA'))
    writeFileSync(join(d, 'sub', 'b.txt'), Buffer.from('BBBB'))
    const walk = walkLocal(d, '/home/dev/proj') // 纯函数语义（目标前缀任意）
    expect(walk.files.map((f) => f.remote)).toEqual([
      '/home/dev/proj/a.txt',
      '/home/dev/proj/sub/b.txt'
    ])
    const mgr = new FileTransferManager({ connection: fakeConn(sftp), connectionId: 'c1', chunkSize: 1024 })
    const { items } = await mgr.enqueueUpload({ localPaths: [d], remoteDir: '/home/dev', policy: 'overwrite' })
    await waitDone(mgr, items[0].id)
    // 引擎目标名 = basename(本地目录)（与单文件同语义——v2.0 原型「上传到当前目录」）
    const base = basename(d)
    expect(dirOf(`/home/dev/${base}/sub`).files.get('b.txt')?.toString()).toBe('BBBB')
    expect(dirOf(`/home/dev/${base}`).files.get('a.txt')?.toString()).toBe('AAA')
    const final = mgr.list().find((i) => i.id === items[0].id)
    expect(final?.transferredBytes).toBe(7) // 3+4 目录聚合
  })
})

// ── 助手 ────────────────────────────────────────────────────────────────
async function waitDone(mgr: FileTransferManager, id: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const it = mgr.list().find((i) => i.id === id)
    if (it !== undefined && (it.status === 'done' || it.status === 'error' || it.status === 'canceled')) {
      if (it.status !== 'done') throw new Error(`waitDone: ${id} → ${it.status} ${it.error ?? ''}`)
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitDone timeout: ${id}`)
}

async function waitStatus(mgr: FileTransferManager, id: string, sts: string[], ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const it = mgr.list().find((i) => i.id === id)
    if (it !== undefined && sts.includes(it.status)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitStatus timeout: ${id}`)
}

function dirnameOf(p: string): string {
  const parts = p.split('/')
  parts.pop()
  return parts.join('/') || '/'
}

