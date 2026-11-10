import type { SshExecResult } from './connection-manager'

/**
 * S2 只读自检（2.1=A）：连接成功后 exec 探测 sshd/claude/node/cwb-server 四项。
 * 2.2=A 阻断口径：BLOCKING_CHECK_IDS 内的项 missing → connect 阻断（状态回 offline
 * + 失败清单）；server 项为 unknown 占位不阻断。
 */

export type SelfCheckItemId = 'sshd' | 'claude' | 'node' | 'server'
export type SelfCheckStatus = 'ok' | 'missing' | 'unknown'

export interface SelfCheckItem {
  id: SelfCheckItemId
  status: SelfCheckStatus
  /** 版本号等摘要（如 '1.0.66'；不含敏感内容） */
  detail?: string
}

/** 2.2 阻断清单：这些项 missing = 连接阻断（server=unknown 不阻断） */
export const BLOCKING_CHECK_IDS: readonly SelfCheckItemId[] = ['claude', 'node']

const CHECK_COMMANDS: Partial<Record<SelfCheckItemId, string>> = {
  claude: 'claude --version',
  node: 'node --version'
}

/** 单项探测超时（远端 PATH 挂起等异常时防连接流程卡死） */
const CHECK_TIMEOUT_MS = 10_000

/** 只读探测命令集（S5 白名单路由复用 exec 通道时以本表为界） */
export async function runSelfCheck(
  exec: (command: string) => Promise<SshExecResult>
): Promise<SelfCheckItem[]> {
  // sshd：SSH 连接已建立即证明 sshd 可达（2.1 首项，无需再 exec）
  const items: SelfCheckItem[] = [{ id: 'sshd', status: 'ok' }]
  for (const id of ['claude', 'node'] as const) {
    items.push(await checkCommand(id, exec))
  }
  // server 项：S7 接管（server-installer 的版本函数批0 未建——此处固定 unknown
  // 占位，不参与 2.2 阻断；S7 落地后改为真实 cwb-server 组件/版本探测）
  items.push({ id: 'server', status: 'unknown' })
  return items
}

async function checkCommand(
  id: 'claude' | 'node',
  exec: (command: string) => Promise<SshExecResult>
): Promise<SelfCheckItem> {
  const command = CHECK_COMMANDS[id]!
  try {
    const r = await withTimeout(exec(command), CHECK_TIMEOUT_MS, `${command} timed out`)
    const version = (r.stdout !== '' ? r.stdout : r.stderr).trim().split('\n').pop()?.trim() ?? ''
    return r.code === 0
      ? { id, status: 'ok', ...(version !== '' ? { detail: version } : {}) }
      : { id, status: 'missing', ...(version !== '' ? { detail: version } : { detail: `exit ${r.code}` }) }
  } catch (err) {
    return { id, status: 'missing', detail: err instanceof Error ? err.message : String(err) }
  }
}

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
