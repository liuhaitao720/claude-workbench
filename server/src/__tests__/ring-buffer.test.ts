import { describe, expect, it } from 'vitest'
import { OutputRingBuffer } from '../ring-buffer'

/**
 * L2 环形缓冲：容量按 UTF-8 字节计量、整块淘汰、tail(≤N) 回放预算、
 * 多字节字符不切半。re-attach 回放退化路径（5.8=A ≤4000 字节）的原料。
 */

describe('OutputRingBuffer', () => {
  it('空缓冲 tail 返回空串', () => {
    const ring = new OutputRingBuffer(100)
    expect(ring.tail(4000)).toBe('')
    expect(ring.byteLength).toBe(0)
  })

  it('未超容量：tail 返回全部内容', () => {
    const ring = new OutputRingBuffer(100)
    ring.push('hello ')
    ring.push('world')
    expect(ring.tail(4000)).toBe('hello world')
    expect(ring.byteLength).toBe(11)
  })

  it('超容量：最旧 chunk 整块淘汰（字节计量）', () => {
    const ring = new OutputRingBuffer(10)
    ring.push('0123456789') // 10B 恰满
    ring.push('abcdefghij') // 再 10B → 淘汰第一块
    expect(ring.byteLength).toBe(10)
    expect(ring.tail(4000)).toBe('abcdefghij')
  })

  it('中文按 UTF-8 字节计量（每字 3B）', () => {
    const ring = new OutputRingBuffer(9) // 3 个汉字
    ring.push('一二')
    ring.push('三四五') // 淘汰前一块
    expect(ring.tail(4000)).toBe('三四五')
  })

  it('tail 预算：按 chunk 粒度从尾部装填，装不下的最旧块整块舍弃', () => {
    const ring = new OutputRingBuffer(1000)
    ring.push('AAAA') // 4B
    ring.push('BBBBBBBB') // 8B
    ring.push('CC') // 2B
    // 预算 10B：CC+BBBBBBBB=10B 装下，AAAA 舍弃
    expect(ring.tail(10)).toBe('BBBBBBBBCC')
    // 预算 6B：CC 装下；BBBBBBBB 装不下且 total>0 → 整块舍弃
    expect(ring.tail(6)).toBe('CC')
    // 预算恰好等于全部：原样
    expect(ring.tail(14)).toBe('AAAABBBBBBBBCC')
  })

  it('tail 预算装不下最新单块：取其尾部（UTF-8 码点边界对齐）', () => {
    const ring = new OutputRingBuffer(1000)
    ring.push('x一二三y') // 1+3+3+3+1=11B
    // 预算 7B：x..无法整块装下 → 取尾部 7B = '二三y'（1+3+3）
    expect(ring.tail(7)).toBe('二三y')
    // 预算 2B：尾部码点最少 1B → 'y'
    expect(ring.tail(2)).toBe('y')
  })

  it('回放预算 4000B：跨多 chunk 装填不超预算（5.8=A 断言口径）', () => {
    const ring = new OutputRingBuffer(8192)
    for (let i = 0; i < 200; i++) ring.push(`chunk-${String(i).padStart(3, '0')};`) // 每 chunk 10B
    const tail = ring.tail(4000)
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(4000)
    // 400 块×10B=4000B → 全装下（容量 8192 未淘汰）
    expect(tail.startsWith('chunk-000;')).toBe(true)
    expect(tail.endsWith('chunk-199;')).toBe(true)
    // 超容量淘汰后再取：仍是最近 ≤4000B
    for (let i = 200; i < 1000; i++) ring.push(`chunk-${String(i).padStart(3, '0')};`)
    const tail2 = ring.tail(4000)
    expect(Buffer.byteLength(tail2, 'utf8')).toBeLessThanOrEqual(4000)
    expect(tail2.endsWith('chunk-999;')).toBe(true)
    expect(tail2.startsWith('chunk-600;')).toBe(true) // 400 块×10B
  })

  it('clear 清空', () => {
    const ring = new OutputRingBuffer(100)
    ring.push('data')
    ring.clear()
    expect(ring.tail(4000)).toBe('')
    expect(ring.byteLength).toBe(0)
  })

  it('单块即超容量：保住最新一块的尾部（ring=最新内容优先）', () => {
    const ring = new OutputRingBuffer(5)
    ring.push('abcdefgh')
    expect(ring.byteLength).toBeLessThanOrEqual(5)
    expect(ring.tail(4000)).toBe('defgh')
  })
})
