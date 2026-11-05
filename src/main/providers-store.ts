import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderConfig, ProviderRegistryState } from '../shared/types'

/**
 * v1.4 模型服务 provider 档案持久化：baseDir/providers.json（参考 cc-switch 的
 * provider 管理）。照 ProjectStore/NotifyService 惯例：原子写（.tmp + rename）、
 * load 容错（缺失/损坏 → 空注册表，逐条字段校验防脏数据进内存）、构造注入
 * baseDir 不碰 electron API（可测性）。
 *
 * apiKey 属凭据仅存本机本文件，不入仓库、不上传（红线，照 notify.ts 先例）。
 */
export class ProviderStore {
  private readonly file: string

  constructor(baseDir: string) {
    this.file = join(baseDir, 'providers.json')
  }

  /** 全量状态（providers + 默认 id；renderer 列表/默认标记一次拉齐） */
  state(): ProviderRegistryState {
    return this.load()
  }

  list(): ProviderConfig[] {
    return this.load().providers
  }

  get(id: string): ProviderConfig | undefined {
    return this.load().providers.find((p) => p.id === id)
  }

  /** 默认（当前）provider；未设置或指向已删条目 → undefined（调用方回退"不注入"） */
  getDefault(): ProviderConfig | undefined {
    const s = this.load()
    return s.defaultProviderId !== undefined
      ? (s.providers.find((p) => p.id === s.defaultProviderId) ?? undefined)
      : undefined
  }

  /**
   * 新增/编辑（id 空串=新增，分配 uuid；否则覆盖同 id 条目）。
   * 入参已由 IPC 层校验（validateProviderInput），此处只做最小防御（id 归一）。
   */
  save(input: ProviderConfig): ProviderConfig {
    const s = this.load()
    const record: ProviderConfig = input.id === '' ? { ...input, id: randomUUID() } : input
    const idx = s.providers.findIndex((p) => p.id === record.id)
    const next =
      idx >= 0 ? s.providers.map((p, i) => (i === idx ? record : p)) : [...s.providers, record]
    this.persist({ ...s, providers: next })
    return record
  }

  /** 删除；被删者恰为默认时清空 defaultProviderId（引用它的任务回退"无默认"链） */
  remove(id: string): boolean {
    const s = this.load()
    const next = s.providers.filter((p) => p.id !== id)
    if (next.length === s.providers.length) return false
    this.persist({
      providers: next,
      ...(s.defaultProviderId === id ? {} : s.defaultProviderId !== undefined ? { defaultProviderId: s.defaultProviderId } : {})
    })
    return true
  }

  /** 设默认（id 空串=取消默认）；id 不存在时 no-op 返回 false */
  setDefault(id: string | undefined): boolean {
    const s = this.load()
    if (id === undefined || id === '') {
      this.persist({ providers: s.providers })
      return true
    }
    if (!s.providers.some((p) => p.id === id)) return false
    this.persist({ providers: s.providers, defaultProviderId: id })
    return true
  }

  /** 容错读取：损坏/缺失回空注册表；逐条字段校验，脏条目丢弃（防半写/手改坏档进内存） */
  private load(): ProviderRegistryState {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return { providers: [] }
    }
    if (typeof parsed !== 'object' || parsed === null) return { providers: [] }
    const obj = parsed as Record<string, unknown>
    const providers = Array.isArray(obj['providers'])
      ? (obj['providers'] as unknown[]).filter(isValidProvider)
      : []
    const defaultProviderId =
      typeof obj['defaultProviderId'] === 'string' && obj['defaultProviderId'] !== ''
        ? obj['defaultProviderId']
        : undefined
    return {
      providers,
      ...(defaultProviderId !== undefined && providers.some((p) => p.id === defaultProviderId)
        ? { defaultProviderId }
        : {})
    }
  }

  private persist(state: ProviderRegistryState): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

/** 档位映射结构校验（可选对象；键值字符串，非字符串值整条丢弃） */
function isValidSlotModels(v: unknown): boolean {
  if (v === undefined) return true
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (['sonnet', 'opus', 'fable', 'haiku'] as const).every(
    (k) => o[k] === undefined || typeof o[k] === 'string'
  )
}

/** 单条档案的结构校验（load 侧防御；与 IPC 层 validateProviderInput 同口径但更宽——只保结构不拒空值） */
function isValidProvider(v: unknown): v is ProviderConfig {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['id'] === 'string' &&
    typeof o['name'] === 'string' &&
    (o['format'] === 'anthropic' || o['format'] === 'openai') &&
    typeof o['baseUrl'] === 'string' &&
    typeof o['apiKey'] === 'string' &&
    Array.isArray(o['models']) &&
    o['models'].every((m) => typeof m === 'string') &&
    (o['apiKeyType'] === undefined || o['apiKeyType'] === 'auth_token' || o['apiKeyType'] === 'api_key') &&
    (o['defaultModel'] === undefined || typeof o['defaultModel'] === 'string') &&
    (o['proxyUrl'] === undefined || typeof o['proxyUrl'] === 'string') &&
    isValidSlotModels(o['slotModels'])
  )
}
