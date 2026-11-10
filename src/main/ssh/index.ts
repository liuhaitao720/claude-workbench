import type { ConnectionStateChangedEvent, RemoteServerLogEvent } from '../../shared/types'
import { mainLanguage } from '../language'
import {
  ConnectionsStore,
  electronSafeStorage,
  type SafeStoragePort
} from '../connections-store'
import { RealConnectionManager } from './manager'

/**
 * S2 组合工厂（main.ts 组合根用）：connections-store + RealConnectionManager +
 * 事件挂钩（onStateChange → ipc broadcastConnectionState、onLog →
 * broadcastRemoteServerLog——A2 权属：ConnectionStateChanged 由 S2 唯一产生）。
 * 计时参数（keepalive/退避）可注入——测试用短序列，产品走 4.4/5.7 缺省值。
 */

export interface SshStackOptions {
  baseDir: string
  /** 缺省 electron.safeStorage（不可用时密码认证保存会被拒绝——明文不落盘红线） */
  safeStorage?: SafeStoragePort
  language?: () => 'zh' | 'en'
  onStateChange?: (e: ConnectionStateChangedEvent) => void
  onLog?: (e: RemoteServerLogEvent) => void
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  backoffScheduleMs?: number[]
}

export function createSshConnectionStack(opts: SshStackOptions): RealConnectionManager {
  const store = new ConnectionsStore(opts.baseDir, opts.safeStorage ?? electronSafeStorage())
  const manager = new RealConnectionManager({
    store,
    language: opts.language ?? mainLanguage,
    connectTimeoutMs: opts.connectTimeoutMs,
    keepaliveIntervalMs: opts.keepaliveIntervalMs,
    keepaliveCountMax: opts.keepaliveCountMax,
    backoffScheduleMs: opts.backoffScheduleMs
  })
  if (opts.onStateChange !== undefined) manager.onStateChange(opts.onStateChange)
  if (opts.onLog !== undefined) manager.onLog(opts.onLog)
  return manager
}

export { RealConnectionManager } from './manager'
export { ConnectionError, mapSshError } from './errors'
export type { ConnectionErrorKind } from './errors'
