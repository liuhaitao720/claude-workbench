import { describe, expect, it } from 'vitest'
import {
  branchesArgs,
  commitDetailArgs,
  commitNumstatArgs,
  commitFileDiffArgs,
  cherryPickArgs,
  createBranchArgs,
  deleteBranchArgs,
  isSafeHash,
  isSafeRef,
  isSafeRemoteName,
  isSafeRemoteUrl,
  logArgs,
  mergeArgs,
  parseBranches,
  parseCommitDetail,
  parseLog,
  parseNameStatus,
  parseNumstatMap,
  parseRemotes,
  parseStashList,
  parseTrack,
  pullArgs,
  pushArgs,
  stashDropArgs,
  stashPopArgs,
  stashPushArgs,
  stashRef,
  switchArgs,
  switchTrackArgs,
  remoteAddArgs,
  remoteSetUrlArgs,
  remoteRemoveArgs,
  mergeStat
} from '../git-manager'

/**
 * v2.2.5 Git 管理纯逻辑：白名单校验 / 输出解析（分支 track、graph 日志、
 * 提交详情、stash、远程）/ 命令构造（模式旗标与引号安全由 args 数组保证）。
 */

describe('v2.2.5 白名单校验', () => {
  it('isSafeRef：合法 ref 通过；穿透/选项注入/空格拒绝', () => {
    for (const ok of ['main', 'feature/push-answer-mobile', 'origin/main', 'release/v2.1', 'a_b.c']) {
      expect(isSafeRef(ok)).toBe(true)
    }
    for (const bad of ['', '-rf', 'a..b', 'a b', '..']) {
      expect(isSafeRef(bad)).toBe(false)
    }
  })
  it('isSafeHash：7-40 位 hex；越界拒绝', () => {
    expect(isSafeHash('550badc')).toBe(true)
    expect(isSafeHash('550badc' + '0'.repeat(33))).toBe(true) // 恰 40 位
    expect(isSafeHash('550ba')).toBe(false)
    expect(isSafeHash('550bad;rm')).toBe(false)
  })
  it('isSafeRemoteName/isSafeRemoteUrl：名称与协议头', () => {
    expect(isSafeRemoteName('origin')).toBe(true)
    expect(isSafeRemoteName('-x')).toBe(false)
    expect(isSafeRemoteUrl('https://github.com/u/r.git')).toBe(true)
    expect(isSafeRemoteUrl('git@github.com:u/r.git')).toBe(true)
    expect(isSafeRemoteUrl('ssh://host/r')).toBe(true)
    expect(isSafeRemoteUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeRemoteUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('v2.2.5 解析：分支（refname 判归属 + track）', () => {
  it('parseTrack：ahead/behind 任意组合', () => {
    expect(parseTrack('')).toEqual({})
    expect(parseTrack('ahead 2')).toEqual({ ahead: 2 })
    expect(parseTrack('ahead 2, behind 3')).toEqual({ ahead: 2, behind: 3 })
    expect(parseTrack('behind 1')).toEqual({ behind: 1 })
  })
  it('parseBranches：本地分支含 / 不误判远程；当前分支置顶', () => {
    const out = [
      // 字段：refname | refname:short | upstream:short | upstream:track | objectname:short
      'refs/remotes/origin/main\torigin/main\t\tbehind 3\tdead00f',
      'refs/heads/feature/push-answer-mobile\tfeature/push-answer-mobile\t\tahead 2\t550badc',
      'refs/heads/main\tmain\torigin/main\t\tc7d9c32'
    ].join('\n')
    const list = parseBranches(out, 'main')
    expect(list).toHaveLength(3)
    const f = list.find((b) => b.name === 'feature/push-answer-mobile')!
    expect(f.isRemote).toBe(false) // 本地分支名含 / 仍判本地
    expect(f.ahead).toBe(2)
    const o = list.find((b) => b.name === 'origin/main')!
    expect(o.isRemote).toBe(true)
    expect(o.behind).toBe(3)
    expect(list[0]!.name).toBe('main') // 当前置顶
  })
})

describe('v2.2.5 解析：log --graph（前缀保留 + 纯曲线行折入上一条）', () => {
  it('提交行：graph 前缀 + \\x1f 字段；refs 缺省可省', () => {
    const out = ['* \x1f550badc4f2…\x1f550badc\x1fHaitao LIU\x1f2026-11-23T14:32:11+08:00\x1ffix(term)…\x1fHEAD -> feature/x'].join('\n')
    const list = parseLog(out)
    expect(list).toHaveLength(1)
    expect(list[0]!.graph).toBe('* ')
    expect(list[0]!.short).toBe('550badc')
    expect(list[0]!.refs).toBe('HEAD -> feature/x')
  })
  it('纯曲线行（|\\ 等）折入上一提交的 graph——时间线不断线', () => {
    const out = [
      '* \x1fH1\x1fh1\x1fA\x1f2026-01-01T00:00:00+08:00\x1fm1',
      '|\\',
      '| * \x1fH2\x1fh2\x1fB\x1f2026-01-01T01:00:00+08:00\x1fm2',
      'row-without-commit'
    ].join('\n')
    const list = parseLog(out)
    expect(list).toHaveLength(2)
    expect(list[0]!.graph).toBe('* \n|\\')
    expect(list[1]!.graph).toBe('| * \nrow-without-commit')
  })
})

describe('v2.2.5 解析：提交详情 / numstat / stash / 远程', () => {
  it('parseCommitDetail + parseNameStatus + mergeStat（含改名对齐）', () => {
    const detail = 'H1\x1fAlice\x1f2026-01-01T00:00:00+08:00\x1f标题行\n\n正文行'
    const meta = parseCommitDetail(detail)
    expect(meta.author).toBe('Alice')
    expect(meta.message).toBe('标题行\n\n正文行')
    const files = parseNameStatus(`${detail}\nM\tsrc/a.ts\nA\tsrc/new.ts\nR100\told.ts\tnew.ts`)
    expect(files).toHaveLength(3)
    expect(files[2]).toMatchObject({ status: 'R', oldPath: 'old.ts', path: 'new.ts' })
    const numstat = parseNumstatMap('3\t1\tsrc/a.ts\n-\t-\tsrc/new.ts\n7\t0\tnew.ts')
    const merged = mergeStat(files, numstat)
    expect(merged[0]).toMatchObject({ path: 'src/a.ts', add: 3, del: 1 })
    expect(merged[2]).toMatchObject({ path: 'new.ts', add: 7 })
  })
  it('parseStashList：stash@{n} 序号 + 消息', () => {
    const list = parseStashList('stash@{0}\x1fa1b2c3d\x1fWIP on main: 550badc fix\nstash@{1}\x1fe4f5g6\x1fOn feature: other')
    expect(list).toEqual([
      { index: 0, short: 'a1b2c3d', message: 'WIP on main: 550badc fix' },
      { index: 1, short: 'e4f5g6', message: 'On feature: other' }
    ])
  })
  it('parseRemotes：fetch/push 分行归并（同 URL 合一）', () => {
    const list = parseRemotes('origin\thttps://a.git (fetch)\norigin\thttps://a.git (push)\nup\tgit@b:u/r.git (fetch)\nup\thttps://b.git (push)')
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ name: 'origin', fetchUrl: 'https://a.git' })
    expect(list[1]).toMatchObject({ name: 'up', fetchUrl: 'git@b:u/r.git', pushUrl: 'https://b.git' })
  })
})

describe('v2.2.5 命令构造（模式旗标）', () => {
  it('merge/pull：--ff-only / --no-ff / --rebase', () => {
    expect(mergeArgs('dev', 'default')).toEqual(['merge', 'dev'])
    expect(mergeArgs('dev', 'ff-only')).toEqual(['merge', '--ff-only', 'dev'])
    expect(mergeArgs('dev', 'no-ff')).toEqual(['merge', '--no-ff', 'dev'])
    expect(pullArgs('default')).toEqual(['pull'])
    expect(pullArgs('rebase')).toEqual(['pull', '--rebase'])
    expect(pullArgs('ff-only')).toEqual(['pull', '--ff-only'])
  })
  it('push：force / -u 建上游 / 指定 remote+branch', () => {
    expect(pushArgs({})).toEqual(['push'])
    expect(pushArgs({ force: true })).toEqual(['push', '-f'])
    expect(pushArgs({ force: true, remote: 'origin', branch: 'x' })).toEqual(['push', '-f', 'origin', 'x'])
    expect(pushArgs({ setUpstream: true, remote: 'origin', branch: 'x' })).toEqual(['push', '-u', 'origin', 'x'])
  })
  it('分支动作：switch/-c/跟踪检出/-d/-D', () => {
    expect(switchArgs('main')).toEqual(['switch', 'main'])
    expect(switchTrackArgs('x', 'origin/x')).toEqual(['switch', '-c', 'x', '--track', 'origin/x'])
    expect(createBranchArgs('x')).toEqual(['switch', '-c', 'x'])
    expect(createBranchArgs('x', 'main')).toEqual(['switch', '-c', 'x', 'main'])
    expect(deleteBranchArgs('x')).toEqual(['branch', '-d', 'x'])
    expect(deleteBranchArgs('x', true)).toEqual(['branch', '-D', 'x'])
  })
  it('stash：push 带/不带消息、pop/apply/drop 引用序号', () => {
    expect(stashPushArgs()).toEqual(['stash', 'push'])
    expect(stashPushArgs('  wip ')).toEqual(['stash', 'push', '-m', 'wip'])
    expect(stashRef(2)).toBe('stash@{2}')
    expect(stashPopArgs(1)).toEqual(['stash', 'pop', 'stash@{1}'])
    expect(stashPopArgs(1, true)).toEqual(['stash', 'apply', 'stash@{1}'])
    expect(stashDropArgs(0)).toEqual(['stash', 'drop', 'stash@{0}'])
  })
  it('v2.2.5 修复：提交详情命令带 -m --first-parent（merge 提交才有文件清单）', () => {
    for (const args of [commitDetailArgs('a1b2c3d'), commitNumstatArgs('a1b2c3d'), commitFileDiffArgs('a1b2c3d', 'a.txt')]) {
      expect(args).toContain('-m')
      expect(args).toContain('--first-parent')
    }
  })
  it('v2.2.5 修复：消息解析剔除 name-status 行（merge -m 多段清单不混入正文）', () => {
    const out = 'H1\x1fAlice\x1f2026-01-01T00:00:00+08:00\x1f标题\n\nM\tsrc/a.ts\n\nA\tb.txt'
    expect(parseCommitDetail(out).message).toBe('标题')
  })
  it('其余：cherry-pick / 远程增改删 / branches / log 形状', () => {
    expect(cherryPickArgs('a1b2c3d')).toEqual(['cherry-pick', 'a1b2c3d'])
    expect(remoteAddArgs('origin', 'https://a.git')).toEqual(['remote', 'add', 'origin', 'https://a.git'])
    expect(remoteSetUrlArgs('origin', 'https://b.git')).toEqual(['remote', 'set-url', 'origin', 'https://b.git'])
    expect(remoteRemoveArgs('up')).toEqual(['remote', 'remove', 'up'])
    expect(branchesArgs()).toContain('for-each-ref')
    expect(logArgs(50)).toContain('--graph')
    expect(logArgs(50)).toContain('--all')
  })
})
