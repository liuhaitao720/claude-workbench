import type { ProviderConfig, ProviderRegistryState } from '../shared/types'
import type { ConnectionManager } from './ssh/connection-manager'
import type { ModelsProbeResult } from './provider-models'
import {
  parseRegistryState,
  removeProviderFromState,
  saveProviderToState,
  setDefaultOfState
} from './providers-store'
import { buildModelsRequest, parseModelsPayload } from './provider-models'

/**
 * v1.6.0 远程模型配置（用户指令：远程连接的模型配置保存在远程服务器——读取与
 * 修改源同在远程）：注册表落 VM `~/.cwb/providers.json`，客户端经 SSH
 * （exec+SFTP）read-modify-write；格式与本地 userData/providers.json 完全同形
 * （parseRegistryState/saveProviderToState 等纯函数共用，行为零分叉）。
 *
 * 安全口径（沿 1.4 红线）：apiKey 属凭据，只经 SSH 加密通道单程写 VM 文件，
 * 不进客户端日志/仓库；探测在 VM 侧执行（curl——消费该端点的正是 VM 的 claude，
 * VM 视角可达性才是真相），apiKey 经 shell 单引号硬化注入命令行。
 */

/** 远端注册表目录/文件（相对 $HOME——与远端 HOME 解析解耦） */
const REMOTE_DIR_REL = '.cwb'
const REMOTE_FILE_REL = '.cwb/providers.json'

/** shell 单引号硬化（apiKey/baseUrl 等用户值进命令行的唯一通道） */
function shq(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** 远端 HOME（exec printf——buildRemoteSettings 同法） */
async function remoteHome(mgr: ConnectionManager, cid: string): Promise<string> {
  const r = await mgr.exec(cid, `h=$(printf %s "$HOME"); printf %s "$h"`)
  if (r.code !== 0) throw new Error(`remote HOME unavailable (exit ${r.code})`)
  const home = r.stdout.trim()
  if (home === '') throw new Error('remote HOME unavailable')
  return home
}

/** 读远端注册表：文件缺失/损坏 → 空注册表（与本地 load 容错同语义） */
export async function readRemoteProviders(
  mgr: ConnectionManager,
  cid: string
): Promise<ProviderRegistryState> {
  const home = await remoteHome(mgr, cid)
  const sftp = await mgr.sftp(cid)
  let text: string
  try {
    text = (await sftp.readFile(`${home}/${REMOTE_FILE_REL}`)).toString('utf8')
  } catch {
    return { providers: [] }
  }
  return parseRegistryState(text)
}

/** 写远端注册表：mkdir -p ~/.cwb（0700——含 apiKey 的文件同目录收紧）后覆写 */
export async function writeRemoteProviders(
  mgr: ConnectionManager,
  cid: string,
  state: ProviderRegistryState
): Promise<void> {
  const home = await remoteHome(mgr, cid)
  const prep = await mgr.exec(
    cid,
    `mkdir -p "$HOME/${REMOTE_DIR_REL}" && chmod 700 "$HOME/${REMOTE_DIR_REL}" && printf ok`
  )
  if (prep.code !== 0 || !prep.stdout.includes('ok')) {
    throw new Error(`remote providers dir prepare failed (exit ${prep.code})`)
  }
  const sftp = await mgr.sftp(cid)
  await sftp.writeFile(`${home}/${REMOTE_FILE_REL}`, JSON.stringify(state, null, 2))
}

/** 新增/编辑（远程 read-modify-write；语义与本地 ProviderStore.save 一致） */
export async function saveRemoteProvider(
  mgr: ConnectionManager,
  cid: string,
  input: ProviderConfig
): Promise<ProviderConfig> {
  const cur = await readRemoteProviders(mgr, cid)
  const { state, record } = saveProviderToState(cur, input)
  await writeRemoteProviders(mgr, cid, state)
  return record
}

/** 删除（不存在 → Error，与本地 IPC 的 provider.errNotFound 同消费面） */
export async function removeRemoteProvider(
  mgr: ConnectionManager,
  cid: string,
  id: string
): Promise<void> {
  const cur = await readRemoteProviders(mgr, cid)
  const next = removeProviderFromState(cur, id)
  if (next === undefined) throw new Error(`provider not found: ${id}`)
  await writeRemoteProviders(mgr, cid, next)
}

/** 设默认（id 空串=取消默认；不存在 → Error） */
export async function setRemoteDefault(
  mgr: ConnectionManager,
  cid: string,
  id: string | undefined
): Promise<void> {
  const cur = await readRemoteProviders(mgr, cid)
  const next = setDefaultOfState(cur, id)
  if (next === undefined) throw new Error(`provider not found: ${id ?? ''}`)
  await writeRemoteProviders(mgr, cid, next)
}

/**
 * VM 侧模型探测：curl 拉 /v1/models（端点由 VM 的 claude 消费——VM 视角可达性
 * 才是真相）。响应解析与本地探测同源（parseModelsPayload）。
 */
export async function probeRemoteModels(
  mgr: ConnectionManager,
  cid: string,
  provider: ProviderConfig
): Promise<ModelsProbeResult> {
  const { url, headers } = buildModelsRequest(provider)
  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `-H ${shq(`${k}: ${v}`)}`)
    .join(' ')
  const r = await mgr.exec(cid, `curl -sS -m 15 -o - -w '\\n%{http_code}' ${shq(url)} ${headerArgs}`)
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() !== '' ? r.stderr.trim() : `curl exit ${r.code}` }
  }
  const out = r.stdout
  const idx = out.lastIndexOf('\n')
  const body = idx >= 0 ? out.slice(0, idx) : out
  const status = idx >= 0 ? out.slice(idx + 1).trim() : ''
  if (status !== '' && status !== '200') {
    return { ok: false, error: `HTTP ${status}` }
  }
  const models = parseModelsPayload(body)
  if (models.length === 0) return { ok: false, error: 'no models in response' }
  return { ok: true, models }
}
