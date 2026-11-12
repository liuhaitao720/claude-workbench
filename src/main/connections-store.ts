import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { Language } from '../shared/i18n'
import type { ConnectionRecord } from '../shared/types'
import { ConnectionError } from './ssh/errors'

/**
 * SSH 连接档案持久化（S2，1.2=A / 1.4=A）：userData/connections.json。
 * 照 ProviderStore 先例：原子写（.tmp + rename）、load 容错（缺失/损坏 → 空
 * 注册表，逐条字段校验防脏数据进内存）、构造注入 baseDir 与 safeStorage 端口
 * 不碰 electron 运行时 API（可测性）。
 *
 * 凭据红线（1.4=A）：password 只以 base64(safeStorage 密文) 落盘，
 * 明文绝不入文件/日志/回传 renderer（list/get 对外输出剥离密文字段）。
 * key 认证时 passwordEncrypted 复用为「私钥 passphrase 密文」
 * （S2 语义决定：契约字段集不变——ConnectionRecord.authMethod='key' 时该
 * 字段=可选 passphrase，见 ConnectionAuth JSDoc 的形状约定）。
 */

/** safeStorage 端口（Electron 实件或测试替身；缺省从 electron 取，不可用时 undefined） */
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** electron 的 safeStorage 是否可用（测试 mock / 非 Electron 环境下返回 undefined） */
export function electronSafeStorage(): SafeStoragePort | undefined {
  const s = safeStorage as SafeStoragePort | undefined
  return s !== undefined &&
    typeof s.isEncryptionAvailable === 'function' &&
    typeof s.encryptString === 'function' &&
    typeof s.decryptString === 'function'
    ? s
    : undefined
}

/** 连接层非分级错误文案（i18n 只锁了 4 个分级键 conn.err.*；此处为 S2 局部双语表） */
export function connectionMessage(lang: Language, key: ConnectionMsgKey): string {
  const M = {
    shape: { zh: '连接数据格式不正确', en: 'Malformed connection data' },
    name: { zh: '名称不能为空（≤64 字符）', en: 'Name required (max 64 chars)' },
    host: { zh: '主机地址不能为空', en: 'Host address required' },
    port: { zh: '端口必须是 1-65535 的整数', en: 'Port must be an integer between 1 and 65535' },
    user: { zh: '用户名不能为空', en: 'Username required' },
    authMethod: { zh: '认证方式只能是 key 或 password', en: 'Auth method must be key or password' },
    keyPath: { zh: '私钥认证必须提供私钥文件路径', en: 'Key path required for key auth' },
    passwordRequired: { zh: '密码认证必须提供密码', en: 'password required for password auth' },
    encryptionUnavailable: {
      zh: '本机安全存储不可用，无法加密保存密码（明文不落盘）',
      en: 'Local secure storage unavailable; cannot encrypt the password (never stored in plain text)'
    },
    notFound: { zh: '连接档案不存在', en: 'Connection profile not found' },
    duplicate: {
      zh: '已存在相同 user@host:port 的连接档案（同一目标只须一条，请直接编辑）',
      en: 'A profile for the same user@host:port already exists (one per target; edit it instead)'
    },
    keyUnreadable: { zh: '私钥文件不可读', en: 'Private key file unreadable' },
    credentialCorrupt: {
      zh: '凭据解密失败（系统密钥串变更或文件损坏），请重新输入密码',
      en: 'Failed to decrypt stored credential (keychain changed or file corrupted); re-enter the password'
    },
    passwordEmpty: { zh: '密码解密结果为空，请重新保存连接', en: 'Decrypted password is empty; re-save the connection' }
  } as const
  return M[key][lang === 'en' ? 'en' : 'zh']
}

export type ConnectionMsgKey =
  | 'shape' | 'name' | 'host' | 'port' | 'user' | 'authMethod'
  | 'keyPath' | 'passwordRequired' | 'encryptionUnavailable' | 'notFound'
  | 'keyUnreadable' | 'credentialCorrupt' | 'passwordEmpty' | 'duplicate'

/** 解析后的保存入参：档案 + 明文 password（undefined=保持既有密文；''=清除） */
export interface ParsedConnectionInput {
  record: ConnectionRecord
  plainPassword: string | undefined
}

/**
 * IPC 边界入参校验（照 validateProviderInput 先例：unknown → 归一化 ConnectionRecord，
 * 非法抛带文案 Error）。raw 额外接受一次性明文字段 `password`（string）：
 * 仅在 main 侧加密为 passwordEncrypted 后即刻丢弃，不进任何持久化/日志。
 */
export function parseConnectionInput(lang: Language, raw: unknown): ParsedConnectionInput {
  const msg = (k: ConnectionMsgKey): string => connectionMessage(lang, k)
  if (typeof raw !== 'object' || raw === null) throw new Error(msg('shape'))
  const o = raw as Record<string, unknown>

  const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
  if (name === '' || name.length > 64) throw new Error(msg('name'))

  const host = typeof o['host'] === 'string' ? o['host'].trim() : ''
  if (host === '' || host.length > 255) throw new Error(msg('host'))

  const port = typeof o['port'] === 'number' ? o['port'] : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(msg('port'))

  const user = typeof o['user'] === 'string' ? o['user'].trim() : ''
  if (user === '' || user.length > 64) throw new Error(msg('user'))

  const authMethod = o['authMethod']
  if (authMethod !== 'key' && authMethod !== 'password') throw new Error(msg('authMethod'))

  const rawKeyPath = typeof o['keyPath'] === 'string' ? o['keyPath'].trim() : ''
  const keyPath = rawKeyPath === '' ? undefined : rawKeyPath
  if (authMethod === 'key' && keyPath === undefined) throw new Error(msg('keyPath'))
  if (keyPath !== undefined && keyPath.length > 1024) throw new Error(msg('keyPath'))

  // 一次性明文 password（可选）：类型必须是 string；'' = 显式清除既有密文
  const rawPassword = o['password']
  if (rawPassword !== undefined && typeof rawPassword !== 'string') throw new Error(msg('shape'))
  const plainPassword = rawPassword as string | undefined

  const rawFp = o['lastHostKeyFingerprint']
  if (rawFp !== undefined && typeof rawFp !== 'string') throw new Error(msg('shape'))
  const lastHostKeyFingerprint =
    rawFp !== undefined && rawFp !== '' ? normalizeFingerprint(rawFp) : undefined

  const id = typeof o['id'] === 'string' ? o['id'] : ''
  const createdAt = typeof o['createdAt'] === 'string' ? o['createdAt'] : ''

  return {
    record: {
      id,
      name,
      host,
      port,
      user,
      authMethod,
      ...(keyPath !== undefined ? { keyPath } : {}),
      ...(o['passwordEncrypted'] !== undefined && typeof o['passwordEncrypted'] === 'string'
        ? { passwordEncrypted: o['passwordEncrypted'] as string }
        : {}),
      ...(lastHostKeyFingerprint !== undefined ? { lastHostKeyFingerprint } : {}),
      createdAt
    },
    plainPassword
  }
}

/** 指纹归一：去空白；无前缀补 SHA256:（base64 大小写敏感，保留原样） */
export function normalizeFingerprint(fp: string): string {
  const t = fp.trim()
  if (t === '') return ''
  return t.toUpperCase().startsWith('SHA256:') ? t : `SHA256:${t}`
}

export class ConnectionsStore {
  private readonly file: string
  private readonly safeStorage: SafeStoragePort | undefined

  constructor(baseDir: string, safeStorage?: SafeStoragePort) {
    this.file = join(baseDir, 'connections.json')
    this.safeStorage = safeStorage
  }

  /** 列表（renderer 面）：剥离 passwordEncrypted —— 密文不回传 UI（1.4） */
  list(): ConnectionRecord[] {
    return this.load().map(stripSecret)
  }

  /** 完整档案（main 内部 connect 用；含密文） */
  get(id: string): ConnectionRecord | undefined {
    return this.load().find((c) => c.id === id)
  }

  /**
   * 新增/编辑。id 空串=新增（分配 uuid）。
   * passwordEncrypted 合并语义（plainPassword 形参）：
   * - undefined 且认证方式未变 → 保留既有密文（编辑流不重输密码）；
   * - '' → 清除；非空 string → safeStorage 加密后覆盖。
   *
   * 新增去重（2.0.2 用户实测：只配 1 个远程却出现 2 条同目标记录——新建表单连点
   * 两次保存即产生两条空 id 档案）：新增路径（id 未命中既有档案）若已存在相同
   * (user, host, port) 的档案则拒绝并报既有档案名；编辑既有档案不受影响。
   * 唯一键取 (user, host, port)——同一服务器不同用户名的多条档案仍合法。
   */
  save(record: ConnectionRecord, plainPassword?: string): ConnectionRecord {
    const existing = record.id === '' ? undefined : this.get(record.id)
    if (existing === undefined) {
      const dup = this.load().find(
        (c) => c.host === record.host && c.port === record.port && c.user === record.user
      )
      if (dup !== undefined) {
        throw new Error(`${connectionMessage('zh', 'duplicate')}：「${dup.name}」`)
      }
    }
    const id = existing?.id ?? (record.id === '' ? randomUUID() : record.id)

    let passwordEncrypted: string | undefined
    if (plainPassword !== undefined) {
      passwordEncrypted = plainPassword === '' ? undefined : this.encrypt(plainPassword)
    } else if (existing !== undefined && existing.authMethod === record.authMethod) {
      passwordEncrypted = existing.passwordEncrypted
    }

    const saved: ConnectionRecord = {
      id,
      name: record.name,
      host: record.host,
      port: record.port,
      user: record.user,
      authMethod: record.authMethod,
      ...(record.authMethod === 'key' && record.keyPath !== undefined ? { keyPath: record.keyPath } : {}),
      ...(passwordEncrypted !== undefined ? { passwordEncrypted } : {}),
      ...(record.lastHostKeyFingerprint !== undefined && record.lastHostKeyFingerprint !== ''
        ? { lastHostKeyFingerprint: normalizeFingerprint(record.lastHostKeyFingerprint) }
        : {}),
      createdAt: existing?.createdAt ?? (record.createdAt !== '' ? record.createdAt : new Date().toISOString())
    }
    if (!isValidConnection(saved)) throw new Error(connectionMessage('zh', 'shape'))
    if (saved.authMethod === 'password' && saved.passwordEncrypted === undefined) {
      throw new Error(connectionMessage('zh', 'passwordRequired'))
    }

    const next = [...this.load().filter((c) => c.id !== saved.id), saved]
    this.persist(next)
    return stripSecret(saved)
  }

  /** 删除档案（1.2=A：仅客户端记录；不触碰 VM 内任何文件） */
  remove(id: string): boolean {
    const cur = this.load()
    const next = cur.filter((c) => c.id !== id)
    if (next.length === cur.length) return false
    this.persist(next)
    return true
  }

  /**
   * 解出连接用认证材料（不落盘、不进日志）。authMethod='password' → SSH 密码；
   * ='key' → 可选私钥 passphrase。解密失败=凭据损坏 → credentialCorrupt（要求重输，1.4）。
   */
  revealSecret(record: ConnectionRecord): { password?: string; passphrase?: string } {
    if (record.passwordEncrypted === undefined) return {}
    if (this.safeStorage === undefined) throw new ConnectionError('credentialCorrupt', 'zh')
    let plain = ''
    try {
      plain = this.safeStorage.decryptString(Buffer.from(record.passwordEncrypted, 'base64'))
    } catch {
      throw new ConnectionError('credentialCorrupt', 'zh')
    }
    if (record.authMethod === 'password') {
      if (plain === '') throw new ConnectionError('credentialCorrupt', 'zh')
      return { password: plain }
    }
    return { passphrase: plain }
  }

  private encrypt(plain: string): string {
    if (this.safeStorage === undefined || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error(connectionMessage('zh', 'encryptionUnavailable'))
    }
    return this.safeStorage.encryptString(plain).toString('base64')
  }

  /** 容错读取：损坏/缺失回空清单；逐条结构校验，脏条目丢弃（防半写/手改坏档进内存） */
  private load(): ConnectionRecord[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) return []
    const obj = parsed as Record<string, unknown>
    const arr = Array.isArray(obj['connections']) ? (obj['connections'] as unknown[]) : []
    return arr.filter(isValidConnection)
  }

  private persist(connections: ConnectionRecord[]): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ connections }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

function stripSecret(c: ConnectionRecord): ConnectionRecord {
  const { passwordEncrypted: _cipher, ...rest } = c
  return rest
}

/** 单条档案结构校验（load/save 侧防御） */
function isValidConnection(v: unknown): v is ConnectionRecord {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['id'] === 'string' &&
    typeof o['name'] === 'string' &&
    typeof o['host'] === 'string' &&
    typeof o['port'] === 'number' &&
    Number.isInteger(o['port']) &&
    o['port'] >= 1 &&
    o['port'] <= 65535 &&
    typeof o['user'] === 'string' &&
    (o['authMethod'] === 'key' || o['authMethod'] === 'password') &&
    (o['keyPath'] === undefined || typeof o['keyPath'] === 'string') &&
    (o['passwordEncrypted'] === undefined || typeof o['passwordEncrypted'] === 'string') &&
    (o['lastHostKeyFingerprint'] === undefined || typeof o['lastHostKeyFingerprint'] === 'string') &&
    typeof o['createdAt'] === 'string'
  )
}
