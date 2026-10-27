import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PtyManager,
  buildClaudeEnv,
  buildNewSessionArgs,
  buildResumeArgs,
  pickClaudePaths
} from '../pty-manager'

describe('buildClaudeEnv（v1.0.8 终端保真环境）', () => {
  it('TERM=xterm-256color + COLORTERM=truecolor（缺 COLORTERM 时 CLI 降级 256 色）', () => {
    const env = buildClaudeEnv()
    expect(env['TERM']).toBe('xterm-256color')
    expect(env['COLORTERM']).toBe('truecolor')
  })

  it('剥离父级 claude 会话身份标记（CLAUDECODE/SESSION_ID 族），偏好类保留', () => {
    const prev = process.env['CLAUDECODE']
    const prevModel = process.env['ANTHROPIC_MODEL']
    process.env['CLAUDECODE'] = '1'
    process.env['CLAUDE_CODE_SESSION_ID'] = 'parent-session'
    process.env['ANTHROPIC_MODEL'] = 'claude-x'
    try {
      const env = buildClaudeEnv()
      expect(env['CLAUDECODE']).toBeUndefined()
      expect(env['CLAUDE_CODE_SESSION_ID']).toBeUndefined()
      expect(env['ANTHROPIC_MODEL']).toBe('claude-x')
    } finally {
      if (prev === undefined) delete process.env['CLAUDECODE']
      else process.env['CLAUDECODE'] = prev
      if (prevModel === undefined) delete process.env['ANTHROPIC_MODEL']
      else process.env['ANTHROPIC_MODEL'] = prevModel
    }
  })
})

describe('args builder（精确数组，结构性互斥）', () => {
  it('buildNewSessionArgs → ["--session-id", uuid, "-n", name]', () => {
    expect(buildNewSessionArgs('UUID-1', '重构登录')).toEqual(['--session-id', 'UUID-1', '-n', '重构登录'])
  })

  it('buildResumeArgs → ["--resume", uuid, "-n", name]', () => {
    expect(buildResumeArgs('UUID-2', '修 bug')).toEqual(['--resume', 'UUID-2', '-n', '修 bug'])
  })

  it('v0.3.1 skipPermissions：两 builder 均可附 --dangerously-skip-permissions（缺省/false 不附）', () => {
    const FLAG = '--dangerously-skip-permissions'
    expect(buildNewSessionArgs('U', 'n', { skipPermissions: true })).toEqual([
      '--session-id', 'U', '-n', 'n', FLAG
    ])
    expect(buildNewSessionArgs('U', 'n', { skipPermissions: false })).toEqual(['--session-id', 'U', '-n', 'n'])
    expect(buildNewSessionArgs('U', 'n')).toEqual(['--session-id', 'U', '-n', 'n'])
    expect(buildResumeArgs('U', 'n', { skipPermissions: true })).toEqual(['--resume', 'U', '-n', 'n', FLAG])
    expect(buildResumeArgs('U', 'n', { skipPermissions: false })).toEqual(['--resume', 'U', '-n', 'n'])
    expect(buildResumeArgs('U', 'n')).toEqual(['--resume', 'U', '-n', 'n'])
  })

  it('v3.2 settingsPath：两 builder 均附 ["--settings", path]（缺省不附——e2e 直连路径行为不变）', () => {
    const P = 'C:\\Users\\x\\AppData\\Local\\cwb\\cwb-settings\\uuid.json'
    expect(buildNewSessionArgs('U', 'n', { settingsPath: P })).toEqual(['--session-id', 'U', '-n', 'n', '--settings', P])
    expect(buildResumeArgs('U', 'n', { settingsPath: P })).toEqual(['--resume', 'U', '-n', 'n', '--settings', P])
    // 与 skipPermissions 组合：flag 在前、--settings 收尾
    expect(buildNewSessionArgs('U', 'n', { skipPermissions: true, settingsPath: P })).toEqual([
      '--session-id', 'U', '-n', 'n', '--dangerously-skip-permissions', '--settings', P
    ])
  })
})

describe('pickClaudePaths（v1.0.6 where 多命中 → 有序候选列表）', () => {
  const whereOutput = [
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1',
    'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
  ]

  it('npm claude.cmd 优先，其余 cmd/exe/bat 按 where 顺序；sh 垫片与 .ps1 过滤', () => {
    expect(pickClaudePaths(whereOutput)).toEqual([
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
    ])
  })

  it('无 npm 命中时保持 where 顺序；空/全不可执行返回空数组；重复去重', () => {
    expect(pickClaudePaths(['D:\\tools\\claude.exe', ''])).toEqual(['D:\\tools\\claude.exe'])
    expect(pickClaudePaths(['', '   '])).toEqual([])
    expect(pickClaudePaths(['C:\\x\\claude.ps1'])).toEqual([])
    expect(pickClaudePaths(['D:\\a\\claude.exe', 'D:\\a\\claude.exe'])).toEqual(['D:\\a\\claude.exe'])
  })
})

describe('PtyManager（真实 node-pty）', () => {
  it('spawn cmd.exe /c echo ok：收到含 ok 字节后退出，isRunning 归假', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwb-pty-'))
    try {
      const chunks: string[] = []
      const exits: string[] = []
      const mgr = new PtyManager({
        onData: (e) => chunks.push(e.data),
        onExit: (taskId) => exits.push(taskId)
      })

      mgr.spawn('t-echo', 'cmd.exe', ['/c', 'echo', 'ok'], dir)
      expect(mgr.isRunning('t-echo')).toBe(true)

      await vi.waitFor(
        () => {
          expect(chunks.join('')).toContain('ok')
          expect(exits).toContain('t-echo')
        },
        { timeout: 9_000, interval: 100 }
      )
      expect(mgr.isRunning('t-echo')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kill 停止长命进程：onExit 触发、句柄清理', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwb-pty-'))
    try {
      const exits: string[] = []
      const mgr = new PtyManager({
        onData: () => {},
        onExit: (taskId) => exits.push(taskId)
      })

      mgr.spawn('t-shell', 'cmd.exe', [], dir)
      expect(mgr.isRunning('t-shell')).toBe(true)

      mgr.kill('t-shell')
      await vi.waitFor(() => expect(exits).toContain('t-shell'), { timeout: 9_000, interval: 100 })
      expect(mgr.isRunning('t-shell')).toBe(false)

      // 未知任务 kill/写/缩放安全 no-op
      mgr.kill('no-such-task')
      mgr.write('no-such-task', 'x')
      mgr.resize('no-such-task', 100, 30)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('恢复场景（v0.1.2）：resize 后 kill 再重开沿用记忆尺寸，而非回退 80×24', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwb-pty-'))
    try {
      const exits: string[] = []
      const mgr = new PtyManager({
        onData: () => {},
        onExit: (taskId) => exits.push(taskId)
      })

      mgr.spawn('t-resume', 'cmd.exe', [], dir)
      expect(mgr.currentSize('t-resume')).toEqual({ cols: 80, rows: 24 }) // 首启默认

      mgr.resize('t-resume', 120, 38) // 模拟终端 fit 后同步
      // node-pty Windows 端 resize 经 _deferNoArgs 异步落 _cols/_rows——等待属性生效
      await vi.waitFor(
        () => expect(mgr.currentSize('t-resume')).toEqual({ cols: 120, rows: 38 }),
        { timeout: 3_000, interval: 50 }
      )

      mgr.kill('t-resume')
      await vi.waitFor(() => expect(exits).toContain('t-resume'), { timeout: 9_000, interval: 100 })

      // --resume 重开：须沿用 120×38，否则 claude 按旧栅格计算光标 → 错位
      mgr.spawn('t-resume', 'cmd.exe', [], dir)
      expect(mgr.currentSize('t-resume')).toEqual({ cols: 120, rows: 38 })

      mgr.kill('t-resume')
      await vi.waitFor(
        () => expect(exits.filter((x) => x === 't-resume').length).toBe(2),
        { timeout: 9_000, interval: 100 }
      )
      // Windows：kill 后 ConPTY 尾部清理可能仍占 temp 目录句柄——等待+重试删除
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(dir, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    } finally {
      // 兜底：重试仍失败时再试一次（temp 残留无害，不阻断测试结论）
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* EBUSY 残留 temp 目录，无害 */
      }
    }
  })
})
