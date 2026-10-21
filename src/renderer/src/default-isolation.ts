/**
 * 新建任务默认隔离（v0.9⑦）：记住用户上次在 git 三选阶段点过的选项，
 * localStorage（键 cwb-default-isolation）持久化。仅纯视觉预选（三选阶段
 * 高亮上次项）——不跳过确认对话框（用户指令：预选≠默认执行）。
 * 缺失/坏值回 'worktree'（对齐既有推荐文案"git 项目推荐使用 worktree 隔离"）。
 */

export type DefaultIsolation = 'worktree' | 'shared'

export const DEFAULT_ISOLATION_FALLBACK: DefaultIsolation = 'worktree'

/** localStorage 持久化键（v0.9 契约） */
const STORAGE_KEY = 'cwb-default-isolation'

/** 读取上次选择；缺失/'worktree'/'shared' 之外 → 回退（localStorage 不可用同） */
export function loadDefaultIsolation(): DefaultIsolation {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return DEFAULT_ISOLATION_FALLBACK
  }
  return raw === 'worktree' || raw === 'shared' ? raw : DEFAULT_ISOLATION_FALLBACK
}

export function persistDefaultIsolation(isolation: DefaultIsolation): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, isolation)
  } catch {
    // 隐私模式等不可写场景静默——预选回退默认即可
  }
}
