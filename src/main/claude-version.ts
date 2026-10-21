import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CliRunner } from './cli-runner'
import { invalidateClaudePathCache, resolveClaudeCommand } from './pty-manager'

const execFileAsync = promisify(execFile)

/**
 * v0.5⑤+5.1 claude CLI 版本信息 / 检查更新 / 未安装下载安装（main 侧）。
 *
 * 版本探测复刻 main.ts 冒烟先例：execFileAsync cmd.exe /c <claudeCmd> --version，
 * 20s 超时、失败不崩（version=''——契约语义「未安装」）。
 * resolveClaudeCommand 失败回退 'claude' 字符串：无 where 命中且 version 探测
 * 也失败 = 未安装（渲染层据 version==='' 显示「未安装」+下载安装入口）。
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

/** 当前 claude CLI 版本+实际解析路径；探测失败 version=''（=未安装） */
export async function getClaudeVersionInfo(): Promise<ClaudeVersionInfo> {
  if (versionInfoCache !== null) return { ...versionInfoCache }
  const claudeCmd = await resolveClaudeCommand()
  let version = ''
  try {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', claudeCmd, '--version'], {
      timeout: PROBE_TIMEOUT_MS
    })
    version = extractSemver(stdout.trim()) // 修剪为纯 semver（与 checkClaudeUpdate 一致；实测修正：原返回 '2.1.301 (Claude Code)' 原文）
  } catch {
    version = '' // 失败不崩（未安装/超时/崩溃输出均归一为空）
  }
  versionInfoCache = { version, path: claudeCmd }
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
