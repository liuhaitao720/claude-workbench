import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SkillInfo } from '../shared/types'

/**
 * skill 目录的纯文件系统工具（v1.2.1 从 skills-store 抽出）。
 *
 * 抽出的原因：插件里的 skill（~/.claude/plugins/cache/…）与用户级/项目级 skill
 * 是同一套目录形态与 frontmatter 解析，但两个读取器分属不同模块——公共部分放这里，
 * 避免 skills-store ↔ plugin-skills 互相依赖。
 */

/** description 截断上限（v0.5③：SKILL.md 实测存在 ~500 字单行，列表只显示前 120 字） */
export const MAX_DESCRIPTION_LENGTH = 120

/** frontmatter 中采纳的字段（其余忽略） */
const FRONTMATTER_FIELDS = ['name', 'description', 'version', 'author'] as const

/** frontmatter 里控制「怎么被调用」的键（见 parseSkillActivation） */
export interface SkillActivationFlags {
  /** disable-model-invocation: true —— 模型不能用 Skill 工具自动调用，只能用户输入 /name */
  disableModelInvocation: boolean
  /** user-invocable: false —— 用户看不到斜杠命令，只有模型能自动调用 */
  userInvocable: boolean
  /** paths: 存在 —— 只有模型触及相关文件时才加载 */
  hasPaths: boolean
}

/**
 * 从 SKILL.md 原文解析调用方式（v1.2.1）。
 *
 * 语义依据 claude CLI 的 skill manifest schema：
 * - `disable-model-invocation: true` → "the model cannot invoke this via the Skill
 *   tool; only users can type the slash command"
 * - `user-invocable: false` → "hides the slash command from users; only the model
 *   can invoke it via the Skill tool"
 * - `paths` → glob；"The skill only loads when the model touches matching files"
 *
 * 三者可组合，优先级取「最需要用户显式操作」的那一档（见 activationOf）。
 */
export function parseSkillActivation(text: string): SkillActivationFlags {
  // 直接扫 frontmatter 原文（parseSkillFrontmatter 只保留展示字段，不含调用控制键）
  const raw = new Map<string, string>()
  if (text.startsWith('---')) {
    const lines = text.split(/\r?\n/)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '---' || line.trim() === '...') break
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
      if (m) raw.set(m[1] ?? '', (m[2] ?? '').trim())
    }
  }
  return {
    disableModelInvocation: raw.get('disable-model-invocation') === 'true',
    // 缺省 true（只有显式 false 才隐藏斜杠命令）
    userInvocable: raw.get('user-invocable') !== 'false',
    // paths 可以是列表（多行 - xxx）：只要出现该键就按「按文件生效」处理
    hasPaths: raw.has('paths')
  }
}

/**
 * 调用方式归一为一档（供 UI 排序与标注）：
 * - manual：模型不会自动用，必须用户输入 /name（最需要显式指定）
 * - paths：自动，但只在触及相关文件时加载
 * - modelOnly：模型自动调用，用户看不到斜杠命令
 * - auto：默认——模型会自动调用，用户也能 /name 手动触发
 */
export function activationOf(flags: SkillActivationFlags): 'auto' | 'paths' | 'modelOnly' | 'manual' {
  if (flags.disableModelInvocation) return 'manual'
  if (flags.hasPaths) return 'paths'
  if (!flags.userInvocable) return 'modelOnly'
  return 'auto'
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

/** 目录是否是 skill（含 SKILL.md） */
export function isSkillDir(dir: string): boolean {
  return existsSync(join(dir, 'SKILL.md'))
}

/**
 * 扫描单个 skills 根的一层子目录（目录缺失 → 空列表）。
 * 只识别「目录内含 SKILL.md」形态；符号链接目录也接受（归属校验在 removeSkill 侧兜底）。
 */
export function scanSkillDirs(root: string): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    // 跳过 zip 文件形态（如打包分发的 .skill 压缩包）与非目录条目
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    if (isSkillDir(dir)) out.push(dir)
  }
  return out
}

/** 由目录与 SKILL.md（可缺失）构造 SkillInfo；description 超长截断至 120 字 */
export function describeSkillDir(
  dir: string,
  source: SkillInfo['source'],
  projectId?: string
): SkillInfo {
  let text = ''
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    // SKILL.md 读取失败按缺字段处理（name 用目录名，调用方式按默认「自动」）
  }
  const frontmatter = parseSkillFrontmatter(text)
  const rawDescription = frontmatter['description'] ?? ''
  return {
    name: frontmatter['name']?.trim() || basename(dir),
    description: rawDescription.slice(0, MAX_DESCRIPTION_LENGTH),
    ...(frontmatter['version'] ? { version: frontmatter['version'] } : {}),
    ...(frontmatter['author'] ? { author: frontmatter['author'] } : {}),
    source,
    ...(source === 'project' && projectId ? { projectId } : {}),
    // v1.2.1：调用方式让用户判断「这条要不要我手动点名」——见 activationOf
    activation: activationOf(parseSkillActivation(text)),
    dir
  }
}