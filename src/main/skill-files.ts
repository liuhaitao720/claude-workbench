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