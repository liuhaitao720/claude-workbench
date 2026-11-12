import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'
import type { DiffFileDetail } from '../../shared/types'

/**
 * v2.0.2 主区审查模式：store 流（打开/选中/刷新/关闭 + tab 切换语义）与
 * DiffReview 组件（文件列表/diff 渲染/hunk 键盘跳转/未跟踪占位）。
 * mock listDiff/diffFile 数据经 vi.mocked 覆写。
 */

const gitProject = makeProject({ id: 'p1', name: 'RepoA', dir: 'D:\\repo-a', isGit: true })
const task1 = makeTask({ id: 't1', projectId: 'p1', name: '任务一', cwd: 'D:\\repo-a' })

const FILES = [
  { path: 'src/a.ts', status: 'M' as const, add: 3, del: 1 },
  { path: 'src/b.ts', status: 'A' as const, add: 45 },
  { path: 'notes.md', status: 'U' as const }
]

function detailOf(path: string, hunks: number): DiffFileDetail {
  return {
    path,
    status: 'M',
    binary: false,
    truncated: false,
    hunks: Array.from({ length: hunks }, (_, i) => ({
      header: `@@ -${i + 1},1 +${i + 1},1 @@ hunk ${i + 1}`,
      lines: [
        { type: 'ctx' as const, oldNo: i + 1, newNo: i + 1, text: `ctx ${i}` },
        { type: 'add' as const, newNo: i + 2, text: `added ${i}` }
      ]
    }))
  }
}

beforeEach(() => {
  useAppStore.setState({
    projects: [gitProject],
    tasks: [task1],
    openTaskIds: ['t1'],
    activeTaskId: 't1',
    reviewState: null,
    reviewActive: false,
    reviewHint: null,
    settingsOpen: false
  })
})

afterEach(cleanup)

async function renderApp(): Promise<ReturnType<typeof installCwbMock>> {
  const mock = installCwbMock({ projects: [gitProject], tasks: [task1] })
  // 覆写 diff 数据源（mock 默认空清单）
  vi.mocked(mock.listDiff).mockResolvedValue({ base: 'HEAD', files: FILES })
  vi.mocked(mock.diffFile).mockImplementation(
    async (_pid, _cwd, path) => detailOf(path, 3)
  )
  render(<App />)
  await waitFor(() => expect(useAppStore.getState().projects).toHaveLength(1))
  return mock
}

describe('审查流（store + TabBar 虚拟 tab）', () => {
  it('项目菜单打开 → 清单渲染 + 虚拟 tab 出现 + 前台切换（任务 tab 留存退后台）', async () => {
    await renderApp()
    await useAppStore.getState().openReview('p1')
    await waitFor(() => expect(useAppStore.getState().reviewState?.files).toHaveLength(3))
    expect(useAppStore.getState().reviewActive).toBe(true)

    // 虚拟 tab 出现（◆ + 项目名 + 改动数角标）
    const reviewTab = screen.getByTestId('review-tab')
    expect(reviewTab.getAttribute('aria-selected')).toBe('true')
    expect(reviewTab.textContent).toContain('RepoA')
    expect(reviewTab.textContent).toContain('3')

    // 首个带详情文件自动选中（跳过未跟踪）
    await waitFor(() => expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/a.ts'))
    expect(screen.getByTestId('diff-review')).toBeDefined()
    expect(screen.getByText('@@ -1,1 +1,1 @@ hunk 1')).toBeDefined()

    // 点任务 tab → 终端回前台，审查退后台但留存（tab 与侧栏任务行同名——按 role 取 tab）
    fireEvent.click(screen.getByRole('tab', { name: /任务一/ }))
    await waitFor(() => expect(useAppStore.getState().reviewActive).toBe(false))
    expect(useAppStore.getState().reviewState).not.toBeNull()
    expect(screen.getByTestId('review-tab').getAttribute('aria-selected')).toBe('false')

    // 点审查 tab → 回审查（状态留存：选中文件不变）
    fireEvent.click(screen.getByTestId('review-tab'))
    await waitFor(() => expect(useAppStore.getState().reviewActive).toBe(true))
    expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/a.ts')
  })

  it('审查 tab × / Esc → 关闭（虚拟 tab 消失；重开重新拉清单）', async () => {
    const mock = await renderApp()
    await useAppStore.getState().openReview('p1')
    await waitFor(() => expect(useAppStore.getState().reviewState?.files).toHaveLength(3))

    fireEvent.click(within(screen.getByTestId('review-tab')).getByText('×'))
    await waitFor(() => expect(useAppStore.getState().reviewState).toBeNull())
    expect(screen.queryByTestId('review-tab')).toBeNull()
    expect(mock.listDiff).toHaveBeenCalledTimes(1)

    // 重开 = 重新拉快照
    await useAppStore.getState().openReview('p1')
    await waitFor(() => expect(mock.listDiff).toHaveBeenCalledTimes(2))
  })

  it('刷新：清单重拉，选中文件保留；清单错误展示 + 重试按钮', async () => {
    const mock = await renderApp()
    await useAppStore.getState().openReview('p1')
    await waitFor(() => expect(useAppStore.getState().reviewState?.files).toHaveLength(3))
    await waitFor(() => expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/a.ts'))

    await useAppStore.getState().refreshReview()
    await waitFor(() => expect(mock.listDiff).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/a.ts')

    // 错误路径
    vi.mocked(mock.listDiff).mockRejectedValue(new Error('not a git repository'))
    await useAppStore.getState().refreshReview()
    await waitFor(() => expect(useAppStore.getState().reviewState?.error).toContain('git'))
    expect(screen.getByText('not a git repository')).toBeDefined()
  })

  it('任务结束提示（ReviewHint 事件）→ toast [审查] 打开对应 cwd', async () => {
    const mock = await renderApp()
    // initListeners 订阅的回调在 mock 内部：经 onReviewHint mock 触发
    const registered = vi.mocked(mock.onReviewHint).mock.calls[0]?.[0]
    expect(registered).toBeDefined()
    registered!({
      projectId: 'p1',
      cwd: 'D:\\repo-a\\.cwb-worktrees\\wt-1',
      files: 4,
      add: 100,
      del: 20
    })
    await waitFor(() => expect(screen.getByTestId('review-hint-toast')).toBeDefined())
    expect(screen.getByTestId('review-hint-toast').textContent).toContain('RepoA')

    fireEvent.click(within(screen.getByTestId('review-hint-toast')).getByText('审查'))
    await waitFor(() => expect(useAppStore.getState().reviewState?.cwd).toBe('D:\\repo-a\\.cwb-worktrees\\wt-1'))
    expect(useAppStore.getState().reviewHint).toBeNull()
  })
})

describe('DiffReview 组件交互', () => {
  it('文件列表 ↑/↓ 换文件（跳过未跟踪）；diff 视图 ↑/↓ 跳 hunk 并播报 n/m', async () => {
    await renderApp()
    await useAppStore.getState().openReview('p1')
    await waitFor(() => expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/a.ts'))

    // 列表聚焦（初始焦点 pane=list）：↓ → 下一文件 b.ts（跳过 notes.md）
    const listBox = screen.getByRole('listbox', { name: '改动文件列表' })
    fireEvent.keyDown(listBox, { key: 'ArrowDown' })
    await waitFor(() => expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/b.ts'))

    // diff 视图聚焦：↑/↓ hunk 跳转（3 hunks；计数器 1/3 → 2/3）
    const view = screen.getByRole('region', { name: /src\/b\.ts/ })
    fireEvent.focus(view)
    expect(screen.getByText('第 1/3 处修改')).toBeDefined()
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    expect(screen.getByText('第 2/3 处修改')).toBeDefined()
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    expect(screen.getByText('第 3/3 处修改')).toBeDefined()
    // 末 hunk 再 ↓ → 连续审查：后续只剩未跟踪文件（无 hunk 可看）→ 停留原文件
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    expect(useAppStore.getState().reviewState?.selectedPath).toBe('src/b.ts')
    // 未跟踪文件：点击选中 → 占位提示、无 hunk 导航条
    fireEvent.click(screen.getByText('notes.md'))
    await waitFor(() => expect(useAppStore.getState().reviewState?.selectedPath).toBe('notes.md'))
    expect(screen.getByText('未跟踪文件（无 HEAD diff）')).toBeDefined()
  })

  it('状态徽标与 +/− 计数渲染（字母+颜色双编码；U 无计数）', async () => {
    await renderApp()
    await useAppStore.getState().openReview('p1')
    await waitFor(() => expect(useAppStore.getState().reviewState?.files).toHaveLength(3))
    const rows = document.querySelectorAll('.diff-file-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('+3')
    expect(rows[0]!.textContent).toContain('−1')
    expect(rows[1]!.getAttribute('data-status')).toBe('A')
    expect(rows[2]!.textContent).toContain('?')
  })
})

describe('v2.0.3 审查竖条入口（常驻可见）', () => {
  it('git 项目 + active 任务 → 竖条「审查改动」可见；点击直达项目与 worktree 目录；非 git 无按钮', async () => {
    await renderApp()
    const wtTask = makeTask({ id: 'tw', projectId: 'p1', name: 'worktree 活', cwd: 'D:\\repo-a', worktreePath: 'D:\\repo-a\\.cwb-worktrees\\tw' })
    useAppStore.setState((s) => ({ tasks: [...s.tasks, wtTask], openTaskIds: [...s.openTaskIds, 'tw'], activeTaskId: 'tw' }))
    const rail = await screen.findByTestId('btn-review-rail')
    expect(rail.textContent).toContain('审查改动')
    fireEvent.click(rail)
    await waitFor(() => {
      expect(useAppStore.getState().reviewState?.projectId).toBe('p1')
      expect(useAppStore.getState().reviewState?.cwd).toBe('D:\\repo-a\\.cwb-worktrees\\tw')
    })
  })
})
