import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDiffList,
  diffDetailOf,
  getDiffFile,
  getDiffList,
  gitCommand,
  localGitRunner,
  parsePorcelainStatus,
  parseUnifiedDiff
} from '../git-diff'

/**
 * v2.0.2 git-diff 单测：纯函数解析（porcelain/numstat/统一 diff）+ 真实临时
 * git 仓库端到端（init/commit/modify/rename/untracked——runner 走 execFile 真链）。
 */

let dirs: string[] = []

beforeEach(() => {
  dirs = []
})

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cwb-git-diff-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'])
  return dir
}

function commitAll(dir: string, msg: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', msg])
}

describe('纯函数解析', () => {
  it('parsePorcelainStatus：M/A/D/R/未跟踪；重命名行带 oldPath；引号路径剥壳', () => {
    const out = [
      ' M src/a.ts',
      'A  new.ts',
      ' D gone.ts',
      'R  old.ts -> moved.ts',
      '?? dir/new-dir',
      'M  "path with space.ts"'
    ].join('\n')
    expect(parsePorcelainStatus(out)).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'new.ts', status: 'A' },
      { path: 'gone.ts', status: 'D' },
      { path: 'moved.ts', status: 'R', oldPath: 'old.ts' },
      { path: 'dir/new-dir', status: 'U' },
      { path: 'path with space.ts', status: 'M' }
    ])
  })

  it('buildDiffList：numstat 行数并入；二进制（- -）无数值', () => {
    const r = buildDiffList(
      ' M a.ts\n?? b.bin\n',
      '3\t1\ta.ts\n-\t-\tb.bin\n'
    )
    expect(r.base).toBe('HEAD')
    expect(r.files).toEqual([
      { path: 'a.ts', status: 'M', add: 3, del: 1 },
      { path: 'b.bin', status: 'U' }
    ])
  })

  it('parseUnifiedDiff：hunk 头/行号推进/增删上下文/No-newline 注释跳过；binary 识别', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@ function foo()',
      ' context',
      '-old line',
      '+new line',
      '+added line',
      '\\ No newline at end of file'
    ].join('\n')
    const { hunks, binary, truncated } = parseUnifiedDiff(diff)
    expect(binary).toBe(false)
    expect(truncated).toBe(false)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.header).toContain('@@ -1,3 +1,4 @@')
    expect(hunks[0]!.lines.map((l) => [l.type, l.oldNo, l.newNo, l.text])).toEqual([
      ['ctx', 1, 1, 'context'],
      ['del', 2, undefined, 'old line'],
      ['add', undefined, 2, 'new line'],
      ['add', undefined, 3, 'added line']
    ])

    const bin = parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')
    expect(bin.binary).toBe(true)
    expect(bin.hunks).toHaveLength(0)
  })

  it('diffDetailOf：超限截断标记（>4000 行 → truncated）', () => {
    const lines: string[] = ['diff --git a/big b/big', '--- a/big', '+++ b/big', '@@ -1,1 +1,1 @@']
    for (let i = 0; i < 5_000; i++) lines.push(`+line ${i}`)
    const r = diffDetailOf('big', 'M', lines.join('\n'))
    expect(r.truncated).toBe(true)
    expect(r.hunks[0]!.lines.length).toBeLessThanOrEqual(4_000)
  })

  it('gitCommand：bash -ic 包装 + 单引号转义（内嵌引号 → 引号闭合重开）', () => {
    const cmd = gitCommand('/home/u/my dir', ['diff', 'HEAD'])
    // 外层 posixQuote 会转义内层全部单引号：'\'' 序列
    expect(cmd).toBe(
      `bash -ic 'git -C '\\''/home/u/my dir'\\'' --no-pager '\\''diff'\\'' '\\''HEAD'\\'''`
    )
  })
})

describe('真实仓库端到端（execFile git）', () => {
  it('getDiffList + getDiffFile：修改/新增/删除/重命名/未跟踪全链', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'a.ts'), 'line1\nline2\n')
    writeFileSync(join(dir, 'old.ts'), 'x\n')
    commitAll(dir, 'init')

    // 工作区改动：a.ts 改一行 + 删 old.ts + 新增已跟踪? 直接未跟踪 + 重命名
    writeFileSync(join(dir, 'a.ts'), 'line1\nCHANGED\nline3\n')
    execFileSync('git', ['-C', dir, 'mv', 'old.ts', 'renamed.ts'])
    writeFileSync(join(dir, 'untracked.ts'), 'new\n')

    const list = await getDiffList(localGitRunner(dir))
    const byPath = new Map(list.files.map((f) => [f.path, f]))
    expect(byPath.get('a.ts')).toMatchObject({ status: 'M', add: 2, del: 1 })
    expect(byPath.get('renamed.ts')).toMatchObject({ status: 'R', oldPath: 'old.ts' })
    expect(byPath.get('untracked.ts')).toMatchObject({ status: 'U' })

    const detail = await getDiffFile(localGitRunner(dir), 'a.ts', 'M')
    expect(detail.binary).toBe(false)
    expect(detail.hunks.length).toBeGreaterThanOrEqual(1)
    const texts = detail.hunks.flatMap((h) => h.lines.map((l) => l.text))
    expect(texts).toContain('CHANGED')
    expect(texts).toContain('line2')
  })

  it('干净工作区 → 空清单；非 git 目录 → 抛错', async () => {
    const dir = newRepo()
    writeFileSync(join(dir, 'a'), '1')
    commitAll(dir, 'only')
    expect((await getDiffList(localGitRunner(dir))).files).toEqual([])

    const plain = mkdtempSync(join(tmpdir(), 'cwb-not-git-'))
    dirs.push(plain)
    await expect(getDiffList(localGitRunner(plain))).rejects.toThrow()
  })
})
