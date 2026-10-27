import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AppUpdater,
  buildUpdaterCmd,
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
    // 更新器脚本落盘且引用校验过的 zip；spawn detached；触发正常退出
    const cmd = readFileSync(join(dir, 'updates', 'updater.cmd'), 'utf8')
    expect(cmd).toContain('robocopy')
    expect(deps.spawnImpl).toHaveBeenCalled()
    expect(
      (deps.spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]
    ).toMatchObject({
      detached: true,
      stdio: 'ignore'
    })
    expect(deps.quit).toHaveBeenCalled()
  })
})
