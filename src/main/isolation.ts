import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** .git 可为目录（常规仓库）或文件（worktree 子仓库），二者皆真 */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

export function worktreePathOf(projectDir: string, taskId: string): string {
  return join(projectDir, '.cwb-worktrees', taskId)
}

/** 建隔离 worktree（分支 cwb/<taskId>），失败抛带 stderr 的 Error；成功返回 worktree 路径 */
export async function worktreeAdd(projectDir: string, taskId: string): Promise<string> {
  const path = worktreePathOf(projectDir, taskId)
  try {
    await execFileAsync('git', ['-C', projectDir, 'worktree', 'add', path, '-b', `cwb/${taskId}`])
  } catch (err) {
    throw new Error(`git worktree add failed: ${stderrOf(err)}`)
  }
  return path
}

/** 先 remove --force，后 prune（prune 失败不致命）；remove 失败抛带 stderr 的 Error */
export async function worktreeRemove(projectDir: string, taskId: string): Promise<void> {
  try {
    await execFileAsync('git', [
      '-C',
      projectDir,
      'worktree',
      'remove',
      '--force',
      worktreePathOf(projectDir, taskId)
    ])
  } catch (err) {
    throw new Error(`git worktree remove failed: ${stderrOf(err)}`)
  }
  try {
    await execFileAsync('git', ['-C', projectDir, 'worktree', 'prune'])
  } catch {
    // prune 失败不致命：主清理已完成，残留元数据由后续 prune/git gc 收敛
  }
}

function stderrOf(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    return String((err as { stderr: unknown }).stderr).trim()
  }
  return err instanceof Error ? err.message : String(err)
}
