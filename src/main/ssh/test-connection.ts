import type { Language } from '../../shared/i18n'
import type { ConnectionRecord } from '../../shared/types'
import type { ConnectionsStore } from '../connections-store'
import { openSshClient, type OpenedSshClient } from './client-core'
import { ConnectionError } from './errors'
import { execOnClient } from './manager'
import { runSelfCheck, type SelfCheckItem } from './self-check'

/**
 * S2 一次性连接测试（ipc.ts ConnectionsTest handler 委托）：
 * 建立独立 ssh2 Client（不走持久连接状态机）→ 只读自检（2.1）→ 立即断开。
 * TOFU 语义与 connect() 一致：无锁定指纹 → hostKeyConfirm（needConfirm +
 * 指纹，UI 确认落档案后重测）；指纹变更 → hostKeyChanged 阻断。
 */

export interface TestConnectionOptions {
  store: ConnectionsStore
  language: () => Language
  connectTimeoutMs?: number
}

export interface TestConnectionOutcome {
  ok: boolean
  /** ok=false 时的分级文案（2.3=A；ConnectionError.message 本地化） */
  error?: string
  /** 结构化错误类（renderer 需要区分 needConfirm 等语义时用） */
  kind?: string
  /** hostKeyConfirm=待确认指纹 / hostKeyChanged=实际指纹 / ok=true=已验证指纹 */
  hostKeyFingerprint?: string
  /** 自检清单（连接成功或 selfCheckFailed 时携带） */
  checks?: SelfCheckItem[]
}

export async function testConnectionRecord(
  record: ConnectionRecord,
  opts: TestConnectionOptions
): Promise<TestConnectionOutcome> {
  const lang = opts.language()
  let opened: OpenedSshClient | null = null
  try {
    const secret = opts.store.revealSecret(record)
    opened = await openSshClient(record, secret, {
      language: opts.language,
      connectTimeoutMs: opts.connectTimeoutMs,
      // 一次性测试不启 keepalive（判死/重连归持久连接管理器）
      keepaliveIntervalMs: 0
    })
    const checks = await runSelfCheck((command) => execOnClient(opened!.client, command, lang))
    const ok = checks.every((c) => c.status !== 'missing')
    return {
      ok,
      ...(ok ? {} : { error: describeChecks(checks) }),
      hostKeyFingerprint: opened.fingerprint,
      checks
    }
  } catch (err) {
    const cerr = err instanceof ConnectionError ? err : undefined
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(cerr !== undefined ? { kind: cerr.kind } : {}),
      ...(cerr?.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: cerr.hostKeyFingerprint } : {}),
      ...(cerr?.checks !== undefined ? { checks: cerr.checks } : {})
    }
  } finally {
    try {
      opened?.client.end()
    } catch {
      /* noop */
    }
  }
}

/** 自检失败摘要：缺失项以 id 列出（本地化条目名由 renderer 用 conn.check.* 渲染清单） */
function describeChecks(checks: SelfCheckItem[]): string {
  const missing = checks.filter((c) => c.status === 'missing').map((c) => c.id)
  const unknown = checks.filter((c) => c.status === 'unknown').map((c) => c.id)
  const parts = [missing.length > 0 ? `missing: ${missing.join(', ')}` : '']
  if (unknown.length > 0) parts.push(`unknown: ${unknown.join(', ')}`)
  return `self-check failed (${parts.filter((p) => p !== '').join('; ')})`
}
