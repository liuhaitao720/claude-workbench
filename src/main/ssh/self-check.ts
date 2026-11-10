import type { SshExecResult } from './connection-manager'
import { probeServerVersion, type ServerInstallTransport } from '../server-installer'

/**
 * S2 只读自检（2.1=A）：连接成功后 exec 探测 sshd/claude/node/cwb-server 四项。
 * 2.2=A 阻断口径：BLOCKING_CHECK_IDS 内的项 missing → connect 阻断（状态回 offline
 * + 失败清单）；server 项 missing 不阻断（cwb-server 缺失由 S4 连接流程健康检查
 * needInstall 语义接管——弹安装确认而非拒绝连接）。
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

/**
 * 只读探测命令集（S5 白名单路由复用 exec 通道时以本表为界）。
 * S4 窄改：nvm PATH 墙——非交互 exec 的 PATH 不含 nvm shim（S2 L3 实证：nvm 装的
 * claude/node 在 `ssh host 'claude --version'` 形态下不可见），探测命令包
 * `bash -ic '...'`（交互 shell 读 .bashrc 的 nvm 初始化段）。bash -ic 的 stderr
 * 噪音（job control 等）由 checkCommand 的 stdout 优先 + bash: 前缀行剥离兜住。
 */
const CHECK_COMMANDS: Partial<Record<SelfCheckItemId, string>> = {
  claude: `bash -ic 'command -v claude && claude --version'`,
  node: `bash -ic 'command -v node && node --version'`
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
  // server 项（S7 probeServerVersion 就绪——S5 接线）：真实协议探活
  // （bash /dev/tcp 回环 GET /，O6 健康=加载 node-pty 的 server 应答 {ok,version}）。
  // ok:true → ok+版本；探活不通 → missing（不阻断——安装确认弹窗语义归 S4/S7）。
  // transport 适配：probeServerVersion 仅消费 exec；sftp 为接口必填项，此路径不可达。
  const transport: ServerInstallTransport = {
    exec: async (_connectionId, command) => exec(command),
    sftp: async () => {
      throw new Error('self-check server probe does not use sftp')
    }
  }
  const probe = await probeServerVersion(transport, '')
  items.push(
    probe.ok
      ? { id: 'server', status: 'ok', detail: probe.version }
      : { id: 'server', status: 'missing', detail: probe.detail }
  )
  return items
}

/**
 * 版本摘要提取：stdout 优先；取末条非空且非 bash -ic 噪音行（`bash:` 前缀——
 * 「no job control in this shell」等交互 shell 告警，S4）。
 */
function versionDetail(stdout: string, stderr: string): string {
  for (const text of [stdout, stderr]) {
    if (text === '') continue
    const lines = text
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('bash:'))
    if (lines.length > 0) return lines[lines.length - 1]!
  }
  return ''
}

async function checkCommand(
  id: 'claude' | 'node',
  exec: (command: string) => Promise<SshExecResult>
): Promise<SelfCheckItem> {
  const command = CHECK_COMMANDS[id]!
  try {
    const r = await withTimeout(exec(command), CHECK_TIMEOUT_MS, `${command} timed out`)
    const version = versionDetail(r.stdout, r.stderr)
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
