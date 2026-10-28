import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TaskRecord } from '../shared/types'
import { translate } from '../shared/i18n'
import { mainLanguage } from './language'
import type { ProjectStore } from './project-store'
import type { TaskStore } from './task-store'

/**
 * v0.9 S13：从 claude CLI 历史会话生成可恢复任务。
 *
 * 会话存储（实测 v2.1.301，~/.claude/projects/<munged-dir>/<sessionId>.jsonl）：
 * - munged-dir = 绝对路径中所有非字母数字字符替换为 `-`（`D:\SourceCode\agent` →
 *   `D--SourceCode-agent`；盘符冒号、反斜杠、点、下划线等一律 `-`）
 * - jsonl 每行一个 JSON 对象，type 取值 user/assistant/ai-title/summary/queue-operation/
 *   attachment/...，部分行无 type 字段；大文件（12MB+）只需头部即可命名——流式读前
 *   HEAD_LINES 行（且 HEAD_BYTES 封顶），避免全文载入
 * - 命名优先级：customTitle（-n 用户命名）> aiTitle（CLI 每轮生成的 AI 标题）>
 *   summary（压缩摘要行）> 首条真实用户消息 > `会话 <id前8位>`。实测本机 summary 行
 *   不存在而 ai-title 行普遍存在（每会话 97+/258+ 行），故 aiTitle 优先于 summary。
 *   首条真实用户消息过滤：isSidechain（子代理链）、isMeta、`<local-command-caveat>`/
 *   `<command-`/`<system-reminder>` 前缀（实测 command 行不带 isMeta，前缀过滤必须独立
 *   于 isMeta）；message.content 为数组时仅取 text 项（tool_result 是机器内容非用户输入）
 *
 * 测试注入缝：CWB_CLAUDE_PROJECTS_ROOT（同 CWB_SKILLS_USER_ROOT 先例，防扫描真实
 * ~/.claude/projects）+ opts.projectsRoot 函数注入。
 */

/** 任务名截断上限（字，按 Unicode 码点） */
const MAX_NAME_LENGTH = 40

/** 单个 jsonl 头部读取行数上限（命名所需字段实测均在首 30 行内） */
const HEAD_LINES = 200

/** 单个 jsonl 头部读取字节上限（首行可能内嵌超大 attachment，防意外全读） */
const HEAD_BYTES = 2 * 1024 * 1024

/** jsonl 头部窗口内提取的命名素材 */
export interface SessionHeadInfo {
  /** 用户命名（-n；实测未在本机出现，按顶层字段通用扫描兜底） */
  customTitle?: string
  /** CLI 生成的 AI 标题（type:'ai-title' 行，随对话演进——窗口内取最后一次） */
  aiTitle?: string
  /** 压缩摘要（type:'summary' 行；本机未出现，兼容处理） */
  summary?: string
  /** 首条真实用户消息文本 */
  firstUser?: string
  /** 头部窗口内最早 timestamp（任意行型） */
  firstTimestamp?: string
}

/** 扫描得到的会话元信息 */
export interface SessionMeta {
  /** jsonl 文件名去 .jsonl（=== 任务 id/sessionId，resume 用） */
  sessionId: string
  name: string
  /** ISO 8601（头部首条 timestamp，缺省文件 mtime） */
  createdAt: string
  /** ISO 8601（文件 mtime——jsonl 追加式写入，mtime≈最后活动时刻） */
  lastActiveAt: string
}

export interface ListSessionsOptions {
  /** claude 会话存储根（缺省 CWB_CLAUDE_PROJECTS_ROOT 缝 → ~/.claude/projects） */
  projectsRoot?: () => string
}

/** 绝对路径 → claude 会话存储目录名（所有非字母数字字符替换为 `-`，大小写保留） */
export function mungePath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

function defaultProjectsRoot(): string {
  return process.env['CWB_CLAUDE_PROJECTS_ROOT'] ?? join(homedir(), '.claude', 'projects')
}

/** user 行 message.content → 纯文本（string 直取；数组仅取 text 项，tool_result 丢弃） */
function extractUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (rec['type'] === 'text' && typeof rec['text'] === 'string') parts.push(rec['text'])
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** 非真实用户输入前缀（local-command 转述 / slash 命令回显 / 系统提醒注入） */
const NON_USER_PREFIX = /^<(local-command-caveat|command-|system-reminder)/

/** 单行 jsonl → 命名素材（解析失败/形态不符静默跳过） */
function consumeLine(rawLine: string, info: SessionHeadInfo): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const o = parsed as Record<string, unknown>
  if (info.firstTimestamp === undefined && typeof o['timestamp'] === 'string') {
    info.firstTimestamp = o['timestamp']
  }
  if (typeof o['customTitle'] === 'string' && o['customTitle'].trim() !== '') {
    info.customTitle = o['customTitle']
  }
  if (o['type'] === 'ai-title' && typeof o['aiTitle'] === 'string' && o['aiTitle'].trim() !== '') {
    info.aiTitle = o['aiTitle'] // 每轮更新，窗口内最后一次最新
  }
  if (o['type'] === 'summary' && info.summary === undefined) {
    if (typeof o['summary'] === 'string' && o['summary'].trim() !== '') info.summary = o['summary']
  }
  if (o['type'] === 'user' && info.firstUser === undefined) {
    if (o['isSidechain'] === true) return // 子代理链消息不是用户对本会话的输入
    if (o['isMeta'] === true) return // 命令转述等元信息行
    const message = o['message']
    if (typeof message !== 'object' || message === null) return
    const text = extractUserText((message as Record<string, unknown>)['content'])
    if (text === undefined || NON_USER_PREFIX.test(text)) return
    if (text.trim() !== '') info.firstUser = text
  }
}

/**
 * 流式读取 jsonl 头部（readline over createReadStream；达到行数/字节上限即销毁流，
 * 12MB 级文件只读头部若干 chunk）。流错误按已读内容收场（容错）。
 */
async function readSessionHead(
  file: string,
  maxLines: number,
  maxBytes: number
): Promise<SessionHeadInfo> {
  const info: SessionHeadInfo = {}
  const stream = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let lines = 0
  let bytes = 0
  let capped = false
  rl.on('line', (line: string) => {
    // 达到上限后同批 chunk 内拆出的剩余行不再消费（destroy/stop 对已入队行不追溯，需守卫）
    if (capped) return
    consumeLine(line, info)
    lines++
    bytes += line.length + 1
    if (lines >= maxLines || bytes >= maxBytes) {
      capped = true
      stream.destroy()
      rl.close()
    }
  })
  // rl 'close' 覆盖正常读完/上限触发/流关闭；stream 'error' 兜底读失败（resolve 幂等，二者先到先收）
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve())
    stream.on('error', () => resolve())
  })
  return info
}

/** 命名素材 → 任务名：优先级链 + 空白归一 + 控制字符剔除 + 40 字（码点）截断 */
function buildSessionName(info: SessionHeadInfo, sessionId: string): string {
  const raw = info.customTitle ?? info.aiTitle ?? info.summary ?? info.firstUser
  // v1.2.0：兜底名随界面语言（历史会话无任何命名素材时才会用到）
  const fallback = translate(mainLanguage(), 'session.defaultName', { id: sessionId.slice(0, 8) })
  if (raw === undefined) return fallback
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized === '') return fallback
  return Array.from(normalized).slice(0, MAX_NAME_LENGTH).join('')
}

/**
 * 扫描某目录的全部 claude 历史会话（存储根缺省 ~/.claude/projects，经 CWB_CLAUDE_PROJECTS_ROOT
 * 或 opts.projectsRoot 注入）。目录缺失/不可读 → 空列表；按 createdAt 升序（稳定输出）。
 */
export async function listSessions(
  dir: string,
  opts: ListSessionsOptions = {}
): Promise<SessionMeta[]> {
  const root = join(opts.projectsRoot?.() ?? defaultProjectsRoot(), mungePath(dir))
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // 无会话目录（从未在该目录跑过 claude）
  }
  const out: SessionMeta[] = []
  for (const entry of entries) {
    // 仅 *.jsonl 文件——同会话名的子目录与 memory/ 等目录不是会话
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const sessionId = entry.name.slice(0, -'.jsonl'.length)
    if (sessionId === '') continue
    let mtimeMs: number
    try {
      mtimeMs = statSync(join(root, entry.name)).mtimeMs
    } catch {
      continue // 列目录与 stat 之间文件消失（竞态）——跳过
    }
    const info = await readSessionHead(join(root, entry.name), HEAD_LINES, HEAD_BYTES)
    const mtimeIso = new Date(mtimeMs).toISOString()
    const createdAt = info.firstTimestamp ?? mtimeIso
    out.push({
      sessionId,
      name: buildSessionName(info, sessionId),
      createdAt,
      lastActiveAt: mtimeIso
    })
  }
  out.sort((a, b) => (a.createdAt === b.createdAt ? a.sessionId.localeCompare(b.sessionId) : a.createdAt.localeCompare(b.createdAt)))
  return out
}

export interface ImportTasksOptions extends ListSessionsOptions {}

/**
 * 为项目导入 claude 历史会话任务（幂等：tasks.json 已有相同 sessionId 的任务跳过，
 * 全局查重——同一会话只归属一个项目记录）。逐个 upsert 落盘，返回新增列表（空数组=
 * 无会话或全部已导入）。广播由 ipc.ts 组合根负责（本函数仅持久化，可测性）。
 */
export async function importTasksFromSessionsImpl(
  projectId: string,
  projects: ProjectStore,
  tasks: TaskStore,
  opts: ImportTasksOptions = {}
): Promise<TaskRecord[]> {
  const project = projects.get(projectId)
  if (!project) throw new Error(`project not found: ${projectId}`)
  const existing = new Set(tasks.list().map((t) => t.sessionId))
  const sessions = await listSessions(project.dir, opts)
  const added: TaskRecord[] = []
  for (const session of sessions) {
    if (existing.has(session.sessionId)) continue
    const record: TaskRecord = {
      id: session.sessionId,
      projectId,
      name: session.name,
      sessionId: session.sessionId,
      cwd: project.dir,
      status: 'stopped',
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt
    }
    added.push(tasks.upsert(record))
  }
  return added
}
