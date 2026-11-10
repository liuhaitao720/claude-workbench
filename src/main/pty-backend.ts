import type { PtyDataEvent } from '../shared/types'

/**
 * PTY 后端契约（SSH 远程模式 S1 批0，H1/H2/H3 评审处置）：
 * Local（现 PtyManager）与 Remote（S4 RemotePtyManager）的统一公共面——
 * AppContext.pty 路由（S4）按 project.connectionId 分流到本地/远程实现。
 *
 * 签名与 src/main/pty-manager.ts 的 PtyManager 公共方法逐一对齐；结构兼容由
 * `PtyManager implements PtyBackend` 在编译期锁定（本文件与 pty-manager 不得
 * 单侧漂移）。实现期改契约=报主控走编译红。
 *
 * 构造契约：实现类经构造注入 onData/onExit 回调外送输出与退出（不直接依赖
 * store，便于测试——照 PtyManagerCallbacks 先例，见 PtyBackendCallbacks）。
 */

/** PTY 输出/退出外送回调（PtyManagerCallbacks 的结构化镜像，两侧独立演化） */
export interface PtyBackendCallbacks {
  onData: (event: PtyDataEvent) => void
  onExit: (taskId: string) => void
}

export interface PtyBackend {
  /**
   * 解析 claude 并 spawn（Local：win 经 cmd.exe /c 包装、linux 直 spawn；
   * Remote（S4）：argv 经协议 task.spawn 下发，providerEnv 不注入——3.3=A
   * 远程任务不注入 ANTHROPIC_*，端点/密钥以 VM 内环境为准）。
   */
  spawnClaude(
    taskId: string,
    claudeArgs: string[],
    cwd: string,
    providerEnv?: Record<string, string>
  ): Promise<void>
  /** 通用 PTY spawn（Local：node-pty 直起；Remote：S4 经协议下发） */
  spawn(
    taskId: string,
    file: string,
    args: string[],
    cwd: string,
    providerEnv?: Record<string, string>
  ): void
  /** 终端键入透传（纯远端回显，4.2=A） */
  write(taskId: string, data: string): void
  /** 栅格同步（Local 含尺寸记忆——恢复沿用；Remote 经协议 task.resize） */
  resize(taskId: string, cols: number, rows: number): void
  /** 杀单个任务（幂等——未知 taskId 安全 no-op） */
  kill(taskId: string): void
  /** PTY 句柄是否存活 */
  isRunning(taskId: string): boolean
  /** 宿主进程 pid（v1.0.3 退出清理用）；未运行返回 undefined */
  pid(taskId: string): number | undefined
  /**
   * 双语义（S1 钉死，H2；S4 Remote 实现必须遵守）：
   * - Local（PtyManager 现行为）：客户端退出前定点杀全部 PTY 进程树
   *   （before-quit 路径；win taskkill /T /F、linux 负 pid 杀进程组），
   *   释放 exe/项目/worktree 目录句柄锁——本地任务随客户端退出终止（5.2 现语义）。
   * - Remote（S4 RemotePtyManager）：**detach-only**——5.9=b server 会话保活：
   *   客户端退出/断开绝不杀远端任务，仅清理本地订阅与转发句柄；远端 PTY 由
   *   cwb-server 持有并在 re-attach（task.attach）后恢复现场。禁止在本实现里
   *   触发任何 task.kill 下发。
   */
  killAllTrees(): void
  /** 活跃 PTY 当前栅格（测试/诊断真实观测量）；未运行返回 undefined */
  currentSize(taskId: string): { cols: number; rows: number } | undefined
  /** 丢弃任务尺寸记忆（removeTask/removeProject 调用，防幽灵条目） */
  forget(taskId: string): void
}
