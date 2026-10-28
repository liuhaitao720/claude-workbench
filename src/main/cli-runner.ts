import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { CliOutputEvent } from '../shared/types'
import { translate, type Language } from '../shared/i18n'
import { buildClaudeEnv, resolveClaudeCommand } from './pty-manager'

/**
 * v0.5③ CLI 命令执行器（安全核心）。
 *
 * 独立于 PtyManager：自有 node-pty 实例表（commandId→pty）+ onData/onExit(code)
 * 回调 + 20min 超时清理；绝不复用任务 PTY 语义，输出只走 IpcChannels.CliOutput
 * 广播（组合根接线），不进 PtyData/noteBytes/taskLastDataAt。
 *
 * 安全面（评审 S1：前缀检查是装饰性防线，真正的边界是受控 args）：
 * 1. validateClaudeCommand（导出纯函数）：tokenize（空白切分+去引号）→ 首 token
 *    必须是 claude / <路径>\claude.cmd / <路径>\claude.exe → 次 token ∈ 冻结白名单
 *    {plugin, update, upgrade, mcp} → 任一 token 拒绝 cmd 元字符（& | > < % ^ " `
 *    与换行）——注入语料单测见 cli-runner.test.ts；
 * 2. spawn 仅用受控 args 数组（node-pty 按 MSDN 规则自行加引号），绝不把用户
 *    原始文本拼接进 cmd.exe /c 命令行。
 */

/** 子命令冻结白名单（v0.5③ 守门评审：不为单条命令放宽；npm 形态安装走 installClaudeCli 固定模板） */
export const CLI_SUBCOMMAND_WHITELIST: ReadonlySet<string> = new Set(['plugin', 'update', 'upgrade', 'mcp'])

/** cmd.exe 元字符黑名单（任一 token 命中即拒绝；含换行防多语句注入） */
const CMD_METACHARS = /[&|><%"^\r\n`]/

/** 单命令最长存活（超时 kill 防孤儿：弹窗已关/用户遗忘的安装命令不能永跑） */
export const CLI_COMMAND_TIMEOUT_MS = 20 * 60 * 1000

/**
 * 词法切分：空白分隔 + 引号分组，随后仅剥离「整 token 被成对同类引号包裹」的引号。
 * 中段/未配对引号保留在 token 内——由元字符检查拒绝（防引号字符被静默吞掉后绕过黑名单）。
 * 例：`"C:\Program Files\claude.exe" plugin install "a b"` → [C:\Program Files\claude.exe, plugin, install, a b]
 */
export function tokenizeCommand(input: string): string[] {
  const raw: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const ch of input) {
    if (quote !== null) {
      current += ch // 引号内一切保留（含空白）
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        raw.push(current)
        current = ''
        hasToken = false
      }
    } else {
      current += ch
      hasToken = true
    }
  }
  if (hasToken) raw.push(current)
  return raw
    .map((t) =>
      t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
        ? t.slice(1, -1)
        : t
    )
    .filter((t) => t.length > 0)
}

/** 首 token 是否指向 claude（裸命令 claude，或任意路径形态的 claude.cmd/claude.exe） */
function isClaudeToken(token: string): boolean {
  if (token === 'claude') return true
  const base = token.split(/[\\/]/).pop() ?? token
  return base === 'claude.cmd' || base === 'claude.exe'
}

/**
 * 校验用户命令（纯函数，拒绝抛带原因 Error，合法返回 token 数组）。
 * 顺序：非空 → 原文无换行（多语句注入纵深防御——裸换行会被 tokenizer 当空白吞掉，
 * 故在切分前先拒）→ 首 token=claude → 次 token ∈ 白名单 → 全 token 无元字符。
 * language：错误文案语言（默认中文——纯函数单测按中文断言；UI 传当前语言）。
 */
export function validateClaudeCommand(input: string, language: Language = 'zh'): string[] {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
    translate(language, key, params)
  if (input.trim().length === 0) throw new Error(t('cli.errEmpty'))
  if (/[\r\n]/.test(input)) {
    throw new Error(t('cli.errNewline'))
  }
  const tokens = tokenizeCommand(input)
  if (tokens.length === 0) throw new Error(t('cli.errEmpty'))
  const first = tokens[0] ?? ''
  if (!isClaudeToken(first)) {
    throw new Error(t('cli.errNotClaude', { word: first }))
  }
  const subcommand = tokens[1]
  if (subcommand === undefined) throw new Error(t('cli.errMissingSub'))
  if (!CLI_SUBCOMMAND_WHITELIST.has(subcommand)) {
    throw new Error(t('cli.errSubNotAllowed', { word: subcommand }))
  }
  const offending = tokens.find((t2) => CMD_METACHARS.test(t2))
  if (offending !== undefined) {
    throw new Error(t('cli.errMetachar', { word: offending }))
  }
  return tokens
}

export interface CliRunnerCallbacks {
  onData: (event: CliOutputEvent) => void
  /** 进程结束（含超时 kill 与显式 kill）；exitCode 为 PTY 上报值 */
  onExit: (commandId: string, exitCode: number) => void
  /** v1.2.0 校验错误文案语言（组合根读 AppSettings.language；缺省中文） */
  language?: () => Language
}

interface TrackedCommand {
  readonly pty: IPty
  readonly timeoutTimer: NodeJS.Timeout
  /** onceExit 注册的一次性完成回调（installClaudeCli 完成→失效路径缓存） */
  onExitOnce?: () => void
}

/** 隐藏命令 PTY 执行器（校验在 run；固定模板在 spawnFixed——编译期常量不进白名单面） */
export class CliRunner {
  private readonly commands = new Map<string, TrackedCommand>()

  constructor(private readonly callbacks: CliRunnerCallbacks) {}

  /** 校验用户命令并启动（经 cmd.exe 包装 resolved claude）；返回 commandId；拒绝抛 Error */
  async run(userCommand: string): Promise<{ commandId: string }> {
    const tokens = validateClaudeCommand(userCommand, this.callbacks.language?.() ?? 'zh')
    const claudeCmd = await resolveClaudeCommand()
    // 受控 args：白名单校验后的 token 数组（无元字符），claude 路径取 main 解析结果——不回拼原文
    // v1.0 乱码修复：npm 子进程在中文 Windows 输出 GBK——chcp 65001 切 UTF-8（输出串行生效）
    return this.spawnFixed('cmd.exe', ['/c', 'chcp 65001>nul&&' + claudeCmd, ...tokens.slice(1)])
  }

  /**
   * v1.2.0 skill 市场固定模板：`claude plugin <argv...>`。
   * 与 spawnFixed 同性质（main 侧构造的受控 args，无自由命令面），但额外按
   * validateClaudeCommand 同口径复核每个 token 的元字符——installId 虽来自
   * marketplace 目录（外部不可信输入，已在 SkillMarket 侧过白名单），仍做纵深防御。
   */
  async runPlugin(argv: readonly string[]): Promise<{ commandId: string }> {
    const offending = argv.find((t) => CMD_METACHARS.test(t))
    if (offending !== undefined) throw new Error(`参数含被禁止的元字符: ${offending}`)
    const claudeCmd = await resolveClaudeCommand()
    return this.spawnFixed('cmd.exe', ['/c', 'chcp 65001>nul&&' + claudeCmd, ...argv])
  }

  /**
   * 固定模板启动（installClaudeCli 专用）：file/args 均为 main 侧编译期常量，
   * 不接受用户输入，故不经白名单校验（模板法的安全前提即「无自由命令面」）。
   */
  async spawnFixed(file: string, args: string[]): Promise<{ commandId: string }> {
    const commandId = randomUUID()
    const pty = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: homedir(),
      env: buildClaudeEnv()
    })
    const timeoutTimer = setTimeout(() => {
      try {
        pty.kill()
      } catch {
        // 已退出时 kill 可能抛错，忽略（onExit 已清理）
      }
    }, CLI_COMMAND_TIMEOUT_MS)
    timeoutTimer.unref?.()
    const tracked: TrackedCommand = { pty, timeoutTimer }
    this.commands.set(commandId, tracked)
    pty.onData((data) => this.callbacks.onData({ commandId, data }))
    pty.onExit(({ exitCode }) => {
      clearTimeout(timeoutTimer)
      this.commands.delete(commandId)
      const once = tracked.onExitOnce
      tracked.onExitOnce = undefined
      this.callbacks.onExit(commandId, exitCode)
      once?.()
    })
    return { commandId }
  }

  /** 指定命令退出时回调一次（已退出则立即回调）——installClaudeCli 完成钩子 */
  onceExit(commandId: string, cb: () => void): void {
    const tracked = this.commands.get(commandId)
    if (!tracked) {
      cb()
      return
    }
    tracked.onExitOnce = cb
  }

  /**
   * v1.0.3 退出目录锁修复：定点杀全部 CLI 命令进程树（同 PtyManager.killAllTrees——
   * before-quit 路径同步 taskkill /T /F，按记录 pid 非枚举）。
   */
  killAllTrees(): void {
    for (const tracked of this.commands.values()) {
      try {
        execFileSync('taskkill', ['/PID', String(tracked.pty.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        // 已死/杀失败——尽力而为
      }
    }
  }

  /** 终止命令（弹窗关闭防孤儿）；未知/已退出 no-op */
  kill(commandId: string): void {
    const tracked = this.commands.get(commandId)
    if (!tracked) return
    try {
      tracked.pty.kill()
    } catch {
      // 已退出时 kill 可能抛错，忽略（onExit 已清理）
    }
  }

  isRunning(commandId: string): boolean {
    return this.commands.has(commandId)
  }
}
