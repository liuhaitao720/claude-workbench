import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { SkillInfo } from '../shared/types'
import { describeSkillDir, isSkillDir, scanSkillDirs } from './skill-files'

/**
 * 插件 skill 读取（v1.2.1）。
 *
 * 用户反馈「在线搜索装完的 skill 在已安装列表里看不到，重启也不行」——根因是
 * `claude plugin install` 并不往 `~/.claude/skills` 复制任何东西，它把插件检出到
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<版本>/`，技能放在该目录的
 * `skills/<name>/SKILL.md`。v0.5 的扫描只认用户级/项目级两个根，插件目录天然扫不到，
 * 所以「装成功」与「列表有它」是两回事。
 *
 * 本模块补上第三条来源：
 * - `~/.claude/plugins/installed_plugins.json`：已安装插件及其 installPath
 * - `<installPath>/skills/*`：标准技能目录（插件 CLI 自身也是这么发现的）
 * - `<installPath>/.claude-plugin/plugin.json` 的 `skills` 字段：插件自定义技能路径
 *   （字符串或数组；外部输入，解析后必须仍在 installPath 之内才采纳）
 * - `~/.claude/settings.json` 的 `enabledPlugins`：启用状态（停用的插件在 claude
 *   会话里不生效，列表要如实标出来，否则用户以为「装了却用不上」）
 *
 * 全只读，不启进程（no-process-detect 约束）。
 */

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/

/** 插件 id 形状校验（`<plugin>@<marketplace>`；供启用/停用目标校验复用） */
export function isValidPluginId(pluginId: string): boolean {
  return PLUGIN_ID_PATTERN.test(pluginId) && pluginId.length <= 256
}

interface RegistryEntry {
  scope?: unknown
  installPath?: unknown
}

/** installed_plugins.json 兼容 v1（对象）与 v2（数组）两种条目形态 */
function entriesOf(value: unknown): RegistryEntry[] {
  if (Array.isArray(value)) return value.filter((e): e is RegistryEntry => typeof e === 'object' && e !== null)
  if (typeof value === 'object' && value !== null) return [value as RegistryEntry]
  return []
}

export interface PluginSkillsOptions {
  /** 用户主目录（缺省 CWB_SKILL_MARKET_HOME 注入缝 → homedir；测试指向 temp） */
  home?: () => string
}

export class PluginSkills {
  constructor(private readonly opts: PluginSkillsOptions = {}) {}

  private home(): string {
    return this.opts.home?.() ?? process.env['CWB_SKILL_MARKET_HOME'] ?? homedir()
  }

  /** 已安装插件 id 全集（启用/停用 IPC 的白名单来源——只允许操作真实装过的插件） */
  installedIds(): string[] {
    const registry = this.readJson<{ plugins?: unknown }>(this.registryPath())
    const plugins = registry?.plugins
    if (typeof plugins !== 'object' || plugins === null) return []
    return Object.keys(plugins as Record<string, unknown>).filter(isValidPluginId)
  }

  /** 全部插件 skill（同一插件多 scope 安装 → 按目录去重；停用插件也列出并标注状态） */
  list(): SkillInfo[] {
    const registry = this.readJson<{ plugins?: unknown }>(this.registryPath())
    const plugins = registry?.plugins
    if (typeof plugins !== 'object' || plugins === null) return []
    const enabled = this.enabledPlugins()
    const seen = new Set<string>()
    const out: SkillInfo[] = []
    for (const [pluginId, raw] of Object.entries(plugins as Record<string, unknown>)) {
      if (!isValidPluginId(pluginId)) continue
      for (const entry of entriesOf(raw)) {
        if (typeof entry.installPath !== 'string' || entry.installPath === '') continue
        for (const skill of this.discover(entry.installPath, pluginId, enabled.has(pluginId))) {
          // 同一插件同一目录可能因多 scope 记录而重复出现
          const key = skill.dir.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push(skill)
        }
      }
    }
    return out
  }

  /** 单个插件检出目录下的技能（标准 skills/* + manifest 声明路径） */
  private discover(installPath: string, pluginId: string, pluginEnabled: boolean): SkillInfo[] {
    const dirs = new Set<string>()
    for (const dir of scanSkillDirs(join(installPath, 'skills'))) dirs.add(dir)
    for (const declared of this.declaredSkillPaths(installPath)) {
      if (isSkillDir(declared)) dirs.add(declared)
      else for (const dir of scanSkillDirs(declared)) dirs.add(dir)
    }
    return [...dirs].map((dir) => ({
      ...describeSkillDir(dir, 'plugin'),
      pluginId,
      pluginEnabled
    }))
  }

  /**
   * plugin.json 的 skills 声明 → 绝对路径（保持在 installPath 之内才采纳）。
   * manifest 来自第三方仓库，属外部不可信输入；`../../` 之类的越界声明直接丢弃。
   */
  private declaredSkillPaths(installPath: string): string[] {
    const manifest = this.readJson<{ skills?: unknown }>(join(installPath, '.claude-plugin/plugin.json'))
    const raw = manifest?.skills
    const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
    const root = resolve(installPath)
    const out: string[] = []
    for (const item of list) {
      if (typeof item !== 'string' || item.trim() === '') continue
      const abs = resolve(root, item)
      if (abs !== root && abs.startsWith(root + sep) && existsSync(abs)) out.push(abs)
    }
    return out
  }

  /** settings.json 里 enabledPlugins 为 true 的插件 id */
  private enabledPlugins(): Set<string> {
    const settings = this.readJson<{ enabledPlugins?: unknown }>(join(this.home(), '.claude/settings.json'))
    const map = settings?.enabledPlugins
    const out = new Set<string>()
    if (typeof map !== 'object' || map === null) return out
    for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
      if (value === true && isValidPluginId(id)) out.add(id)
    }
    return out
  }

  private registryPath(): string {
    return join(this.home(), '.claude/plugins/installed_plugins.json')
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }
}