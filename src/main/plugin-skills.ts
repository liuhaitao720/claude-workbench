import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { SkillInfo } from '../shared/types'
import { describeSkillDir, isSkillDir, scanSkillDirs } from './skill-files'
import {
  activationOf,
  MAX_DESCRIPTION_LENGTH,
  parseSkillActivation,
  parseSkillFrontmatter
} from './skill-files'
import { posixQuote, remoteHomeOf } from './cli-runner'
import type { ConnectionManager } from './ssh/connection-manager'

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

  // ── S5 远端读侧（6.1=a）：registry/settings/manifest 经 RemoteClaudeHomeReader ──

  /** 远端已安装插件 id 全集（启用/停用白名单来源——远程上下文经 SSH 校验） */
  async installedIdsRemote(reader: RemoteClaudeHomeReader): Promise<string[]> {
    const registry = parseJsonOrNull<{ plugins?: unknown }>(
      await reader.readTextFile(`${reader.home}/.claude/plugins/installed_plugins.json`)
    )
    const plugins = registry?.plugins
    if (typeof plugins !== 'object' || plugins === null) return []
    return Object.keys(plugins as Record<string, unknown>).filter(isValidPluginId)
  }

  /** 远端全部插件 skill（与本机 list() 同语义：多 scope 去重、停用标注、manifest 声明路径越界丢弃） */
  async listRemote(reader: RemoteClaudeHomeReader): Promise<SkillInfo[]> {
    const registry = parseJsonOrNull<{ plugins?: unknown }>(
      await reader.readTextFile(`${reader.home}/.claude/plugins/installed_plugins.json`)
    )
    const plugins = registry?.plugins
    if (typeof plugins !== 'object' || plugins === null) return []
    const enabled = await this.enabledPluginsRemote(reader)
    const seen = new Set<string>()
    const out: SkillInfo[] = []
    for (const [pluginId, raw] of Object.entries(plugins as Record<string, unknown>)) {
      if (!isValidPluginId(pluginId)) continue
      for (const entry of entriesOf(raw)) {
        if (typeof entry.installPath !== 'string' || entry.installPath === '') continue
        for (const skill of await this.discoverRemote(reader, entry.installPath, pluginId, enabled.has(pluginId))) {
          const key = skill.dir.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          out.push(skill)
        }
      }
    }
    return out
  }

  /** 远端插件检出目录下的技能（标准 skills/* + manifest 声明路径——目录存在性/越界校验同本机） */
  private async discoverRemote(
    reader: RemoteClaudeHomeReader,
    installPath: string,
    pluginId: string,
    pluginEnabled: boolean
  ): Promise<SkillInfo[]> {
    const dirs = new Set<string>()
    const skillsRoot = `${installPath}/skills`
    if (await reader.exists(skillsRoot)) {
      for (const name of await reader.listDirs(skillsRoot)) dirs.add(`${skillsRoot}/${name}`)
    }
    for (const declared of await this.declaredSkillPathsRemote(reader, installPath)) {
      if (await reader.exists(`${declared}/SKILL.md`)) dirs.add(declared)
      else for (const name of await reader.listDirs(declared)) dirs.add(`${declared}/${name}`)
    }
    const out: SkillInfo[] = []
    for (const dir of dirs) {
      const text = await reader.readTextFile(`${dir}/SKILL.md`)
      if (text === null) continue // 无 SKILL.md 的目录不是 skill（同 scanSkillDirs+isSkillDir）
      out.push({ ...describeSkillFromText(dir, 'plugin', text), pluginId, pluginEnabled })
    }
    return out
  }

  /** 远端 plugin.json 的 skills 声明（越界声明丢弃——manifest 属外部不可信输入，同本机） */
  private async declaredSkillPathsRemote(
    reader: RemoteClaudeHomeReader,
    installPath: string
  ): Promise<string[]> {
    const manifest = parseJsonOrNull<{ skills?: unknown }>(
      await reader.readTextFile(`${installPath}/.claude-plugin/plugin.json`)
    )
    const raw = manifest?.skills
    const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
    const root = posixResolve(installPath)
    const out: string[] = []
    for (const item of list) {
      if (typeof item !== 'string' || item.trim() === '') continue
      // 与本机 node:path.resolve 同语义：绝对声明路径替换 root（→ 越界被下方校验拒绝）
      const abs = item.startsWith('/') ? posixResolve(item) : posixResolve(`${root}/${item}`)
      if (abs !== root && abs.startsWith(`${root}/`) && (await reader.exists(abs))) {
        out.push(abs)
      }
    }
    return out
  }

  /** 远端 settings.json 的 enabledPlugins */
  private async enabledPluginsRemote(reader: RemoteClaudeHomeReader): Promise<Set<string>> {
    const settings = parseJsonOrNull<{ enabledPlugins?: unknown }>(
      await reader.readTextFile(`${reader.home}/.claude/settings.json`)
    )
    const map = settings?.enabledPlugins
    const out = new Set<string>()
    if (typeof map !== 'object' || map === null) return out
    for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
      if (value === true && isValidPluginId(id)) out.add(id)
    }
    return out
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

/** 远端读侧 JSON 解析（readJson 的文本入参版——文本为 null/损坏 → null） */
function parseJsonOrNull<T>(text: string | null): T | null {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** POSIX 路径归一（'.'/'..' 折叠，不加盘符——远端声明路径越界校验用；Windows 客户端上 node:path.resolve 会按 win32 语义失真） */
function posixResolve(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return `${abs ? '' : '/'}${out.join('/')}`
}
// ── S5 远端 ~/.claude 读侧（6.1=a：skills/插件清单/市场共用的最小只读面）──────

/**
 * 远端 ~/.claude 只读数据源（S5 6.1=a）。定义为 exec/find/cat 命令面（全部
 * /usr/bin 标准件——无 nvm PATH 依赖，不包 bash -ic）；skills-store/skill-market
 * 经此读取 VM 侧目录，本机模式不经此（行为不变）。
 * 放在 plugin-skills（skills 两模块的下层，无反向依赖）——避免 skills-store ↔
 * plugin-skills 值级循环。
 */
export interface RemoteClaudeHomeReader {
  /** 远端 $HOME（~/.claude 前缀由此拼出） */
  readonly home: string
  /** 列 dir 的一层子目录名（目录/symlink 目录；不存在/失败 → 空） */
  listDirs(dir: string): Promise<string[]>
  /** 路径存在性（文件或目录） */
  exists(path: string): Promise<boolean>
  /** 读文本文件（失败/不存在 → null） */
  readTextFile(path: string): Promise<string | null>
}

/** 打开远端读侧：解析 $HOME 后返回带 home 的 reader（每次调用现开——无失效缓存问题） */
export async function openRemoteClaudeHome(
  connection: ConnectionManager,
  connectionId: string
): Promise<RemoteClaudeHomeReader> {
  const home = await remoteHomeOf(connection, connectionId)
  const exec = (command: string): Promise<{ code: number; stdout: string; stderr: string }> =>
    connection.exec(connectionId, command)
  return {
    home,
    async listDirs(dir) {
      // \( -type d -o -type l \)：目录与 symlink 目录（与 scanSkillDirs 的受理面一致）
      const r = await exec(
        `find ${posixQuote(dir)} -mindepth 1 -maxdepth 1 \\( -type d -o -type l \\) -printf '%f\\n'`
      )
      if (r.code !== 0) return []
      return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    },
    async exists(path) {
      try {
        return (await exec(`test -e ${posixQuote(path)}`)).code === 0
      } catch {
        return false
      }
    },
    async readTextFile(path) {
      const r = await exec(`cat ${posixQuote(path)}`)
      return r.code === 0 ? r.stdout : null
    }
  }
}

/**
 * SKILL.md 原文 → SkillInfo（远端描述；与 skill-files.describeSkillDir 同语义——
 * frontmatter/激活方式/截断全一致，仅数据源从本机 fs 换为已取回的文本）。
 */
export function describeSkillFromText(
  dir: string,
  source: SkillInfo['source'],
  text: string,
  projectId?: string
): SkillInfo {
  const frontmatter = parseSkillFrontmatter(text)
  return {
    name: frontmatter['name']?.trim() || posixBasename(dir),
    description: (frontmatter['description'] ?? '').slice(0, MAX_DESCRIPTION_LENGTH),
    ...(frontmatter['version'] ? { version: frontmatter['version'] } : {}),
    ...(frontmatter['author'] ? { author: frontmatter['author'] } : {}),
    source,
    ...(source === 'project' && projectId !== undefined ? { projectId } : {}),
    activation: activationOf(parseSkillActivation(text)),
    dir
  }
}

/** POSIX basename（远端路径恒 / 分隔——Windows 客户端上 node:path.win32.basename 会失真） */
function posixBasename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] !== '' ? parts[parts.length - 1]! : parts[parts.length - 2] ?? p
}
