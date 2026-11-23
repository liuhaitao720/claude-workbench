import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'
import type { GitRepoStatus } from '../../shared/types'

/**
 * v2.2.5 Git 工作台（合并审查窗口——用户指令）：项目菜单打开 → 历史模式
 * （分支/时间线/详情）→ 动作弹窗（拉取 --rebase / 推送 -f 确认）→ 模式切到
 * 工作区（openReview→listDiff，DiffReview 嵌入）。IPC 面 mock（gitStatus/
 * gitLog/gitCommitDetail/gitAction/listDiff）。
 */

const gitProject = makeProject({ id: 'p1', name: 'RepoA', dir: '/home/dev/repo-a', isGit: true })
const task1 = makeTask({ id: 't1', projectId: 'p1', name: '任务一', cwd: '/home/dev/repo-a' })

function statusFixture(): GitRepoStatus {
  return {
    current: 'main',
    branches: [
      { name: 'main', isRemote: false, upstream: 'origin/main', behind: 3, short: 'c7d9c32' },
      { name: 'feature/x', isRemote: false, ahead: 2, short: '550badc' },
      { name: 'origin/main', isRemote: true, short: 'dead00f' }
    ],
    remotes: [{ name: 'origin', fetchUrl: 'https://github.com/u/repo-a.git' }],
    stashes: [{ index: 0, short: 'a1b2c3d', message: 'WIP on main' }],
    wcCount: 2
  }
}

const COMMITS = [
  { graph: '* ', hash: '550badc4f2d7', short: '550badc', author: 'Haitao LIU', date: '2026-11-23T14:32:11+08:00', subject: 'fix(term): v2.2.4 追加', refs: 'HEAD -> feature/x' },
  { graph: '|\n| * ', hash: 'c7d9c3244e0', short: 'c7d9c32', author: 'Haitao LIU', date: '2026-11-23T14:10:00+08:00', subject: 'docs(release): v2.2.4 发布说明', refs: undefined }
]

beforeEach(() => {
  useAppStore.setState({
    projects: [gitProject],
    tasks: [task1],
    openTaskIds: ['t1'],
    activeTaskId: 't1',
    selectedProjectId: 'p1',
    activityMap: {},
    settingsOpen: false,
    connections: [],
    connectionStates: {},
    serverLogs: [],
    uiSettings: {},
    filesTargetConn: null,
    pendingServerInstall: null,
    settingsScope: 'local',
    reviewState: null,
    gitPanel: null,
    gitActive: false,
    reviewActive: false,
    sshActive: false
  })
  localStorage.removeItem('cwb-language')
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

async function openViaMenu(api: ReturnType<typeof installCwbMock>): Promise<void> {
  vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, status: statusFixture() })
  vi.mocked(api.gitLog).mockResolvedValue({ ok: true, commits: COMMITS })
  render(<App />)
  // 项目行「项目操作」菜单 → Git 管理…
  const row = await waitFor(() => document.querySelector('li[data-project-id="p1"]') as HTMLElement)
  fireEvent.click(within(row).getByRole('button', { name: '项目操作' }))
  fireEvent.click(await screen.findByText('Git 管理…'))
  await waitFor(() => expect(screen.getByTestId('git-frame')).toBeDefined())
}

describe('v2.2.5 Git 工作台（L2.5 装配）', () => {
  it('项目菜单「Git 管理…」→ Git tab + 历史模式：分支列表/时间线/顶栏（当前分支+Stash 数）', async () => {
    const api = installCwbMock({ projects: [gitProject], tasks: [task1] })
    await openViaMenu(api)
    expect(api.gitStatus).toHaveBeenCalledWith('p1')
    expect(api.gitLog).toHaveBeenCalledWith('p1')
    // 分支列表：本地组当前置顶 + ahead/behind；远程组
    const frame = screen.getByTestId('git-frame')
    expect(within(frame).getByText('main')).toBeDefined()
    expect(within(frame).getAllByTestId('git-branch')).toHaveLength(3)
    expect(within(frame).getAllByText('↓3').length).toBeGreaterThan(0)
    // 提交行 + graph 前缀渲染
    expect(within(frame).getAllByTestId('git-commit')).toHaveLength(2)
    expect(within(frame).getByText('fix(term): v2.2.4 追加')).toBeDefined()
    // 顶栏：Stash (1)
    expect(within(frame).getByText(/Stash \(1\)/)).toBeDefined()
    // 任务 tab 留存退后台
    expect(document.querySelector('li[data-task-id="t1"]')).toBeDefined()
  })

  it('点击提交 → gitCommitDetail（文件 ±行数渲染）；切到工作区 → openReview（listDiff）+ DiffReview 嵌入', async () => {
    const api = installCwbMock({ projects: [gitProject], tasks: [task1] })
    vi.mocked(api.listDiff).mockResolvedValue({
      base: 'HEAD' as const,
      files: [{ path: 'src/a.ts', status: 'M' as const, add: 3, del: 1 }]
    })
    await openViaMenu(api)
    // 提交详情
    vi.mocked(api.gitCommitDetail).mockResolvedValue({
      ok: true,
      message: 'fix(term): 主题\n\n正文',
      author: 'Haitao LIU',
      date: '2026-11-23T14:32:11+08:00',
      files: [
        { path: 'src/a.ts', status: 'M', add: 12, del: 4 },
        { path: 'old.ts', oldPath: 'prev.ts', path2: undefined, status: 'R' } as never
      ]
    })
    fireEvent.click(screen.getAllByTestId('git-commit')[0]!)
    await waitFor(() => expect(api.gitCommitDetail).toHaveBeenCalledWith('p1', '550badc4f2d7'))
    await waitFor(() => expect(screen.getByText('+12')).toBeDefined())
    // 模式切换 → 工作区（openReview → listDiff → DiffReview 文件行嵌入）
    fireEvent.click(screen.getByTestId('git-mode-worktree'))
    await waitFor(() => expect(api.listDiff).toHaveBeenCalledWith('p1', '/home/dev/repo-a'))
    await waitFor(() => expect(screen.getByText('src/a.ts')).toBeDefined())
    // 切回历史（gitActive）
    fireEvent.click(screen.getByTestId('git-mode-history'))
    await waitFor(() => expect(screen.getAllByTestId('git-commit').length).toBeGreaterThan(0))
  })

  it('分支右键「检出 checkout」→ gitAction {op:switch}；远程分支 → switchTrack', async () => {
    const api = installCwbMock({ projects: [gitProject], tasks: [task1] })
    await openViaMenu(api)
    vi.mocked(api.gitAction).mockResolvedValue({ ok: true })
    // 本地分支 feature/x（非当前）右键 → 检出
    const row = screen.getAllByTestId('git-branch').find((el) => el.getAttribute('data-branch') === 'feature/x')!
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByText('检出 checkout'))
    await waitFor(() => expect(api.gitAction).toHaveBeenCalledWith('p1', { op: 'switch', branch: 'feature/x' }))
  })

  it('拉取弹窗选 --rebase → {op:pull,mode:rebase}；推送勾选 -f → 确认窗后 {op:push,force:true}', async () => {
    const api = installCwbMock({ projects: [gitProject], tasks: [task1] })
    await openViaMenu(api)
    vi.mocked(api.gitAction).mockResolvedValue({ ok: true })
    // 拉取：默认 merge → rebase 单选 → 确认
    fireEvent.click(screen.getByTitle('拉取（git pull）'))
    const dlg = await screen.findByRole('dialog', { name: '拉取（git pull）' })
    fireEvent.click(within(dlg).getByLabelText('变基 --rebase'))
    fireEvent.click(within(dlg).getByText('拉取'))
    await waitFor(() => expect(api.gitAction).toHaveBeenCalledWith('p1', { op: 'pull', mode: 'rebase' }))
    // 推送：勾选 force → window.confirm（危险确认）→ 确认
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByTitle('推送（git push）'))
    const pdlg = await screen.findByRole('dialog', { name: '推送（git push）' })
    fireEvent.click(within(pdlg).getByTestId('git-push-force'))
    expect(within(pdlg).getByText(/强推会覆盖远端历史/)).toBeDefined()
    fireEvent.click(within(pdlg).getByText('推送'))
    await waitFor(() =>
      expect(api.gitAction).toHaveBeenCalledWith('p1', expect.objectContaining({ op: 'push', force: true }))
    )
    expect(confirmSpy).toHaveBeenCalled()
  })

  it('Stash 面板：push 带消息 → {op:stashPush,message}；远程管理：添加 origin2 → {op:remoteAdd}', async () => {
    const api = installCwbMock({ projects: [gitProject], tasks: [task1] })
    await openViaMenu(api)
    vi.mocked(api.gitAction).mockResolvedValue({ ok: true })
    // Stash
    fireEvent.click(screen.getByTitle('Stash 暂存区'))
    const sdlg = await screen.findByRole('dialog', { name: 'Stash 暂存区' })
    expect(within(sdlg).getByTestId('git-stash-row')).toBeDefined() // 列表渲染
    fireEvent.change(within(sdlg).getByTestId('git-stash-msg'), { target: { value: 'wip 一下' } })
    fireEvent.click(within(sdlg).getByText('暂存当前变更'))
    await waitFor(() => expect(api.gitAction).toHaveBeenCalledWith('p1', { op: 'stashPush', message: 'wip 一下' }))
    // 远程管理
    fireEvent.click(screen.getByTitle('远程仓库 URL 管理'))
    const rdlg = await screen.findByRole('dialog', { name: '远程仓库 URL 管理' })
    expect(within(rdlg).getByTestId('git-remote-row')).toBeDefined()
    fireEvent.change(within(rdlg).getAllByRole('textbox')[0]!, { target: { value: 'origin2' } })
    fireEvent.change(within(rdlg).getAllByRole('textbox')[1]!, { target: { value: 'https://github.com/u/r2.git' } })
    fireEvent.click(within(rdlg).getByText('添加'))
    await waitFor(() =>
      expect(api.gitAction).toHaveBeenCalledWith('p1', {
        op: 'remoteAdd',
        name: 'origin2',
        url: 'https://github.com/u/r2.git'
      })
    )
  })
})
