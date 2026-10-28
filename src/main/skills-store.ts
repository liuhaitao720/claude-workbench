import { cpSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { shell } from 'electron'
import type { SkillInfo } from '../shared/types'
import { translate } from '../shared/i18n'
import { mainLanguage } from './language'
import { describeSkillDir, parseSkillFrontmatter, scanSkillDirs } from './skill-files'
import { PluginSkills } from './plugin-skills'

/** v1.2.0 错误文案按当前界面语言取（main 进程级语言，renderer 启动/切换时同步） */
function tr(key: Parameters<typeof translate>[1], params: Record<string, string>): string {
  return translate(mainLanguage(), key, params)
}

export { parseSkillFrontmatter }

/**
 * v0.5③ skill 扫描/导入/移除（main 侧）。
 *
 * 扫描三级来源（v1.2.1 补第三级）：
 * - 用户级 %USERPROFILE%\.claude\skills（全局生效）
 * - 项目级 <项目dir>\.claude\skills（仅该项目会话生效）
 * - 插件级 ~/.claude/plugins/cache/<marketplace>/<plugin>/<版本>/skills（见 plugin-skills）
 *
 * 第三级是用户报障「在线搜索装完，已安装列表里没有」的修复：`claude plugin install`
 * 从不往 ~/.claude/skills 复制文件，插件技能落在自己的 cache 目录，v0.5 的两个根
 * 天然扫不到，所以装成功后重启也看不见。
 *
 * 解析 SKILL.md frontmatter（name/description/version/author），容忍缺字段（name
 * 缺省用目录名）与超长 description（截断至 120 字）。
 *
 * 移除走 Electron shell.trashItem()（回收站，非永久删除——终版评审高2）；
 * 删除前 realpathSync 解析真实路径并校验必须严格位于对应 skills 根之下
 * （防 junction/symlink 越界把任意目录送进回收站）。插件来源不可走这条路——
 * 它的目录归 claude 插件机制管，删除会破坏插件的一致性。
 */

export interface SkillsStoreOptions {
  /** 用户级 skills 根（缺省 CWB_SKILLS_USER_ROOT 环境缝 → %USERPROFILE%\.claude\skills；测试注入 temp） */
  userRoot?: () => string
  /** 已注册项目快照（项目级扫描与 import/remove 归属校验的 dir 来源；缺省空） */
  projects?: () => ReadonlyArray<{ id: string; dir: string }>
  /** 插件 skill 来源（缺省按真实 ~/.claude；测试注入 temp 主目录） */
  pluginSkills?: PluginSkills
}

function defaultUserRoot(): string {
  return process.env['CWB_SKILLS_USER_ROOT'] ?? join(homedir(), '.claude', 'skills')
}

export class SkillsStore {
  private readonly pluginSkills: PluginSkills

  constructor(private readonly opts: SkillsStoreOptions = {}) {
    this.pluginSkills = opts.pluginSkills ?? new PluginSkills()
  }

  private userRoot(): string {
    return this.opts.userRoot?.() ?? defaultUserRoot()
  }

  private projects(): ReadonlyArray<{ id: string; dir: string }> {
    return this.opts.projects?.() ?? []
  }

  /** 全部 skill（用户级 + 项目级 + 插件级；目录缺失/无 SKILL.md 的条目跳过） */
  list(): SkillInfo[] {
    const out: SkillInfo[] = scanSkillDirs(this.userRoot()).map((dir) =>
      describeSkillDir(dir, 'user')
    )
    for (const project of this.projects()) {
      for (const dir of scanSkillDirs(join(project.dir, '.claude', 'skills'))) {
        out.push(describeSkillDir(dir, 'project', project.id))
      }
    }
    out.push(...this.pluginSkills.list())
    return out
  }

  /** 项目 scope 的 skills 根（项目记录缺失报错——归属校验无从谈起） */
  private rootForScope(scope: 'user' | 'project', projectId?: string): string {
    if (scope === 'user') return this.userRoot()
    const project = this.projects().find((p) => p.id === projectId)
    if (!project) throw new Error(`project not found: ${projectId ?? '(missing)'}`)
    return join(project.dir, '.claude', 'skills')
  }

  /**
   * 导入本地 skill 文件夹：整目录复制（fs.cp recursive）到目标 scope 的 skills 根；
   * 同名（目标已存在同名目录）冲突抛错——不静默覆盖；返回新 skill 元信息。
   */
  importSkillFolder(
    fromDir: string,
    target: { scope: 'user' | 'project'; projectId?: string }
  ): SkillInfo {
    let stat
    try {
      stat = statSync(fromDir)
    } catch {
      throw new Error(tr('skills.errSrcMissing', { dir: fromDir }))
    }
    if (!stat.isDirectory()) throw new Error(tr('skills.errSrcNotDir', { dir: fromDir }))
    if (!existsSync(join(fromDir, 'SKILL.md'))) {
      throw new Error(tr('skills.errNoSkillMd', { dir: fromDir }))
    }
    const root = this.rootForScope(target.scope, target.projectId)
    const dest = join(root, basename(fromDir))
    if (existsSync(dest)) {
      throw new Error(tr('skills.errConflict', { name: basename(fromDir) }))
    }
    mkdirSync(root, { recursive: true })
    cpSync(fromDir, dest, { recursive: true })
    return describeSkillDir(dest, target.scope, target.projectId)
  }

  /**
   * 移除 skill（回收站）：realpathSync 解析 dir 与对应 skills 根的真实路径，
   * 校验 dir 必须严格位于根之下（含 junction/symlink 解析后的真实落点），
   * 通过后 shell.trashItem()（可从回收站找回，非永久删除）。
   * 插件来源拒绝——那会拆坏插件的目录结构，应由 claude plugin uninstall 处理。
   */
  async removeSkill(skill: SkillInfo): Promise<void> {
    if (skill.source === 'plugin') throw new Error(tr('skills.errPluginRemove', { id: skill.pluginId ?? '' }))
    const root = this.rootForScope(skill.source, skill.projectId)
    let realDir: string
    let realRoot: string
    try {
      realDir = realpathSync(skill.dir)
      realRoot = realpathSync(root)
    } catch {
      throw new Error(tr('skills.errDirGone', { dir: skill.dir }))
    }
    if (!isStrictlyUnder(realDir, realRoot)) {
      throw new Error(tr('skills.errOutOfRoot', { dir: skill.dir }))
    }
    await shell.trashItem(realDir)
  }
}

/** child 必须严格位于 root 之下（child===root 拒绝——防整个 skills 根被删）；win32 大小写不敏感比较 */
function isStrictlyUnder(child: string, root: string): boolean {
  const normalize = (p: string): string =>
    (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '')
  const c = normalize(child)
  const r = normalize(root)
  return c.startsWith(r + sep)
}