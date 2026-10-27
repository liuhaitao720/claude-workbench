import { describe, expect, it } from 'vitest'
import { probeClaudeVersion } from '../claude-version'

/**
 * v1.1.0 真机回归（不 mock child_process）：复现「输出已到但 cmd 壳不退出」——
 * 本机实测 12 次中 3~5 次出现，旧 execFile({timeout}) 实现会丢弃已到输出并误报
 * 「未安装」。新实现拿到版本串即定点杀树返回，20 次必须全成功。
 *
 * 找不到 claude 的环境（CI/无安装）自动跳过。
 */
describe('probeClaudeVersion 真机回归（spawn 流式读 + 定点杀树）', () => {
  it('连续 20 次探测全部拿到版本（含壳进程不退出场景），单次 <5s', { timeout: 120_000 }, async () => {
    const first = await probeClaudeVersion('claude')
    if (first === '') return // 本机无 claude：跳过（非失败）

    expect(first).toMatch(/^\d+\.\d+\.\d+/)
    const results: Array<{ v: string; ms: number }> = []
    for (let i = 0; i < 19; i++) {
      const t = Date.now()
      const v = await probeClaudeVersion('claude')
      results.push({ v, ms: Date.now() - t })
    }
    const failures = results.filter((r) => r.v === '')
    expect(failures).toEqual([]) // 旧实现在此实测有 25%~40% 失败率
    expect(Math.max(...results.map((r) => r.ms))).toBeLessThan(5_000) // 旧实现挂起时 8s 超时
  })
})