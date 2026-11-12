/**
 * cwb-server 双向协议帧契约（SSH 远程模式 S1 批0 骨架）。
 *
 * 传输：WS+JSON（S3 实现编解码与分发；端口策略 127.0.0.1:17717 固定）。
 * 本文件是客户端与 server 两侧的唯一事实源——tools/sync-protocol.mjs 把它连同
 * 传递依赖逐字节拷入 server/src/shared/ 并做 hash 一致性校验；两侧漂移=同步
 * 脚本非零退出。实现期改契约=报主控走编译红。
 */

import type { RemoteProxyConfig } from './types'

/**
 * 远程任务 spawn 请求【S4 生产（RemotePtyManager.spawn/spawnClaude 经协议下发）/
 * S3 消费（PTY 注册表创建并 attach）】。
 * argv 由客户端组装完整形态（Linux 侧直跑二进制，不经 cmd.exe 包装——Windows
 * 包装仅存在于本地 backend）；env 注入语义=3.3=A（远程任务不注入 ANTHROPIC_*，
 * 端点/密钥/模型以 VM 内 ~/.claude 与 shell 环境为准，见 envDenylist）。
 */
export interface RemoteTaskSpawnRequest {
  /** 任务 id（=== claude --session-id，同本机契约 id===sessionId） */
  taskId: string
  /** 完整 argv（含可执行文件与全部参数，如 settingsPath 已展开为 --settings <path>） */
  argv: string[]
  /** 远端工作目录（VM 内 Linux 绝对路径） */
  cwd: string
  /** 初始栅格（xterm fit 后实际尺寸；re-attach 的 resize toggle 语义见 task.attach） */
  cols: number
  rows: number
  /**
   * claude --settings 文件（hooks 注入）：客户端参数化构造后 SFTP 写入 VM 的
   * 远端路径（4.6=A 单轨——server 不注入 hooks 端口）。缺省不附。
   */
  settingsPath?: string
  /**
   * 任务显示名（v2.0.2 server 侧 webhook 推送文案用——服务器端推送需任务名；
   * 旧客户端不传=server 回退 taskId 前 8 位）。缺省不附。
   */
  name?: string
  /**
   * 剥离不注入的环境变量名（3.3=A 防御性白名单外剥离；S3 应用到 spawn env）。
   * 缺省=不剥离（VM 内 shell 环境原样为准）。
   */
  envDenylist?: string[]
}

/**
 * client→server 帧全集【S2/S4/S7 生产 / S3 消费】。
 * 携带 rid 的请求帧由 server 以 result 帧回执（inReplyTo=rid）；fire-and-forget
 * 帧（task.write/resize 等高频流）不带 rid 不回执。
 */
export type ClientFrame =
  /** 建任务（不存在则创建，已存在=幂等拒绝）【S4 / S3】 */
  | { type: 'task.spawn'; rid?: string; req: RemoteTaskSpawnRequest }
  /** 终端键入透传（纯远端回显，4.2=A）【S4 / S3】 */
  | { type: 'task.write'; taskId: string; data: string }
  /** 栅格同步（同尺寸 resize 是 no-op；re-attach 重绘走 task.attach）【S4 / S3】 */
  | { type: 'task.resize'; taskId: string; cols: number; rows: number }
  /** 杀任务（显式停止；PTY 由 server 端 terminate）【S4 / S3】 */
  | { type: 'task.kill'; taskId: string; rid?: string }
  /**
   * re-attach 既有任务（5.9=b 保活后重挂）。S3 语义：resize toggle（cols±1→复原）
   * 强制 SIGWINCH 促 claude TUI 全量重绘；失败退化=回放尾部 ≤4000 字节。
   * 【S4 / S3】
   */
  | { type: 'task.attach'; taskId: string; rid?: string }
  /** detach（断开数据流但不杀 PTY——客户端退出/断连路径，5.9=b）【S4 / S3】 */
  | { type: 'task.detach'; taskId: string }
  /** 任务清单（重启后远程任务恢复视图/自检探测用）【S4（S2 自检亦可经此）/ S3】 */
  | { type: 'task.list'; rid?: string }
  /** 健康探测（安装健康=真实协议往返；O6 ABI 不匹配经此暴露明确错误）【S7/S2 / S3】 */
  | { type: 'server.ping'; rid?: string }
  /** server 版本查询（升级滚动替换比对，6.7）【S7 / S3】 */
  | { type: 'server.version'; rid?: string }
  /** 远程代理状态（6.4=c）【S4 / S3】 */
  | { type: 'proxy.status'; rid?: string }
  /** 远程代理启动【S4 / S3】 */
  | { type: 'proxy.start'; rid?: string }
  /** 远程代理停止【S4 / S3】 */
  | { type: 'proxy.stop'; rid?: string }
  /** 远程代理配置读【S4（设置页回显/状态卡）/ S3】 */
  | { type: 'proxy.config.get'; rid?: string }
  /** 远程代理配置写（A5 验收：set→get 回环一致）【S4 / S3】 */
  | { type: 'proxy.config.set'; rid?: string; patch: Partial<RemoteProxyConfig> }

/**
 * server→client 帧全集【S3 生产 / S2/S4/S7 消费】。
 */
export type ServerFrame =
  /**
   * 终端输出字节流（UTF-8 chunk）。【S3 产生 / S4 消费→PtyData 广播】
   */
  | { type: 'task.data'; taskId: string; chunk: string }
  /**
   * 任务退出（H6：显式 kill 与自行退出统一经此帧；exitCode 语义同本机 onExit）。
   * 【S3 产生 / S4 消费→onExit 桥接】
   */
  | { type: 'task.exit'; taskId: string; exitCode: number }
  /**
   * claude hook 事件转发（v2.0.2 推送服务器侧化）：claude 的 HTTP hook 直 POST
   * 到 server（稳定本机口，不再经客户端 SSH forwardIn——客户端离线不再
   * ECONNREFUSED），server 收下后经此帧转发给在线客户端（客户端回放进本地
   * task-activity 接收端做 epoch 校验/活动裁决/排序 touch；离线即丢弃，无损）。
   * 【S3 产生 / S4 消费→pipe 回本机 hook 接收端】
   */
  | { type: 'hook.event'; taskId: string; event: string; epoch: number }
  /**
   * server 日志（M8）：仅脱敏元数据（启动/升级/异常摘要）——终端内容不落盘
   * 不经此帧（8.1=A）。【S3 产生 / S4 桥接为 RemoteServerLog EVENT】
   */
  | { type: 'server.log'; level: 'info' | 'warn' | 'error'; message: string }
  /** 连接关闭通知（server 主动断开/升级滚动替换；reason 为脱敏摘要）【S3 / S4→重连状态机】 */
  | { type: 'conn.closed'; reason?: string }
  /**
   * 请求回执：inReplyTo=对应 ClientFrame 的 rid；ok=false 时 error 为脱敏原因。
   * payload 形状由具体请求定义（task.list→任务摘要数组、proxy.status→状态对象、
   * proxy.config.get→RemoteProxyConfig 等，S3 定终态）。【S3 产生 / 请求发起方消费】
   */
  | { type: 'result'; inReplyTo: string; ok: boolean; error?: string; payload?: unknown }
