import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, defaultConfigPath } from '../config-store'

/** 6.4=c：配置存 VM 侧 ~/.cwb-server/config.json（测试注入临时目录） */
describe('ConfigStore', () => {
  const dirs: string[] = []
  const newDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'cwb-srv-cfg-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('缺失文件→默认空配置（不炸）', () => {
    const store = new ConfigStore(join(newDir(), 'config.json'))
    expect(store.get()).toEqual({})
  })

  it('损坏 JSON→默认空配置', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'config.json'), '{broken json', 'utf8')
    expect(new ConfigStore(join(dir, 'config.json')).get()).toEqual({})
  })

  it('set→get 回环一致；落盘持久（新实例读回）', () => {
    const dir = newDir()
    const store = new ConfigStore(join(dir, 'config.json'))
    const next = store.set({ proxyUrl: 'http://127.0.0.1:7890' })
    expect(next).toEqual({ proxyUrl: 'http://127.0.0.1:7890' })
    expect(store.get()).toEqual({ proxyUrl: 'http://127.0.0.1:7890' })
    const reloaded = new ConfigStore(join(dir, 'config.json'))
    expect(reloaded.get()).toEqual({ proxyUrl: 'http://127.0.0.1:7890' })
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(raw).toEqual({ proxyUrl: 'http://127.0.0.1:7890' })
  })

  it('patch 清键（undefined=删）与改值', () => {
    const dir = newDir()
    const store = new ConfigStore(join(dir, 'config.json'))
    store.set({ proxyUrl: 'http://a:1' })
    expect(store.set({ proxyUrl: undefined })).toEqual({})
    expect(store.set({ proxyUrl: 'http://b:2' })).toEqual({ proxyUrl: 'http://b:2' })
  })

  it('白名单字段过滤：未知字段读丢弃（防将来敏感字段被旧客户端读走）', () => {
    const dir = newDir()
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ proxyUrl: 'http://x:1', secretField: 'leak' }),
      'utf8'
    )
    const store = new ConfigStore(join(dir, 'config.json'))
    expect(store.get()).toEqual({ proxyUrl: 'http://x:1' })
  })

  it('父目录不存在时自动创建（~/.cwb-server 首次写入路径）', () => {
    const dir = newDir()
    const store = new ConfigStore(join(dir, 'nested', 'deeper', 'config.json'))
    store.set({ proxyUrl: 'http://c:3' })
    expect(readFileSync(join(dir, 'nested', 'deeper', 'config.json'), 'utf8')).toContain('http://c:3')
  })
})

describe('defaultConfigPath', () => {
  it('默认 ~/.cwb-server/config.json；CWB_SERVER_HOME 可覆写（部署/测试用）', () => {
    const prev = process.env['CWB_SERVER_HOME']
    try {
      delete process.env['CWB_SERVER_HOME']
      expect(defaultConfigPath()).toBe(join(process.env['HOME'] ?? '', '.cwb-server', 'config.json'))
      process.env['CWB_SERVER_HOME'] = '/opt/cwb-test-home'
      expect(defaultConfigPath()).toBe('/opt/cwb-test-home/config.json')
    } finally {
      if (prev !== undefined) process.env['CWB_SERVER_HOME'] = prev
      else delete process.env['CWB_SERVER_HOME']
    }
  })
})
