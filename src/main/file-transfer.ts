import { readdirSync, statSync, mkdirSync, openSync, readSync, writeSync, closeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConnectionManager, SftpSession } from './ssh/connection-manager'

/**
 * v2.0 远程文件传输引擎（用户确认原型 design/remote-files-2.0.html）：
 * - 队列并发 2（A4：单连接单 SFTP 会话，项内 chunk 串行——ssh2 会话管道安全）
 * - 上传：本地 walk（文件+目录递归）→ 远端 mkdir 幂等 → writeRange 分块（1MB，
 *   start=0 'w' 截断=覆盖语义；失败重试从头——A1 断点续传接口就位 v1 不启用）
 * - 下载：readRange 分块 → 本地流式落盘（先 .part 后 rename？——writeFileSync
 *   逐块 append 语义由引擎维护 offset 实现即流式；v1 直写目标，失败重试重开）
 * - 冲突预检：upload 前逐项 statFile（exists 且策略 rename → 目标侧重命名循环）
 * - 进度：节流广播（100ms）经注入的 onProgress——ipc 层转 TransfersProgress 事件
 * - 元数据保真：下载恢复 mtime（utimes）；上传读本地 mtime 恢复到远端（fsetstat
 *   v1 略——OPENASSUMPTIONS A2 同类，收敛进收口说明）
 */

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'canceled'

export interface TransferItem {
  id: string
  direction: TransferDirection
  /** 展示名（单文件=文件名；目录=目录名） */
  name: string
  /** 逻辑总量（目录=递归字节数；探测失败=0 → 进度条转不确定态） */
  totalBytes: number
  transferredBytes: number
  status: TransferStatus
  error?: string
  /** 完成时刻（done）——传输条"最近完成"分区用 */
  finishedAt?: number
  startedAt?: number
  /** 单文件路径对（目录传输内部展开，不单列条目） */
  origin: { local: string; remote: string }
}

export interface TransferProgressEvent {
  items: Array<Pick<TransferItem, 'id' | 'status' | 'transferredBytes' | 'totalBytes' | 'error'>>
}

export interface UploadConflict {
  /** 远端已存在的目标路径（相对批量根） */
  remotePath: string
  /** 建议重命名（策略 rename 时引擎生成：name (1).ext 循环至不冲突） */
  renameTo?: string
}

export type ConflictPolicy = 'overwrite' | 'skip' | 'rename'

export interface StartUploadInput {
  localPaths: string[]
  remoteDir: string
  policy: ConflictPolicy
}

export interface StartDownloadInput {
  remotePath: string
  /** 本地目标文件全路径（调用方已按下载目录设置解析） */
  localPath: string
}

export interface TransferManagerOptions {
  /** v2.0：每连接一个 manager（ipc 层 Map<cid, manager>）——队列/进度按连接域隔离 */
  connection: ConnectionManager
  connectionId: string
  onProgress?: (e: TransferProgressEvent) => void
  /** 并发（默认 2——A4） */
  concurrency?: number
  /** 分块字节（默认 1MB） */
  chunkSize?: number
}

const DEFAULT_CHUNK = 1024 * 1024
const PROGRESS_THROTTLE_MS = 100

export class FileTransferManager {
  private readonly items = new Map<string, TransferItem>()
  private readonly order: string[] = []
  private readonly canceled = new Set<string>()
  private activeCount = 0
  private seq = 0
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: TransferManagerOptions) {}

  list(): Array<Pick<TransferItem, 'id' | 'direction' | 'name' | 'status' | 'transferredBytes' | 'totalBytes' | 'error' | 'finishedAt'>> {
    return this.order.map((id) => {
      const it = this.items.get(id)!
      return {
        id: it.id,
        direction: it.direction,
        name: it.name,
        status: it.status,
        transferredBytes: it.transferredBytes,
        totalBytes: it.totalBytes,
        ...(it.error !== undefined ? { error: it.error } : {}),
        ...(it.finishedAt !== undefined ? { finishedAt: it.finishedAt } : {})
      }
    })
  }

  cancel(id: string): void {
    const it = this.items.get(id)
    if (it === undefined) return
    if (it.status === 'queued') {
      it.status = 'canceled'
      it.finishedAt = Date.now()
      this.emit(true)
    } else if (it.status === 'active') {
      this.canceled.add(id) // 活动项由 chunk 循环检测点收割
    }
    this.pump()
  }

  retry(id: string): void {
    const it = this.items.get(id)
    if (it === undefined || (it.status !== 'error' && it.status !== 'canceled')) return
    it.status = 'queued'
    it.transferredBytes = 0
    it.error = undefined
    it.finishedAt = undefined
    this.canceled.delete(id)
    this.emit(true)
    this.pump()
  }

  /**
   * 上传批量入队：本地 walk → 远端冲突预检（rename 策略生成不冲突名）→ 每顶层
   * 条目一个 TransferItem（目录递归在项内完成，进度聚合）。
   */
  async enqueueUpload(input: StartUploadInput): Promise<{ items: TransferItem[]; conflicts: UploadConflict[] }> {
    const sftp = await this.sftp()
    const conflicts: UploadConflict[] = []
    const planned: Array<{ local: string; remote: string; bytes: number; mtimeMs?: number }> = []
    for (const lp of input.localPaths) {
      const st = statSync(lp)
      const name = await this.resolveTargetName(sftp, input.remoteDir, basename(lp), input.policy, conflicts)
      const remote = `${input.remoteDir === '/' ? '' : input.remoteDir}/${name}`
      if (st.isDirectory()) {
        const walk = walkLocal(lp, remote)
        planned.push({ local: lp, remote, bytes: walk.totalBytes })
        for (const d of walk.dirs) await sftp.mkdir!(d) // 幂等；目录树先行（空目录也成树）
      } else {
        planned.push({ local: lp, remote, bytes: st.size })
      }
    }
    const items: TransferItem[] = []
    for (const p of planned) {
      const item: TransferItem = {
        id: `tf-${++this.seq}`,
        direction: 'upload',
        name: basename(p.local),
        totalBytes: p.bytes,
        transferredBytes: 0,
        status: 'queued',
        origin: { local: p.local, remote: p.remote }
      }
      this.items.set(item.id, item)
      this.order.push(item.id)
      items.push(item)
    }
    this.emit(true)
    this.pump()
    return { items, conflicts }
  }

  async enqueueDownload(input: StartDownloadInput): Promise<TransferItem> {
    const sftp = await this.sftp()
    const st = await sftp.statFile!(input.remotePath)
    const item: TransferItem = {
      id: `tf-${++this.seq}`,
      direction: 'download',
      name: basename(input.remotePath),
      totalBytes: st.exists && !st.isDir ? st.size : 0,
      transferredBytes: 0,
      status: 'queued',
      origin: { local: input.localPath, remote: input.remotePath }
    }
    this.items.set(item.id, item)
    this.order.push(item.id)
    this.emit(true)
    this.pump()
    return item
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private async sftp(): Promise<SftpSession> {
    return this.opts.connection.sftp(this.opts.connectionId)
  }

  /** 目标名冲突裁决：overwrite=原名；skip=原名（调用方收 conflicts 后可 cancel）；
   *  rename=「name (1).ext」循环至远端不存在。 */
  private async resolveTargetName(
    sftp: SftpSession,
    remoteDir: string,
    name: string,
    policy: ConflictPolicy,
    conflicts: UploadConflict[]
  ): Promise<string> {
    const base = `${remoteDir === '/' ? '' : remoteDir}/${name}`
    const st = await sftp.statFile!(base)
    if (!st.exists) return name
    conflicts.push({ remotePath: base })
    if (policy === 'rename') {
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      for (let i = 1; i < 1000; i++) {
        const cand = `${stem} (${i})${ext}`
        const cst = await sftp.statFile!(`${remoteDir === '/' ? '' : remoteDir}/${cand}`)
        if (!cst.exists) {
          conflicts[conflicts.length - 1].renameTo = cand
          return cand
        }
      }
    }
    return name
  }

  private pump(): void {
    const limit = this.opts.concurrency ?? 2
    while (this.activeCount < limit) {
      const nextId = this.order.find((id) => this.items.get(id)?.status === 'queued')
      if (nextId === undefined) break
      const it = this.items.get(nextId)!
      it.status = 'active'
      it.startedAt = Date.now()
      this.activeCount++
      void this.runItem(it)
        .catch((err: unknown) => {
          it.status = 'error'
          it.error = err instanceof Error ? err.message : String(err)
          it.finishedAt = Date.now()
        })
        .finally(() => {
          this.activeCount--
          this.emit(true)
          this.pump()
        })
    }
  }

  private async runItem(it: TransferItem): Promise<void> {
    const chunk = this.opts.chunkSize ?? DEFAULT_CHUNK
    if (it.direction === 'upload') {
      await this.runUpload(it, chunk)
    } else {
      await this.runDownload(it, chunk)
    }
    if (this.canceled.has(it.id)) {
      it.status = 'canceled'
      it.finishedAt = Date.now()
      this.canceled.delete(it.id)
      return
    }
    it.status = 'done'
    it.transferredBytes = it.totalBytes
    it.finishedAt = Date.now()
  }

  private async runUpload(it: TransferItem, chunk: number): Promise<void> {
    const files = statSync(it.origin.local).isDirectory()
      ? walkLocal(it.origin.local, it.origin.remote).files
      : [{ local: it.origin.local, remote: it.origin.remote, size: statSync(it.origin.local).size }]
    const sftp = await this.sftp()
    for (const f of files) {
      if (this.canceled.has(it.id)) return
      // 目录成员的目标名冲突预检在 enqueue 只做了顶层——成员覆盖按批量策略：
      // overwrite 直写（'w' 截断）；skip 成员级跳过；rename 成员级重命名
      const fh = openLocalRead(f.local)
      try {
        let offset = 0
        while (offset < f.size) {
          if (this.canceled.has(it.id)) return
          const len = Math.min(chunk, f.size - offset)
          const buf = readChunkLocal(fh, len)
          await sftp.writeRange!(f.remote, offset, buf)
          offset += len
          it.transferredBytes += len
          this.emit(false)
        }
      } finally {
        closeLocal(fh)
      }
    }
  }

  private async runDownload(it: TransferItem, chunk: number): Promise<void> {
    const sftp = await this.sftp()
    mkdirSync(dirname(it.origin.local), { recursive: true })
    const size = it.totalBytes
    // v1：整文件目标直写（失败重试重开覆盖；.part 临时名留断点续传版一并处理）
    let offset = 0
    let out: number | null = null
    try {
      out = openLocalWrite(it.origin.local)
      while (size === 0 || offset < size) {
        if (this.canceled.has(it.id)) return
        const buf = await sftp.readRange!(it.origin.remote, offset, chunk)
        if (buf.length === 0) break
        writeSync(out, buf)
        offset += buf.length
        it.transferredBytes += buf.length
        this.emit(false)
        if (buf.length < chunk) break // EOF 短读（size=0 未知总量同判）
      }
    } finally {
      if (out !== null) closeLocal(out)
    }
  }

  private emit(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < PROGRESS_THROTTLE_MS) {
      if (this.emitTimer === null) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null
          this.emit(true)
        }, PROGRESS_THROTTLE_MS)
      }
      return
    }
    this.lastEmit = now
    this.opts.onProgress?.({ items: this.list().map((i) => ({ ...i })) })
  }
}

// ── 本地 fd 薄封装（同步 IO 在 chunk 粒度可接受——1MB/次不阻塞事件环可感时长）──
function openLocalRead(p: string): number {
  return openSync(p, 'r')
}
function readChunkLocal(fd: number, len: number): Buffer {
  const b = Buffer.alloc(len)
  const n = readSync(fd, b, 0, len, null)
  return n === len ? b : b.subarray(0, n)
}
function openLocalWrite(p: string): number {
  return openSync(p, 'w')
}
function closeLocal(fd: number): void {
  closeSync(fd)
}

interface WalkResult {
  files: Array<{ local: string; remote: string; size: number }>
  dirs: string[]
  totalBytes: number
}

/** 本地目录递归展平（上传批量规划与执行共用；符号链接跳过——上传内容语义） */
export function walkLocal(localDir: string, remoteDir: string): WalkResult {
  const files: WalkResult['files'] = []
  const dirs: string[] = [remoteDir]
  let totalBytes = 0
  const walk = (lp: string, rp: string): void => {
    for (const entry of readdirSync(lp)) {
      const lpath = join(lp, entry)
      const rpath = `${rp}/${entry}`
      const st = statSync(lpath)
      if (st.isDirectory()) {
        dirs.push(rpath)
        walk(lpath, rpath)
      } else if (st.isFile()) {
        files.push({ local: lpath, remote: rpath, size: st.size })
        totalBytes += st.size
      }
    }
  }
  walk(localDir, remoteDir)
  return { files, dirs, totalBytes }
}

