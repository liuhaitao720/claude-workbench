import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AppSettings } from '../shared/types'

export interface AppSettingsChange {
  (settings: AppSettings): void
}

/**
 * v0.9 应用设置存储（NotifyService 先例：userData/settings.json 原子写+容错 load）。
 * closeToTray 默认 true（v0.5⑥ 行为不变）；launchAtLogin 默认 false。
 * v1.2.0 增加 language（仅 main 侧托盘/退出确认取文案用，界面的权威在 renderer）。
 * SSH 远程模式（S1 批0）新增侧栏持久化键：sidebarWidth/sidebarCollapsedPersist/
 * serverNodesCollapsed——main 侧仅容错存取不解释（消费在 S6 renderer），缺省不落键
 * =既有行为不变（照 proxyAutoStart 条件展开先例）。
 */

/** filesPanelPath 形状校验：Record<string, string>（连接档案 id → 远端路径） */
function isFilesPanelPath(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
}

/** serverNodesCollapsed 形状校验：Record<string, boolean>（连接档案 id → 折叠态） */
function isServerNodesCollapsed(v: unknown): v is Record<string, boolean> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'boolean')
}

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
      autoUpdate: false
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
          autoUpdate: typeof rec['autoUpdate'] === 'boolean' ? rec['autoUpdate'] : false,
          // v1.4 本地代理随应用启动（缺省不开）
          ...(typeof rec['proxyAutoStart'] === 'boolean' ? { proxyAutoStart: rec['proxyAutoStart'] } : {}),
          // SSH 远程模式侧栏持久化键（S1 批0；S6 消费——缺省不落键=现行为）
          ...(typeof rec['sidebarWidth'] === 'number' && Number.isFinite(rec['sidebarWidth'])
            ? { sidebarWidth: rec['sidebarWidth'] }
            : {}),
          ...(typeof rec['sidebarCollapsedPersist'] === 'boolean'
            ? { sidebarCollapsedPersist: rec['sidebarCollapsedPersist'] }
            : {}),
          ...(isServerNodesCollapsed(rec['serverNodesCollapsed'])
            ? { serverNodesCollapsed: { ...rec['serverNodesCollapsed'] } }
            : {}),
          // v2.0 文件面板目录记忆（Record<cid, string>——同 serverNodesCollapsed 容错口径）
          ...(isFilesPanelPath(rec['filesPanelPath']) ? { filesPanelPath: { ...rec['filesPanelPath'] } } : {}),
          // v2.0.1 侧栏作用域（字符串窄集——非法值落 all 由消费点归一，此处只保结构）
          ...(typeof rec['sidebarScope'] === 'string' ? { sidebarScope: rec['sidebarScope'] } : {}),
          // v2.0 下载落位三键（缺省不落键=现行为：direct + 默认目录 + 按连接分档）
          ...(typeof rec['downloadDir'] === 'string' ? { downloadDir: rec['downloadDir'] } : {}),
          ...(rec['downloadMode'] === 'ask' ? { downloadMode: 'ask' as const } : {}),
          ...(typeof rec['downloadPerConnection'] === 'boolean'
            ? { downloadPerConnection: rec['downloadPerConnection'] }
            : {})
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
