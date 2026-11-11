import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * v1.3 平台策略收敛缝（Ubuntu 适配）：where/which、杀进程树、claude 安装/查询模板、
 * 版本探测命令形态在此按 process.platform 分流——Windows 分支逐字节保持既有行为
 * （含 cmd.exe /c 包装与 chcp 65001 前缀），Linux 分支为直 execvp 无壳形态。
 *
 * 本模块不 import 任何业务模块（防 pty-manager ↔ platform 循环依赖——
 * pickClaudePaths 自 pty-manager 迁入此处，pty-manager re-export 保 import 面）。
 * 平台分支的可测内部（xxxFor(platform, ...)）供单测在任意宿主平台覆盖双分支；
 * 无参导出绑定运行时 process.platform。
 */

export const IS_WIN = process.platform === 'win32'
export const IS_LINUX = process.platform === 'linux'

type Platform = string

// ── claude 候选解析（where/which 多命中 → 有序可执行列表）─────────────────

/** win 分支与迁入前 pty-manager 逐字节一致；linux 认无扩展名 claude（npm sh 垫片/官方安装器形态） */
export function pickClaudePathsFor(platform: Platform, candidates: string[]): string[] {
  const lines = candidates.map((l) => l.trim()).filter((l) => l.length > 0)
  if (platform !== 'win32') {
    return [...new Set(lines.filter((l) => /(^|\/)claude$/.test(l)))]
  }
  const runnables = lines.filter((l) => /claude\.(cmd|exe|bat)$/i.test(l))
  const npmCmd = runnables.find((l) => /npm[/\\]claude\.cmd$/i.test(l))
  const ordered = [...(npmCmd !== undefined ? [npmCmd] : []), ...runnables.filter((l) => l !== npmCmd)]
  return [...new Set(ordered)]
}

/**
 * v1.0.6 where 多命中 → cmd 可执行候选列表（npm claude.cmd 优先，其余
 * .cmd/.exe/.bat 按 where 顺序，去重）：本机 where 实测会同时命中 npm 垫片、
 * WinGet Links 的 claude.exe 等；探测/回退需要整个有序列表而非单个。
 * 无扩展名的 npm\claude（sh 垫片）与 .ps1 不入列——cmd.exe 跑不了。
 * v1.3 Linux：无扩展名可执行（npm 装的 prefix/bin/claude、官方 ~/.local/bin/claude）。
 */
export function pickClaudePaths(candidates: string[]): string[] {
  return pickClaudePathsFor(process.platform, candidates)
}

// ── Linux PATH 发现（桌面会话不继承 nvm/fnm/volta 的登录 PATH——最高频翻车点）──

/** 登录 shell 才有的 PATH 目录（bash -lc 探测；超时/无 bash 回空——nvm/fnm 等在此注入） */
async function loginShellPathDirs(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('bash', ['-l', '-c', 'printf %s "$PATH"'], { timeout: 5_000 })
    return stdout.split(pathDelimiter).filter((d) => d.length > 0)
  } catch {
    return []
  }
}

/** 常见 claude/node 安装目录（存在性过滤；nvm 逐版本枚举） */
function knownInstallDirs(): string[] {
  const home = homedir()
  const dirs = [
    join(home, '.local', 'bin'), // 官方安装器默认落点
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin'
  ]
  // nvm：~/.nvm/versions/node/<ver>/bin 逐版本入列（claude/npm 都在版本 bin 下）
  const nvmBase = join(home, '.nvm', 'versions', 'node')
  try {
    for (const v of readdirSync(nvmBase)) dirs.push(join(nvmBase, v, 'bin'))
  } catch {
    // 未装 nvm
  }
  return dirs.filter((d) => {
    try {
      return existsSync(d)
    } catch {
      return false
    }
  })
}

/** PATH 去重保序（首个出现位置优先） */
function dedupeDirs(dirs: string[]): string[] {
  return [...new Set(dirs.map((d) => d.replace(/[\\/]+$/, '')))]
}

/** Linux 发现结果缓存（与 claudePathCache 同生命周期：invalidateClaudePathCache 一并失效） */
let linuxExtraPathCache: string[] | null = null

/** 登录 PATH + 常见安装目录中，进程 env.PATH 之外的新增目录（缓存） */
async function linuxExtraPathDirs(): Promise<string[]> {
  if (linuxExtraPathCache !== null) return linuxExtraPathCache
  const own = new Set((process.env['PATH'] ?? '').split(pathDelimiter).filter((d) => d.length > 0))
  const merged = dedupeDirs([...(await loginShellPathDirs()), ...knownInstallDirs()])
  linuxExtraPathCache = merged.filter((d) => !own.has(d))
  return linuxExtraPathCache
}

/** 失效 PATH 发现缓存（安装完成重解析用） */
export function invalidatePlatformDiscovery(): void {
  linuxExtraPathCache = null
}

/** 把发现的增量 PATH 前置合并进子进程 env（Linux/无壳 execvp 语义必需：claude 的
 *  `#!/usr/bin/env node` shebang 与裸名回退都要在这份 PATH 里找得到 node 与 claude）。
 *  无增量/非 Linux 时 no-op（Windows env 逐字节不变）。 */
export function mergeAugmentedPath(env: Record<string, string>): void {
  if (IS_WIN || linuxExtraPathCache === null || linuxExtraPathCache.length === 0) return
  const base = (env['PATH'] ?? '').split(pathDelimiter).filter((d) => d.length > 0)
  env['PATH'] = dedupeDirs([...linuxExtraPathCache, ...base]).join(pathDelimiter)
}

// ── claude 候选列表（where/which 统一入口）────────────────────────────────

/**
 * claude 可执行候选（win：where claude + pickClaudePaths，与 v1.0.6 行为一致；
 * linux：以「登录 PATH + 常见安装目录 + 进程 PATH」合成搜索 PATH 跑 which -a，
 * 结果为绝对路径列表；同时缓存增量目录供 mergeAugmentedPath 注入子进程 env）。
 * 失败回 []（调用方自行回退裸 'claude' 交 PTY/execvp 按 PATH 解析）。
 */
export async function listClaudeCandidates(): Promise<string[]> {
  if (IS_WIN) {
    try {
      const { stdout } = await execFileAsync('where', ['claude'])
      return pickClaudePaths(stdout.split(/\r?\n/))
    } catch {
      return []
    }
  }
  if (!IS_LINUX) return []
  const extra = await linuxExtraPathDirs()
  const searchPath = dedupeDirs([
    ...extra,
    ...(process.env['PATH'] ?? '').split(pathDelimiter).filter((d) => d.length > 0)
  ]).join(pathDelimiter)
  try {
    const { stdout } = await execFileAsync('which', ['-a', 'claude'], {
      env: { ...process.env, PATH: searchPath },
      timeout: 5_000
    })
    return pickClaudePaths(stdout.split(/\r?\n/))
  } catch {
    return []
  }
}

// ── 进程树定点杀（按记录 pid，非枚举）─────────────────────────────────────

/**
 * win：taskkill /PID /T /F（既有行为——ConPTY 子孙持 CWD/句柄，不杀则目录锁）。
 * linux：node-pty forkpty 子进程是会话首兼组长（pgid==pid，pty.cc login_tty→setsid），
 * 负 pid 杀整组；组不存在（裸 spawn 的探测进程未自立组）回退杀直接子进程。
 * 覆盖面差异背书：组杀对自行 setsid 脱组的守护化后代不生效（taskkill /T 枚举可覆盖）
 * ——本应用子进程均为前台 CLI，不涉及；如将来引入守护化子进程需改用枚举式杀树。
 */
export function killTreeSync(pid: number): void {
  if (IS_WIN) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // 进程已死/杀失败——尽力而为，不阻断退出
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // 组不在（子进程非组长）→ 回退杀直接子进程
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已死——尽力而为
  }
}

// ── claude 安装/查询/版本探测命令模板（win 保持原常量；linux 无壳形态）────

export function nativeInstallTemplateFor(platform: Platform): { file: string; args: readonly string[] } {
  if (platform !== 'win32') {
    // 官方安装器（登录 shell：install.sh 落 ~/.local/bin 且可能用到 PATH 里的 curl）
    return { file: 'bash', args: ['-l', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'] }
  }
  // 域名硬编码白名单仅 claude.ai；-NoProfile 不加 ExecutionPolicy Bypass（评审 R5/S2）
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex']
  }
}

export function npmInstallTemplateFor(platform: Platform): { file: string; args: readonly string[] } {
  // v1.7.3：npm ≥12 的 install-scripts 安全策略默认拦截包内 postinstall（claude-code
  // 的 node install.cjs 被拦 → 安装残缺/升级失败）。追加包级白名单 flag（用户实测
  // 验证）；旧版 npm 对未知 --flag 按未用 config 静默收纳，不报错。
  const allowScripts = ['--allow-scripts=@anthropic-ai/claude-code']
  if (platform !== 'win32')
    return { file: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code', ...allowScripts] }
  // npm 在 Windows 是 npm.cmd，须经 cmd.exe /c 包装（CreateProcess 不能直接解析）
  return {
    file: 'cmd.exe',
    args: ['/c', 'npm', 'install', '-g', '@anthropic-ai/claude-code', ...allowScripts]
  }
}

/** 官方原生安装器模板（v0.5⑤；win 值与原 claude-version 常量逐字节一致） */
export const NATIVE_INSTALL_FILE = nativeInstallTemplateFor(process.platform).file
export const NATIVE_INSTALL_ARGS: readonly string[] = nativeInstallTemplateFor(process.platform).args

/** npm 安装模板 */
export const NPM_INSTALL_FILE = npmInstallTemplateFor(process.platform).file
export const NPM_INSTALL_ARGS: readonly string[] = npmInstallTemplateFor(process.platform).args

/** npm registry 查询（checkClaudeUpdate 的 npm view 兜底） */
export function npmViewCommand(): { file: string; args: string[] } {
  if (IS_WIN) {
    return { file: 'cmd.exe', args: ['/c', 'npm', 'view', '@anthropic-ai/claude-code', 'version'] }
  }
  return { file: 'npm', args: ['view', '@anthropic-ai/claude-code', 'version'] }
}

/** claude --version 探测命令（win：cmd.exe /c 包装——.cmd 不能被 CreateProcess 直接解析；
 *  linux：直跑二进制（execvp 语义，shebang 脚本可直接执行）） */
export function versionProbeCommandFor(
  platform: string,
  claudeCmd: string
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/c', claudeCmd, '--version'] }
  return { file: claudeCmd, args: ['--version'] }
}

export function versionProbeCommand(claudeCmd: string): { file: string; args: string[] } {
  return versionProbeCommandFor(process.platform, claudeCmd)
}
