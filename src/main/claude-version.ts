import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { CliRunner } from './cli-runner'
import { invalidateClaudePathCache, resolveClaudeCandidates } from './pty-manager'
import { parseChangelog } from './app-updater'
import type { AppChangelogEntry } from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * v0.5⑤+5.1 claude CLI 版本信息 / 检查更新 / 未安装下载安装（main 侧）。
 *
 * 版本探测复刻 main.ts 冒烟先例：execFileAsync cmd.exe /c <claudeCmd> --version，
 * 失败不崩（version=''——契约语义「未安装」）。
 * v1.0.6 两项加固（用户报告「明明装了却显示未安装」）：
 * 1) 多候选回退：resolveClaudeCandidates 返回 where 全命中（npm 垫片、WinGet
 *    claude.exe…）+ 'claude' PATH 兜底，逐个探测取第一个能跑通 --version 的；
 * 2) 失败不缓存：冷启动 --version 超 20s（Defender 扫新解压 exe 等）曾被
 *    永久缓存为「未安装」钉死整个会话——现在只有成功才进 versionInfoCache，
 *    重开弹窗即重试。
 * 每候选 8s 超时（实测热跑 ~0.7s；原 20s 单候选在多候选下总时长失控）。
 *
 * 安装为固定模板（编译期常量，不经 runCliCommand 白名单面——评审 R4/T9）：
 * - native：官方安装器（PowerShell 内存执行，不写盘；不加 -ExecutionPolicy Bypass）
 * - npm：npm.cmd 经 cmd.exe 包装（npm 在 Windows 是 npm.cmd，CreateProcess 不能直接解析）
 * 完成后失效 claudePathCache 刷新 About（onceExit 钩子）。
 */

export interface ClaudeVersionInfo {
  version: string
  path: string
}

export interface ClaudeUpdateInfo {
  current: string
  latest: string
  upToDate: boolean
  /** true=无 npm 环境/探测失败（渲染层提示走 claude update） */
  degraded?: boolean
}

/** 官方原生安装器模板（v0.5⑤ 评审 R5/S2：域名硬编码白名单仅 claude.ai；-NoProfile 不加 ExecutionPolicy Bypass） */
export const NATIVE_INSTALL_FILE = 'powershell.exe'
export const NATIVE_INSTALL_ARGS: readonly string[] = [
  '-NoProfile',
  '-Command',
  'irm https://claude.ai/install.ps1 | iex'
]

/** npm 安装模板（npm 是 npm.cmd，须经 cmd.exe /c 包装） */
export const NPM_INSTALL_FILE = 'cmd.exe'
export const NPM_INSTALL_ARGS: readonly string[] = ['/c', 'npm', 'install', '-g', '@anthropic-ai/claude-code']

/** npm registry 查询模板 */
const NPM_VIEW_ARGS: readonly string[] = ['/c', 'npm', 'view', '@anthropic-ai/claude-code', 'version']

const PROBE_TIMEOUT_MS = 20_000
/** v1.0.6 每候选 --version 超时（热跑 ~0.7s；多候选循环下 20s 单值总时长失控） */
const VERSION_TIMEOUT_MS = 8_000

/** 从版本输出提取 semver（如 "2.1.301 (Claude Code)" → "2.1.301"） */
export function extractSemver(text: string): string {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? ''
}

/** 数字 semver 比较（v1.0：字符串相等对尾随空白/预发布号脆弱——逐段数值比） */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** 版本探测结果缓存（v1.0.1：弹窗每次打开不再重复 spawn claude --version——实测 0.7s/次） */
let versionInfoCache: ClaudeVersionInfo | null = null

/** 失效版本缓存（安装/更新完成后由 installClaudeCli 钩子调用） */
export function invalidateVersionCache(): void {
  versionInfoCache = null
}

/** 探测依赖缝（测试注入假 spawn/假杀树；生产走 node:child_process） */
export interface VersionProbeDeps {
  spawnImpl?: typeof spawn
  /** 定点杀进程树（按记录的 pid；默认 taskkill /T /F——不枚举进程） */
  killTree?: (pid: number) => void
  /** 输出静默观察窗口（默认 PROBE_QUIET_MS；测试注入小值提速） */
  quietMs?: number
  /** 硬超时（默认 VERSION_TIMEOUT_MS） */
  timeoutMs?: number
}

/** 拿到版本串后的静默窗口：期间再无输出即认定「版本已完整」，立即收尾 */
const PROBE_QUIET_MS = 800

/** 定点杀进程树（no-process-detect：只按记录的 pid 杀，不做进程枚举） */
function killTreeDefault(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程已退出/权限不足——尽力而为，不阻断探测结果
  }
}

/**
 * v1.1.0 版本探测（用户报告「claude CLI 的版本检测失败」根因修复）：
 * `cmd.exe /c claude.cmd --version` 存在「输出已到、壳进程不退出」的现象
 * （本机实测 12 次中 3~5 次，版本串 ~160ms 即到而 cmd 壳残留不退出）。
 * 原实现用 execFile({timeout}) ——超时即抛错，把**已经拿到的 stdout 一并丢弃**，
 * 该候选判负；候选表与实际是同一 exe 时全灭 → 误报「未安装」。
 *
 * 现实现：spawn 流式累积 stdout，一旦 extractSemver 命中且输出静默 PROBE_QUIET_MS
 * 即认定成功，立即定点杀进程树并返回（不等壳进程自然退出）；超时/关闭路径仍用
 * 已累积输出兜底解析。stdin 给 'ignore'（立刻 EOF，排除等待输入）。
 */
export function probeClaudeVersion(candidate: string, deps: VersionProbeDeps = {}): Promise<string> {
  const spawnImpl = deps.spawnImpl ?? spawn
  const killTree = deps.killTree ?? killTreeDefault
  const quietMs = deps.quietMs ?? PROBE_QUIET_MS
  const timeoutMs = deps.timeoutMs ?? VERSION_TIMEOUT_MS
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let exited = false
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let hardTimer: ReturnType<typeof setTimeout> | null = null
    let child: ReturnType<typeof spawn> | undefined

    const clearTimers = (): void => {
      if (quietTimer !== null) clearTimeout(quietTimer)
      if (hardTimer !== null) clearTimeout(hardTimer)
    }
    const finish = (version: string): void => {
      if (settled) return
      settled = true
      clearTimers()
      // 只在壳进程仍未退出时定点杀树——已退出的 pid 可能被复用，绝不误杀
      if (!exited && child?.pid !== undefined) killTree(child.pid)
      resolve(version)
    }

    try {
      child = spawnImpl('cmd.exe', ['/c', candidate, '--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve('')
      return
    }

    hardTimer = setTimeout(() => finish(extractSemver(out)), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += chunk.toString()
      const v = extractSemver(out)
      if (v === '') return
      // 有版本串后保一段静默观察期：期间再有输出就顺延，确保拿到完整串而非截断
      if (quietTimer !== null) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(extractSemver(out)), quietMs)
    })
    child.on('error', () => {
      exited = true
      finish(extractSemver(out))
    })
    child.on('close', () => {
      exited = true
      finish(extractSemver(out))
    })
  })
}

/** 当前 claude CLI 版本+实际解析路径；探测失败 version=''（=未安装） */
export async function getClaudeVersionInfo(deps: VersionProbeDeps = {}): Promise<ClaudeVersionInfo> {
  if (versionInfoCache !== null) return { ...versionInfoCache }
  const candidates = await resolveClaudeCandidates()
  let version = ''
  let okPath = candidates[0] ?? 'claude'
  for (const cand of candidates) {
    const v = await probeClaudeVersion(cand, deps)
    if (v !== '') {
      version = v
      okPath = cand
      break
    }
  }
  if (version === '') {
    // v1.0.6：失败不缓存——重开弹窗即重试（原实现把「未安装」钉死整个会话）
    return { version, path: okPath }
  }
  versionInfoCache = { version, path: okPath }
  return { ...versionInfoCache }
}

/**
 * v1.0.1 检查更新提速（实测：npm view CLI 16.2s vs registry HTTP 0.4s——40 倍）：
 * 直接 HTTPS 请求 registry latest（registry 地址从 ~/.npmrc 读取，缺省 npmjs）；
 * fetch 失败回退 npm view CLI（保留原降级链）。
 */
const REGISTRY_HTTP_TIMEOUT_MS = 8_000

/** 从 npmrc（home 优先于项目）解析 registry 地址；无配置回 npmjs 缺省 */
export function resolveNpmRegistry(homeDir: string, npmrcText: string | null): string {
  const m = /^registry\s*=\s*(\S+)\s*$/m.exec(npmrcText ?? '')
  if (m !== null) return m[1].replace(/\/$/, '')
  void homeDir
  return 'https://registry.npmjs.org'
}

export async function fetchLatestFromRegistry(): Promise<string> {
  const { homedir } = await import('node:os')
  const { readFileSync } = await import('node:fs')
  let npmrcText: string | null = null
  try {
    npmrcText = readFileSync(`${homedir()}/.npmrc`, 'utf8')
  } catch {
    // 无用户 npmrc → 缺省 registry
  }
  const registry = resolveNpmRegistry(homedir(), npmrcText)
  const res = await fetch(`${registry}/@anthropic-ai/claude-code/latest`, {
    signal: AbortSignal.timeout(REGISTRY_HTTP_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
  const json: unknown = await res.json()
  const version = (json as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') throw new Error('registry 响应无 version')
  return version
}

/** 检查更新：registry latest（HTTP 直连优先，npm view 兜底）对比当前；双路失败 → degraded */
export async function checkClaudeUpdate(): Promise<ClaudeUpdateInfo> {
  const info = await getClaudeVersionInfo()
  const current = extractSemver(info.version)
  let latest = ''
  let degraded = false
  try {
    latest = extractSemver((await fetchLatestFromRegistry()).replace(/^﻿/, ''))
  } catch {
    // HTTP 直连失败（代理/网络策略）→ 回退 npm view CLI（慢但可能走通代理链）
    try {
      const { stdout } = await execFileAsync('cmd.exe', [...NPM_VIEW_ARGS], { timeout: PROBE_TIMEOUT_MS })
      latest = extractSemver(stdout.replace(/^﻿/, '').trim())
    } catch {
      degraded = true
    }
  }
  if (latest === '') degraded = true
  return {
    current,
    latest,
    upToDate: current !== '' && latest !== '' && compareSemver(current, latest) >= 0,
    ...(degraded ? { degraded: true } : {})
  }
}

// ── v1.1.0 claude CLI 更新说明（用户需求：检查更新时看到新版 changelog）──────

/** 主源：官方仓库 CHANGELOG.md（raw 直读；~1.1MB 全量但支持 Range——头部即最新版本） */
export const CLAUDE_CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
/** 兜底：GitHub Releases atom（最近 10 个 release；raw 域被网络策略拦时 github.com 或仍可达） */
export const CLAUDE_RELEASES_ATOM_URL = 'https://github.com/anthropics/claude-code/releases.atom'
/** 只请求外部公开内容的 GET（零负载、无凭据）——Range 头部 256KB 覆盖约 45 个版本 */
const CHANGELOG_RANGE_BYTES = 262_144
const CHANGELOG_HTTP_TIMEOUT_MS = 8_000

export interface ClaudeChangelogResult {
  /** (current, latest] 区间条目（已是最新=当前版本段）；两路都失败为空数组 */
  notes: AppChangelogEntry[]
  error?: string
}

/** atom 条目 → 更新说明条目（content 是「XML 转义后的 HTML」：需两趟解实体 → 取 <li> → 去标签） */
export function atomToEntries(xml: string, fromExclusive: string, toInclusive: string): AppChangelogEntry[] {
  const out: AppChangelogEntry[] = []
  const unescapeOnce = (s: string): string =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  // 两趟：XML 层（&amp;lt; → &lt;）+ HTML 层（&lt; → <）；&amp;amp; 亦经两趟还原为 &
  const unescape = (s: string): string => unescapeOnce(unescapeOnce(s))
  for (const m of xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const title = /<title>v?(\d+\.\d+\.\d+)<\/title>/.exec(m[0])
    if (title === null) continue
    const v = title[1]
    if (toInclusive === '' || compareSemver(v, toInclusive) > 0) continue
    if (fromExclusive !== '' && compareSemver(v, fromExclusive) <= 0) continue
    if (out.length >= 10) break
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(m[0])?.[1] ?? ''
    const items = [...unescape(content).matchAll(/<li>([\s\S]*?)<\/li>/g)]
      .map((li) => li[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 280))
      .filter((s) => s !== '')
      .slice(0, 30)
    out.push({ version: v, items })
  }
  return out
}

/**
 * 拉取 claude CLI 更新说明：raw CHANGELOG（Range 头部请求）→ 失败回退 releases.atom →
 * 双路失败降级返回 error。解析复用 app-updater.parseChangelog（同样的 `## <version>` 段格式
 * 与区间语义；覆盖不到 from 版本时锚定到只展示 latest 段）。
 */
export async function fetchClaudeChangelog(
  current: string,
  latest: string,
  fetchImpl: typeof fetch = fetch
): Promise<ClaudeChangelogResult> {
  let primaryError = ''
  try {
    const res = await fetchImpl(CLAUDE_CHANGELOG_URL, {
      headers: { Range: `bytes=0-${CHANGELOG_RANGE_BYTES - 1}` },
      signal: AbortSignal.timeout(CHANGELOG_HTTP_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = await res.text()
    return { notes: parseChangelog(md, current, latest) }
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err)
  }
  try {
    const res = await fetchImpl(CLAUDE_RELEASES_ATOM_URL, {
      signal: AbortSignal.timeout(CHANGELOG_HTTP_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { notes: atomToEntries(await res.text(), current, latest) }
  } catch (err) {
    return {
      notes: [],
      error: `${primaryError}；atom 兜底 ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 下载安装 claude CLI：固定模板经 CliRunner 执行（输出走 onCliOutput 事件流）；完成钩子失效路径缓存 */
export async function installClaudeCli(
  runner: CliRunner,
  method: 'native' | 'npm'
): Promise<{ commandId: string }> {
  const [file, args] =
    method === 'native' ? [NATIVE_INSTALL_FILE, NATIVE_INSTALL_ARGS] : [NPM_INSTALL_FILE, NPM_INSTALL_ARGS]
  const { commandId } = await runner.spawnFixed(file, [...args])
  // 完成后（无论成败）失效 claudePathCache——安装成功即重新解析路径，失败重解析亦无害
  runner.onceExit(commandId, () => {
    invalidateClaudePathCache()
    invalidateVersionCache() // v1.0.1：安装/更新后下次探测取新版本
  })
  return { commandId }
}
