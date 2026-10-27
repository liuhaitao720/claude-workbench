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
    /** v1.1.0：模拟「输出已到但 cmd 壳不退出」（本机实测 1/4 概率） */
    hangAfterOutput: false,
    /** v1.1.0：假 spawn 调用记录 + 被定点杀树的 pid */
    spawnCalls: [] as Array<{ cmd: string; args: readonly string[]; opts: unknown }>,
    killedPids: [] as number[],
    execFileCalls: [] as Array<{ cmd: string; args: readonly string[]; opts: unknown }>,
    calls: [] as Array<{ cmd: string; args: readonly string[]; opts: unknown }>
  }
})

vi.mock('node:child_process', () => ({
  /** v1.1.0 版本探测改用 spawn 流式读（拿到输出即收尾，不等壳退出） */
  spawn: vi.fn((cmd: string, args: readonly string[], opts: unknown) => {
    state.spawnCalls.push({ cmd, args, opts })
    const cand = String(args[1] ?? '')
    const fail = state.execFails || (state.failVersionFor !== '' && cand.includes(state.failVersionFor))
    const stdoutCbs: Array<(d: Buffer) => void> = []
    const closeCbs: Array<() => void> = []
    const errorCbs: Array<() => void> = []
    const child = {
      pid: 4242,
      stdout: { on: (_ev: string, cb: (d: Buffer) => void) => stdoutCbs.push(cb) },
      stderr: { on: () => {} },
      on: (ev: string, cb: () => void) => {
        if (ev === 'close') closeCbs.push(cb)
        if (ev === 'error') errorCbs.push(cb)
      }
    }
    setTimeout(() => {
      if (fail) {
        for (const cb of errorCbs) cb()
        for (const cb of closeCbs) cb()
        return
      }
      const out = Buffer.from(state.versionOut)
      for (const cb of stdoutCbs) cb(out)
      // hangAfterOutput=true 模拟 cmd 壳拿到输出后不退出（真实故障场景）
      if (!state.hangAfterOutput) for (const cb of closeCbs) cb()
    }, 0)
    return child
  }),
  execFileSync: vi.fn((_cmd: string, args: readonly string[]) => {
    state.killedPids.push(Number(args[1]))
  }),
  execFile: vi.fn((cmd: string, args: readonly string[], opts: unknown, cb: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result?: { stdout: string }
    ) => void
    state.calls.push({ cmd, args, opts })
    state.execFileCalls.push({ cmd, args, opts })
    if (state.execFails) {
      callback(new Error('spawn ENOENT'), undefined)
      return
    }
    if (args.join(' ').includes('npm view')) callback(null, { stdout: state.npmOut })
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
  atomToEntries,
  checkClaudeUpdate,
  extractSemver,
  fetchClaudeChangelog,
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
  state.hangAfterOutput = false
  state.spawnCalls.length = 0
  state.killedPids.length = 0
  state.execFileCalls.length = 0
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

describe('getClaudeVersionInfo（v1.1.0：spawn 流式探测，拿到输即收尾）', () => {
  const fast = { quietMs: 5, timeoutMs: 500 }

  it('cmd.exe /c <claudeCmd> --version（stdio stdin=ignore）；返回版本与解析路径', async () => {
    const info = await getClaudeVersionInfo(fast)
    const call = state.spawnCalls.find((c) => c.args[2] === '--version')
    expect(call).toMatchObject({ cmd: 'cmd.exe' })
    expect(call?.args).toEqual(['/c', 'C:\\npm-global\\claude.cmd', '--version'])
    expect((call?.opts as { stdio?: string[] }).stdio?.[0]).toBe('ignore')
    expect(info).toEqual({ version: '2.1.301', path: 'C:\\npm-global\\claude.cmd' })
  })

  it('v1.1.0 核心回归：输出已到但 cmd 壳不退出 → 仍判定成功并定点杀树', async () => {
    // 真实故障场景（本机实测 1/4 概率）：版本串 ~160ms 已到，cmd 壳残留不退出
    state.hangAfterOutput = true
    const info = await getClaudeVersionInfo(fast)
    expect(info).toEqual({ version: '2.1.301', path: 'C:\\npm-global\\claude.cmd' })
    expect(state.killedPids).toEqual([4242]) // 按记录的 pid 定点杀，不枚举进程
  })

  it("探测失败（未安装/超时/非零退出）→ version='' 不崩（契约：空=未安装）", async () => {
    state.execFails = true
    await expect(getClaudeVersionInfo(fast)).resolves.toEqual({
      version: '',
      path: 'C:\\npm-global\\claude.cmd'
    })
  })

  it('v1.0.6 失败不缓存：失败后恢复可用的环境，重调即重新探测成功（原实现把「未安装」钉死整个会话）', async () => {
    state.execFails = true
    await expect(getClaudeVersionInfo(fast)).resolves.toEqual({ version: '', path: 'C:\\npm-global\\claude.cmd' })
    state.execFails = false
    await expect(getClaudeVersionInfo(fast)).resolves.toEqual({
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
    const info = await getClaudeVersionInfo(fast)
    expect(info).toEqual({
      version: '2.1.301',
      path: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
    })
    // 版本探测调了两个候选各一次（第一个失败、第二个成功即止）
    expect(state.spawnCalls).toHaveLength(2)
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

describe('v1.1.0 claude CLI 更新说明（CHANGELOG 区间 + atom 兜底）', () => {
  const MD = `# Changelog

## 2.1.312

- 新增功能甲
- 修复乙

## 2.1.311

- 中版本条目

## 2.1.310

- 旧版本（区间外）

## 2.1.309

- 当前版本（不展示）
`

  it('fetchClaudeChangelog：raw CHANGELOG（Range 头部请求）解析出 current→latest 区间', async () => {
    const calls: Array<{ url: string; range?: string }> = []
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        range: (init?.headers as Record<string, string> | undefined)?.['Range']
      })
      return new Response(MD, { status: 206 })
    })
    const r = await fetchClaudeChangelog('2.1.309', '2.1.312', fake as unknown as typeof fetch)
    expect(r.error).toBeUndefined()
    expect(r.notes.map((n) => n.version)).toEqual(['2.1.312', '2.1.311', '2.1.310'])
    // Range 头部限制传输量（全量 CHANGELOG ~1.1MB）
    expect(calls[0].range).toBe('bytes=0-262143')
    expect(calls[0].url).toContain('anthropics/claude-code')
  })

  it('atomToEntries：HTML 实体解转义 + <li> 提取 + 区间过滤（raw 域被拦时的兜底）', () => {
    const xml = `<feed>
<entry><title>v2.1.312</title><content type="html">&lt;h2&gt;What&#39;s changed&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Added &lt;code&gt;--flag&lt;/code&gt; thing&lt;/li&gt;&lt;li&gt;Fixed bug &amp;amp; crash&lt;/li&gt;&lt;/ul&gt;</content></entry>
<entry><title>v2.1.309</title><content type="html">&lt;ul&gt;&lt;li&gt;当前版本条目不展示&lt;/li&gt;&lt;/ul&gt;</content></entry>
</feed>`
    const out = atomToEntries(xml, '2.1.309', '2.1.312')
    expect(out).toEqual([
      { version: '2.1.312', items: ['Added --flag thing', 'Fixed bug & crash'] }
    ])
  })

  it('双路都失败 → notes 空 + error 含两段原因（不抛错）', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    const r = await fetchClaudeChangelog('2.1.309', '2.1.312', dead as unknown as typeof fetch)
    expect(r.notes).toEqual([])
    expect(r.error).toContain('ENOTFOUND')
    expect(r.error).toContain('atom 兜底')
  })

  it('raw 失败但 atom 成功 → 走 atom 分支', async () => {
    const fake = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('raw.githubusercontent')) return new Response('', { status: 403 })
      return new Response(
        `<feed><entry><title>v2.1.312</title><content type="html">&lt;ul&gt;&lt;li&gt;atom 条目&lt;/li&gt;&lt;/ul&gt;</content></entry></feed>`,
        { status: 200 }
      )
    })
    const r = await fetchClaudeChangelog('2.1.309', '2.1.312', fake as unknown as typeof fetch)
    expect(r.notes).toEqual([{ version: '2.1.312', items: ['atom 条目'] }])
  })

  it('真实网络：raw CHANGELOG Range 请求可取到最新版本段（本机联网实测）', { timeout: 20_000 }, async () => {
    // 锚定语义要求 to 版本在文件里存在——用 registry 真实 latest 作锚
    const latest = await fetchLatestFromRegistry()
    const r = await fetchClaudeChangelog('2.1.300', latest)
    expect(r.notes.length).toBeGreaterThan(0)
    expect(r.notes[0].version).toBe(latest)
    expect(r.notes[0].items.length).toBeGreaterThan(0)
  })
})
