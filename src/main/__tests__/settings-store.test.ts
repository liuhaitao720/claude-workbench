import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '../../shared/types'
import { AppSettingsStore } from '../settings-store'

/**
 * v0.9/v1.2.0 应用设置（userData/settings.json）：默认值、patch 合并落盘、
 * language 往返（main 侧托盘/退出确认文案语言的事实源）、onChange 旁路。
 */

describe('AppSettingsStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cwb-settings-'))
    file = join(dir, 'settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('文件缺失 → 默认值（托盘常驻 / 不自启 / 中文）', () => {
    const store = new AppSettingsStore(file)
    expect(store.get()).toEqual({ closeToTray: true, launchAtLogin: false, language: 'zh', autoUpdate: true })
  })

  it('patch 合并并落盘；再次 load 读回（含 language）', () => {
    const store = new AppSettingsStore(file)
    store.set({ language: 'en' })
    store.set({ launchAtLogin: true })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as AppSettings
    expect(saved).toEqual({ closeToTray: true, launchAtLogin: true, language: 'en', autoUpdate: true })
    // 新实例（等价于重启）读回同一组值
    expect(new AppSettingsStore(file).get()).toEqual({
      closeToTray: true,
      launchAtLogin: true,
      language: 'en',
      autoUpdate: true
    })
  })

  it('损坏文件/非法 language → 回落默认（不抛）', () => {
    writeFileSync(file, '{ not json')
    expect(new AppSettingsStore(file).get().language).toBe('zh')
    writeFileSync(file, JSON.stringify({ language: 'fr', closeToTray: 'yes' }))
    expect(new AppSettingsStore(file).get()).toEqual({
      closeToTray: true,
      launchAtLogin: false,
      language: 'zh',
      autoUpdate: true
    })
  })

  it('onChange 旁路：每次 set 收到全量设置（托盘语言刷新用）', () => {
    const onChange = vi.fn()
    const store = new AppSettingsStore(file, onChange)
    store.set({ language: 'en' })
    expect(onChange).toHaveBeenCalledWith({ closeToTray: true, launchAtLogin: false, language: 'en', autoUpdate: true })
  })

  it('get() 返回副本（调用方改动不污染缓存）', () => {
    const store = new AppSettingsStore(file)
    const a = store.get()
    a.language = 'en'
    expect(store.get().language).toBe('zh')
  })
})