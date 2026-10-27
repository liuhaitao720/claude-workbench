import { describe, expect, it } from 'vitest'
import { normalizeCliOutput, stripAnsi } from './cli-output-clean'

describe('stripAnsi（v1.1.0 CLI 输出清洗）', () => {
  it('去 CSI 清行/光标定位、OSC 标题、单字符 ESC 序列', () => {
    expect(stripAnsi('\u001b[Khello')).toBe('hello')
    expect(stripAnsi('\u001b[2J\u001b[Hreset')).toBe('reset')
    expect(stripAnsi('\u001b]0;claude\u0007title')).toBe('title')
    expect(stripAnsi('a\u001b[?25hb')).toBe('ab')
    expect(stripAnsi('\u001b[1;32mgreen\u001b[0m')).toBe('green')
  })

  it('保留普通文本与换行/制表', () => {
    expect(stripAnsi('a\tb\nc')).toBe('a\tb\nc')
    expect(stripAnsi('纯中文输出')).toBe('纯中文输出')
  })
})

describe('normalizeCliOutput（行编辑语义：\\r 覆盖 / \\b 退格）', () => {
  it('进度条 \\r 覆盖：同一行只保留最后一次写入', () => {
    const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%\nDone'
    expect(normalizeCliOutput(raw)).toBe('Downloading 100%\nDone')
  })

  it('\\b 退格删除前一个字符', () => {
    expect(normalizeCliOutput('abc\b\bXY')).toBe('aXY')
  })

  it('组合场景：ANSI + \\r + \\r\\n 结尾 → 可读文本（用户报告「点了更新没变化」修复）', () => {
    const raw =
      '\u001b[K\r\n\u001b[K\u001b[H\u001b[?25h\u001b]0;claude\u0007Current version: 2.1.309\r\n' +
      'Checking for updates...\r\n[====    ] 50%\r[========] 100%\r\nUpdated to 2.1.311\r\n'
    expect(normalizeCliOutput(raw)).toBe(
      'Current version: 2.1.309\nChecking for updates...\n[========] 100%\nUpdated to 2.1.311'
    )
  })

  it('尾部空行去除；内部空行保留', () => {
    expect(normalizeCliOutput('a\n\nb\n\n\n')).toBe('a\n\nb')
    expect(normalizeCliOutput('')).toBe('')
  })
})

describe('stripAnsi 分片残留（v1.1.0 二次加固）', () => {
  it('OSC 前缀已被上一片吃掉时，孤立 BEL / ESC 也清掉（实测 cmd 标题残留）', () => {
    expect(stripAnsi(':\WINDOWS\SYSTEM32\cmd.exe\u0007')).toBe(':\WINDOWS\SYSTEM32\cmd.exe')
    expect(stripAnsi('abc\u001bdef')).toBe('abcdef')
  })
})
