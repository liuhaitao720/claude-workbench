import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DiffFileDetail, DiffFileEntry, DiffHunk, DiffListResult } from '../shared/types'

/**
 * v2.0.2 git diff 审查数据层（纯函数解析 + 命令执行分离，均导出供单测）。
 *
 * 命令面（本地=execFile git / 远程=connection.exec 同命令串）：
 * - 清单：`git status --porcelain`（状态+路径，含未跟踪）+ `git diff HEAD --numstat`
 *   （+/- 行数；合并键=路径）；
 * - 详情：`git diff HEAD --no-color -U3 -- <path>`（统一 diff 解析）。
 *
 * 防御：单文件 diff 输出 >2MB 或解析行 >4000 → truncated（渲染层提示）；
 * 二进制（"Binary files ... differ"）→ binary=true 无 hunks；解析失败不抛——
 * 返回空 hunks（审查是增值功能，脏数据不炸主流程）。
 */

const execFileAsync = promisify(execFile)

/** 单文件 diff 输出字节上限（超过即截断标记） */
const MAX_DIFF_BYTES = 2 * 1024 * 1024
/** 单文件解析行数上限 */
const MAX_DIFF_LINES = 4_000

/** 远程命令构造（照 ipc.ts remoteDirProbeCommand 先例：bash -ic 包装 + 单引号转义） */
export function gitCommand(dir: string, args: string[]): string {
  const full = `git -C ${posixQuote(dir)} --no-pager ${args.map(posixQuote).join(' ')}`
  return `bash -ic ${posixQuote(full)}`
}

/** POSIX 单引号转义（内嵌单引号→ '\''） */
export function posixQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** git status --porcelain 行 → 状态字母（XY → 展示口径） */
function statusOf(xy: string): DiffFileEntry['status'] {
  if (xy.includes('R')) return 'R'
  if (xy.includes('A')) return 'A'
  if (xy.includes('D')) return 'D'
  if (xy === '??') return 'U'
  return 'M'
}

/**
 * 解析 `git status --porcelain` 输出（-z 不可用于远程一致性，行模式即可——
 * 路径含空格时整行 path 部分原样保留）。重命名行 `R  old -> new`。
 */
export function parsePorcelainStatus(out: string): DiffFileEntry[] {
  const entries: DiffFileEntry[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') continue
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    if (arrow >= 0) {
      entries.push({
        path: rest.slice(arrow + 4),
        status: statusOf(xy),
        oldPath: rest.slice(0, arrow)
      })
    } else {
      entries.push({ path: rest.replace(/^"|"$/g, ''), status: statusOf(xy) })
    }
  }
  return entries
}

/** 解析 `git diff HEAD --numstat` 输出（add\tdel\tpath；二进制= `-\t-\t`） */
export function parseNumstat(out: string): Map<string, { add?: number; del?: number }> {
  const m = new Map<string, { add?: number; del?: number }>()
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') continue
    const [a, d, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    if (path === '') continue
    m.set(path, {
      ...(a !== '-' && /^\d+$/.test(a) ? { add: Number(a) } : {}),
      ...(d !== '-' && /^\d+$/.test(d) ? { del: Number(d) } : {})
    })
  }
  return m
}

/** 清单合成：porcelain 状态 + numstat 行数（未跟踪无数值） */
export function buildDiffList(porcelain: string, numstat: string): DiffListResult {
  const counts = parseNumstat(numstat)
  const files = parsePorcelainStatus(porcelain).map((e) => ({
    ...e,
    ...(counts.get(e.path) ?? {})
  }))
  return { base: 'HEAD', files }
}

/** 单个统一 diff 文件段（自 `diff --git` 起至下一个或文末）→ hunks */
export function parseUnifiedDiff(out: string): { hunks: DiffHunk[]; binary: boolean; truncated: boolean } {
  if (/^Binary files .* differ$/m.test(out) || out.includes('\nBinary files ')) {
    return { hunks: [], binary: true, truncated: false }
  }
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let lineCount = 0
  let truncated = false
  for (const raw of out.split('\n')) {
    if (truncated) break
    if (raw.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m !== null) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
        current = { header: raw, lines: [] }
        hunks.push(current)
        continue
      }
    }
    if (current === null) continue // diff --git / index / --- / +++ 头部行
    if (raw.startsWith('+')) {
      current.lines.push({ type: 'add', newNo, text: raw.slice(1) })
      newNo += 1
    } else if (raw.startsWith('-')) {
      current.lines.push({ type: 'del', oldNo, text: raw.slice(1) })
      oldNo += 1
    } else if (raw.startsWith('\\')) {
      continue // "\ No newline at end of file" 注释行
    } else {
      current.lines.push({ type: 'ctx', oldNo, newNo, text: raw.slice(1) })
      oldNo += 1
      newNo += 1
    }
    lineCount += 1
    if (lineCount >= MAX_DIFF_LINES) truncated = true
  }
  return { hunks, binary: false, truncated }
}

/** git 输出 → 单文件详情（字节上限先行截断） */
export function diffDetailOf(path: string, status: DiffFileEntry['status'], out: string): DiffFileDetail {
  const clipped = out.length > MAX_DIFF_BYTES
  const { hunks, binary, truncated } = parseUnifiedDiff(clipped ? out.slice(0, MAX_DIFF_BYTES) : out)
  return { path, status, binary, truncated: truncated || clipped, hunks }
}

/** 命令执行端口：本地 execFile / 远程 connection.exec（stdout 字符串出参） */
export interface GitRunner {
  run(args: string[]): Promise<string>
}

/** 本地 runner（execFile git，无 shell——路径含空格安全由参数数组保证） */
export function localGitRunner(dir: string): GitRunner {
  return {
    async run(args) {
      try {
        const { stdout } = await execFileAsync('git', ['-C', dir, '--no-pager', ...args], {
          maxBuffer: MAX_DIFF_BYTES * 4
        })
        return stdout
      } catch (err) {
        throw new Error(stderrMessage(err))
      }
    }
  }
}

/** 远程 runner（连接 exec——ipc 注入；命令串经 gitCommand 包装；非零退出码转抛） */
export function remoteGitRunner(
  dir: string,
  exec: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>
): GitRunner {
  return {
    async run(args) {
      const r = await exec(gitCommand(dir, args))
      if (r.code !== 0) throw new Error(r.stderr.trim() !== '' ? r.stderr.trim() : `git exit ${r.code}`)
      return r.stdout
    }
  }
}

function stderrMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  return (typeof e.stderr === 'string' && e.stderr.trim() !== '' ? e.stderr.trim() : undefined) ??
    (e.message ?? String(err))
}

/** 清单（状态 + 行数两次往返合成） */
export async function getDiffList(runner: GitRunner): Promise<DiffListResult> {
  const porcelain = await runner.run(['status', '--porcelain'])
  let numstat = ''
  try {
    numstat = await runner.run(['diff', 'HEAD', '--numstat'])
  } catch {
    // 空仓库（无 HEAD）等：numstat 尽力而为，状态清单仍可用
  }
  return buildDiffList(porcelain, numstat)
}

/** 单文件详情 */
export async function getDiffFile(
  runner: GitRunner,
  path: string,
  status: DiffFileEntry['status']
): Promise<DiffFileDetail> {
  const out = await runner.run(['diff', 'HEAD', '--no-color', '-U3', '--', path])
  return diffDetailOf(path, status, out)
}
