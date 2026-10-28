import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SkillMarket,
  matchesQuery,
  sortEntries,
  toMarketEntry,
  validateInstallTarget
} from '../skill-market'
import type { SkillMarketEntry } from '../../shared/types'

/** 造一个 marketplace 检出目录（`<dir>/.claude-plugin/marketplace.json`） */
function makeMarketplace(root: string, name: string, plugins: unknown[]): string {
  const dir = join(root, 'marketplaces', name)
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin/marketplace.json'),
    JSON.stringify({ name, plugins })
  )
  return dir
}

/** 写 known_marketplaces.json（name → installLocation） */
function writeKnown(home: string, known: Record<string, string>): void {
  const dir = join(home, '.claude', 'plugins')
  mkdirSync(dir, { recursive: true })
  const json: Record<string, unknown> = {}
  for (const [name, location] of Object.entries(known)) json[name] = { installLocation: location }
  writeFileSync(join(dir, 'known_marketplaces.json'), JSON.stringify(json))
}

function writeCounts(home: string, counts: Array<{ plugin: string; unique_installs: number }>): void {
  const dir = join(home, '.claude', 'plugins')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'install-counts-cache.json'), JSON.stringify({ counts }))
}

describe('toMarketEntry（目录条目 → 市场条目，纯函数）', () => {
  it('补齐 marketplace/installs/installId；author 支持对象与字符串', () => {
    expect(
      toMarketEntry({ name: 'pdf-tools', description: 'PDF 工具', category: 'docs', author: { name: 'alice' } }, 'official', 42)
    ).toEqual({
      name: 'pdf-tools',
      marketplace: 'official',
      description: 'PDF 工具',
      category: 'docs',
      author: 'alice',
      installs: 42,
      installId: 'pdf-tools@official'
    })
    expect(toMarketEntry({ name: 'x', author: 'bob', version: '1.0.0' }, 'm', 0)).toMatchObject({
      author: 'bob',
      version: '1.0.0',
      description: ''
    })
  })

  it('非法/缺失 name、非对象一律拒绝（不产生可安装条目）', () => {
    expect(toMarketEntry({ name: 'has space' }, 'm', 0)).toBeNull()
    expect(toMarketEntry({ name: 'bad;name' }, 'm', 0)).toBeNull()
    expect(toMarketEntry({ description: 'no name' }, 'm', 0)).toBeNull()
    expect(toMarketEntry(null, 'm', 0)).toBeNull()
    expect(toMarketEntry('str', 'm', 0)).toBeNull()
  })

  it('描述超长截断（500 字符上限）', () => {
    const entry = toMarketEntry({ name: 'n', description: 'x'.repeat(900) }, 'm', 0)
    expect(entry?.description).toHaveLength(500)
  })
})

describe('matchesQuery / sortEntries', () => {
  const base: SkillMarketEntry = {
    name: 'code-review',
    marketplace: 'official',
    description: 'Review diffs for bugs',
    category: 'dev',
    installs: 10,
    installId: 'code-review@official'
  }

  it('多词 all-match；大小写不敏感；空词全通过', () => {
    expect(matchesQuery(base, '')).toBe(true)
    expect(matchesQuery(base, 'REVIEW')).toBe(true)
    expect(matchesQuery(base, 'review bugs')).toBe(true)
    expect(matchesQuery(base, 'review missing')).toBe(false)
    expect(matchesQuery(base, 'dev')).toBe(true) // 命中 category
  })

  it('按安装量降序、同量按名称升序', () => {
    const list: SkillMarketEntry[] = [
      { ...base, name: 'b', installs: 5 },
      { ...base, name: 'a', installs: 5 },
      { ...base, name: 'c', installs: 9 }
    ]
    expect(sortEntries(list).map((e) => e.name)).toEqual(['c', 'a', 'b'])
  })
})

describe('validateInstallTarget（拼命令行前的白名单闸门）', () => {
  it('合法 installId 通过', () => {
    expect(validateInstallTarget('pdf-tools@claude-plugins-official')).toBeNull()
    expect(validateInstallTarget('a.b_c-d@m')).toBeNull()
  })

  it('缺段/多段/空段/注入字符一律拒绝', () => {
    for (const bad of [
      'noat',
      'a@b@c',
      '@market',
      'name@',
      'a b@m',
      'a@b c',
      'a&calc@m',
      'a@m|calc',
      'a@m;rm',
      'a@m$x',
      'a@m\u0000',
      'a'.repeat(300) + '@m'
    ]) {
      expect(validateInstallTarget(bad), bad).not.toBeNull()
    }
  })

  it('非字符串参数拒绝', () => {
    expect(validateInstallTarget(undefined as unknown as string)).not.toBeNull()
    expect(validateInstallTarget(42 as unknown as string)).not.toBeNull()
  })
})

describe('SkillMarket（读本机 marketplace 目录）', () => {
  let home: string
  let official: string
  let superpowers: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cwb-market-'))
    official = makeMarketplace(home, 'claude-plugins-official', [
      { name: 'pdf-tools', description: 'PDF 处理', category: 'docs', author: { name: 'alice' } },
      { name: 'code-review', description: 'Review diffs', category: 'dev', author: { name: 'bob' } },
      { name: 'bad name', description: '非法名应被丢弃' }
    ])
    superpowers = makeMarketplace(home, 'superpowers', [
      { name: 'brainstorm', description: '头脑风暴', category: 'thinking', author: { name: 'carol' } }
    ])
    writeKnown(home, { 'claude-plugins-official': official, superpowers })
    writeCounts(home, [
      { plugin: 'code-review@claude-plugins-official', unique_installs: 500 },
      { plugin: 'brainstorm@superpowers', unique_installs: 50 }
    ])
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('listMarketplaces：名称 + 条目数（非法名不计入），按名称排序', () => {
    const market = new SkillMarket({ home })
    expect(market.listMarketplaces()).toEqual([
      { name: 'claude-plugins-official', count: 2 },
      { name: 'superpowers', count: 1 }
    ])
  })

  it('listAll：合并全部 marketplace，补安装量，按安装量降序', () => {
    const market = new SkillMarket({ home })
    const all = market.listAll()
    expect(all.map((e) => e.installId)).toEqual([
      'code-review@claude-plugins-official',
      'brainstorm@superpowers',
      'pdf-tools@claude-plugins-official'
    ])
    expect(all[0]?.installs).toBe(500)
    expect(all[2]?.installs).toBe(0) // 无计数记录 → 0
  })

  it('search：关键词过滤 + marketplace 过滤 + limit', () => {
    const market = new SkillMarket({ home })
    expect(market.search('pdf').map((e) => e.name)).toEqual(['pdf-tools'])
    expect(market.search('', 'superpowers').map((e) => e.name)).toEqual(['brainstorm'])
    expect(market.search('', undefined, 1)).toHaveLength(1)
    expect(market.search('nothing-here')).toEqual([])
  })

  it('.staging marketplace 不展示（CLI 临时检出）', () => {
    const staging = makeMarketplace(home, 'foo.staging', [{ name: 'ghost', description: '' }])
    writeKnown(home, { 'claude-plugins-official': official, 'foo.staging': staging })
    const market = new SkillMarket({ home })
    expect(market.listAll().some((e) => e.name === 'ghost')).toBe(false)
    expect(market.listMarketplaces().map((m) => m.name)).toEqual(['claude-plugins-official'])
  })

  it('known_marketplaces.json 缺失/损坏 / 目录不存在 → 空结果（不抛）', () => {
    const empty = new SkillMarket({ home: join(home, 'nope') })
    expect(empty.listAll()).toEqual([])
    expect(empty.listMarketplaces()).toEqual([])

    writeKnown(home, { missing: join(home, 'does-not-exist') })
    const market = new SkillMarket({ home })
    expect(market.listAll()).toEqual([])
    expect(market.listMarketplaces()).toEqual([])
  })
})