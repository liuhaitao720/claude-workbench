import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AppSettings } from '../shared/types'

export interface AppSettingsChange {
  (settings: AppSettings): void
}

/**
 * v0.9 应用设置存储（NotifyService 先例：userData/settings.json 原子写+容错 load）。
 * closeToTray 默认 true（v0.5⑥ 行为不变）；launchAtLogin 默认 false。
 * v1.2.0 增加 language（仅 main 侧托盘/退出确认取文案用，界面的权威在 renderer）。
 */
export class AppSettingsStore {
  private cache: AppSettings | null = null

  constructor(
    private readonly file: string,
    private readonly onChange?: AppSettingsChange
  ) {}

  get(): AppSettings {
    if (this.cache) return { ...this.cache }
    let settings: AppSettings = {
      closeToTray: true,
      launchAtLogin: false,
      language: 'zh',
      autoUpdate: true
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const rec = parsed as Record<string, unknown>
        settings = {
          closeToTray: typeof rec['closeToTray'] === 'boolean' ? rec['closeToTray'] : true,
          launchAtLogin: typeof rec['launchAtLogin'] === 'boolean' ? rec['launchAtLogin'] : false,
          language: rec['language'] === 'en' ? 'en' : 'zh',
          // v1.2.1 缺省开启（用户要求升级无需手动点按钮；想要手动的人可在设置里关）
          autoUpdate: typeof rec['autoUpdate'] === 'boolean' ? rec['autoUpdate'] : true
        }
      }
    } catch {
      // 缺失/损坏 → 默认
    }
    this.cache = settings
    return { ...settings }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch }
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, this.file)
    this.cache = next
    this.onChange?.(next)
    return { ...next }
  }
}
