import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client, type ConnectConfig } from 'ssh2'
import type { Language } from '../../shared/i18n'
import type { ConnectionRecord } from '../../shared/types'
import { connectionMessage } from '../connections-store'
import { ConnectionError, mapSshError } from './errors'

/**
 * S2 SSH 客户端建立核心（manager 持久连接与一次性 Test 共用）：
 * - 认证（1.3=B）：私钥（keyPath 读文件 + 可选 passphrase）或密码（safeStorage 密文解出）；
 * - host key TOFU（1.5=A）：hostVerifier 钩子计算 SHA256 指纹——无锁定指纹 →
 *   hostKeyConfirm（needConfirm 语义，携指纹上抛由 UI 确认后随档案锁定重连）；
 *   指纹变更 → hostKeyChanged 阻断；
 * - keepalive（4.4=A）：ssh2 原生 keepaliveInterval/keepaliveCountMax——连续
 *   keepaliveCountMax 次无响应 ssh2 判死（error+close），由 manager 转入重连。
 */

export interface SshClientTuning {
  /** ready 超时（TCP+握手+认证总窗；默认 20s） */
  connectTimeoutMs?: number
  /** keepalive 间隔（4.4=A 默认 15000） */
  keepaliveIntervalMs?: number
  /** 连续无响应判死阈值（4.4=A 默认 3） */
  keepaliveCountMax?: number
}

export interface OpenSshClientOptions extends SshClientTuning {
  language: () => Language
}

export interface OpenedSshClient {
  client: Client
  /** 本次连接的 host key 指纹（公开值：与 sshd 侧 ssh-keygen -lf 展示同源） */
  fingerprint: string
}

/** OpenSSH 风格指纹：SHA256:<base64(sha256(pubkey))>（去填充） */
export function fingerprintOfKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function openSshClient(
  record: ConnectionRecord,
  secret: { password?: string; passphrase?: string },
  opts: OpenSshClientOptions
): Promise<OpenedSshClient> {
  const lang = opts.language()
  const config: ConnectConfig = {
    host: record.host,
    port: record.port,
    username: record.user,
    readyTimeout: opts.connectTimeoutMs ?? 20_000,
    keepaliveInterval: opts.keepaliveIntervalMs ?? 15_000,
    keepaliveCountMax: opts.keepaliveCountMax ?? 3
  }

  if (record.authMethod === 'key') {
    let privateKey: Buffer
    try {
      privateKey = readFileSync(record.keyPath!)
    } catch {
      return Promise.reject(
        new ConnectionError('invalid', lang, {
          detail: `${connectionMessage(lang, 'keyUnreadable')}: ${record.keyPath}`
        })
      )
    }
    config.privateKey = privateKey
    if (secret.passphrase !== undefined && secret.passphrase !== '') {
      config.passphrase = secret.passphrase
    }
  } else {
    if (secret.password === undefined || secret.password === '') {
      return Promise.reject(new ConnectionError('credentialCorrupt', lang))
    }
    config.password = secret.password
  }

  return new Promise<OpenedSshClient>((resolve, reject) => {
    const client = new Client()
    let settled = false
    let fingerprint = ''
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        /* 已死连接 end 失败无害 */
      }
      reject(err)
    }

    // TOFU（1.5=A）：hostVerifier 在 KEX 期、认证前被调——指纹未确认/变更时
    // 先于任何凭据交互阻断（SyncHostVerifier 返回 false → ssh2 断开）
    config.hostVerifier = (key: Buffer): boolean => {
      fingerprint = fingerprintOfKey(key)
      const locked = record.lastHostKeyFingerprint?.trim() ?? ''
      if (locked === '') {
        fail(new ConnectionError('hostKeyConfirm', lang, { fingerprint }))
        return false
      }
      if (normalizeLocked(locked) !== fingerprint) {
        fail(new ConnectionError('hostKeyChanged', lang, { fingerprint }))
        return false
      }
      return true
    }

    client.on('error', (err: Error) => {
      // settle 后（ready 已交 manager 管辖）的错误由 manager 的 drop 处理接管
      fail(mapSshError(err, lang))
    })
    client.on('ready', () => {
      if (settled) return
      settled = true
      resolve({ client, fingerprint })
    })
    client.connect(config)
  })
}

function normalizeLocked(locked: string): string {
  return locked.toUpperCase().startsWith('SHA256:') ? locked : `SHA256:${locked}`
}
