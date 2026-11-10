/**
 * cwb-server 入口骨架（SSH 远程模式 S1 批0）：协议 handler 注册表 + 全 NotImplemented。
 *
 * S3 落位内容：WS 传输层（监听 127.0.0.1:17717）、帧 JSON 编解码、按帧类型分发到
 * handlers、PTY 注册表与保活（5.9=b）、re-attach（resize toggle + 尾部回放退化）、
 * 代理核心移植（6.4=c）。本骨架只锁「键=ClientFrame['type'] 全集」的注册表形状，
 * 完整性由编译期 Record 键校验锁定（缺一个帧类型=编译红）。
 *
 * 注意：src/shared/ 目录由 tools/sync-protocol.mjs 从客户端 src/shared/ 同步生成
 * （remote-protocol.ts 及其传递依赖，逐字节一致）——勿手改，改了会被一致性校验
 * 非零退出拦下。
 */
import type { ClientFrame, ServerFrame } from './shared/remote-protocol'

/** 帧分发 handler：frame=解码后的请求帧；send=该连接的回帧出口（含 result 回执） */
export type FrameHandler = (
  frame: ClientFrame,
  send: (frame: ServerFrame) => void
) => void | Promise<void>

/** S1 桩：全部帧类型统一占位——S3 逐帧实现后替换本注册表对应项 */
function notImplemented(frame: ClientFrame): never {
  throw new Error(`NotImplemented: ${frame.type}（S3 实现）`)
}

/** 协议 handler 注册表——键恰为 ClientFrame['type'] 全集（编译期完整性锁定） */
export const handlers: Record<ClientFrame['type'], FrameHandler> = {
  'task.spawn': notImplemented,
  'task.write': notImplemented,
  'task.resize': notImplemented,
  'task.kill': notImplemented,
  'task.attach': notImplemented,
  'task.detach': notImplemented,
  'task.list': notImplemented,
  'server.ping': notImplemented,
  'server.version': notImplemented,
  'proxy.status': notImplemented,
  'proxy.start': notImplemented,
  'proxy.stop': notImplemented,
  'proxy.config.get': notImplemented,
  'proxy.config.set': notImplemented
}
