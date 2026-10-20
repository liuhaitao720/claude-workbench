import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { shell } from 'electron'
import type { SkillInfo } from '../shared/types'

/**
 * v0.5③ skill 扫描/导入/移除（main 侧）。
 *
 * 只读扫描两级来源：用户级 %USERPROFILE%\.claude\skills（全局生效）与
 * 项目级 <项目dir>\.claude\skills（仅该项目会话生效）。解析 SKILL.md frontmatter
 * （name/description/version/author），容忍缺字段（name 缺省用目录名）与超长
 * description（截断至 120 字）。
 *
 * 移除走 Electron shell.trashItem()（回收站，非永久删除——终版评审高2）；
 * 删除前 realpathSync 解析真实路径并校验必须严格位于对应 skills 根之下
 * （防 junction/symlink 越界把任意目录送进回收站）。
 */

/** description 截断上限（v0.5③：SKILL.md 实测存在 ~500 字单行，列表只显示前 120 字） */
const MAX_DESCRIPTION_LENGTH = 120

/** frontmatter 中采纳的字段（其余忽略） */
const FRONTMATTER_FIELDS = ['name', 'description', 'version', 'author'] as const

export interface SkillsStoreOptions {
  /** 用户级 skills 根（缺省 CWB_SKILLS_USER_ROOT 环境缝 → %USERPROFILE%\.claude\skills；测试注入 temp） */
  userRoot?: () => string
  /** 已注册项目快照（项目级扫描与 import/remove 归属校验的 dir 来源；缺省空） */
  projects?: () => ReadonlyArray<{ id: string; dir: string }>
}

function defaultUserRoot(): string {
  return process.env['CWB_SKILLS_USER_ROOT'] ?? join(homedir(), '.claude', 'skills')
}

/** 解析 SKILL.md frontmatter（容忍缺失/空文件；仅取单行 key: value 形态） */
export function parseSkillFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!text.startsWith('---')) return out
  const lines = text.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---' || line.trim() === '...') break
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match) {
      const key = match[1] ?? ''
      if ((FRONTMATTER_FIELDS as readonly string[]).includes(key)) out[key] = (match[2] ?? '').trim()
    }
  }
  return out
}

export class SkillsStore {
  constructor(private readonly opts: SkillsStoreOptions = {}) {}

  private userRoot(): string {
    return this.opts.userRoot?.() ?? defaultUserRoot()
  }

  private projects(): ReadonlyArray<{ id: string; dir: string }> {
    return this.opts.projects?.() ?? []
  }

  /** 全部 skill（用户级 + 全部项目级；目录缺失/无 SKILL.md 的条目跳过） */
  list(): SkillInfo[] {
    const out: SkillInfo[] = [...scanRoot(this.userRoot(), 'user')]
    for (const project of this.projects()) {
      out.push(...scanRoot(join(project.dir, '.claude', 'skills'), 'project', project.id))
    }
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
      throw new Error(`源文件夹不存在: ${fromDir}`)
    }
    if (!stat.isDirectory()) throw new Error(`源路径不是文件夹: ${fromDir}`)
    if (!existsSync(join(fromDir, 'SKILL.md'))) {
      throw new Error(`所选文件夹缺少 SKILL.md（不是有效 skill 目录）: ${fromDir}`)
    }
    const root = this.rootForScope(target.scope, target.projectId)
    const dest = join(root, basename(fromDir))
    if (existsSync(dest)) {
      throw new Error(`同名 skill 已存在，导入取消（如需覆盖请先移除既有项）: ${basename(fromDir)}`)
    }
    mkdirSync(root, { recursive: true })
    cpSync(fromDir, dest, { recursive: true })
    return describeSkillDir(dest, target.scope, target.projectId)
  }

  /**
   * 移除 skill（回收站）：realpathSync 解析 dir 与对应 skills 根的真实路径，
   * 校验 dir 必须严格位于根之下（含 junction/symlink 解析后的真实落点），
   * 通过后 shell.trashItem()（可从回收站找回，非永久删除）。
   */
  async removeSkill(skill: SkillInfo): Promise<void> {
    const root = this.rootForScope(skill.source, skill.projectId)
    let realDir: string
    let realRoot: string
    try {
      realDir = realpathSync(skill.dir)
      realRoot = realpathSync(root)
    } catch {
      throw new Error(`skill 目录不存在或不可解析: ${skill.dir}`)
    }
    if (!isStrictlyUnder(realDir, realRoot)) {
      throw new Error(`拒绝移除：目录不在对应 skills 根之下（越界防护）: ${skill.dir}`)
    }
    await shell.trashItem(realDir)
  }
}

/** 扫描单个 skills 根（目录缺失 → 空列表） */
function scanRoot(root: string, source: 'user' | 'project', projectId?: string): SkillInfo[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const entry of entries) {
    // 跳过 zip 文件形态（如打包分发的 .skill 压缩包）与非目录条目——仅识别「目录内含 SKILL.md」形态；
    // 符号链接目录（isSymbolicLink）也接受，归属校验在 removeSkill 的 realpath 侧兜底
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    const skillMd = join(dir, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    out.push(describeSkillDir(dir, source, projectId))
  }
  return out
}

/** 由目录与 SKILL.md（可缺失）构造 SkillInfo；description 超长截断至 120 字 */
function describeSkillDir(dir: string, source: 'user' | 'project', projectId?: string): SkillInfo {
  let frontmatter: Record<string, string> = {}
  try {
    frontmatter = parseSkillFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  } catch {
    // SKILL.md 读取失败按缺字段处理（name 用目录名）
  }
  const rawDescription = frontmatter['description'] ?? ''
  return {
    name: frontmatter['name']?.trim() || basename(dir),
    description: rawDescription.slice(0, MAX_DESCRIPTION_LENGTH),
    ...(frontmatter['version'] ? { version: frontmatter['version'] } : {}),
    ...(frontmatter['author'] ? { author: frontmatter['author'] } : {}),
    source,
    ...(source === 'project' && projectId ? { projectId } : {}),
    dir
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
