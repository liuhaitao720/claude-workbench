import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compareSemver } from './claude-version'
import { translate } from '../shared/i18n'
import { mainLanguage } from './language'

/** v1.2.0 错误文案按当前界面语言（main 进程级语言） */
function tr(key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string {
  return translate(mainLanguage(), key, params)
}

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
  /** v1.2.1 自动升级：已下载就绪，正在等运行中的任务结束（count=当前运行任务数） */
  | { phase: 'waiting-tasks'; count: number }
  | { phase: 'installing' }
  | { phase: 'error'; error: string }
  /** v1.2.1 启动检查结果（含版本对比与更新说明；renderer 据此显示角标/说明，无需再自查一次） */
  | { phase: 'available'; info: AppUpdateCheckResult }

/** 自动升级轮询间隔（等待运行中任务结束；任务记录变更也会经 onTaskUpdate 触发） */
export const AUTO_INSTALL_POLL_MS = 5_000

/**
 * 启动后不立刻自动重启的宽限期（v1.2.1）：用户刚打开应用就开始升级、窗口一闪而过会
 * 让人以为应用崩了。下载通常要几十秒，实际上多数情况已超过本窗口；无任务且已过宽限期
 * 才退出替换。
 */
export const AUTO_INSTALL_GRACE_MS = 30_000

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
  /** 结构化最小接口（生产=child_process.spawn；测试替身只需返回可 unref 句柄） */
  spawnImpl?: (cmd: string, args: readonly string[], opts: object) => { unref(): void }
  quit?: () => void
  onProgress?: (e: AppUpdateProgressEvent) => void
  /** 运行中的任务数（v1.2.1 自动升级守卫：有任务在跑时不打断，等全部停止后自动继续） */
  runningCount?: () => number
  /** v1.2.1 自动升级开关来源（缺省读 settings.autoUpdate；false = 仅检查不下载） */
  autoUpdate?: () => boolean
  /** 等待运行任务结束的轮询间隔（测试注入小值） */
  autoInstallPollMs?: number
  /** 启动宽限期：应用刚打开时即使无任务也先等一会儿再自动重启（缺省 30s） */
  autoInstallGraceMs?: number
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
 * 更新器脚本（.cmd）：等主进程退出 → tar 解压 → robocopy /E 覆盖 → 重启 exe → 清理。
 * 路径全部引号包裹（安装目录含空格安全）；不使用 /MIR（绝不删安装目录额外文件）。
 *
 * v1.2.1：脚本自身不留痕——结束前删掉 .cmd 与 .vbs 启动垫片（只保留 update.log 取证）。
 */
export function buildUpdaterCmd(params: {
  zipPath: string
  installDir: string
  exeName: string
  extractDir: string
  logPath: string
  /** 启动垫片 .vbs 路径（v1.2.1；缺省不生成删除行——保持旧签名兼容） */
  launcherPath?: string
}): string {
  const { zipPath, installDir, exeName, extractDir, logPath, launcherPath } = params
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
    ...(launcherPath !== undefined ? [`del "${launcherPath}" >>"${logPath}" 2>&1`] : []),
    // 自删：cmd 正在执行本文件时 Windows 允许删除（句柄已随批处理读入释放），失败无碍
    `del "%~f0" >>"${logPath}" 2>&1`,
    'exit /b 0'
  ].join('\r\n')
}

/**
 * 静默启动垫片（.vbs，v1.2.1）——修「自升级后残留 cmd 窗口」：
 *
 * 根因：Node 在 Windows 上 detached:true 与 windowsHide:true 同时给时，CreateProcess
 * 拿到的 CREATE_NO_WINDOW 会被 DETACHED_PROCESS 忽略（两者互斥），于是 cmd.exe 带着
 * 自己的可见控制台窗口跑 updater.cmd（updater 跨主进程退出存活，这个过程常驻数十秒）。
 *
 * 做法：改由 wscript.exe（GUI 子系统，本身无控制台）以 `sh.Run <cmd>, 0, False`
 * 隐藏窗口异步拉起 updater.cmd。垫片内容纯 ASCII、路径经命令行参数传入（Node 以
 * UTF-16 传参，中文用户名路径不会损坏），不拼接任何外部输入。
 */
export function buildUpdaterLauncher(): string {
  return [
    "' Claude Workbench updater launcher (v1.2.1)",
    "' Usage: wscript.exe //nologo updater-launch.vbs \"<abs path to updater.cmd>\"",
    "' Window style 0 = hidden; third arg False = do not wait (updater waits for the app to exit)",
    'Dim sh, target',
    'Set sh = CreateObject("WScript.Shell")',
    'target = WScript.Arguments(0)',
    'sh.Run """" & target & """", 0, False'
  ].join('\r\n')
}

export class AppUpdater {
  private readonly fetchImpl: typeof fetch
  private readonly spawnImpl: NonNullable<AppUpdaterDeps['spawnImpl']>
  private readonly deps: AppUpdaterDeps
  private manifest: AppUpdateManifest | null = null
  private downloadedZip: string | null = null
  /** v1.2.1 最近一次检查结果（renderer 经 IPC 读，避免启动时重复请求清单/CHANGELOG） */
  private lastInfo: AppUpdateCheckResult | null = null
  /** v1.2.1 自动升级：轮次进行中 / 安装已交给更新器（防重复触发） */
  private autoRunning = false
  private installStarted = false
  /** 下载就绪、等运行中任务结束后自动安装 */
  private pendingInstall = false
  private pollTimer: NodeJS.Timeout | null = null
  /** 上次广播的等待计数（同计数不重复推送，见 tryAutoInstall） */
  private lastWaitingCount = -1
  /** 进行中的检查（并发去重；见 checkAppUpdate） */
  private inflight: Promise<AppUpdateCheckResult> | null = null
  /** 自动升级流程启动时刻（宽限期基准；0=未启动） */
  private autoStartedAt = 0

  constructor(deps: AppUpdaterDeps) {
    this.deps = deps
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.spawnImpl = deps.spawnImpl ?? spawn
  }

  /**
   * v1.2.1 自动升级（用户要求「无需手动点击按钮」）：
   * 检查 → 有新版本则后台下载校验 → 等运行中的任务全部结束后自动退出替换重启。
   *
   * 为什么等任务：自动重启会终止 PTY 会话，正在跑的任务会被打断。产品取舍是
   * 不打断工作——任务一结束就自动升级；期间 UI 显示「等待 N 个任务结束」。
   * autoUpdate()=false 时整个自动路径不启动（用户仍可手动检查/下载）。
   */
  async runAutoUpdate(): Promise<void> {
    if (this.autoRunning || this.installStarted) return
    if (!this.deps.isPackaged) return // 开发运行不自升级
    if (this.deps.autoUpdate !== undefined && !this.deps.autoUpdate()) return
    this.autoRunning = true
    if (this.autoStartedAt === 0) this.autoStartedAt = Date.now()
    try {
      const info = await this.checkAndCache()
      if (info.upToDate || info.latest === '') return
      // 先让界面拿到版本+说明（侧栏角标/设置中心「更新说明」立即有内容）
      this.deps.onProgress?.({ phase: 'available', info })
      if (this.downloadedZip === null) {
        const r = await this.download()
        if (!r.ok) return // 下载/校验失败：静默降级，设置中心可手动重试
      }
      this.pendingInstall = true
      this.tryAutoInstall()
    } finally {
      this.autoRunning = false
    }
  }

  /**
   * 就绪后尝试安装：无运行中任务且过了启动宽限期 → 立即退出替换；否则广播等待态并轮询。
   * 任务记录变更（onTaskUpdate）也会调用本方法，所以最后一条任务停下能立即续上。
   */
  tryAutoInstall(): void {
    if (!this.pendingInstall || this.installStarted) return
    const running = this.deps.runningCount?.() ?? 0
    const graceLeft = this.graceRemaining()
    if (running > 0 || graceLeft > 0) {
      // 去重：任务记录每次变更都会调到本方法，同计数不重复广播。
      // 只在真有运行任务时广播——宽限期内等 0 个任务不算「等待任务」，界面别显示
      // 「等待 0 个任务结束」这种读不懂的状态。
      if (running === 0) {
        // 任务跑完了但还在宽限期：把界面从「等待 N 个任务」退回「已就绪」
        if (this.lastWaitingCount > 0) {
          this.lastWaitingCount = 0
          this.deps.onProgress?.({ phase: 'ready' })
        }
      } else if (this.lastWaitingCount !== running) {
        this.lastWaitingCount = running
        this.deps.onProgress?.({ phase: 'waiting-tasks', count: running })
      }
      if (this.pollTimer === null) {
        // 有任务时按固定间隔轮询；仅剩宽限期则精确到剩余毫秒
        const pollMs = this.deps.autoInstallPollMs ?? AUTO_INSTALL_POLL_MS
        const delay = running > 0 ? pollMs : Math.min(graceLeft, pollMs)
        const timer = setTimeout(() => {
          this.pollTimer = null
          this.tryAutoInstall()
        }, Math.max(50, delay))
        timer.unref?.()
        this.pollTimer = timer
      }
      return
    }
    this.clearPoll()
    this.pendingInstall = false
    this.installStarted = true
    void this.install()
  }

  /** 距「允许自动重启」还剩多少毫秒（宽限期从自动升级流程启动算起） */
  private graceRemaining(): number {
    if (this.autoStartedAt === 0) return 0
    const grace = this.deps.autoInstallGraceMs ?? AUTO_INSTALL_GRACE_MS
    return Math.max(0, this.autoStartedAt + grace - Date.now())
  }

  /** 取消挂起的自动安装（用户关掉自动升级开关时由组合根调用） */
  cancelAutoInstall(): void {
    this.pendingInstall = false
    this.lastWaitingCount = -1
    this.clearPoll()
  }

  /**
   * 手动下载完成后的续接（v1.2.1）：自动升级开启时同样无需再点「立即升级」——
   * 交给与自动路径相同的守卫（有运行任务则等，宽限期后退出替换）。
   * 自动升级关闭时不接管（尊重「我要手动决定何时重启」的选择）。
   */
  continueAfterManualDownload(): void {
    if (this.installStarted) return
    if (this.deps.autoUpdate !== undefined && !this.deps.autoUpdate()) return
    if (this.deps.runningCount === undefined) return
    if (this.autoStartedAt === 0) this.autoStartedAt = Date.now()
    this.pendingInstall = true
    this.tryAutoInstall()
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
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
        manifestError = tr('appUpd.errManifestNoVersion')
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

  /** 最近一次检查结果（null=本次启动尚未检查）；供 renderer 启动时直接取用 */
  cachedInfo(): AppUpdateCheckResult | null {
    return this.lastInfo
  }

  /**
   * 检查（带缓存与并发去重）：
   * - force=true（设置中心手动点「检查更新」）→ 总是重新请求
   * - 非强制：已有结果直接返回；正在检查则复用同一个 promise（启动自动检查与
   *   renderer 启动自查往往同时发生，不该打两次网络）
   */
  async checkAppUpdate(force = false): Promise<AppUpdateCheckResult> {
    if (!force && this.lastInfo !== null) return this.lastInfo
    if (this.inflight !== null) return this.inflight
    const p = this.check().then((info) => {
      this.lastInfo = info
      this.inflight = null
      return info
    })
    this.inflight = p
    return p
  }

  /** 检查并缓存（自动升级用；与 checkAppUpdate 同一去重链） */
  async checkAndCache(): Promise<AppUpdateCheckResult> {
    return this.checkAppUpdate(false)
  }

  /** 下载安装包到 updateDir 并做 sha256 校验；进度经 onProgress 推送。
   *  v1.2.1：已下载并校验过的包直接复用（自动升级已下好，用户手动点下载不再重复拉 185MB）。 */
  async download(): Promise<{ ok: boolean; error?: string }> {
    if (this.downloadedZip !== null && existsSync(this.downloadedZip)) return { ok: true }
    this.downloadedZip = null
    if (!this.manifest) return { ok: false, error: tr('appUpd.errNoManifest') }
    if (!this.deps.isPackaged) return { ok: false, error: tr('appUpd.errDevMode') }
    const m = this.manifest
    try {
      mkdirSync(this.deps.updateDir, { recursive: true })
      const res = await this.fetchImpl(m.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!res.ok || res.body === null) {
        return { ok: false, error: tr('appUpd.errHttp', { status: res.status }) }
      }
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
        return { ok: false, error: tr('appUpd.errSha') }
      }
      if (total > 0 && received !== total) {
        // content-length 已知却不完整——同样视为损坏
        rmSync(zipPath, { force: true })
        return { ok: false, error: tr('appUpd.errIncomplete', { received, total }) }
      }
      this.downloadedZip = zipPath
      this.deps.onProgress?.({ phase: 'ready' })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 退出并替换：写更新器脚本 + 静默启动垫片 → 经 wscript 隐藏拉起 → app.quit() 正常退出
   * （before-quit 杀 PTY 树释放文件锁 → 更新器覆盖安装目录 → 重启新版）。
   *
   * v1.2.1 两处修正（用户反馈「升级成功后还有 2 个 cmd 窗口没关」）：
   * 1) 不再 detached+windowsHide 直起 cmd.exe（两者互斥，隐藏标志被忽略 → 可见黑窗）；
   *    改由 wscript.exe 以 0 号窗口样式异步拉起，全程无控制台；
   * 2) 更新器脚本收尾自删 .cmd/.vbs，不留下可再次误触的脚本。
   */
  async install(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.isPackaged) return { ok: false, error: tr('appUpd.errDevMode') }
    if (this.downloadedZip === null || !existsSync(this.downloadedZip)) {
      return { ok: false, error: tr('appUpd.errPackageMissing') }
    }
    try {
      // 下载后安装目录未变（同机自更新），zip 存在即校验过；体积兜底防零字节文件
      if (statSync(this.downloadedZip).size === 0) return { ok: false, error: tr('appUpd.errPackageEmpty') }
      const extractDir = join(this.deps.tempDir, `cwb-update-${Date.now()}`)
      mkdirSync(extractDir, { recursive: true })
      const cmdPath = join(this.deps.updateDir, 'updater.cmd')
      const vbsPath = join(this.deps.updateDir, 'updater-launch.vbs')
      const logPath = join(this.deps.updateDir, 'update.log')
      writeFileSync(
        cmdPath,
        buildUpdaterCmd({
          zipPath: this.downloadedZip,
          installDir: dirname(this.deps.execPath),
          exeName: basename(this.deps.execPath),
          extractDir,
          logPath,
          launcherPath: vbsPath
        }),
        'utf8'
      )
      writeFileSync(vbsPath, buildUpdaterLauncher(), 'ascii')
      this.deps.onProgress?.({ phase: 'installing' })
      // wscript：GUI 子系统无控制台；隐藏窗口异步执行，主进程随后正常退出
      const child = this.spawnImpl(
        'wscript.exe',
        ['//nologo', vbsPath, cmdPath],
        { detached: true, stdio: 'ignore' }
      )
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
