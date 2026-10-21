import { describe, expect, it, vi } from 'vitest'

// vi.mock 工厂被提升——内部只能用自包含定义（不能引用外部顶层变量）
vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

describe('v0.9.4 FontScanner（等宽字体自动检测）', () => {
  it('返回字体列表 → 图标字体过滤、去重排序（活体已验 49 款含 CJK）', async () => {
    const { execFile } = (await import('node:child_process')) as unknown as {
      execFile: ReturnType<typeof vi.fn>
    }
    execFile.mockImplementationOnce(
      (_cmd: string, args: string[], _o: unknown, cb: Function) => {
        // 禁用 ExecutionPolicy（EDR 防御篡改红线——脚本经 -Command 传参不落盘）
        expect(JSON.stringify(args)).not.toContain('ExecutionPolicy')
        cb(null, { stdout: 'Segoe MDL2 Assets\nConsolas\nCourier New\nSimSun-ExtB\nConsolas\n宋体' })
      }
    )
    const { FontScanner } = await import('../font-scan')
    const list = await new FontScanner().getInstalledMonoFonts()
    expect(list).toEqual(['Consolas', 'Courier New', 'SimSun-ExtB', '宋体'].sort((a, b) => a.localeCompare(b)))
    expect(list.some((f) => /MDL2/.test(f))).toBe(false)
  })

  it('execFile 失败 → 返回 [] 不抛；结果缓存（二次调用零新扫描）', async () => {
    const { execFile } = (await import('node:child_process')) as unknown as {
      execFile: ReturnType<typeof vi.fn>
    }
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) =>
      cb(new Error('scan failed'))
    )
    const { FontScanner } = await import('../font-scan')
    const scanner = new FontScanner()
    expect(await scanner.getInstalledMonoFonts()).toEqual([])
    await scanner.getInstalledMonoFonts()
    expect(execFile).toHaveBeenCalledTimes(1) // 缓存命中
  })
})
