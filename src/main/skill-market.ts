import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillMarketEntry, SkillMarketplaceInfo } from '../shared/types'
import { translate, type Language } from '../shared/i18n'

/**
 * Skill 市场（v1.2.0）：搜索本机已配置 marketplace 目录。
 *
 * 数据来源（全部只读本机文件，本模块不自行发起网络请求——联网由 `claude plugin
 * marketplace update` / `claude plugin install` 完成，凭据与代理策略沿用 CLI）：
 * - `~/.claude/plugins/known_marketplaces.json`：已配置 marketplace 及其本地检出目录
 * - `<marketplace>/.claude-plugin/marketplace.json`：条目名/描述/分类/作者
 * - `~/.claude/plugins/install-counts-cache.json`：安装量（排序权重，缺失降级为 0）
 *
 * 安装/刷新由 ipc.ts 走 CliRunner 的受控执行面（`claude plugin install <id> -y`），
 * 本模块只承担「读目录 + 过滤 + 校验目标名」，不持有进程。
 */

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const MARKET_PATTERN = /^[A-Za-z0-9._-]+$/

/** 目录条目 → 市场条目（纯函数；marketplace 名与安装量由调用方补） */
export function toMarketEntry(
  raw: unknown,
  marketplace: string,
  installs: number
): SkillMarketEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const name = typeof rec['name'] === 'string' ? rec['name'] : ''
  if (!NAME_PATTERN.test(name)) return null
  const author =
    typeof rec['author'] === 'object' && rec['author'] !== null
      ? (rec['author'] as Record<string, unknown>)['name']
      : rec['author']
  return {
    name,
    marketplace,
    description: typeof rec['description'] === 'string' ? rec['description'].slice(0, 500) : '',
    ...(typeof rec['category'] === 'string' ? { category: rec['category'] } : {}),
    ...(typeof author === 'string' && author !== '' ? { author } : {}),
    ...(typeof rec['version'] === 'string' ? { version: rec['version'] } : {}),
    installs,
    installId: `${name}@${marketplace}`
  }
}

/** 关键词匹配：名称/描述/分类/作者，全部小写；空词返回 true */
export function matchesQuery(entry: SkillMarketEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = [entry.name, entry.description, entry.category ?? '', entry.author ?? '']
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}

/** 排序：安装量降序 → 名称升序（稳定、可预期） */
export function sortEntries(entries: SkillMarketEntry[]): SkillMarketEntry[] {
  return [...entries].sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name))
}

/**
 * 安装目标校验（marketplace 目录内容属外部不可信输入）：
 * 合法返回 null，否则返回错误文案。installId 必须恰为 `<name>@<marketplace>`，
 * 两段均过字符白名单——这是把目录内容拼进命令行前的唯一闸门。
 */
export function validateInstallTarget(installId: string, language: Language = 'zh'): string | null {
  const t = (key: Parameters<typeof translate>[1]): string => translate(language, key)
  if (typeof installId !== 'string' || installId.length > 256) return t('skill.errIdFormat')
  const parts = installId.split('@')
  if (parts.length !== 2) return t('skill.errIdFormat')
  const [name, market] = parts as [string, string]
  if (name === '' || !NAME_PATTERN.test(name)) return t('skill.errNameChars')
  if (market === '' || !MARKET_PATTERN.test(market)) return t('skill.errMarketChars')
  return null
}

interface KnownMarketplace {
  installLocation?: string
}

export class SkillMarket {
  private readonly home: string

  constructor(deps: { home?: string } = {}) {
    this.home = deps.home ?? homedir()
  }

  /** 已配置 marketplace 概要（名称 + 可安装条目数；非法名不计入；读不到返回空） */
  listMarketplaces(): SkillMarketplaceInfo[] {
    const out: SkillMarketplaceInfo[] = []
    for (const [name, dir] of this.marketplaceDirs()) {
      // 计数值与搜索可安装的条目一致（toMarketEntry 会丢弃非法名条目）
      const count = this.readCatalog(dir).filter((raw) => toMarketEntry(raw, name, 0) !== null).length
      out.push({ name, count })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 全量条目（含安装量，按安装量排序）；关键词由调用方过滤，便于本地即时搜索 */
  listAll(): SkillMarketEntry[] {
    const counts = this.readInstallCounts()
    const all: SkillMarketEntry[] = []
    for (const [market, dir] of this.marketplaceDirs()) {
      for (const raw of this.readCatalog(dir)) {
        const installs =
          counts.get(`${String((raw as Record<string, unknown>)['name'])}@${market}`) ?? 0
        const entry = toMarketEntry(raw, market, installs)
        if (entry !== null) all.push(entry)
      }
    }
    return sortEntries(all)
  }

  /** 搜索（关键词 + 可选 marketplace 过滤 + 上限） */
  search(query: string, marketplace?: string, limit = 50): SkillMarketEntry[] {
    return this.listAll()
      .filter((e) => (marketplace === undefined ? true : e.marketplace === marketplace))
      .filter((e) => matchesQuery(e, query))
      .slice(0, Math.max(1, Math.min(limit, 200)))
  }

  /** 已配置且本地目录存在的 marketplace（名 → 目录）；`.staging` 是 CLI 的临时检出，不展示 */
  private marketplaceDirs(): Array<[string, string]> {
    const known = this.readJson<Record<string, KnownMarketplace>>(
      join(this.home, '.claude/plugins/known_marketplaces.json')
    )
    if (known === null) return []
    const out: Array<[string, string]> = []
    for (const [name, info] of Object.entries(known)) {
      if (name.endsWith('.staging')) continue
      const dir = info.installLocation
      if (typeof dir === 'string' && existsSync(dir)) out.push([name, dir])
    }
    return out.sort(([a], [b]) => a.localeCompare(b))
  }

  private readCatalog(dir: string): unknown[] {
    const json = this.readJson<{ plugins?: unknown }>(join(dir, '.claude-plugin/marketplace.json'))
    return Array.isArray(json?.plugins) ? (json!.plugins as unknown[]) : []
  }

  private readInstallCounts(): Map<string, number> {
    const json = this.readJson<{ counts?: Array<{ plugin?: unknown; unique_installs?: unknown }> }>(
      join(this.home, '.claude/plugins/install-counts-cache.json')
    )
    const map = new Map<string, number>()
    for (const c of json?.counts ?? []) {
      if (typeof c.plugin === 'string' && typeof c.unique_installs === 'number') {
        map.set(c.plugin, c.unique_installs)
      }
    }
    return map
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }
}