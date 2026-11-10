import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { posix as posixPath } from 'node:path'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { CliOutputEvent } from '../shared/types'
import { translate, type Language } from '../shared/i18n'
import { buildClaudeEnv, resolveClaudeCommand } from './pty-manager'
import { IS_WIN, killTreeSync, nativeInstallTemplateFor, npmInstallTemplateFor } from './platform'
import type { ConnectionManager } from './ssh/connection-manager'
import { compareSemver, extractSemver, fetchLatestFromRegistry, type ClaudeUpdateInfo } from './claude-version'

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

/** cmd.exe 元字符黑名单（任一 token 命中即拒绝；含换行防多语句注入）。
 *  v1.3 跨平台不变量：Linux 直 execvp（argv 数组无 shell）下这些字符全部惰性，
 *  黑名单为超集防御继续全平台生效；红线——Linux 分支必须保持 no-shell 直 spawn，
 *  若将来改走 sh -c 则 $ ; ( ) 等未列字符立即构成注入面，须重建黑名单。 */
const CMD_METACHARS = /[&|><%"^\r\n`]/

/**
 * S5 远端黑名单（红线落实：bash -ic 组合即「改走 sh -c」的等价局面）：在本地
 * 黑名单之上补 shell 活性字符 ; $ ( ) \ ——主边界仍是逐 token posixQuote（引号
 * 转义气密，黑名单只是纵深防御层；plugin/marketplace id 形状 [A-Za-z0-9._-@]
 * 天然不含这些字符，合法输入零误伤）。
 */
const REMOTE_METACHARS = /[&|><%"^\r\n`;$()\\]/

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

/** 首 token 是否指向 claude（裸命令 claude，或任意路径形态的 claude.cmd/claude.exe/
 *  claude——v1.3 Linux 无扩展名全路径，如 /home/u/.local/bin/claude） */
function isClaudeToken(token: string): boolean {
  if (token === 'claude') return true
  const base = token.split(/[\\/]/).pop() ?? token
  return base === 'claude.cmd' || base === 'claude.exe' || base === 'claude'
}

/**
 * 校验用户命令（纯函数，拒绝抛带原因 Error，合法返回 token 数组）。
 * 顺序：非空 → 原文无换行（多语句注入纵深防御——裸换行会被 tokenizer 当空白吞掉，
 * 故在切分前先拒）→ 首 token=claude → 次 token ∈ 白名单 → 全 token 无元字符。
 * language：错误文案语言（默认中文——纯函数单测按中文断言；UI 传当前语言）。
 * opts.allowVersionProbe（S5 远端路由）：次 token 额外放行只读 `--version`
 * （远端版本探测——L3 验收契约；本地冻结白名单不受影响）。
 */
export function validateClaudeCommand(
  input: string,
  language: Language = 'zh',
  opts?: { allowVersionProbe?: boolean }
): string[] {
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
  const allowed =
    CLI_SUBCOMMAND_WHITELIST.has(subcommand) ||
    (opts?.allowVersionProbe === true && subcommand === '--version')
  if (!allowed) {
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

  /**
   * 校验用户命令并启动（win 经 cmd.exe 包装 resolved claude；linux 直 spawn）；
   * 返回 commandId；拒绝抛 Error。
   */
  async run(userCommand: string): Promise<{ commandId: string }> {
    const tokens = validateClaudeCommand(userCommand, this.callbacks.language?.() ?? 'zh')
    const claudeCmd = await resolveClaudeCommand()
    // 受控 args：白名单校验后的 token 数组（无元字符），claude 路径取 main 解析结果——不回拼原文
    // v1.0 乱码修复（win）：npm 子进程在中文 Windows 输出 GBK——chcp 65001 切 UTF-8（输出串行生效）
    if (IS_WIN) {
      return this.spawnFixed('cmd.exe', ['/c', 'chcp 65001>nul&&' + claudeCmd, ...tokens.slice(1)])
    }
    // Linux：直 spawn 解析出的二进制（execvp 无壳，env 已含增强 PATH）
    return this.spawnFixed(claudeCmd, [...tokens.slice(1)])
  }

  /**
   * v1.2.0 skill 市场固定模板：`claude plugin <argv...>`。
   * 与 spawnFixed 同性质（main 侧构造的受控 args，无自由命令面——file 取运行时
   * 解析的 claude 路径，v1.3 起 win/linux 均如此），但额外按
   * validateClaudeCommand 同口径复核每个 token 的元字符——installId 虽来自
   * marketplace 目录（外部不可信输入，已在 SkillMarket 侧过白名单），仍做纵深防御。
   */
  async runPlugin(argv: readonly string[]): Promise<{ commandId: string }> {
    const offending = argv.find((t) => CMD_METACHARS.test(t))
    if (offending !== undefined) throw new Error(`参数含被禁止的元字符: ${offending}`)
    const claudeCmd = await resolveClaudeCommand()
    if (IS_WIN) {
      return this.spawnFixed('cmd.exe', ['/c', 'chcp 65001>nul&&' + claudeCmd, ...argv])
    }
    return this.spawnFixed(claudeCmd, [...argv])
  }

  /**
   * 固定模板启动（installClaudeCli 专用）：file/args 均为 main 侧常量或
   * main 解析的 claude 路径（v1.3 起 run/runPlugin 亦以运行时解析路径作 file——
   * 路径来源可信、args 受控），不接受用户输入，故不经白名单校验
   * （模板法的安全前提即「无自由命令面」）。
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
    const remote = this.remoteCommands.get(commandId)
    if (remote !== undefined) {
      if (remote.done) cb()
      else remote.onExitOnce = cb
      return
    }
    const tracked = this.commands.get(commandId)
    if (!tracked) {
      cb()
      return
    }
    tracked.onExitOnce = cb
  }

  /**
   * v1.0.3 退出目录锁修复：定点杀全部 CLI 命令进程树（同 PtyManager.killAllTrees——
   * before-quit 路径同步杀树，按记录 pid 非枚举；win taskkill /T /F、linux 进程组，
   * 见 platform.killTreeSync）。
   */
  killAllTrees(): void {
    for (const tracked of this.commands.values()) {
      killTreeSync(tracked.pty.pid)
    }
  }

  /** 终止命令（弹窗关闭防孤儿）；未知/已退出 no-op */
  kill(commandId: string): void {
    // 远端命令：exec 聚合接口无中断通道（disconnect 会误伤整条连接的其他任务）——
    // no-op 落地（v1 边界，命令 20min 级自止或用户断开连接）；本地照旧 kill
    if (this.remoteCommands.has(commandId)) return
    const tracked = this.commands.get(commandId)
    if (!tracked) return
    try {
      tracked.pty.kill()
    } catch {
      // 已退出时 kill 可能抛错，忽略（onExit 已清理）
    }
  }

  isRunning(commandId: string): boolean {
    return this.commands.has(commandId) || this.remoteCommands.get(commandId)?.done === false
  }

  // ── S5 远端执行（6.3/6.5/6.6=B：白名单命令经 SSH 在 VM 内执行）──────────

  /**
   * 校验用户命令并在远端启动（bash -ic 包装——非交互 exec 的 PATH 不含 nvm shim，
   * S2/S4/S7 三方实证；S5 同墙）。输出聚合后分段回投 onData（CliOutput 形态与本地
   * PTY 一致，UI 既有弹窗可直接消费），完结发 onExit。远端白名单在本地冻结白名单
   * 基础上放行只读的 `--version`（L3 验收契约：runCliCommand('claude --version')）。
   */
  async runRemote(
    connection: ConnectionManager,
    connectionId: string,
    userCommand: string
  ): Promise<{ commandId: string }> {
    const tokens = validateClaudeCommand(userCommand, this.callbacks.language?.() ?? 'zh', {
      allowVersionProbe: true
    })
    const offending = tokens.find((t) => REMOTE_METACHARS.test(t))
    if (offending !== undefined) {
      throw new Error(translate(this.callbacks.language?.() ?? 'zh', 'cli.errMetachar', { word: offending }))
    }
    return this.execRemoteTracked(
      connection,
      connectionId,
      bashIcCommand(['claude', ...tokens.slice(1)])
    )
  }

  /**
   * 固定模板远端启动（skill 市场安装/刷新、插件启停——ipc 侧构造的受控 argv）。
   * 与 runPlugin 同口径复核元字符后拼 `bash -ic 'claude <argv...>'`。
   */
  async runPluginRemote(
    connection: ConnectionManager,
    connectionId: string,
    argv: readonly string[]
  ): Promise<{ commandId: string }> {
    const offending = argv.find((t) => REMOTE_METACHARS.test(t))
    if (offending !== undefined) throw new Error(`参数含被禁止的元字符: ${offending}`)
    return this.execRemoteTracked(connection, connectionId, bashIcCommand(['claude', ...argv]))
  }

  /**
   * 既成命令串远端启动（installClaudeCliRemote 等固定模板专用——命令由本模块
   * build* 纯函数构造、不含用户自由输入；不接受 renderer 传入的任意命令串）。
   */
  async runRawRemote(
    connection: ConnectionManager,
    connectionId: string,
    command: string
  ): Promise<{ commandId: string }> {
    return this.execRemoteTracked(connection, connectionId, command)
  }

  /** 远端命令登记表（kill 无通道/无超时——见 kill 注释；onceExit/isRunning 消费） */
  private readonly remoteCommands = new Map<
    string,
    { done: boolean; exitCode?: number; onExitOnce?: () => void }
  >()

  /**
   * exec + 输出回投：commandId 立即返回（spawn 语义对齐），exec 在后台聚合——
   * 完结后 stdout/stderr（剥 bash -ic 噪音行）分段 onData + onExit(exitCode)。
   * ConnectionManager.exec 为聚合接口（无流式/stdin 面）——分段回投是契约内最小实现
   * （选型见 S5 任务书：CliRunner 输出形态对齐或 exec 输出分段回投）。
   */
  private async execRemoteTracked(
    connection: ConnectionManager,
    connectionId: string,
    command: string
  ): Promise<{ commandId: string }> {
    const commandId = randomUUID()
    const tracked: { done: boolean; exitCode?: number; onExitOnce?: () => void } = { done: false }
    this.remoteCommands.set(commandId, tracked)
    void (async () => {
      let code: number
      let text: string
      try {
        const r = await connection.exec(connectionId, command)
        code = r.code
        text = mergeRemoteOutput(r.stdout, r.stderr)
      } catch (err) {
        code = 255
        text = `${err instanceof Error ? err.message : String(err)}\n`
      }
      for (const chunk of chunkText(text)) this.callbacks.onData({ commandId, data: chunk })
      tracked.done = true
      tracked.exitCode = code
      this.callbacks.onExit(commandId, code)
      tracked.onExitOnce?.()
    })()
    return { commandId }
  }
}

// ── S5 远端命令构造/执行助手（6.3/6.5/6.6=B）────────────────────────────

/** POSIX 单引号包裹（远端恒 Linux；与 ssh/manager.ts 同法——防路径空格/元字符注入） */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 受控 token → `bash -ic '<tokens...>'`（交互 shell 读 .bashrc 破 nvm PATH 墙——S2/S4/S7 实证） */
export function bashIcCommand(tokens: readonly string[]): string {
  const script = tokens.map(posixQuote).join(' ')
  return `bash -ic ${posixQuote(script)}`
}

/** 远端输出整形：stdout 原样 + stderr 追加（剥 bash -ic 交互噪音行——同 self-check 口径） */
export function mergeRemoteOutput(stdout: string, stderr: string): string {
  const noise = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('bash:'))
    .join('\n')
  if (stdout === '') return noise
  if (noise === '') return stdout
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${noise}`
}

/** 文本分段（cli-output 单事件负载上限——对齐 PTY chunk 量级，防超大单帧） */
function chunkText(text: string, size = 16 * 1024): string[] {
  if (text === '') return []
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** 远端只读命令超时（exec 聚合接口无超时面——挂起防御，self-check 同法） */
const REMOTE_CMD_TIMEOUT_MS = 30_000

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeout)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 远端解析登录 shell 内可执行文件路径（bash -ic 'command -v <name>'；空=未解析到） */
async function remoteWhich(
  connection: ConnectionManager,
  connectionId: string,
  name: string
): Promise<string> {
  const r = await withTimeout(
    connection.exec(connectionId, bashIcCommand(['command', '-v', name])),
    REMOTE_CMD_TIMEOUT_MS,
    `command -v ${name} timed out`
  )
  if (r.code !== 0) return ''
  const line = r.stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('bash:'))
    .pop()
  return line ?? ''
}

/** 远端 claude 版本探测（bash -ic 'claude --version' → semver；失败 ''=未安装） */
export async function remoteClaudeVersion(
  connection: ConnectionManager,
  connectionId: string
): Promise<string> {
  const r = await withTimeout(
    connection.exec(connectionId, bashIcCommand(['claude', '--version'])),
    REMOTE_CMD_TIMEOUT_MS,
    'claude --version timed out'
  ).catch(() => null)
  if (r === null || r.code !== 0) return ''
  return extractSemver(mergeRemoteOutput(r.stdout, r.stderr))
}

/**
 * 远端检查更新（6.3）：current=VM 内 claude --version；latest=客户端 registry
 * 直查（快），失败回退 VM 内 `npm view`（客户端无 node/npm 时仍可判），再失败 degraded。
 */
export async function checkClaudeUpdateRemote(
  connection: ConnectionManager,
  connectionId: string
): Promise<ClaudeUpdateInfo> {
  const current = await remoteClaudeVersion(connection, connectionId)
  let latest = ''
  let degraded = false
  try {
    latest = extractSemver((await fetchLatestFromRegistry()).replace(/^﻿/, ''))
  } catch {
    try {
      const r = await withTimeout(
        connection.exec(
          connectionId,
          bashIcCommand(['npm', 'view', '@anthropic-ai/claude-code', 'version'])
        ),
        REMOTE_CMD_TIMEOUT_MS,
        'npm view timed out'
      )
      latest = extractSemver(r.stdout.replace(/^﻿/, '').trim())
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

/** 远端 HOME（exec printf——S4 buildRemoteSettings 同法；失败抛错） */
export async function remoteHomeOf(
  connection: ConnectionManager,
  connectionId: string
): Promise<string> {
  const r = await withTimeout(
    connection.exec(connectionId, `printf %s "$HOME"`),
    REMOTE_CMD_TIMEOUT_MS,
    'resolve remote HOME timed out'
  )
  const home = r.stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop() ?? ''
  if (home === '') throw new Error('remote HOME unavailable')
  return home
}

/**
 * 远端 npm 安装命令构造（纯函数——sudo -S 断言的测试锚点）：
 * - 密码经 stdin 重定向 `< '<pwFile>'` 进入 sudo -S——**密码本体绝不进命令串/argv**
 *   （pwFile 为 mktemp 产物、0600 权限，密码经 SFTP 写入；命令内 `; rm -f` 自清）
 * - `env PATH=<npm 所在 bin>:标准路径` 破 sudo secure_path 对 node shebang 的遮蔽
 *   （npm 为 `#!/usr/bin/env node` 脚本——root 的 PATH 无 nvm bin 则解析失败）
 * - -k 强制重新认证（不吃 sudo 时间戳缓存，stdin 语义稳定）
 */
export function buildRemoteNpmInstallCommand(npmPath: string, pwFile?: string): string {
  const binDir = posixPath.dirname(npmPath)
  const envPath = `${binDir}:/usr/local/bin:/usr/bin:/bin`
  const core = `${posixQuote(npmPath)} install -g @anthropic-ai/claude-code`
  if (pwFile === undefined) {
    // npm 落在用户可写前缀（如 nvm/~/.npm-global）——无需提权
    return bashIcCommand([npmPath, 'install', '-g', '@anthropic-ai/claude-code'])
  }
  return (
    `sudo -S -p '' -k env PATH=${posixQuote(envPath)} ${core} < ${posixQuote(pwFile)}; ` +
    `rc=$?; rm -f ${posixQuote(pwFile)}; exit $rc`
  )
}

/** 远端官方安装器命令（nativeInstallTemplateFor('linux') 的脚本体——复用 platform.ts 模板） */
export function buildRemoteNativeInstallCommand(): string {
  const template = nativeInstallTemplateFor('linux')
  const script = template.args[template.args.length - 1] ?? ''
  return `bash -ic ${posixQuote(script)}`
}

/** 远端 npm 安装命令解析模板（npmInstallTemplateFor('linux') 同源——测试对照用） */
export const REMOTE_NPM_INSTALL_ARGS: readonly string[] = npmInstallTemplateFor('linux').args

export interface InstallClaudeCliRemoteOptions {
  language?: () => Language
  /** SSH 连接密码（authMethod='password' 档案经 ConnectionsStore.revealSecret 解出）；
   * npm 装在系统前缀需要 sudo 时必传，仅经 SFTP 写临时文件+stdin 重定向使用 */
  password?: string
}

/**
 * 远端安装/更新 claude CLI（6.3+6.6=B，经 CliRunner 远端通道——输出回投 cli-output）：
 * - native：官方安装器 curl|bash（装 ~/.local/bin，无 sudo）
 * - npm：解析 VM 内 npm 路径——落在 $HOME 下（nvm 等用户前缀）直接装（root 写用户
 *   nvm 目录会留下 root 属主文件，后续自更新必坏——不提权）；系统前缀才走
 *   sudo -S（mktemp 0600 密码文件 + stdin 重定向，命令串不含密码；见 buildRemoteNpmInstallCommand）
 */
export async function installClaudeCliRemote(
  runner: CliRunner,
  connection: ConnectionManager,
  connectionId: string,
  method: 'native' | 'npm',
  opts: InstallClaudeCliRemoteOptions = {}
): Promise<{ commandId: string }> {
  const lang = opts.language?.() ?? 'zh'
  if (method === 'native') {
    return runner.runRawRemote(connection, connectionId, buildRemoteNativeInstallCommand())
  }
  const npmPath = await remoteWhich(connection, connectionId, 'npm')
  if (npmPath === '') {
    throw new Error(translate(lang, 'cli.errNoRemoteNpm'))
  }
  const home = await remoteHomeOf(connection, connectionId)
  // npm 落在 $HOME 前缀下（nvm/~/.npm-global 等用户可写）→ 不提权（root 写用户
  // nvm 目录留 root 属主文件，后续用户态自更新必坏）；系统前缀才走 sudo -S
  if (npmPath.startsWith(`${home}/`)) {
    return runner.runRawRemote(connection, connectionId, buildRemoteNpmInstallCommand(npmPath))
  }
  if (opts.password === undefined || opts.password === '') {
    throw new Error(translate(lang, 'cli.errNoSudoPassword'))
  }
  // mktemp 先行（0600 原子创建），SFTP 写入既有文件不改变权限——无明文裸露窗口
  const mk = await withTimeout(connection.exec(connectionId, 'mktemp'), REMOTE_CMD_TIMEOUT_MS, 'mktemp timed out')
  const pwFile = mk.stdout.trim().split('\n').pop() ?? ''
  if (mk.code !== 0 || pwFile === '') {
    throw new Error(translate(lang, 'cli.errRemoteExec', { detail: 'mktemp failed' }))
  }
  try {
    const sftp = await connection.sftp(connectionId)
    await sftp.writeFile(pwFile, `${opts.password}\n`)
  } catch (err) {
    void connection.exec(connectionId, `rm -f ${posixQuote(pwFile)}`).catch(() => undefined)
    throw new Error(
      translate(lang, 'cli.errRemoteExec', {
        detail: err instanceof Error ? err.message : String(err)
      })
    )
  }
  return runner.runRawRemote(
    connection,
    connectionId,
    buildRemoteNpmInstallCommand(npmPath, pwFile)
  )
}
