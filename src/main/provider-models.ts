import type { ProviderConfig } from '../shared/types'

/**
 * v1.4 provider 模型列表探测（表单「探测」按钮）：调 provider 的 /v1/models
 * 拉取可用模型（Anthropic 与 OpenAI 两种格式响应同形 {data:[{id}]}）。
 *
 * 网络出口注入式（可测）：默认 global fetch（直连）；组合根可传 sessionFetch——
 * Electron net.fetch + 独立 partition session（setProxy 走 provider.proxyUrl），
 * 官方 api.anthropic.com 探测同样需要代理（与 spawn 注入同源语义）。
 */

export interface ModelsProbeResult {
  ok: boolean
  models?: string[]
  error?: string
}

/** 模型列表端点：baseUrl 以 /v1 结尾直接拼 /models，否则拼 /v1/models（两种格式一致） */
export function buildModelsRequest(provider: ProviderConfig): {
  url: string
  headers: Record<string, string>
} {
  const base = provider.baseUrl.replace(/\/+$/, '')
  const url = `${base.endsWith('/v1') ? base : `${base}/v1`}/models`
  const headers: Record<string, string> = {}
  if (provider.apiKey !== '') {
    if (provider.format === 'openai') {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    } else if (provider.apiKeyType === 'api_key') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    }
  }
  return { url, headers }
}

/** 两种格式同形响应 {data:[{id,...}]} → id 数组（保序去重；容错：坏 JSON/无 data → []） */
export function parseModelsPayload(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const data = (parsed as Record<string, unknown>)['data']
  if (!Array.isArray(data)) return []
  const ids = data
    .map((e) => (typeof e === 'object' && e !== null ? (e as Record<string, unknown>)['id'] : undefined))
    .filter((id): id is string => typeof id === 'string' && id !== '')
  return [...new Set(ids)]
}

export interface ModelsProbeDeps {
  /** 直连出口（缺省 global fetch）；注入桩测试用 */
  fetchImpl?: typeof fetch
  /**
   * 代理出口工厂：组合根用 Electron net.fetch + 独立 partition session
   * （setProxy(proxyUrl)），官方端点探测走 provider.proxyUrl；缺省/无代理 → 直连。
   * 异步（Electron setProxy 是异步落定）；返回 undefined（环境无 net/session）→ 回退直连。
   */
  sessionFetch?: (proxyUrl: string) => Promise<typeof fetch | undefined>
  /** 超时（缺省 12s——模型列表体量小，官方端点经代理可能慢） */
  timeoutMs?: number
}

export function createModelsProbe(deps: ModelsProbeDeps = {}): (p: ProviderConfig) => Promise<ModelsProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 12_000
  return async (provider) => {
    const { url, headers } = buildModelsRequest(provider)
    const viaSession =
      provider.proxyUrl !== undefined && provider.proxyUrl !== ''
        ? await deps.sessionFetch?.(provider.proxyUrl)
        : undefined
    const doFetch = viaSession ?? deps.fetchImpl ?? fetch
    try {
      const res = await doFetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        const body = (await res.text()).slice(0, 120)
        return { ok: false, error: `HTTP ${res.status}${body !== '' ? ` ${body}` : ''}` }
      }
      const models = parseModelsPayload(await res.text())
      if (models.length === 0) {
        return { ok: false, error: '响应无模型列表（检查端点/鉴权方式）' }
      }
      return { ok: true, models }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error:
          provider.proxyUrl !== undefined && provider.proxyUrl !== ''
            ? `${msg}（已按代理 ${provider.proxyUrl} 出口探测）`
            : msg
      }
    }
  }
}
