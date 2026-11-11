import type { ConnectionManager } from './ssh/connection-manager'
import type { NotifyConfig } from '../shared/types'
import { inferChannel, validateWebhookUrl } from './notify'
import type { Language } from '../shared/i18n'

/**
 * v1.7.0 远程 Webhook 通知（用户指令：本地和远程都要 webhook 通知）：
 * 配置存 VM `~/.cwb/notify.json`（与本地 userData/notify.json 同形同容错），
 * 客户端经 SSH exec+SFTP read-modify-write；远程任务的 awaiting 事件到达客户端后
 * 按任务 connectionId 取本配置触发（远程数据留在远程——与 providers 同边界）。
 */

const REMOTE_DIR_REL = '.cwb'
const REMOTE_FILE_REL = '.cwb/notify.json'

async function remoteHome(mgr: ConnectionManager, cid: string): Promise<string> {
  const r = await mgr.exec(cid, `h=$(printf %s "$HOME"); printf %s "$h"`)
  if (r.code !== 0) throw new Error(`remote HOME unavailable (exit ${r.code})`)
  const home = r.stdout.trim()
  if (home === '') throw new Error('remote HOME unavailable')
  return home
}

/** 读远端通知配置：缺失/损坏 → 默认关闭态（与本地 load 容错同语义） */
export async function readRemoteNotify(
  mgr: ConnectionManager,
  cid: string
): Promise<NotifyConfig> {
  const home = await remoteHome(mgr, cid)
  const sftp = await mgr.sftp(cid)
  let text: string
  try {
    text = (await sftp.readFile(`${home}/${REMOTE_FILE_REL}`)).toString('utf8')
  } catch {
    return { url: '', enabled: false, channel: 'generic' }
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const url = typeof parsed['url'] === 'string' ? parsed['url'] : ''
    return {
      url,
      enabled: parsed['enabled'] === true && url.length > 0,
      channel: url !== '' ? inferChannel(url) : 'generic'
    }
  } catch {
    return { url: '', enabled: false, channel: 'generic' }
  }
}

/** 写远端通知配置（校验同本地 setWebhook；mkdir -p ~/.cwb 后覆写） */
export async function writeRemoteNotify(
  mgr: ConnectionManager,
  cid: string,
  url: string,
  enabled: boolean,
  lang: Language
): Promise<NotifyConfig> {
  const trimmed = url.trim()
  const invalid = validateWebhookUrl(trimmed, lang)
  if (invalid !== null) throw new Error(invalid)
  const config: NotifyConfig = {
    url: trimmed,
    enabled: enabled && trimmed.length > 0,
    channel: inferChannel(trimmed)
  }
  const home = await remoteHome(mgr, cid)
  const prep = await mgr.exec(
    cid,
    `mkdir -p "$HOME/${REMOTE_DIR_REL}" && chmod 700 "$HOME/${REMOTE_DIR_REL}" && printf ok`
  )
  if (prep.code !== 0 || !prep.stdout.includes('ok')) {
    throw new Error(`remote notify dir prepare failed (exit ${prep.code})`)
  }
  const sftp = await mgr.sftp(cid)
  await sftp.writeFile(`${home}/${REMOTE_FILE_REL}`, JSON.stringify(config, null, 2))
  return { ...config }
}
