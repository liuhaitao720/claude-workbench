/**
 * server 配置存取（S3，6.4=c）：~/.cwb-server/config.json（VM 侧持久化）。
 *
 * 只存代理配置（RemoteProxyConfig 契约形状）；原子写（tmp+rename）；容错读
 * （缺失/损坏→默认空配置，不炸服务）。凭据（代理 URL 可能含用户名:密码）只落
 * VM 本地盘，不经协议回传明文密钥字段以外内容——契约本身只有 proxyUrl，读写
 * 均按契约白名单字段过滤，未知字段不透传（防将来加敏感字段被旧客户端读走）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RemoteProxyConfig } from './shared/types'

export function defaultConfigPath(): string {
  return process.env['CWB_SERVER_HOME'] !== undefined
    ? join(process.env['CWB_SERVER_HOME'], 'config.json')
    : join(homedir(), '.cwb-server', 'config.json')
}

const EMPTY: RemoteProxyConfig = {}

export class ConfigStore {
  private cache: RemoteProxyConfig | null = null

  constructor(private readonly filePath: string = defaultConfigPath()) {}

  /** 读（容错：缺失/损坏/非法 JSON→默认空配置；结果缓存） */
  get(): RemoteProxyConfig {
    if (this.cache !== null) return this.cache
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      this.cache = { ...EMPTY }
      return this.cache
    }
    this.cache = sanitizeConfig(parsed)
    return this.cache
  }

  /** 写（patch 合并：undefined 值=删除该键——sanitize 后自然落空）；原子落盘 */
  set(patch: Partial<RemoteProxyConfig>): RemoteProxyConfig {
    const next = sanitizeConfig({ ...this.get(), ...patch })
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
    this.cache = next
    return next
  }

  get path(): string {
    return this.filePath
  }
}

/** 白名单字段过滤（proxyUrl 须为 string；其余丢弃） */
function sanitizeConfig(v: unknown): RemoteProxyConfig {
  if (typeof v !== 'object' || v === null) return { ...EMPTY }
  const url = (v as Record<string, unknown>)['proxyUrl']
  if (typeof url === 'string' && url.length > 0) return { proxyUrl: url }
  return { ...EMPTY }
}
