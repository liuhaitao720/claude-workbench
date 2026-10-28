import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AppUpdater,
  buildUpdaterCmd,
  buildUpdaterLauncher,
  parseChangelog,
  type AppUpdaterDeps
} from '../app-updater'

const CHANGELOG_MD = `# Changelog

## 1.2.0

- 新功能甲
- 新功能乙

## 1.1.0

- 自更新上线
- 很长的条目要被截断到 280 字符：${'x'.repeat(400)}

## 1.0.9

- 旧版本条目（不应出现）

## 0.9.0

- 更旧（不应出现）
`

describe('parseChangelog（CHANGELOG.md → 版本段，纯函数）', () => {
  it('取 (from, to] 区间：1.1.0 → 1.2.0 只含 1.2.0；0.9.0 → 1.2.0 含三段', () => {
    expect(parseChangelog(CHANGELOG_MD, '1.1.0', '1.2.0')).toEqual([
      { version: '1.2.0', items: ['新功能甲', '新功能乙'] }
    ])
    const wide = parseChangelog(CHANGELOG_MD, '0.9.0', '1.2.0')
    expect(wide.map((n) => n.version)).toEqual(['1.2.0', '1.1.0', '1.0.9'])
  })

  it('from 为空 → 只取 to 段（已是最新时展示当前版本自身说明）', () => {
    expect(parseChangelog(CHANGELOG_MD, '', '1.1.0')).toEqual([
      { version: '1.1.0', items: ['自更新上线', expect.stringContaining('很长的条目')] }
    ])
  })

  it('单条 280 字符截断；to 不存在/空 → 空数组；带 v 前缀的版本号兼容', () => {
    const one = parseChangelog(CHANGELOG_MD, '1.0.9', '1.1.0')[0]
    expect(one.items[1].length).toBeLessThanOrEqual(280)
    expect(parseChangelog(CHANGELOG_MD, '1.0.9', '9.9.9')).toEqual([])
    expect(parseChangelog('# x\n\n## v2.0.0\n\n- 前缀条目\n', '', '2.0.0')).toEqual([
      { version: '2.0.0', items: ['前缀条目'] }
    ])
  })
})

describe('buildUpdaterCmd（替换脚本安全红线）', () => {
  it('robocopy 用 /E 覆盖拷贝——绝不 /MIR（不删安装目录用户自放文件）', () => {
    const cmd = buildUpdaterCmd({
      zipPath: 'C:\\tmp\\z.zip',
      installDir: 'D:\\App Dir\\Claude',
      exeName: 'Claude Workbench.exe',
      extractDir: 'C:\\tmp\\ex',
      logPath: 'C:\\tmp\\log'
    })
    expect(cmd).toContain('robocopy')
    expect(cmd).not.toContain('/MIR')
    expect(cmd).toContain('/E /R:5 /W:2')
    // 路径含空格全程引号；无执行策略绕过、无进程枚举
    expect(cmd).toContain('"D:\\App Dir\\Claude"')
    expect(cmd).not.toMatch(/ExecutionPolicy|tasklist|Get-Process/)
  })

  // ── v1.2.1 升级后残留控制台窗口修复 ────────────────────────────────
  it('脚本收尾自删（.cmd 自身 + .vbs 垫片），只留 update.log 取证', () => {
    const cmd = buildUpdaterCmd({
      zipPath: 'C:\\tmp\\z.zip',
      installDir: 'D:\\App',
      exeName: 'app.exe',
      extractDir: 'C:\\tmp\\ex',
      logPath: 'C:\\tmp\\log',
      launcherPath: 'C:\\tmp\\updater-launch.vbs'
    })
    expect(cmd).toContain('del "C:\\tmp\\updater-launch.vbs"')
    expect(cmd).toContain('del "%~f0"') // 自删（批处理读完即释放句柄）
  })

  it('静默启动垫片：wscript 以隐藏窗口（0）异步拉起，纯 ASCII、路径来自参数不拼接', () => {
    const vbs = buildUpdaterLauncher()
    expect(vbs).toContain('CreateObject("WScript.Shell")')
    expect(vbs).toMatch(/sh\.Run\s+""""\s*&\s*target\s*&\s*""""\s*,\s*0\s*,\s*False/)
    expect(vbs).toContain('WScript.Arguments(0)')
    // 不含中文/非 ASCII（wscript 按系统 ANSI 解析纯 ASCII 脚本最稳）
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(vbs)).toBe(true)
  })
})

describe('AppUpdater（注入式：假网络/假 spawn/临时目录）', () => {
  let dir: string
  const fetchManifest = (m: unknown): typeof fetch =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('latest.json')) return new Response(JSON.stringify(m), { status: 200 })
      if (u.includes('CHANGELOG')) return new Response(CHANGELOG_MD, { status: 200 })
      throw new Error(`unexpected ${u}`)
    })

  const makeDeps = (over: Partial<AppUpdaterDeps> = {}): AppUpdaterDeps => ({
    appVersion: '1.1.0',
    isPackaged: true,
    execPath: join(dir, 'app', 'Claude Workbench.exe'),
    updateDir: join(dir, 'updates'),
    tempDir: join(dir, 'temp'),
    // spawn 替身须返回带 unref 的句柄（install 里 child.unref()）
    spawnImpl: vi.fn(() => ({ unref: vi.fn() })),
    quit: vi.fn(),
    ...over
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cwb-upd-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('check：清单+CHANGELOG 正常 → 区间说明；已是最新 → 当前版本段', async () => {
    const u = new AppUpdater(
      makeDeps({ fetchImpl: fetchManifest({ version: '1.2.0', url: 'x', sha256: 'y' }) })
    )
    const r = await u.check()
    expect(r).toMatchObject({ current: '1.1.0', latest: '1.2.0', upToDate: false })
    expect(r.notes.map((n) => n.version)).toEqual(['1.2.0'])

    const same = new AppUpdater(
      makeDeps({ fetchImpl: fetchManifest({ version: '1.1.0', url: 'x', sha256: 'y' }) })
    )
    expect((await same.check()).notes.map((n) => n.version)).toEqual(['1.1.0'])
  })

  it('check：网络失败逐项降级（manifestError/notesError 不影响结构）', async () => {
    const dead = vi.fn(async () => {
      throw new Error('offline')
    })
    const r = await new AppUpdater(makeDeps({ fetchImpl: dead as unknown as typeof fetch })).check()
    expect(r.latest).toBe('')
    expect(r.upToDate).toBe(false)
    expect(r.manifestError).toContain('offline')
    expect(r.notesError).toContain('offline')
    expect(r.notes).toEqual([])
  })

  it('download：sha256 不符 → 删除并报错，不进入就绪', async () => {
    const chunks = [new Uint8Array([1, 2, 3])]
    const dl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('latest.json')) {
        return new Response(JSON.stringify({ version: '1.2.0', url: 'http://x/zip', sha256: 'deadbeef' }), { status: 200 })
      }
      return new Response(chunks[0], {
        status: 200,
        headers: { 'content-length': String(chunks[0].byteLength) }
      })
    })
    const u = new AppUpdater(makeDeps({ fetchImpl: dl as unknown as typeof fetch }))
    await u.check()
    const r = await u.download()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('sha256')
    expect(existsSync(join(dir, 'updates', 'Claude-Workbench-1.2.0-portable.zip'))).toBe(false)
  })

  it('install：未打包/未下载先拒绝；就绪后写脚本+detached 启动+quit', async () => {
    const u0 = new AppUpdater(makeDeps({ isPackaged: false }))
    expect((await u0.install()).error).toContain('开发模式')

    const u1 = new AppUpdater(makeDeps())
    expect((await u1.install()).error).toContain('未就绪')

    // 就绪态模拟：check+download 成功路径（真 sha256 匹配）
    const body = new Uint8Array([9, 9, 9])
    const sha = createHash('sha256').update(body).digest('hex')
    const dl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('latest.json')) {
        return new Response(JSON.stringify({ version: '1.2.0', url: 'http://x/zip', sha256: sha }), { status: 200 })
      }
      return new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } })
    })
    const deps = makeDeps({ fetchImpl: dl as unknown as typeof fetch })
    const u2 = new AppUpdater(deps)
    await u2.check()
    expect((await u2.download()).ok).toBe(true)

    const r = await u2.install()
    expect(r.ok).toBe(true)
    // 更新器脚本落盘且引用校验过的 zip；经 wscript 静默拉起；触发正常退出
    const cmd = readFileSync(join(dir, 'updates', 'updater.cmd'), 'utf8')
    expect(cmd).toContain('robocopy')
    expect(deps.spawnImpl).toHaveBeenCalled()
    const [file, args, opts] = (deps.spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ]
    // v1.2.1：不再直起 cmd.exe（detached+windowsHide 互斥会露出黑窗），改 wscript 隐藏拉起
    expect(file).toBe('wscript.exe')
    expect(args[0]).toBe('//nologo')
    expect(args[1]).toBe(join(dir, 'updates', 'updater-launch.vbs'))
    expect(args[2]).toBe(join(dir, 'updates', 'updater.cmd'))
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(opts['windowsHide']).toBeUndefined() // 靠 vbs 的窗口样式 0，不依赖该标志
    expect(readFileSync(join(dir, 'updates', 'updater-launch.vbs'), 'utf8')).toContain('WScript.Shell')
    expect(deps.quit).toHaveBeenCalled()
  })

  // ── v1.2.1 自动升级（无需点按钮）──────────────────────────────────
  /** 就绪态：check + download 成功（真 sha256） */
  async function readyUpdater(over: Partial<AppUpdaterDeps> = {}): Promise<{
    updater: AppUpdater
    deps: AppUpdaterDeps
    progress: Array<{ phase: string; [k: string]: unknown }>
  }> {
    const progress: Array<{ phase: string; [k: string]: unknown }> = []
    const body = new Uint8Array([7, 7, 7])
    const sha = createHash('sha256').update(body).digest('hex')
    const dl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('latest.json')) {
        return new Response(JSON.stringify({ version: '1.2.0', url: 'http://x/zip', sha256: sha }), { status: 200 })
      }
      if (String(url).includes('CHANGELOG')) return new Response(CHANGELOG_MD, { status: 200 })
      return new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } })
    })
    const deps = makeDeps({
      fetchImpl: dl as unknown as typeof fetch,
      onProgress: (e) => progress.push(e),
      ...over
    })
    return { updater: new AppUpdater(deps), deps, progress }
  }

  it('自动升级：无运行任务且过宽限期 → 直接下载并退出替换（不点任何按钮）', async () => {
    const { updater, deps, progress } = await readyUpdater({ autoInstallGraceMs: 0 })
    await updater.runAutoUpdate()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
    // 进度事件：available（版本+说明）→ 下载百分比 → verifying → ready → installing
    expect(progress[0]?.phase).toBe('available')
    expect(progress.some((e) => e.phase === 'installing')).toBe(true)
  })

  it('自动升级：有运行任务 → 不退出，广播 waiting-tasks；任务结束后自动续上升级', async () => {
    let running = 2
    const { updater, deps, progress } = await readyUpdater({
      autoInstallGraceMs: 0,
      autoInstallPollMs: 1_000_000, // 轮询拉到很长：验证「任务变更即续上」而非等轮询
      runningCount: () => running
    })
    await updater.runAutoUpdate()
    expect(deps.quit).not.toHaveBeenCalled()
    const waiting = progress.filter((e) => e.phase === 'waiting-tasks')
    expect(waiting.at(-1)).toEqual({ phase: 'waiting-tasks', count: 2 })

    running = 0
    updater.tryAutoInstall() // 组合根 onTaskUpdate 钩子在任务停下时调用
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })

  it('任务结束后只剩宽限期 → 广播 ready（界面从「等待 N 个任务」退回已就绪）', async () => {
    let running = 1
    const { updater, deps, progress } = await readyUpdater({
      autoInstallGraceMs: 60_000,
      autoInstallPollMs: 1_000_000,
      runningCount: () => running
    })
    await updater.runAutoUpdate()
    expect(progress.filter((e) => e.phase === 'waiting-tasks').at(-1)).toEqual({
      phase: 'waiting-tasks',
      count: 1
    })
    running = 0
    updater.tryAutoInstall()
    expect(progress.at(-1)?.phase).toBe('ready')
    expect(deps.quit).not.toHaveBeenCalled() // 仍在宽限期，不退出
  })

  it('自动升级：启动宽限期内不重启（避免刚打开就闪退观感）', async () => {
    const { updater, deps, progress } = await readyUpdater({
      autoInstallGraceMs: 60_000,
      autoInstallPollMs: 1_000_000
    })
    await updater.runAutoUpdate()
    expect(deps.quit).not.toHaveBeenCalled()
    // 宽限期内仅静默等待：不广播「等待 0 个任务」这种读不懂的状态
    expect(progress.some((e) => e.phase === 'waiting-tasks')).toBe(false)
  })

  it('自动升级关闭 / 开发模式 → 不发起任何请求', async () => {
    const off = await readyUpdater({ autoUpdate: () => false })
    await off.updater.runAutoUpdate()
    expect(off.deps.quit).not.toHaveBeenCalled()
    expect(off.deps.fetchImpl).not.toHaveBeenCalled()

    const dev = await readyUpdater({ isPackaged: false })
    await dev.updater.runAutoUpdate()
    expect(dev.deps.quit).not.toHaveBeenCalled()
    expect(dev.deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('已是最新 → 不下载不退出', async () => {
    const dl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('latest.json')) {
        return new Response(JSON.stringify({ version: '1.1.0', url: 'x', sha256: 'y' }), { status: 200 })
      }
      return new Response(CHANGELOG_MD, { status: 200 })
    })
    const deps = makeDeps({ fetchImpl: dl as unknown as typeof fetch, autoInstallGraceMs: 0 })
    await new AppUpdater(deps).runAutoUpdate()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('cancelAutoInstall：用户关掉自动升级 → 取消挂起安装（不再退出）', async () => {
    let running = 1
    const { updater, deps } = await readyUpdater({
      autoInstallGraceMs: 0,
      autoInstallPollMs: 1_000_000,
      runningCount: () => running
    })
    await updater.runAutoUpdate()
    expect(deps.quit).not.toHaveBeenCalled()
    updater.cancelAutoInstall()
    running = 0
    updater.tryAutoInstall()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('checkAppUpdate：非强制复用缓存；force 重新请求；并发去重只打一次网络', async () => {
    const { updater, deps } = await readyUpdater()
    const [a, b] = await Promise.all([updater.checkAppUpdate(), updater.checkAppUpdate()])
    expect(a).toBe(b)
    const callsAfterFirst = (deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    // 非强制 → 命中缓存，不再请求
    await updater.checkAppUpdate()
    expect((deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst)
    // force → 重新请求清单
    await updater.checkAppUpdate(true)
    expect(
      (deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThan(callsAfterFirst)
  })
})
