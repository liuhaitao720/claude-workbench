import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { join as pjoin } from 'node:path'
import { ProviderStore } from '../providers-store'
import type { ProviderConfig } from '../../shared/types'

/** v1.4 ProviderStore：照 settings-store.test 三件套（默认值/落盘读回/损坏回落）+ CRUD 语义 */

function makeProvider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: '',
    name: 'GLM',
    format: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: 'sk-test',
    models: ['glm-4.6', 'glm-4.5-air'],
    defaultModel: 'glm-4.6',
    ...over
  }
}

describe('ProviderStore（providers.json CRUD）', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cwb-providers-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('默认：无文件 → 空注册表、无默认；state/list/get/getDefault 全空', () => {
    const store = new ProviderStore(base)
    expect(store.state()).toEqual({ providers: [] })
    expect(store.list()).toEqual([])
    expect(store.get('nope')).toBeUndefined()
    expect(store.getDefault()).toBeUndefined()
  })

  it('save 新增（id 空串=分配 uuid）+ 落盘读回（新实例=模拟重启）+ 原子写无 .tmp 残留', () => {
    const store = new ProviderStore(base)
    const saved = store.save(makeProvider())
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)

    const file = pjoin(base, 'providers.json')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    const disk = JSON.parse(readFileSync(file, 'utf8')) as { providers: ProviderConfig[] }
    expect(disk.providers).toHaveLength(1)
    expect(disk.providers[0]).toEqual(saved)

    const reopened = new ProviderStore(base)
    expect(reopened.get(saved.id)).toEqual(saved)
  })

  it('v1.4 proxyUrl：带代理档案落盘读回一致；load 对非法类型（非字符串）条目整条丢弃', () => {
    const file = pjoin(base, 'providers.json')
    const store = new ProviderStore(base)
    const saved = store.save(makeProvider({ proxyUrl: 'http://127.0.0.1:7890' }))
    expect(new ProviderStore(base).get(saved.id)?.proxyUrl).toBe('http://127.0.0.1:7890')

    writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { id: 'x', name: 'X', format: 'anthropic', baseUrl: 'https://x', apiKey: 'k', models: [], proxyUrl: 123 }
        ]
      }),
      'utf8'
    )
    expect(new ProviderStore(base).list()).toEqual([])
  })

  it('v1.4 slotModels：档位映射落盘读回一致；非法形态（非对象/值非字符串）整条丢弃', () => {
    const file = pjoin(base, 'providers.json')
    const store = new ProviderStore(base)
    const saved = store.save(makeProvider({ slotModels: { sonnet: 'glm-4.6', haiku: 'glm-4.5-air' } }))
    expect(new ProviderStore(base).get(saved.id)?.slotModels).toEqual({
      sonnet: 'glm-4.6',
      haiku: 'glm-4.5-air'
    })

    writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { ...makeProvider({ id: 'ok' }), slotModels: { sonnet: 's' } },
          // 非法形态用纯字面量（绕开 Partial<ProviderConfig> 类型，模拟手改坏档）
          { id: 'bad1', name: 'B1', format: 'anthropic', baseUrl: 'https://b1', apiKey: 'k', models: [], slotModels: 'nope' },
          { id: 'bad2', name: 'B2', format: 'anthropic', baseUrl: 'https://b2', apiKey: 'k', models: [], slotModels: { sonnet: 1 } }
        ]
      }),
      'utf8'
    )
    const list = new ProviderStore(base).list()
    expect(list).toHaveLength(1)
    expect(list[0].slotModels).toEqual({ sonnet: 's' })
  })

  it('save 编辑（同 id 覆盖）；remove 删除；remove 默认项时 defaultProviderId 一并清空', () => {
    const store = new ProviderStore(base)
    const a = store.save(makeProvider({ name: 'A' }))
    store.save(makeProvider({ name: 'B', format: 'openai', baseUrl: 'https://gw.example/v1' }))
    store.setDefault(a.id)
    expect(store.getDefault()?.name).toBe('A')

    store.save({ ...a, name: 'A2' })
    expect(store.get(a.id)?.name).toBe('A2')
    expect(store.list()).toHaveLength(2)

    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false) // 再删 no-op
    expect(store.getDefault()).toBeUndefined() // 默认项被删 → 默认清空
    expect(store.list().map((p) => p.name)).toEqual(['B'])
  })

  it('setDefault：空串=取消默认；不存在的 id 返回 false 不落盘', () => {
    const store = new ProviderStore(base)
    const a = store.save(makeProvider())
    expect(store.setDefault(a.id)).toBe(true)
    expect(store.state().defaultProviderId).toBe(a.id)
    expect(store.setDefault('')).toBe(true)
    expect(store.state().defaultProviderId).toBeUndefined()
    expect(store.setDefault('ghost')).toBe(false)
  })

  it('损坏文件 → 回落空注册表不抛；脏条目（缺字段/错 format）丢弃、好条目保留', () => {
    const file = pjoin(base, 'providers.json')
    writeFileSync(file, '{broken json', 'utf8')
    expect(new ProviderStore(base).list()).toEqual([])

    const good = makeProvider({ id: '11111111-1111-4111-8111-111111111111' })
    writeFileSync(
      file,
      JSON.stringify({
        providers: [
          good,
          { id: 'x', name: '缺字段' }, // 缺 format/baseUrl → 丢弃
          { id: 'y', name: 'Y', format: 'bogus', baseUrl: 'https://y', apiKey: 'k', models: [] }, // format 非法 → 丢弃
          null
        ],
        defaultProviderId: '22222222-2222-4222-8222-222222222222' // 指向不存在 → 忽略
      }),
      'utf8'
    )
    const store = new ProviderStore(base)
    expect(store.list()).toEqual([good])
    expect(store.state().defaultProviderId).toBeUndefined()
  })
})
