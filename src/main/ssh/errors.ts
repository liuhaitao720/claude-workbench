import { translate, type Language } from '../../shared/i18n'
import type { SelfCheckItem, SelfCheckItemId } from './self-check'

/**
 * S2 连接层结构化错误（2.3=A 三级错误 + 阻断类）。
 * 分级（i18n conn.err.*）：refused=sshd 未起/未装、timeout=VM 未启动/挂起/NAT 配错、
 * auth=密钥/密码问题；hostKeyChanged=TOFU 指纹变更阻断（1.5=A）。
 * 非分级类：hostKeyConfirm（TOFU 首连待确认）、selfCheckFailed（2.2=A 阻断+清单）、
 * notFound/invalid/credentialCorrupt/unavailable。
 */

export type ConnectionErrorKind =
  | 'refused'
  | 'timeout'
  | 'auth'
  | 'hostKeyChanged'
  /** TOFU 首连：无锁定指纹——本层返回 needConfirm 语义（kind+指纹），UI 确认后随档案锁定重连 */
  | 'hostKeyConfirm'
  /** 只读自检未过（2.2=A）：missing=缺失清单，connect 已阻断 */
  | 'selfCheckFailed'
  | 'notFound'
  | 'invalid'
  /** safeStorage 密文解不开（1.4=A：凭据损坏 → 要求重输） */
  | 'credentialCorrupt'
  | 'unavailable'

export interface ConnectionErrorOptions {
  /** hostKeyConfirm/hostKeyChanged 携带本次 host key 指纹（公开值，可展示/入日志） */
  fingerprint?: string
  /** selfCheckFailed 的缺失项清单 */
  missing?: SelfCheckItemId[]
  /** 完整自检清单（结构化回执） */
  checks?: SelfCheckItem[]
  /** 原始原因摘要（已脱敏：不含任何密钥/密码内容，长度截断） */
  detail?: string
}

const LOCAL_MESSAGES: Record<
  Exclude<ConnectionErrorKind, 'refused' | 'timeout' | 'auth' | 'hostKeyChanged'>,
  { zh: string; en: string }
> = {
  hostKeyConfirm: {
    zh: '首次连接：请确认主机指纹后重试',
    en: 'First connection: confirm the host key fingerprint, then retry'
  },
  selfCheckFailed: { zh: '自检未通过，缺失：', en: 'Self-check failed, missing: ' },
  notFound: { zh: '连接档案不存在', en: 'Connection profile not found' },
  invalid: { zh: '连接档案无效', en: 'Invalid connection profile' },
  credentialCorrupt: {
    zh: '凭据解密失败（系统密钥串变更或文件损坏），请重新输入密码',
    en: 'Failed to decrypt stored credential (keychain changed or file corrupted); re-enter the password'
  },
  unavailable: { zh: '连接不可用', en: 'Connection unavailable' }
}

const I18N_KEYS = {
  refused: 'conn.err.refused',
  timeout: 'conn.err.timeout',
  auth: 'conn.err.auth',
  hostKeyChanged: 'conn.err.hostKeyChanged'
} as const

export class ConnectionError extends Error {
  readonly kind: ConnectionErrorKind
  readonly hostKeyFingerprint?: string
  readonly missing?: SelfCheckItemId[]
  readonly checks?: SelfCheckItem[]

  constructor(kind: ConnectionErrorKind, lang: Language = 'zh', opts: ConnectionErrorOptions = {}) {
    let message: string
    if (kind === 'refused' || kind === 'timeout' || kind === 'auth' || kind === 'hostKeyChanged') {
      message = translate(lang, I18N_KEYS[kind])
    } else {
      const local = LOCAL_MESSAGES[kind][lang === 'en' ? 'en' : 'zh']
      if (kind === 'selfCheckFailed' && opts.missing !== undefined) {
        message = `${local}${opts.missing.join(', ')}`
      } else if (kind === 'hostKeyConfirm' && opts.fingerprint !== undefined) {
        message = `${local}（${opts.fingerprint}）`
      } else {
        message = local
      }
    }
    if (opts.detail !== undefined && opts.detail !== '') {
      message = `${message}（${sanitizeDetail(opts.detail)}）`
    }
    super(message)
    this.name = 'ConnectionError'
    this.kind = kind
    if (opts.fingerprint !== undefined) this.hostKeyFingerprint = opts.fingerprint
    if (opts.missing !== undefined) this.missing = opts.missing
    if (opts.checks !== undefined) this.checks = opts.checks
  }
}

/** 细节脱敏：截断到 200 字符（ssh2 错误消息不含密钥/密码，防御性兜底） */
function sanitizeDetail(detail: string): string {
  const t = detail.replace(/\s+/g, ' ').trim()
  return t.length > 200 ? `${t.slice(0, 200)}…` : t
}

/** ssh2 错误 → 三级分类（2.3=A：refused/timeout/auth；其余归 unavailable 透传细节） */
export function mapSshError(err: unknown, lang: Language = 'zh'): ConnectionError {
  const e = err instanceof Error ? err : new Error(String(err))
  const msg = e.message ?? String(e)
  const code = (e as { code?: string }).code
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return new ConnectionError('refused', lang, { detail: msg })
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    /timed?\s?out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ECONNABORTED|handshake/i.test(msg)
  ) {
    return new ConnectionError('timeout', lang, { detail: msg })
  }
  if (/authenticat/i.test(msg)) {
    return new ConnectionError('auth', lang, { detail: msg })
  }
  return new ConnectionError('unavailable', lang, { detail: msg })
}

/** 重连循环内也必须停止（用户干预才能解决）的错误类 */
export function isFatalConnectionError(kind: ConnectionErrorKind): boolean {
  return (
    kind === 'hostKeyConfirm' ||
    kind === 'hostKeyChanged' ||
    kind === 'selfCheckFailed' ||
    kind === 'credentialCorrupt' ||
    kind === 'invalid' ||
    kind === 'notFound'
  )
}
