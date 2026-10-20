import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * claude-version 单测：execFile 全桩（vi.mock('node:child_process')）——绝不真跑
 * claude --version / npm view / 安装器；模板字符串精确断言，绝不真跑 irm|iex。
 * CliRunner 用假 PTY 缝（vi.mock('node-pty')）验证安装命令的 spawn 与完成钩子。
 */

const state = vi.hoisted(() => {
  const fakePty = {
    spawns: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
    instances: [] as Array<{
      onExitCbs: Array<(e: { exitCode: number }) => void>
      killed: boolean
    }>
  }
  class FakePty {
    readonly onExitCbs: Array<(e: { exitCode: number }) => void> = []
    killed = false
    constructor(
      readonly file: string,
      readonly args: string[],
      readonly options: Record<string, unknown>
    ) {
      fakePty.spawns.push({ file, args, options })
      fakePty.instances.push(this)
    }
    onData(_cb: (d: string) => void): void {}
    onExit(cb: (e: { exitCode: number }) => void): void {
      this.onExitCbs.push(cb)
    }
    kill(): void {
      this.killed = true
    }
  }
  return {
    fakePty,
    FakePty,
    /** execFile 桩响应（每用例重置） */
    claudeCmd: 'C:\\npm-global\\claude.cmd',
    versionOut: '2.1.301 (Claude Code)\n',
    npmOut: '2.1.304\n',
    execFails: false,
    calls: [] as Array<{ cmd: string; args: readonly string[]; opts: unknown }>
  }
})

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: readonly string[], opts: unknown, cb: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result?: { stdout: string }
    ) => void
    state.calls.push({ cmd, args, opts })
    if (state.execFails) {
      callback(new Error('spawn ENOENT'), undefined)
      return
    }
    if (args.includes('--version')) callback(null, { stdout: state.versionOut })
    else if (args.join(' ').includes('npm view')) callback(null, { stdout: state.npmOut })
    else callback(null, { stdout: '' })
  })
}))

vi.mock('node-pty', () => ({ spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => new state.FakePty(file, args, options)) }))

/** pty-manager 桩：路径解析走 state.claudeCmd；invalidateClaudePathCache 为 spy（断言完成钩子） */
vi.mock('../pty-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pty-manager')>()
  return {
    ...actual,
    resolveClaudeCommand: vi.fn(async () => state.claudeCmd),
    invalidateClaudePathCache: vi.fn()
  }
})

import {
  NATIVE_INSTALL_ARGS,
  NATIVE_INSTALL_FILE,
  NPM_INSTALL_ARGS,
  NPM_INSTALL_FILE,
  checkClaudeUpdate,
  extractSemver,
  getClaudeVersionInfo,
  installClaudeCli
} from '../claude-version'
import { invalidateClaudePathCache } from '../pty-manager'
import { CliRunner } from '../cli-runner'
import { execFile } from 'node:child_process'

const execFileMock = vi.mocked(execFile)

beforeEach(() => {
  execFileMock.mockClear()
  state.calls.length = 0
  state.fakePty.spawns.length = 0
  state.fakePty.instances.length = 0
  state.claudeCmd = 'C:\\npm-global\\claude.cmd'
  state.versionOut = '2.1.301 (Claude Code)\n'
  state.npmOut = '2.1.304\n'
  state.execFails = false
  vi.mocked(invalidateClaudePathCache).mockClear()
})

describe('extractSemver', () => {
  it('从版本输出提取 semver（含 prerelease）；无匹配返回空串', () => {
    expect(extractSemver('2.1.301 (Claude Code)')).toBe('2.1.301')
    expect(extractSemver('  1.0.0-beta.1\n')).toBe('1.0.0-beta.1')
    expect(extractSemver('not a version')).toBe('')
  })
})

describe('getClaudeVersionInfo（cmd.exe 包装 + 失败不崩）', () => {
  it('cmd.exe /c <claudeCmd> --version（20s 超时）；返回版本与解析路径', async () => {
    const info = await getClaudeVersionInfo()
    expect(
      state.calls.some(
        (c) =>
          c.cmd === 'cmd.exe' &&
          c.args.length === 3 &&
          c.args[0] === '/c' &&
          c.args[1] === 'C:\\npm-global\\claude.cmd' &&
          c.args[2] === '--version' &&
          (c.opts as { timeout?: number } | undefined)?.timeout === 20_000
      )
    ).toBe(true)
    expect(info).toEqual({ version: '2.1.301', path: 'C:\\npm-global\\claude.cmd' })
  })

  it("探测失败（未安装/超时/非零退出）→ version='' 不崩（契约：空=未安装）", async () => {
    state.execFails = true
    await expect(getClaudeVersionInfo()).resolves.toEqual({
      version: '',
      path: 'C:\\npm-global\\claude.cmd'
    })
  })
})

describe('checkClaudeUpdate（npm view cmd 包装 + 降级）', () => {
  it('npm view @anthropic-ai/claude-code version（npm 是 npm.cmd 须 cmd.exe 包装）；版本对比', async () => {
    const info = await checkClaudeUpdate()
    expect(state.calls).toContainEqual({
      cmd: 'cmd.exe',
      args: ['/c', 'npm', 'view', '@anthropic-ai/claude-code', 'version'],
      opts: expect.objectContaining({ timeout: 20_000 })
    })
    expect(info).toEqual({ current: '2.1.301', latest: '2.1.304', upToDate: false })
  })

  it('已是最新：current === latest → upToDate=true（无 degraded 字段）', async () => {
    state.versionOut = '2.1.304 (Claude Code)\n'
    await expect(checkClaudeUpdate()).resolves.toEqual({
      current: '2.1.304',
      latest: '2.1.304',
      upToDate: true
    })
  })

  it('无 npm（探测失败）→ degraded=true（渲染层提示走 claude update）', async () => {
    state.npmOut = ''
    state.execFails = true // version 探测也失败 → current=''；npm 探测失败 → degraded
    await expect(checkClaudeUpdate()).resolves.toMatchObject({
      current: '',
      degraded: true,
      upToDate: false
    })
  })

  it('npm 输出解析失败 → degraded=true 不崩', async () => {
    state.npmOut = 'garbage no semver here!!!'
    await expect(checkClaudeUpdate()).resolves.toMatchObject({ degraded: true, upToDate: false })
  })
})

describe('installClaudeCli（固定模板——绝不真跑安装器）', () => {
  it('模板常量精确断言：native=irm|iex 且无 ExecutionPolicy Bypass；npm=npm install -g', () => {
    expect(NATIVE_INSTALL_FILE).toBe('powershell.exe')
    expect(NATIVE_INSTALL_ARGS).toEqual(['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'])
    expect(NATIVE_INSTALL_ARGS.join(' ')).not.toContain('ExecutionPolicy')
    expect(NPM_INSTALL_FILE).toBe('cmd.exe')
    expect(NPM_INSTALL_ARGS).toEqual(['/c', 'npm', 'install', '-g', '@anthropic-ai/claude-code'])
  })

  it('经 CliRunner 固定模板执行（不经 execFile）；模板字符串原样进入 spawn args', async () => {
    const runner = new CliRunner({ onData: () => {}, onExit: () => {} })
    const native = await installClaudeCli(runner, 'native')
    expect(native.commandId).toBeTruthy()
    expect(state.fakePty.spawns[0]).toMatchObject({
      file: 'powershell.exe',
      args: [...NATIVE_INSTALL_ARGS]
    })

    const npm = await installClaudeCli(runner, 'npm')
    expect(npm.commandId).toBeTruthy()
    expect(state.fakePty.spawns[1]).toMatchObject({ file: 'cmd.exe', args: [...NPM_INSTALL_ARGS] })
    expect(execFileMock).not.toHaveBeenCalled() // 全走 PTY 通道，不走 execFile
  })

  it('完成（进程退出）→ invalidateClaudePathCache 被调（About 刷新链路）', async () => {
    const runner = new CliRunner({ onData: () => {}, onExit: () => {} })
    await installClaudeCli(runner, 'native')
    expect(invalidateClaudePathCache).not.toHaveBeenCalled() // 尚未退出
    const pty = state.fakePty.instances[0]
    pty?.onExitCbs[0]?.({ exitCode: 0 })
    expect(invalidateClaudePathCache).toHaveBeenCalledTimes(1)
  })
})
