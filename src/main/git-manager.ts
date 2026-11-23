/**
 * v2.2.5 Git 分支与修改记录管理（用户需求 2026-11-23，IDEA Git 工具窗式）。
 *
 * 纯逻辑层：命令构造（args 数组——本地/远程 GitRunner 同构，引号安全由
 * gitCommand/参数数组保证）+ 输出解析 + 白名单校验。执行编排函数接收
 * GitRunner（main 侧 ipc 组合根按项目 connectionId 分派本地/远程）。
 *
 * 全部功能用 git 自带命令：
 * - 状态：for-each-ref（分支+upstream+track）/ branch --show-current /
 *   remote -v / stash list / status --porcelain
 * - 日志：log --graph --all --pretty（\x1f 字段分隔；graph 前缀原样保留——
 *   渲染层按字符画竖线/点/斜线，保留 git 真实拓扑含分叉合并曲线）
 * - 详情：show --name-status + --numstat（合并出 ±行数与改名）
 * - 动作：switch / switch -c / merge（--ff-only|--no-ff）/ pull（--rebase|
 *   --ff-only）/ push（-f 弹窗确认在 renderer）/ branch -d / cherry-pick /
 *   stash push|pop|apply|drop / remote add|set-url|remove
 *
 * 安全口径：ref/名称/hash/URL 白名单校验后才进 args（防选项注入/路径穿越）；
 * 危险动作（-D/-f/push/drop/remove）的确认弹窗在 renderer。
 */
import type { GitRunner } from './git-diff'
import type {
  GitBranchInfo,
  GitFileStatus,
  GitCommitFileInfo,
  GitCommitInfo,
  GitMergeMode,
  GitPullMode,
  GitRemoteInfo,
  GitRepoStatus,
  GitStashInfo
} from '../shared/types'

// ── 白名单校验 ────────────────────────────────────────────────────────

/** ref 名（分支/tag，含 origin/x、a/b-c）：字母数字._/- 且不穿透 */
export function isSafeRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes(' ') &&
    !ref.startsWith('-')
  )
}

/** 提交 hash（7-40 位 hex） */
export function isSafeHash(h: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(h)
}

/** 远程名（origin 等） */
export function isSafeRemoteName(n: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)
}

/** 远程 URL：http(s)/ssh/git 协议头（无 shell 元字符注入面——args 数组直传） */
export function isSafeRemoteUrl(u: string): boolean {
  return (
    /^https?:\/\/\S{3,500}$/.test(u) || /^git@\S{3,500}$/.test(u) || /^ssh:\/\/\S{3,500}$/.test(u)
  )
}

// ── 命令构造（args 数组）──────────────────────────────────────────────

/** 分支清单（本地+远程，含 upstream 与 ahead/behind 原文；refname 全名判归属——本地分支名可含 /） */
export function branchesArgs(): string[] {
  return [
    'for-each-ref',
    '--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)',
    'refs/heads',
    'refs/remotes'
  ]
}

/** 当前分支（detached HEAD → 空串；调用方回落 rev-parse --short HEAD） */
export function currentBranchArgs(): string[] {
  return ['branch', '--show-current']
}

export function detachedHeadArgs(): string[] {
  return ['rev-parse', '--short', 'HEAD']
}

/** 多分支 graph 日志（--all + 当前 HEAD 在前；\x1f 字段分隔） */
export function logArgs(limit: number): string[] {
  return [
    'log',
    '--graph',
    '--all',
    `--date=iso8601-strict`,
    `--pretty=format:%x1f%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D`,
    '-n',
    String(limit)
  ]
}

/** 提交详情（消息全文 + 变更文件状态行） */
export function commitDetailArgs(hash: string): string[] {
  // v2.2.5 修复（用户实测 merge 提交无文件清单）：-m --first-parent——合并提交显示
  // 相对第一父的变更（git show 默认对 merge 不输出 name-status）；普通提交无影响
  return ['show', '-m', '--first-parent', '--pretty=format:%H%x1f%an%x1f%ad%x1f%B', '--name-status', '--no-color', hash]
}

/** 提交详情（±行数——numstat 与 name-status 按路径对齐） */
export function commitNumstatArgs(hash: string): string[] {
  return ['show', '-m', '--first-parent', '--pretty=format:', '--numstat', '--no-color', hash]
}

/** 单文件在指定提交的 diff 文本（复用 parseUnifiedDiff 渲染） */
export function commitFileDiffArgs(hash: string, path: string): string[] {
  return ['show', '-m', '--first-parent', '--no-color', '-U3', '--pretty=format:', hash, '--', path]
}

export function stashListArgs(): string[] {
  return ['stash', 'list', '--pretty=format:%gd%x1f%h%x1f%s']
}

// ── 解析 ──────────────────────────────────────────────────────────────

/** `ahead 2, behind 3` / `ahead 1` / `behind 4` → 数值 */
export function parseTrack(track: string): { ahead?: number; behind?: number } {
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ...(ahead !== null ? { ahead: Number(ahead[1]) } : {}),
    ...(behind !== null ? { behind: Number(behind[1]) } : {})
  }
}

export function parseBranches(out: string, current: string): GitBranchInfo[] {
  const list: GitBranchInfo[] = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const [refname, name, upstream, track, short] = line.split('\t')
    if (refname === undefined || name === undefined || name === '') continue
    list.push({
      name,
      isRemote: refname.startsWith('refs/remotes/'),
      ...(upstream !== undefined && upstream !== '' ? { upstream } : {}),
      ...(track !== undefined && track !== '' ? parseTrack(track) : {}),
      short: short ?? ''
    })
  }
  // 当前分支置顶（本地组内）
  list.sort((a, b) => {
    if (a.name === current) return -1
    if (b.name === current) return 1
    return a.name.localeCompare(b.name)
  })
  return list
}

/**
 * log --graph 输出 → 提交行（graph ASCII 前缀原样保留，\x1f 后为字段）。
 * 纯曲线行（无 \x1f，如 `|\`）折入上一提交的 graph 后缀——渲染连续不断线。
 */
export function parseLog(out: string): GitCommitInfo[] {
  const list: GitCommitInfo[] = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const sep = line.indexOf('\x1f')
    if (sep < 0) {
      // 纯 graph 行：并进上一条（尾部追加，含换行符保持字符画对齐）
      const prev = list[list.length - 1]
      if (prev !== undefined) prev.graph += `\n${line}`
      continue
    }
    const [hash, short, author, date, subject, refs] = line.slice(sep + 1).split('\x1f')
    if (hash === undefined) continue
    list.push({
      graph: line.slice(0, sep),
      hash,
      short: short ?? hash.slice(0, 7),
      author: author ?? '',
      date: date ?? '',
      subject: subject ?? '',
      ...(refs !== undefined && refs !== '' ? { refs } : {})
    })
  }
  return list
}

/** show --name-status 输出：首组 \x1f 行=提交元数据，其后 X[\told\t]new 行 */
export function parseCommitDetail(out: string): { message: string; author: string; date: string } {
  const lines = out.split('\n')
  let author = ''
  let date = ''
  const msgLines: string[] = []
  let inBody = false
  for (const line of lines) {
    const sep = line.indexOf('\x1f')
    if (!inBody && sep >= 0) {
      const [, a, d, ...rest] = line.split('\x1f')
      author = a ?? ''
      date = d ?? ''
      msgLines.push(rest.join('\x1f'))
      inBody = true
      continue
    }
    // name-status 行不属消息正文（merge -m 输出每段都会带清单——全部剔除）
    if (/^[ACDMRTUX]\d*\t/.test(line)) continue
    if (inBody) msgLines.push(line)
  }
  return { author, date, message: msgLines.join('\n').trim() }
}

/** name-status 行（R100\told\tnew）→ 文件信息；非「状态字母+tab」行一律忽略 */
export function parseNameStatus(out: string): GitCommitFileInfo[] {
  const files: GitCommitFileInfo[] = []
  for (const line of out.split('\n')) {
    if (!/^[ACDMRTUX]\d*\t/.test(line)) continue
    const parts = line.split('\t')
    const st = parts[0]!
    const status = st[0] as GitFileStatus
    if (status === 'R' || status === 'C') {
      files.push({ oldPath: parts[1], path: parts[2] ?? '', status })
    } else {
      files.push({ path: parts[1] ?? '', status })
    }
  }
  return files
}

/** numstat 行（±\t±\tpath）→ path → {add,del}（二进制 `-` 无值） */
export function parseNumstatMap(out: string): Map<string, { add?: number; del?: number }> {
  const map = new Map<string, { add?: number; del?: number }>()
  for (const line of out.split('\n')) {
    if (line.trim() === '' || line.includes('\x1f')) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const add = parts[0] === '-' ? undefined : Number(parts[0])
    const del = parts[1] === '-' ? undefined : Number(parts[1])
    map.set(parts[2]!, { ...(add !== undefined ? { add } : {}), ...(del !== undefined ? { del } : {}) })
  }
  return map
}

/** numstat 并入 name-status（改名对齐 new path） */
export function mergeStat(
  files: GitCommitFileInfo[],
  numstat: Map<string, { add?: number; del?: number }>
): GitCommitFileInfo[] {
  return files.map((f) => {
    const n = numstat.get(f.path)
    return n === undefined ? f : { ...f, ...n }
  })
}

export function parseStashList(out: string): GitStashInfo[] {
  const list: GitStashInfo[] = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const [gd, short, ...rest] = line.split('\x1f')
    const idx = /stash@\{(\d+)\}/.exec(gd ?? '')
    if (idx === null) continue
    list.push({ index: Number(idx[1]), short: short ?? '', message: rest.join('\x1f') })
  }
  return list
}

export function parseRemotes(out: string): GitRemoteInfo[] {
  const map = new Map<string, GitRemoteInfo>()
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line.trim())
    if (m === null) continue
    const name = m[1]!
    const url = m[2]!
    const kind = m[3]!
    const cur = map.get(name) ?? { name, fetchUrl: url }
    if (kind === 'push' && url !== cur.fetchUrl) cur.pushUrl = url
    map.set(name, cur)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── 执行编排（GitRunner 注入；ipc 组合根按项目分派本地/远程）──────────

/** 当前分支名（detached → `HEAD-detached: <short>` 占位；sort/高亮用） */
export async function gitCurrentBranch(runner: GitRunner): Promise<string> {
  const cur = (await runner.run(currentBranchArgs())).trim()
  if (cur !== '') return cur
  const short = (await runner.run(detachedHeadArgs()).catch(() => '')).trim()
  return short !== '' ? `HEAD (${short})` : 'HEAD'
}

export async function gitRepoStatus(runner: GitRunner, current: string): Promise<GitRepoStatus> {
  const [branchOut, remoteOut, stashOut, wcOut] = await Promise.all([
    runner.run(branchesArgs()),
    runner.run(['remote', '-v']).catch(() => ''),
    runner.run(stashListArgs()).catch(() => ''),
    runner.run(['status', '--porcelain'])
  ])
  return {
    current,
    branches: parseBranches(branchOut, current),
    remotes: parseRemotes(remoteOut),
    stashes: parseStashList(stashOut),
    wcCount: wcOut.split('\n').filter((l) => l.trim() !== '').length
  }
}

export async function gitLog(runner: GitRunner, limit = 200): Promise<GitCommitInfo[]> {
  return parseLog(await runner.run(logArgs(limit)))
}

export async function gitCommitDetail(
  runner: GitRunner,
  hash: string
): Promise<{ message: string; author: string; date: string; files: GitCommitFileInfo[] }> {
  const [detailOut, numstatOut] = await Promise.all([
    runner.run(commitDetailArgs(hash)),
    runner.run(commitNumstatArgs(hash))
  ])
  const meta = parseCommitDetail(detailOut)
  const files = mergeStat(parseNameStatus(detailOut), parseNumstatMap(numstatOut))
  return { ...meta, files }
}

/** 单文件提交 diff 文本（renderer 经 parseUnifiedDiff 渲染——审查视图同款） */
export async function gitCommitFileDiff(runner: GitRunner, hash: string, path: string): Promise<string> {
  return runner.run(commitFileDiffArgs(hash, path))
}

// ── 动作（args 构造；执行/错误上抛由 ipc 统一）────────────────────────

export function switchArgs(branch: string): string[] {
  return ['switch', branch]
}

/** 检出远程分支（IDEA 语义）：建同名本地分支并跟踪 */
export function switchTrackArgs(local: string, remoteRef: string): string[] {
  return ['switch', '-c', local, '--track', remoteRef]
}

export function createBranchArgs(name: string, base?: string): string[] {
  return base === undefined || base === '' ? ['switch', '-c', name] : ['switch', '-c', name, base]
}

export function mergeArgs(branch: string, mode: GitMergeMode): string[] {
  const flag = mode === 'ff-only' ? ['--ff-only'] : mode === 'no-ff' ? ['--no-ff'] : []
  return ['merge', ...flag, branch]
}

export function pullArgs(mode: GitPullMode): string[] {
  const flag = mode === 'rebase' ? ['--rebase'] : mode === 'ff-only' ? ['--ff-only'] : []
  return ['pull', ...flag]
}

/** push：无 force；分支无 upstream 时 -u <remote> <branch> 建立跟踪 */
export function pushArgs(opts: { force?: boolean; remote?: string; branch?: string; setUpstream?: boolean }): string[] {
  const f = opts.force === true ? ['-f'] : []
  const tail =
    opts.setUpstream === true && opts.remote !== undefined && opts.branch !== undefined
      ? ['-u', opts.remote, opts.branch]
      : opts.remote !== undefined && opts.branch !== undefined
        ? [opts.remote, opts.branch]
        : []
  return ['push', ...f, ...tail]
}

export function deleteBranchArgs(branch: string, force?: boolean): string[] {
  return ['branch', force === true ? '-D' : '-d', branch]
}

export function cherryPickArgs(hash: string): string[] {
  return ['cherry-pick', hash]
}

export function stashPushArgs(message?: string): string[] {
  return message === undefined || message.trim() === '' ? ['stash', 'push'] : ['stash', 'push', '-m', message.trim()]
}

export function stashRef(n: number): string {
  return `stash@{${n}}`
}

export function stashPopArgs(n: number, apply?: boolean): string[] {
  const cmd = apply === true ? 'apply' : 'pop'
  return ['stash', cmd, stashRef(n)]
}

export function stashDropArgs(n: number): string[] {
  return ['stash', 'drop', stashRef(n)]
}

export function remoteAddArgs(name: string, url: string): string[] {
  return ['remote', 'add', name, url]
}

export function remoteSetUrlArgs(name: string, url: string): string[] {
  return ['remote', 'set-url', name, url]
}

export function remoteRemoveArgs(name: string): string[] {
  return ['remote', 'remove', name]
}
