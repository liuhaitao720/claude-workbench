import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { PtyDataEvent } from '../shared/types'
import type { PtyBackend } from './pty-backend'
import {
  IS_WIN,
  invalidatePlatformDiscovery,
  killTreeSync,
  listClaudeCandidates,
  mergeAugmentedPath,
  pickClaudePaths
} from './platform'

// v1.3：pickClaudePaths 迁至 platform.ts（平台收敛缝），此处 re-export 保既有 import 面
export { pickClaudePaths }

/** 新会话 args 附加项（可选） */
export interface SessionArgsOptions {
  /** v0.3.1 任务级开关：spawn 附加 --dangerously-skip-permissions */
  skipPermissions?: boolean
  /** v3.2 per-task claude settings 文件路径（hooks 注入）；spawn 附加 --settings <path> */
  settingsPath?: string
}

/** 新会话：claude --session-id <uuid> -n <name>（与 buildResumeArgs 互斥，结构性防呆）；
 *  opts.skipPermissions=true 附加 --dangerously-skip-permissions（v0.3.1，任务级开关）；
 *  opts.settingsPath 附加 --settings <path>（v3.2 hooks 注入，缺省不附——e2e 直连路径行为不变） */
export function buildNewSessionArgs(
  sessionId: string,
  name: string,
  opts?: SessionArgsOptions
): string[] {
  return [
    '--session-id',
    sessionId,
    '-n',
    name,
    ...(opts?.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(opts?.settingsPath ? ['--settings', opts.settingsPath] : [])
  ]
}

/** 恢复会话：claude --resume <uuid> -n <name>（与 buildNewSessionArgs 互斥）；
 *  沿用任务记录的 skipPermissions 元数据（切换在下次恢复生效）；
 *  settingsPath 同 buildNewSessionArgs（v3.2） */
export function buildResumeArgs(
  sessionId: string,
  name: string,
  opts?: SessionArgsOptions
): string[] {
  return [
    '--resume',
    sessionId,
    '-n',
    name,
    ...(opts?.skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(opts?.settingsPath ? ['--settings', opts.settingsPath] : [])
  ]
}

/** `where claude` 多命中时优先 npm 全局装的 claude.cmd（.\AppData\Roaming\npm\claude.cmd）；无可用命中返回 null（调用方回退 PATH 语义） */
/**
 * claude 子进程环境：透传 PATH/HOME + TERM=xterm-256color + COLORTERM=truecolor（v1.0.8：
 * 只设 TERM 时 CLI 按 256 色降级，24 位色需显式声明——Windows Terminal 同款约定），
 * 并剥离本进程可能继承的 claude 会话身份标记——工作台终端是面向用户的独立会话，
 * 不应继承父级 claude 会话的身份（CLAUDECODE/SESSION_ID 等——子 claude 检测到
 * 会话跳过首启对话框、关闭转写保存等）。偏好类变量（EFFORT/模型映射）保留透传。
 *
 * v1.4 providerEnv（每任务 API 配置注入）：传入时先剥离继承的 ANTHROPIC_* 端点/
 * 鉴权/模型变量（防系统级配置与任务配置串扰）再覆写；不传（无任何 provider 配置）
 * 时行为与 v1.3 前逐字节一致——继承 env 原样透传（含用户手设的 ANTHROPIC_*）。
 */
const SESSION_MARKER_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID'
] as const

/** provider 注入前须剥离的继承变量（ANTHROPIC 端点/鉴权/模型四件套） */
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL'
] as const

export function buildClaudeEnv(providerEnv?: Record<string, string>): Record<string, string> {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
    string,
    string
  >
  for (const name of SESSION_MARKER_VARS) delete env[name]
  // v1.3 Linux：前置合并登录 PATH/常见安装目录（无壳 execvp 找得到 claude 与 node）；
  // Windows 无增量时 no-op——env 逐字节不变
  mergeAugmentedPath(env)
  if (providerEnv !== undefined) {
    for (const name of PROVIDER_ENV_KEYS) delete env[name]
    Object.assign(env, providerEnv)
  }
  return env
}

let claudePathCache: string | null = null

/** claude 启动命令解析（缓存结果；失败回退 'claude'，win 由 cmd.exe / linux 由 execvp 按 PATH 语义解析） */
export async function resolveClaudeCommand(): Promise<string> {
  if (claudePathCache !== null) return claudePathCache
  let resolved = 'claude'
  try {
    resolved = (await listClaudeCandidates())[0] ?? 'claude'
  } catch {
    resolved = 'claude'
  }
  claudePathCache = resolved
  return resolved
}

/**
 * v1.0.6 候选列表解析（不走 claudePathCache——版本探测每次要新鲜列表以便回退）：
 * where/which 命中的可执行候选 + 末尾 'claude' PATH 兜底（被过滤空/垫片瞬时
 * 失效时壳层/execvp 仍可按 PATH 解析）。
 */
export async function resolveClaudeCandidates(): Promise<string[]> {
  let list: string[] = []
  try {
    list = await listClaudeCandidates()
  } catch {
    list = []
  }
  return [...new Set([...list, 'claude'])]
}

/**
 * 失效 claude 路径缓存（v0.5⑤ installClaudeCli 完成回调：安装后立即刷新 About 的
 * 版本/路径信息，否则 resolveClaudeCommand 仍返回旧解析或未安装回退值）；
 * v1.3 一并失效 platform 侧 Linux PATH 发现缓存
 */
export function invalidateClaudePathCache(): void {
  claudePathCache = null
  invalidatePlatformDiscovery()
}

export interface PtyManagerCallbacks {
  onData: (event: PtyDataEvent) => void
  onExit: (taskId: string) => void
}

/**
 * 按 taskId 管理的 claude PTY 集合；输出/退出经构造注入回调外送（不直接依赖 store，便于测试）。
 *
 * SSH 远程模式（S1 批0）：本类即 PTY 后端契约的 Local 实现——`implements PtyBackend`
 * （src/main/pty-backend.ts）在编译期锁定公共面与契约逐一对齐；远程实现=S4 的
 * RemotePtyManager（killAllTrees=detach-only，见契约 Javadoc）。除 implements 声明外
 * 零改动——本地行为不变。
 */
export class PtyManager implements PtyBackend {
  private readonly ptys = new Map<string, IPty>()

  /**
   * 任务最近一次尺寸（v0.1.2 光标错位修复）：PTY 每次 spawn 默认 80×24，而恢复任务
   * （--resume）时终端不重新挂载、不会自动 ptyResize——若不记忆尺寸，恢复后的 PTY
   * 停在 80×24 而 xterm 是 fit 后的大尺寸，claude 按小栅格计算光标 → 错位。
   * kill 后保留（恢复需要）；taskId 为一次性 uuid，不回收故无泄漏之虞。
   */
  private readonly lastSize = new Map<string, { cols: number; rows: number }>()

  constructor(private readonly callbacks: PtyManagerCallbacks) {}

  /**
   * 解析 claude 并 spawn：win 经 cmd.exe /c <claude.cmd 全路径> 包装（.cmd 无法被
   * CreateProcess 直接解析）；linux 直 spawn 二进制（execvp 语义，npm 装的
   * `#!/usr/bin/env node` shebang 脚本可直接执行——env 经 buildClaudeEnv 已含增强 PATH）。
   * v1.4 providerEnv：任务/默认 provider 的 ANTHROPIC_* 注入（见 buildClaudeEnv）。
   */
  async spawnClaude(
    taskId: string,
    claudeArgs: string[],
    cwd: string,
    providerEnv?: Record<string, string>
  ): Promise<void> {
    const claudeCmd = await resolveClaudeCommand()
    if (IS_WIN) {
      this.spawn(taskId, 'cmd.exe', ['/c', claudeCmd, ...claudeArgs], cwd, providerEnv)
      return
    }
    this.spawn(taskId, claudeCmd, claudeArgs, cwd, providerEnv)
  }

  /** 通用 PTY spawn（首启 80x24，重开沿用记忆尺寸；TERM=xterm-256color，PATH/HOME 经 process.env 自然透传） */
  spawn(
    taskId: string,
    file: string,
    args: string[],
    cwd: string,
    providerEnv?: Record<string, string>
  ): void {
    if (this.ptys.has(taskId)) throw new Error(`PTY already running for task ${taskId}`)
    const size = this.lastSize.get(taskId) ?? { cols: 80, rows: 24 }
    const pty = ptySpawn(file, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd,
      env: buildClaudeEnv(providerEnv)
    })
    this.ptys.set(taskId, pty)
    pty.onData((data) => this.callbacks.onData({ taskId, data }))
    pty.onExit(() => {
      this.ptys.delete(taskId)
      this.callbacks.onExit(taskId)
    })
  }

  write(taskId: string, data: string): void {
    this.ptys.get(taskId)?.write(data)
  }

  resize(taskId: string, cols: number, rows: number): void {
    this.lastSize.set(taskId, { cols, rows })
    this.ptys.get(taskId)?.resize(cols, rows)
  }

  kill(taskId: string): void {
    const pty = this.ptys.get(taskId)
    if (!pty) return
    try {
      pty.kill()
    } catch {
      // 已退出时 kill 可能抛错，忽略（onExit 已清理）
    }
  }

  isRunning(taskId: string): boolean {
    return this.ptys.has(taskId)
  }

  /** PTY 宿主进程 pid（S4 recovery：app 退出前记录，驱动脚本据此定点 taskkill 残留）；未运行返回 undefined */
  pid(taskId: string): number | undefined {
    return this.ptys.get(taskId)?.pid
  }

  /**
   * v1.0.3 退出目录锁修复：定点杀全部 PTY 进程树（win：taskkill /T /F——ConPTY 子孙
   * 持 exe 目录与项目目录的 CWD/句柄；linux：负 pid 杀进程组，见 platform.killTreeSync）。
   * 按记录的 pid 非枚举；同步执行——before-quit 路径。
   */
  killAllTrees(): void {
    for (const pty of this.ptys.values()) {
      killTreeSync(pty.pid)
    }
  }

  /** 活跃 PTY 当前栅格（测试/诊断用真实观测量）；未运行返回 undefined */
  currentSize(taskId: string): { cols: number; rows: number } | undefined {
    const pty = this.ptys.get(taskId)
    return pty ? { cols: pty.cols, rows: pty.rows } : undefined
  }

  /** 丢弃任务尺寸记忆（removeTask/removeProject 调用，防幽灵条目——评审 F3） */
  forget(taskId: string): void {
    this.lastSize.delete(taskId)
  }
}
