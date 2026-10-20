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

/** 当前 claude CLI 版本+实际解析路径；探测失败 version=''（=未安装） */
export async function getClaudeVersionInfo(): Promise<ClaudeVersionInfo> {
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
  return { version, path: claudeCmd }
}

/** 检查更新：npm registry latest 对比当前；无 npm/探测失败 → degraded（提示走 claude update） */
export async function checkClaudeUpdate(): Promise<ClaudeUpdateInfo> {
  const info = await getClaudeVersionInfo()
  const current = extractSemver(info.version)
  let latest = ''
  let degraded = false
  try {
    const { stdout } = await execFileAsync('cmd.exe', [...NPM_VIEW_ARGS], { timeout: PROBE_TIMEOUT_MS })
    latest = extractSemver(stdout.trim())
    if (latest === '') degraded = true // 解析失败不崩：降级提示
  } catch {
    degraded = true // 无 npm（探测失败）→ 走 claude update 提示
  }
  return {
    current,
    latest,
    upToDate: current !== '' && latest !== '' && current === latest,
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
  runner.onceExit(commandId, () => invalidateClaudePathCache())
  return { commandId }
}
