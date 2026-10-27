import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compareSemver } from './claude-version'

/**
 * 应用自更新（v1.1.0）：检测 → 下载校验 → 退出替换重启。
 *
 * 通道与安全设计（对照企业开发安全策略自查）：
 * - 清单与安装包都来自本仓 GitHub Releases（HTTPS 固定源，无用户数据外发——GET 零负载）；
 * - 安装包 sha256 与清单逐字节比对通过才允许进入替换阶段；
 * - 替换用 Windows 自带 tar（解压）+ robocopy /E（覆盖拷贝，绝不 /MIR——不删安装目录
 *   里用户自放的文件）；不写脚本策略绕过（.cmd + 内联 powershell 均不受 ExecutionPolicy
 *   限制），不枚举系统进程（固定 3s 延时 + robocopy /R 重试兜住主进程退出竞态）；
 * - 退出走 app.quit() 正常路径：before-quit 二段式先杀 PTY/CLI 进程树（v1.0.3 目录锁
 *   修复沿用），文件锁释放后 robocopy 才动手。
 *
 * 可测性：网络（fetchImpl）/文件系统落点（updateDir/tempDir）/spawn/quit 全注入。
 */

/** 最新版清单：GitHub「latest release」固定下载地址（无 API 限流；由 scripts/release.mjs 发布） */
export const LATEST_MANIFEST_URL =
  'https://github.com/liuhaitao720/claude-workbench/releases/latest/download/latest.json'
/** 更新说明唯一事实源：仓库根 CHANGELOG.md（raw 直读） */
export const CHANGELOG_URL =
  'https://raw.githubusercontent.com/liuhaitao720/claude-workbench/main/CHANGELOG.md'

const HTTP_TIMEOUT_MS = 8_000
const DOWNLOAD_TIMEOUT_MS = 600_000

export interface AppUpdateManifest {
  version: string
  /** portable zip 下载地址（GitHub Releases 资产） */
  url: string
  /** zip 的 sha256 hex（下载后逐字节校验） */
  sha256: string
  size?: number
  date?: string
}

export interface AppChangelogEntry {
  version: string
  items: string[]
}

export interface AppUpdateCheckResult {
  current: string
  latest: string
  upToDate: boolean
  /** 更新说明（current→latest 区间；已是最新时=当前版本段）。拉取失败为空数组 */
  notes: AppChangelogEntry[]
  manifestError?: string
  notesError?: string
}

export type AppUpdateProgressEvent =
  | { phase: 'downloading'; percent: number }
  | { phase: 'verifying' }
  | { phase: 'ready' }
  | { phase: 'installing' }
  | { phase: 'error'; error: string }

export interface AppUpdaterDeps {
  /** 注入测试替身；生产用全局 fetch */
  fetchImpl?: typeof fetch
  appVersion: string
  isPackaged: boolean
  execPath: string
  /** 下载与更新器脚本落点（生产=userData/updates；测试=临时目录） */
  updateDir: string
  /** 解压暂存目录（生产=系统 temp；测试=临时目录） */
  tempDir: string
  /** 结构化最小接口（生产=child_process.spawn detached；测试替身只需返回可 unref 句柄） */
  spawnImpl?: (cmd: string, args: readonly string[], opts: object) => { unref(): void }
  quit?: () => void
  onProgress?: (e: AppUpdateProgressEvent) => void
}

/**
 * 解析 CHANGELOG.md 为版本段列表（纯函数）。
 * 锚定语义：toInclusive 必须在文件中存在（不存在→空数组——锚不住就不展示）；
 * fromExclusive 存在 → 取 (from, to] 严格区间（文件序从新到旧）；from 为空或
 * 不在文件中 → 只取 to 段（已是最新时展示当前版本自身说明的用法）。
 * 防超大版本撑爆 UI：最多 10 个版本、每版 30 条、单条 280 字符截断。
 */
export function parseChangelog(
  md: string,
  fromExclusive: string,
  toInclusive: string
): AppChangelogEntry[] {
  const sections = new Map<string, string[]>()
  const lines = md.split('\n')
  let current: string | null = null
  for (const line of lines) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)\s*$/.exec(line.trim())
    if (h !== null) {
      current = h[1]
      sections.set(current, [])
      continue
    }
    if (current === null) continue
    const item = /^-\s+(.*)$/.exec(line.trim())
    if (item !== null) sections.get(current)!.push(item[1].slice(0, 280))
  }
  const versions = [...sections.keys()]
  const toIdx = versions.indexOf(toInclusive)
  if (toInclusive === '' || toIdx === -1) return []
  const fromIdx = fromExclusive === '' ? -1 : versions.indexOf(fromExclusive)
  // 文件序从新到旧：区间 = [toIdx, fromIdx)（from 段本身排除）；from 缺失 → 只取 to 段
  const end = fromIdx === -1 || fromIdx <= toIdx ? toIdx + 1 : fromIdx
  return versions
    .slice(toIdx, end)
    .slice(0, 10)
    .map((v) => ({ version: v, items: sections.get(v)!.slice(0, 30) }))
}

/** sha256 hex（小写）——下载完成后逐字节校验用 */
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 更换器脚本（.cmd）：等主进程退出 → tar 解压 → robocopy /E 覆盖 → 重启 exe → 清理。
 * 路径全部引号包裹（安装目录含空格安全）；不使用 /MIR（绝不删安装目录额外文件）。
 */
export function buildUpdaterCmd(params: {
  zipPath: string
  installDir: string
  exeName: string
  extractDir: string
  logPath: string
}): string {
  const { zipPath, installDir, exeName, extractDir, logPath } = params
  return [
    '@echo off',
    'timeout /t 3 /nobreak >nul',
    `tar -xf "${zipPath}" -C "${extractDir}" >>"${logPath}" 2>&1`,
    // portable zip 根目录是 win-unpacked（Compress-Archive 打包目录）；兼容将来扁平化打包
    `if exist "${extractDir}\\win-unpacked\\" (set "COPYFROM=${extractDir}\\win-unpacked") else (set "COPYFROM=${extractDir}")`,
    // /E 含子目录不删除目标多余文件；/R:5 /W:2 对主进程退出竞态兜底重试
    `robocopy "%COPYFROM%" "${installDir}" /E /R:5 /W:2 /NFL /NDL /NP >>"${logPath}" 2>&1`,
    `start "" "${installDir}\\${exeName}"`,
    `rd /s /q "${extractDir}" >>"${logPath}" 2>&1`,
    `del "${zipPath}" >>"${logPath}" 2>&1`,
    'exit /b 0'
  ].join('\r\n')
}

export class AppUpdater {
  private readonly fetchImpl: typeof fetch
  private readonly spawnImpl: NonNullable<AppUpdaterDeps['spawnImpl']>
  private readonly deps: AppUpdaterDeps
  private manifest: AppUpdateManifest | null = null
  private downloadedZip: string | null = null

  constructor(deps: AppUpdaterDeps) {
    this.deps = deps
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.spawnImpl = deps.spawnImpl ?? spawn
  }

  /** 检查更新：manifest（版本对比）+ CHANGELOG（更新说明）并行，各自独立降级 */
  async check(): Promise<AppUpdateCheckResult> {
    const current = this.deps.appVersion
    let manifest: AppUpdateManifest | null = null
    let manifestError = ''
    try {
      manifest = await this.fetchJson<AppUpdateManifest>(LATEST_MANIFEST_URL, HTTP_TIMEOUT_MS)
      if (typeof manifest.version !== 'string' || manifest.version === '') {
        manifest = null
        manifestError = '清单格式异常（无 version）'
      }
    } catch (err) {
      manifestError = err instanceof Error ? err.message : String(err)
    }
    this.manifest = manifest

    const latest = manifest?.version ?? ''
    const upToDate = current !== '' && latest !== '' && compareSemver(current, latest) >= 0

    let notes: AppChangelogEntry[] = []
    let notesError = ''
    try {
      const md = await this.fetchText(CHANGELOG_URL, HTTP_TIMEOUT_MS)
      // 已是最新 → 只取当前版本段（from='' 放开下界）；否则取 current→latest 区间
      notes = parseChangelog(md, upToDate ? '' : current, upToDate ? current : latest)
    } catch (err) {
      notesError = err instanceof Error ? err.message : String(err)
    }
    return {
      current,
      latest,
      upToDate,
      notes,
      ...(manifestError !== '' ? { manifestError } : {}),
      ...(notesError !== '' ? { notesError } : {})
    }
  }

  /** 下载安装包到 updateDir 并做 sha256 校验；进度经 onProgress 推送 */
  async download(): Promise<{ ok: boolean; error?: string }> {
    this.downloadedZip = null
    if (!this.manifest) return { ok: false, error: '尚未检查更新（无清单）' }
    if (!this.deps.isPackaged) return { ok: false, error: '开发模式运行，不支持自升级' }
    const m = this.manifest
    try {
      mkdirSync(this.deps.updateDir, { recursive: true })
      const res = await this.fetchImpl(m.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!res.ok || res.body === null) return { ok: false, error: `下载失败 HTTP ${res.status}` }
      const total = Number(res.headers.get('content-length') ?? m.size ?? 0)
      const zipPath = join(this.deps.updateDir, `Claude-Workbench-${m.version}-portable.zip`)
      const hash = createHash('sha256')
      const out = createWriteStream(zipPath)
      const reader = res.body.getReader()
      let received = 0
      let lastPercent = -1
      for (;;) {
        const { done, value } = await reader.read()
        if (done === true) break
        if (value === undefined) continue
        hash.update(value)
        out.write(value)
        received += value.byteLength
        const percent = total > 0 ? Math.floor((received / total) * 100) : -1
        if (percent >= 0 && percent !== lastPercent) {
          lastPercent = percent
          this.deps.onProgress?.({ phase: 'downloading', percent })
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
      this.deps.onProgress?.({ phase: 'verifying' })
      const actual = hash.digest('hex')
      if (actual.toLowerCase() !== m.sha256.toLowerCase()) {
        rmSync(zipPath, { force: true })
        return { ok: false, error: 'sha256 校验失败（下载损坏或被篡改）' }
      }
      if (total > 0 && received !== total) {
        // content-length 已知却不完整——同样视为损坏
        rmSync(zipPath, { force: true })
        return { ok: false, error: `下载不完整 ${received}/${total}` }
      }
      this.downloadedZip = zipPath
      this.deps.onProgress?.({ phase: 'ready' })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 退出并替换：写更新器脚本 → detached 启动（3s 后动手）→ app.quit() 正常退出
   * （before-quit 杀 PTY 树释放文件锁 → 更新器覆盖安装目录 → 重启新版）。
   */
  async install(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.isPackaged) return { ok: false, error: '开发模式运行，不支持自升级' }
    if (this.downloadedZip === null || !existsSync(this.downloadedZip)) {
      return { ok: false, error: '安装包未就绪（请先下载）' }
    }
    try {
      // 下载后安装目录未变（同机自更新），zip 存在即校验过；体积兜底防零字节文件
      if (statSync(this.downloadedZip).size === 0) return { ok: false, error: '安装包为空' }
      const extractDir = join(this.deps.tempDir, `cwb-update-${Date.now()}`)
      mkdirSync(extractDir, { recursive: true })
      const cmdPath = join(this.deps.updateDir, 'updater.cmd')
      const logPath = join(this.deps.updateDir, 'update.log')
      writeFileSync(
        cmdPath,
        buildUpdaterCmd({
          zipPath: this.downloadedZip,
          installDir: dirname(this.deps.execPath),
          exeName: basename(this.deps.execPath),
          extractDir,
          logPath
        }),
        'utf8'
      )
      this.deps.onProgress?.({ phase: 'installing' })
      const child = this.spawnImpl('cmd.exe', ['/c', cmdPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      this.deps.quit?.()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const text = await this.fetchText(url, timeoutMs)
    return JSON.parse(text) as T
  }

  private async fetchText(url: string, timeoutMs: number): Promise<string> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }
}
