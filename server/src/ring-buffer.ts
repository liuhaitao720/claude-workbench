/**
 * 每 PTY 输出环形缓冲（S3，5.8=A re-attach 回放退化路径）。
 *
 * 用途：客户端断连期间 PTY 输出仍在产生（5.9=b 保活）——缓冲按 chunk 记录最近
 * capacityBytes 字节（UTF-8 计量），re-attach 的 resize toggle 若 300ms 内未逼出
 * claude TUI 全量重绘，则取 tail(≤4000) 作为回放兜底。8.1=A：缓冲仅在内存、
 * 随任务销毁，任何时刻不落盘。
 *
 * 容量按 UTF-8 字节计量（ANSI 转义序列在字节流里；按字符计量会低估体积）；
 * 回放按 chunk 粒度截取（chunk=onData 交付的完整字符串，切半会产生悬挂 UTF-8
 * 序列——仅当单 chunk 超预算时才做字节级尾部截取，并在 UTF-8 码点边界对齐）。
 */
export class OutputRingBuffer {
  private chunks: string[] = []
  private bytes = 0

  constructor(readonly capacityBytes: number) {}

  /** 追加一个输出 chunk；超容量时从最旧端整块丢弃 */
  push(chunk: string): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.bytes += byteLength(chunk)
    while (this.bytes > this.capacityBytes && this.chunks.length > 1) {
      this.bytes -= byteLength(this.chunks[0]!)
      this.chunks.shift()
    }
    // 单 chunk 即超容量：保住最新一块（ring 语义=最新内容优先）
    if (this.bytes > this.capacityBytes && this.chunks.length === 1) {
      const only = this.chunks[0]!
      const keep = tailBytes(only, this.capacityBytes)
      this.chunks = keep === '' ? [] : [keep]
      this.bytes = byteLength(keep)
    }
  }

  /** 最近 ≤maxBytes 字节的输出（拼接为一个字符串；空缓冲返回 ''） */
  /**
   * v2.1.4（用户实测「开发终端显示乱」）：回放尾部——整块 chunk 直接用
   * （chunk=onData 交付边界，天然不在序列中间）；仅当单 chunk 超预算走字节级
   * 截取时，对截取头做安全对齐（跳过残缺转义序列与残行——半个 CSI/OSC 进
   * xterm 会当字面字符渲染成整屏乱码）。
   */
  tailAligned(maxBytes: number): string {
    if (this.chunks.length === 0) return ''
    const picked: string[] = []
    let total = 0
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]!
      const b = byteLength(c)
      if (total + b > maxBytes) {
        if (total === 0) picked.unshift(alignAfterCut(tailBytes(c, maxBytes)))
        break
      }
      picked.unshift(c)
      total += b
      if (total === maxBytes) break
    }
    return picked.join('')
  }

  tail(maxBytes: number): string {
    if (this.chunks.length === 0) return ''
    const picked: string[] = []
    let total = 0
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]!
      const b = byteLength(c)
      if (total + b > maxBytes) {
        if (total === 0) {
          // 预算装不下最新一块：取其尾部（UTF-8 边界对齐）
          picked.unshift(tailBytes(c, maxBytes))
        }
        break
      }
      picked.unshift(c)
      total += b
      if (total === maxBytes) break
    }
    return picked.join('')
  }

  get byteLength(): number {
    return this.bytes
  }

  /** attach 后收到新数据（toggle 生效判定用） */
  clear(): void {
    this.chunks = []
    this.bytes = 0
  }
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

/** 字符串尾部 ≤maxBytes 字节（UTF-8 码点边界对齐；按码单元回退避免切半多字节字符） */
function tailBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s
  // 从尾部按码单元推进直到装入预算（ surrogate pair 视作 2 码单元整体推进不切半）
  let units = 0
  let acc = 0
  for (let i = s.length - 1; i >= 0; i--) {
    const b = byteLength(s[i]!)
    if (acc + b > maxBytes) break
    acc += b
    units += 1
  }
  return s.slice(s.length - units)
}


/**
 * 字节级截取后的安全对齐：跳过残缺转义序列（孤立 \x1b 起步的 CSI/OSC）与
 * 残行（前进到下一换行——仅当窗口内确有换行，防整块无换行时丢光）。
 */
function alignAfterCut(text: string): string {
  let i = 0
  while (i < text.length && text[i] === '\x1b') {
    let j = i + 1
    if (text[j] === '[') {
      j++
      let n = 0
      while (j < text.length && n < 64) {
        const c = text[j]!
        j++
        n++
        if (c >= '@' && c <= '~') break
      }
    } else if (text[j] === ']') {
      j++
      let n = 0
      while (j < text.length && n < 256) {
        const c = text[j]!
        j++
        n++
        if (c === '\x07' || (c === '\\' && text[j] === '\\')) break
      }
    } else {
      j++
    }
    i = j
  }
  const nl = text.indexOf('\n', i)
  if (nl >= 0 && nl < text.length - 1) i = nl + 1
  return text.slice(i)
}
