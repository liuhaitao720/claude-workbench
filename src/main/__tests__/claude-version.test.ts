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
    /** v1.0.6：候选列表覆盖（null → [claudeCmd]） */
    candidates: null as string[] | null,
    /** v1.0.6：候选子串命中即让 --version 失败（多候选回退用例） */
    failVersionFor: '',
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
    if (args.includes('--version')) {
      const cand = String(args[1] ?? '')
      if (state.failVersionFor !== '' && cand.includes(state.failVersionFor)) {
        callback(new Error('broken shim'), undefined)
        return
      }
      callback(null, { stdout: state.versionOut })
    }
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
    resolveClaudeCandidates: vi.fn(async () => state.candidates ?? [state.claudeCmd]),
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
  fetchLatestFromRegistry,
  getClaudeVersionInfo,
  installClaudeCli,
  invalidateVersionCache,
  resolveNpmRegistry
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
  state.candidates = null
  state.failVersionFor = ''
  state.versionOut = '2.1.301 (Claude Code)\n'
  state.npmOut = '2.1.304\n'
  state.execFails = false
  vi.mocked(invalidateClaudePathCache).mockClear()
  invalidateVersionCache() // v1.0.1：版本缓存不跨用例泄漏
})

describe('extractSemver', () => {
  it('从版本输出提取 semver（含 prerelease）；无匹配返回空串', () => {
    expect(extractSemver('2.1.301 (Claude Code)')).toBe('2.1.301')
    expect(extractSemver('  1.0.0-beta.1\n')).toBe('1.0.0-beta.1')
    expect(extractSemver('not a version')).toBe('')
  })
})

describe('getClaudeVersionInfo（cmd.exe 包装 + 失败不崩 + v1.0.6 加固）', () => {
  it('cmd.exe /c <claudeCmd> --version（每候选 8s 超时）；返回版本与解析路径', async () => {
    const info = await getClaudeVersionInfo()
    expect(
      state.calls.some(
        (c) =>
          c.cmd === 'cmd.exe' &&
          c.args.length === 3 &&
          c.args[0] === '/c' &&
          c.args[1] === 'C:\\npm-global\\claude.cmd' &&
          c.args[2] === '--version' &&
          (c.opts as { timeout?: number } | undefined)?.timeout === 8_000
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

  it('v1.0.6 失败不缓存：失败后恢复可用的环境，重调即重新探测成功（原实现把「未安装」钉死整个会话）', async () => {
    state.execFails = true
    await expect(getClaudeVersionInfo()).resolves.toEqual({ version: '', path: 'C:\\npm-global\\claude.cmd' })
    state.execFails = false
    await expect(getClaudeVersionInfo()).resolves.toEqual({
      version: '2.1.301',
      path: 'C:\\npm-global\\claude.cmd'
    })
  })

  it('v1.0.6 多候选回退：npm 垫片坏 → 逐候选探测，WinGet claude.exe 接管（path=可用者）', async () => {
    state.candidates = [
      'C:\\npm-global\\claude.cmd',
      'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
    ]
    state.failVersionFor = 'npm-global'
    const info = await getClaudeVersionInfo()
    expect(info).toEqual({
      version: '2.1.301',
      path: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
    })
    // 版本探测调了两个候选各一次（第一个失败、第二个成功即止）
    const versionCalls = state.calls.filter((c) => c.args.includes('--version'))
    expect(versionCalls).toHaveLength(2)
  })
})

describe('checkClaudeUpdate（v1.0.1：registry HTTP 直连优先，npm view 兜底）', () => {
  /** 桩掉全局 fetch：可控 registry 路径（v1.0.1 主路不再走 npm CLI） */
  const stubFetch = (version: string | null): void => {
    vi.stubGlobal(
      'fetch',
      version === null
        ? vi.fn(() => Promise.reject(new Error('network blocked')))
        : vi.fn(() =>
            Promise.resolve(
              new Response(JSON.stringify({ version }), { status: 200 })
            )
          )
    )
  }

  it('registry HTTP 直连返回 latest → 版本对比正确（无 npm CLI 调用）', async () => {
    stubFetch('2.1.304')
    try {
      const info = await checkClaudeUpdate()
      expect(info).toEqual({ current: '2.1.301', latest: '2.1.304', upToDate: false })
      expect(
        state.calls.some((c) => c.args.includes('view'))
      ).toBe(false) // 主路成功不落 npm CLI
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('已是最新：current === latest → upToDate=true（无 degraded 字段）', async () => {
    state.versionOut = '2.1.304 (Claude Code)\n'
    stubFetch('2.1.304')
    try {
      await expect(checkClaudeUpdate()).resolves.toEqual({
        current: '2.1.304',
        latest: '2.1.304',
        upToDate: true
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HTTP 失败 → 回退 npm view CLI（cmd.exe /c 包装断言）', async () => {
    stubFetch(null)
    try {
      const info = await checkClaudeUpdate()
      expect(state.calls).toContainEqual({
        cmd: 'cmd.exe',
        args: ['/c', 'npm', 'view', '@anthropic-ai/claude-code', 'version'],
        opts: expect.objectContaining({ timeout: 20_000 })
      })
      expect(info).toEqual({ current: '2.1.301', latest: '2.1.304', upToDate: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('双路失败 → degraded=true（渲染层提示走 claude update）', async () => {
    stubFetch(null)
    state.npmOut = ''
    state.execFails = true // version 探测也失败 → current=''；双路失败 → degraded
    try {
      await expect(checkClaudeUpdate()).resolves.toMatchObject({
        current: '',
        degraded: true,
        upToDate: false
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('npm 输出解析失败（回退路 garbage）→ degraded=true 不崩', async () => {
    stubFetch(null)
    state.npmOut = 'garbage no semver here!!!'
    try {
      await expect(checkClaudeUpdate()).resolves.toMatchObject({ degraded: true, upToDate: false })
    } finally {
      vi.unstubAllGlobals()
    }
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

describe('v1.0.1 检查更新提速（registry HTTP 直连优先，npm view 兜底）', () => {
  it('resolveNpmRegistry：npmrc registry= 行解析；无配置回 npmjs 缺省', () => {
    expect(resolveNpmRegistry('/home/u', 'registry=https://registry.npmmirror.com/\n')).toBe(
      'https://registry.npmmirror.com'
    )
    expect(resolveNpmRegistry('/home/u', null)).toBe('https://registry.npmjs.org')
    expect(resolveNpmRegistry('/home/u', 'prefix=D:\npm-global')).toBe('https://registry.npmjs.org')
  })

  it('真实 registry HTTP 直连 <2s 返回 latest（实测对比 npm view 16s）', { timeout: 15_000 }, async () => {
    const t0 = Date.now()
    const latest = await fetchLatestFromRegistry()
    const elapsed = Date.now() - t0
    expect(latest).toMatch(/^\d+\.\d+\.\d+$/)
    expect(elapsed).toBeLessThan(10_000) // 网络余量断言（本机实测 0.4s）
  })
})
