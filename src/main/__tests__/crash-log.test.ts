import { describe, expect, it } from 'vitest'
import { formatCrashLine } from '../crash-log'

describe('formatCrashLine（v1.1.0 退出取证日志）', () => {
  it('ISO 时间 + 事件 + 来源 + 细节；控制字符/换行被中和（防日志注入）', () => {
    const line = formatCrashLine({ event: 'before-quit', origin: 'tray', detail: 'a\nb\u0000c' })
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \| before-quit \| origin=tray \| a b c\n$/)
    expect(line.split('\n')).toHaveLength(2) // 仅末尾换行
  })

  it('超长细节截断到 400 字符（防单条撑爆日志）', () => {
    const line = formatCrashLine({ event: 'x', detail: 'y'.repeat(1000) })
    expect(line.length).toBeLessThan(500)
  })
})
