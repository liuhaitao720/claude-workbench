import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isGitRepo, worktreeAdd, worktreePathOf, worktreeRemove } from '../isolation'

const execFileAsync = promisify(execFile)

function git(dir: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync('git', ['-C', dir, ...args])
}

async function initRepoWithCommit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init'])
  await execFileAsync('git', [
    '-C',
    dir,
    '-c',
    'user.name=CWB Test',
    '-c',
    'user.email=cwb-test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'init'
  ])
}

describe('isolation（真实 git）', () => {
  it('isGitRepo：常规 .git 目录与 worktree 场景的 .git 文件均真；缺失则假', () => {
    const base = mkdtempSync(join(tmpdir(), 'cwb-iso-'))
    try {
      const plain = join(base, 'plain')
      mkdirSync(plain)
      expect(isGitRepo(plain)).toBe(false)
      mkdirSync(join(plain, '.git'))
      expect(isGitRepo(plain)).toBe(true)

      const linked = join(base, 'linked')
      mkdirSync(linked)
      writeFileSync(join(linked, '.git'), 'gitdir: ../repo/.git/worktrees/x\n', 'utf8') // worktree 情形：.git 是文件
      expect(isGitRepo(linked)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('worktreeAdd：建目录+建分支 cwb/<taskId>；worktreeRemove：目录消失', { timeout: 30_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), 'cwb-iso-'))
    try {
      const repo = join(base, 'repo')
      mkdirSync(repo)
      await initRepoWithCommit(repo)

      const taskId = '11111111-2222-3333-4444-555555555555'
      const wtPath = await worktreeAdd(repo, taskId)
      expect(wtPath).toBe(worktreePathOf(repo, taskId))
      expect(existsSync(wtPath)).toBe(true)

      const branch = await git(repo, ['branch', '--list', `cwb/${taskId}`])
      expect(branch.stdout).toContain(`cwb/${taskId}`)

      await worktreeRemove(repo, taskId)
      expect(existsSync(wtPath)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('worktreeAdd 对非 git 目录抛带 stderr 的 Error', { timeout: 30_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), 'cwb-iso-'))
    try {
      const notGit = join(base, 'not-git')
      mkdirSync(notGit)
      await expect(worktreeAdd(notGit, 'deadbeef-task')).rejects.toThrow(/git worktree add failed/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
