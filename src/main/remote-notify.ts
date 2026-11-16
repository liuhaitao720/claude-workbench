import type { ConnectionManager } from './ssh/connection-manager'
import type {
  AnswerConfig,
  NotifyConfig,
  NotifyEventFlags,
  NotifySettingsView
} from '../shared/types'
import {
  inferChannel,
  mergeAnswerConfig,
  mergeEventFlags,
  normalizeAnswerConfig,
  normalizeEventFlags,
  validateWebhookUrl
} from './notify'
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

/**
 * 写远端通知配置（校验同本地 setWebhook）。
 * 3.2=A read-modify-write：先读同文件原始对象再合并本段三字段——整文件覆写会抹掉
 * 旧客户端不认识的 events/answer（两端版本不一致是常态）。
 */
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
  const path = `${home}/${REMOTE_FILE_REL}`
  const raw = await readRawJson(sftp, path)
  await sftp.writeFile(path, JSON.stringify({ ...raw, ...config }, null, 2))
  return { ...config }
}

/** 读远端文件为原始对象（缺失/损坏 → {}；不解释语义） */
async function readRawJson(
  sftp: Awaited<ReturnType<ConnectionManager['sftp']>>,
  path: string
): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse((await sftp.readFile(path)).toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* 缺失/损坏 → 空对象 */
  }
  return {}
}

/** 远端 notify.json 原始对象（缺目录/文件 → {}） */
async function readRemoteRaw(
  mgr: ConnectionManager,
  cid: string
): Promise<Record<string, unknown>> {
  const home = await remoteHome(mgr, cid)
  const sftp = await mgr.sftp(cid)
  return readRawJson(sftp, `${home}/${REMOTE_FILE_REL}`)
}

/** 远端 notify.json 整对象写回（目录权限 700；调用方先读-改） */
async function writeRemoteRaw(
  mgr: ConnectionManager,
  cid: string,
  raw: Record<string, unknown>
): Promise<void> {
  const home = await remoteHome(mgr, cid)
  const prep = await mgr.exec(
    cid,
    `mkdir -p "$HOME/${REMOTE_DIR_REL}" && chmod 700 "$HOME/${REMOTE_DIR_REL}" && printf ok`
  )
  if (prep.code !== 0 || !prep.stdout.includes('ok')) {
    throw new Error(`remote notify dir prepare failed (exit ${prep.code})`)
  }
  const sftp = await mgr.sftp(cid)
  await sftp.writeFile(`${home}/${REMOTE_FILE_REL}`, JSON.stringify(raw, null, 2))
}

/**
 * v2.2.0 远端设置聚合读（webhook + 事件开关 + 手机答复）：与本地 NotifyService
 * 同归一化语义；缺失/损坏逐段回落缺省。
 */
export async function readRemoteNotifySettings(
  mgr: ConnectionManager,
  cid: string
): Promise<NotifySettingsView> {
  const raw = await readRemoteRaw(mgr, cid)
  const url = typeof raw['url'] === 'string' ? raw['url'] : ''
  return {
    config: {
      url,
      enabled: raw['enabled'] === true && url.length > 0,
      channel: url !== '' ? inferChannel(url) : 'generic'
    },
    events: normalizeEventFlags(raw['events']),
    answer: normalizeAnswerConfig(raw['answer'])
  }
}

/** 远端事件开关部分更新（read-modify-write 保留其余段） */
export async function writeRemoteNotifyEvents(
  mgr: ConnectionManager,
  cid: string,
  patch: Partial<NotifyEventFlags>
): Promise<NotifyEventFlags> {
  const raw = await readRemoteRaw(mgr, cid)
  const next = mergeEventFlags(normalizeEventFlags(raw['events']), patch)
  await writeRemoteRaw(mgr, cid, { ...raw, events: next })
  return next
}

/** 远端手机答复配置部分更新（数值越界抛错；隧道固定 cloudflare） */
export async function writeRemoteNotifyAnswer(
  mgr: ConnectionManager,
  cid: string,
  patch: Partial<AnswerConfig>
): Promise<AnswerConfig> {
  const raw = await readRemoteRaw(mgr, cid)
  const next = mergeAnswerConfig(normalizeAnswerConfig(raw['answer']), patch)
  await writeRemoteRaw(mgr, cid, { ...raw, answer: next })
  return next
}
