import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeProject, makeTask } from './test-helpers'
import { emitTaskData, useAppStore } from './store'

const gitProject = makeProject({ id: 'pg', name: 'GitProj', isGit: true, dir: 'D:\\gitproj' })
const plainProject = makeProject({ id: 'pn', name: 'PlainProj', isGit: false, dir: 'D:\\plain' })
const BANNER_TEXT = '共享目录模式——建议 git init 以启用 worktree 隔离'

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    activityMap: {}
  })
})
afterEach(cleanup)

/** 项目名同时出现在侧栏行与新建对话框标题——用 id 行定位等待加载完成 */
async function renderWithProject(
  project: ReturnType<typeof makeProject>,
  tasks: ReturnType<typeof makeTask>[] = []
) {
  const api = installCwbMock({ projects: [project], tasks })
  render(<App />)
  await waitFor(() =>
    expect(document.querySelector(`li[data-project-id="${project.id}"]`)).toBeDefined()
  )
  return api
}

/** 任务行（任务名同时出现在树行/最近区块/tab，统一用 data-task-id 定位） */
function taskRow(id: string): HTMLElement | null {
  return document.querySelector(`li[data-task-id="${id}"]`)
}
function projectNode(id: string): HTMLElement | null {
  return document.querySelector(`li[data-project-id="${id}"]`)
}

/** S6-B：行操作按钮收进「⋯」溢出菜单——先点行 ⋯ 开菜单（菜单浮层 portal 挂 body，用 screen 查询） */
function openTaskMenu(id: string): void {
  fireEvent.click(within(taskRow(id) as HTMLElement).getByRole('button', { name: '任务操作' }))
}
function openProjectMenu(id: string): void {
  fireEvent.click(within(projectNode(id) as HTMLElement).getByRole('button', { name: '项目操作' }))
}

describe('新建任务流程（S6-A：顶部「＋ 新建任务」按钮 + 对话框）', () => {
  it('git 项目：弹三选对话框 → 创建隔离分支 → createTask(..., {isolation:"worktree"})，成功自动开 tab 并关对话框', async () => {
    const api = await renderWithProject(gitProject)
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'mytask' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新建任务' }))
    fireEvent.click(screen.getByRole('button', { name: /创建隔离分支/ }))
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith('pg', 'mytask', { isolation: 'worktree' })
    )
    expect(await screen.findByRole('tab', { name: /mytask/ })).toBeDefined()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull())
  })

  it('git 项目：改用共享目录 → createTask(..., {isolation:"shared"})', async () => {
    const api = await renderWithProject(gitProject)
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'sh' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新建任务' }))
    fireEvent.click(screen.getByRole('button', { name: /改用共享目录/ }))
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith('pg', 'sh', { isolation: 'shared' })
    )
  })

  it('git 项目：三选「取消」返回名称输入（草稿保留）；名称阶段取消关闭对话框，createTask 不被调用', async () => {
    const api = await renderWithProject(gitProject)
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    let dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新建任务' }))
    // 三选阶段取消 → 回名称输入，草稿保留（沿旧 NewTaskForm 语义）
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    dialog = screen.getByRole('dialog', { name: '新建任务' })
    expect(within(dialog).getByDisplayValue('x')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull())
    expect(api.createTask).not.toHaveBeenCalled()
  })

  it('非 git 项目：无三选直接 {isolation:"shared"}，且不再显示常驻提示横幅（v0.9.1 移除）', async () => {
    const api = await renderWithProject(plainProject)
    expect(screen.queryByText(BANNER_TEXT)).toBeNull()
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'plain' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新建任务' }))
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith('pn', 'plain', { isolation: 'shared' })
    )
  })

  it('git 项目不显示共享目录横幅', async () => {
    await renderWithProject(gitProject)
    expect(screen.queryByText(BANNER_TEXT)).toBeNull()
  })

  it('A16（v0.5.1 适配）：零项目时新建任务入口不存在（按钮已移除，经项目菜单/Ctrl+N）', async () => {
    await renderWithProject(plainProject, [])
    useAppStore.setState({ projects: [], selectedProjectId: null })
    expect(screen.queryByRole('button', { name: '＋ 新建任务' })).toBeNull()
    await waitFor(() => expect(document.querySelector('li[data-project-id]')).toBeNull())
  })

  it('项目菜单「新建任务」：预选中该项目并在其中创建（同顶部按钮流程）', async () => {
    const api = installCwbMock({
      projects: [
        makeProject({ id: 'pa', name: 'First' }),
        makeProject({ id: 'pb', name: 'Second', isGit: false })
      ]
    })
    render(<App />)
    await waitFor(() => expect(projectNode('pb')).toBeDefined())
    expect(useAppStore.getState().selectedProjectId).toBe('pa') // loadAll 自动选首个
    openProjectMenu('pb')
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    // 对话框标题含预选项目名，且该项目被选中
    expect(screen.getByText('在 “Second” 新建任务')).toBeDefined()
    expect(useAppStore.getState().selectedProjectId).toBe('pb')
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'm' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '新建任务' }))
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith('pb', 'm', { isolation: 'shared' }))
  })
})

describe('任务行操作（S6-B：⋯ 溢出菜单 + 单行化）', () => {
  const runner = makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'running', cwd: 'D:\\wt1' })
  const sleeper = makeTask({ id: 'ts', projectId: 'pg', name: 'sleeper', status: 'stopped' })
  const wtTask = makeTask({
    id: 'tw',
    projectId: 'pg',
    name: 'wttask',
    status: 'stopped',
    worktreePath: 'D:\\wt'
  })

  it('任务行渲染：名称 + 状态点；cwd 移 tooltip（S6-B 单行化）', async () => {
    await renderWithProject(gitProject, [runner])
    expect(within(taskRow('tr') as HTMLElement).getByText('runner')).toBeDefined()
    expect(
      (taskRow('tr') as HTMLElement).querySelector('.task-main')?.getAttribute('title')
    ).toBe('D:\\wt1')
    expect(taskRow('tr')?.querySelector('.status-dot')?.getAttribute('data-status')).toBe('running')
  })

  it('running 行菜单：有「停止」无「恢复」→ stopTask(taskId)', async () => {
    const api = await renderWithProject(gitProject, [runner, sleeper])
    openTaskMenu('tr')
    expect(screen.getByRole('menuitem', { name: '停止' })).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: '恢复' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
    await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith('tr'))
  })

  it('stopped 行菜单：有「恢复」无「停止」→ resumeTask(taskId)', async () => {
    const api = await renderWithProject(gitProject, [runner, sleeper])
    openTaskMenu('ts')
    expect(screen.getByRole('menuitem', { name: '恢复' })).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: '停止' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复' }))
    await waitFor(() => expect(api.resumeTask).toHaveBeenCalledWith('ts'))
  })

  it('删除：菜单进入确认对话框，勾选“同时删除 worktree 分支” → removeTask(id, {deleteWorktree:true})', async () => {
    const api = await renderWithProject(gitProject, [wtTask])
    openTaskMenu('tw')
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(api.removeTask).toHaveBeenCalledWith('tw', { deleteWorktree: true })
    )
  })

  it('删除：不勾选 → removeTask(id, {deleteWorktree:false})，任务行从列表移除', async () => {
    const api = await renderWithProject(gitProject, [wtTask])
    openTaskMenu('tw')
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(api.removeTask).toHaveBeenCalledWith('tw', { deleteWorktree: false })
    )
    await waitFor(() => expect(taskRow('tw')).toBeNull())
  })

  it('onTaskUpdate 推送 → 状态点 running→stopped', async () => {
    const api = await renderWithProject(gitProject, [runner])
    expect(taskRow('tr')?.querySelector('.status-dot')?.getAttribute('data-status')).toBe('running')
    act(() => {
      for (const cb of api.taskUpdateCallbacks) {
        cb(makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'stopped' }))
      }
    })
    await waitFor(() =>
      expect(taskRow('tr')?.querySelector('.status-dot')?.getAttribute('data-status')).toBe('stopped')
    )
  })

  it('单击任务行主区=开 tab；× 仅关视图不停任务；菜单无「打开」项（v0.5① 与单击重复移除）', async () => {
    const api = await renderWithProject(gitProject, [runner])
    fireEvent.click((taskRow('tr') as HTMLElement).querySelector('.task-main') as HTMLElement)
    const tab = await screen.findByRole('tab')
    expect(within(tab).getByText('runner')).toBeDefined()
    fireEvent.click(within(tab).getByRole('button', { name: '×' }))
    await waitFor(() => expect(screen.queryByRole('tab')).toBeNull())
    expect(taskRow('tr')).toBeDefined() // 任务行仍在
    expect(api.stopTask).not.toHaveBeenCalled() // 不停止任务
    // v0.5① 回归断言：菜单不再有「打开」（与单击行完全重复）
    openTaskMenu('tr')
    expect(screen.queryByRole('menuitem', { name: '打开' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '停止' })).toBeDefined() // 其余菜单项保留
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    // 再单击行可重新打开 tab（开 tab 语义只剩单击入口）
    fireEvent.click((taskRow('tr') as HTMLElement).querySelector('.task-main') as HTMLElement)
    expect(await screen.findByRole('tab')).toBeDefined()
  })

  it('活跃 tab 对应任务行高亮（S6-F：task-row.active）', async () => {
    await renderWithProject(gitProject, [runner, sleeper])
    expect(taskRow('tr')?.className).not.toContain('active')
    fireEvent.click((taskRow('tr') as HTMLElement).querySelector('.task-main') as HTMLElement)
    await waitFor(() => expect(taskRow('tr')?.className).toContain('active'))
    expect(taskRow('ts')?.className).not.toContain('active')
  })

  it('菜单重命名：inline 编辑 Enter 提交 → renameTask(taskId, 新名)', async () => {
    const api = await renderWithProject(gitProject, [sleeper])
    openTaskMenu('ts')
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = within(taskRow('ts') as HTMLElement).getByDisplayValue('sleeper')
    fireEvent.change(input, { target: { value: 'awake' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameTask).toHaveBeenCalledWith('ts', 'awake'))
  })

  it('双击任务行名=重命名（S6-B）；Esc 取消不提交', async () => {
    const api = await renderWithProject(gitProject, [sleeper])
    const main = (taskRow('ts') as HTMLElement).querySelector('.task-main') as HTMLElement
    fireEvent.doubleClick(main)
    const input = within(taskRow('ts') as HTMLElement).getByDisplayValue('sleeper')
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() =>
      expect(within(taskRow('ts') as HTMLElement).queryByDisplayValue('nope')).toBeNull()
    )
    expect(api.renameTask).not.toHaveBeenCalled()
  })

  it('复制 sessionId → navigator.clipboard.writeText(sessionId)', async () => {
    await renderWithProject(gitProject, [wtTask])
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    openTaskMenu('tw')
    fireEvent.click(screen.getByRole('menuitem', { name: '复制 sessionId' }))
    expect(writeText).toHaveBeenCalledWith('tw') // makeTask 契约 sessionId===id
  })
})

describe('项目树折叠（v0.1.2 行为保持：CSS 隐藏保挂载）', () => {
  const runner = makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'running' })

  it('默认展开；点折叠按钮 CSS 隐藏子树（保挂载防丢草稿），再点展开；aria-expanded 同步', async () => {
    await renderWithProject(gitProject, [runner])
    const node = projectNode('pg') as HTMLElement
    const children = node.querySelector('.project-children') as HTMLElement
    expect(taskRow('tr')).toBeDefined() // 默认展开，任务行直接可见
    expect(children.style.display).toBe('')

    const caret = within(node).getByRole('button', { name: /折叠 GitProj 的任务/ })
    expect(caret.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(caret)
    await waitFor(() => expect(children.style.display).toBe('none'))
    // CSS 隐藏而非卸载：DOM 保留（草稿状态不丢）
    expect(children.contains(taskRow('tr'))).toBe(true)

    const collapsedCaret = within(node).getByRole('button', { name: /展开 GitProj 的任务/ })
    expect(collapsedCaret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(collapsedCaret)
    await waitFor(() => expect(children.style.display).toBe(''))
    expect(taskRow('tr')).toBeDefined()
  })

  it('折叠与终端解耦：折叠持有已开 tab 的项目，tab 不受影响', async () => {
    await renderWithProject(gitProject, [runner])
    fireEvent.click((taskRow('tr') as HTMLElement).querySelector('.task-main') as HTMLElement)
    expect(await screen.findByRole('tab')).toBeDefined()

    const node = projectNode('pg') as HTMLElement
    const children = node.querySelector('.project-children') as HTMLElement
    fireEvent.click(within(node).getByRole('button', { name: /折叠 GitProj 的任务/ }))
    await waitFor(() => expect(children.style.display).toBe('none'))
    expect(screen.getByRole('tab')).toBeDefined() // tab 与终端面板不受折叠影响
    expect(within(screen.getByRole('tab')).getByText('runner')).toBeDefined()
  })
})

describe('溢出菜单浮层交互（S6-B）', () => {
  const runner = makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'running' })
  const sleeper = makeTask({ id: 'ts', projectId: 'pg', name: 'sleeper', status: 'stopped' })

  it('互斥：点开第二行菜单自动关闭前一个（同时仅一个 menu）', async () => {
    await renderWithProject(gitProject, [runner, sleeper])
    openTaskMenu('tr')
    expect(screen.getByRole('menu')).toBeDefined()
    openTaskMenu('ts')
    expect(screen.getAllByRole('menu').length).toBe(1)
    // 当前菜单属于 ts（恢复项），tr 的停止项已随之关闭
    expect(screen.getByRole('menuitem', { name: '恢复' })).toBeDefined()
  })

  it('Escape 关闭；点击菜单外区域关闭', async () => {
    await renderWithProject(gitProject, [runner, sleeper])
    openTaskMenu('tr')
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    openTaskMenu('tr')
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})

describe('单任务跳过权限确认（v0.3.1：--dangerously-skip-permissions）', () => {
  it('新建勾选 → createTask 带 skipPermissions:true（git 三选流携带）', async () => {
    const api = await renderWithProject(gitProject)
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'sp' } })
    fireEvent.click(screen.getByRole('checkbox')) // 对话框内唯一 checkbox（安全默认关）
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.click(screen.getByRole('button', { name: /创建隔离分支/ }))
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith('pg', 'sp', {
        isolation: 'worktree',
        skipPermissions: true
      })
    )
  })

  it('⋯ 菜单切换单任务开关 → setTaskSkipPermissions(id, on)；⚡ 徽标随状态', async () => {
    const flagged = makeTask({
      id: 'tk',
      projectId: 'pg',
      name: 'flagged',
      status: 'stopped',
      skipPermissions: true
    })
    const api = await renderWithProject(gitProject, [flagged])
    expect(taskRow('tk')!.querySelector('.skip-perm-badge')).not.toBeNull()

    // 开 → 关
    fireEvent.click(within(taskRow('tk')!).getByRole('button', { name: '任务操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /跳过权限确认：开（点击关闭）/ }))
    await waitFor(() => expect(api.setTaskSkipPermissions).toHaveBeenCalledWith('tk', false))
    await waitFor(() => expect(taskRow('tk')!.querySelector('.skip-perm-badge')).toBeNull())

    // 关 → 开
    fireEvent.click(within(taskRow('tk')!).getByRole('button', { name: '任务操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /跳过权限确认：关（点击开启）/ }))
    await waitFor(() => expect(api.setTaskSkipPermissions).toHaveBeenCalledWith('tk', true))
  })

  it('默认不勾选 → createTask 不带 skipPermissions（安全默认）', async () => {
    const api = await renderWithProject(plainProject)
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    const dialog = screen.getByRole('dialog', { name: '新建任务' })
    fireEvent.change(within(dialog).getByPlaceholderText('任务名'), { target: { value: 'plain' } })
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith('pn', 'plain', { isolation: 'shared' })
    )
  })
})

describe('v0.3.2 状态跟踪（三态 + 运行时长）', () => {
  it('exited：红点 data-status=exited + "已退出"标题；菜单显示恢复', async () => {
    const crashed = makeTask({ id: 'tx', projectId: 'pg', name: 'crashed', status: 'exited' })
    await renderWithProject(gitProject, [crashed])
    const dot = taskRow('tx')!.querySelector('.status-dot')!
    expect(dot.getAttribute('data-status')).toBe('exited')
    expect(dot.getAttribute('title')).toContain('已退出')
    fireEvent.click(within(taskRow('tx')!).getByRole('button', { name: '任务操作' }))
    expect(screen.getByRole('menuitem', { name: '恢复' })).toBeDefined()
  })

  it('running 显示运行时长（lastActiveAt 2 小时前 → 2h 0m）', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
    const runner = makeTask({
      id: 'ty',
      projectId: 'pg',
      name: 'longrun',
      status: 'running',
      lastActiveAt: twoHoursAgo
    })
    await renderWithProject(gitProject, [runner])
    expect(within(taskRow('ty')!).getByText('2h 0m')).toBeDefined()
  })

  it('stopped 不显示时长；running 不足 1 分钟也不显示', async () => {
    const s = makeTask({ id: 'tz', projectId: 'pg', name: '静默', status: 'stopped' })
    const fresh = makeTask({ id: 'tf', projectId: 'pg', name: '刚起', status: 'running' })
    await renderWithProject(gitProject, [s, fresh])
    expect(taskRow('tz')!.querySelector('.task-elapsed')).toBeNull()
    expect(taskRow('tf')!.querySelector('.task-elapsed')).toBeNull()
  })
})

describe('v3.2 事件驱动视觉状态（四态：busy 黄转圈/awaiting 红/idle 绿/stopped 绿/exited 灰空心环）', () => {
  function visual(id: string): string | null {
    return taskRow(id)!.querySelector('.status-dot')!.getAttribute('data-visual')
  }
  function dotTitle(id: string): string | null {
    return taskRow(id)!.querySelector('.status-dot')!.getAttribute('title')
  }
  /** v0.4.5：视觉断言前先开 tab（tab 未开 → closed 灰） */
  function openTab(id: string): void {
    act(() => {
      useAppStore.getState().openTask(id)
    })
  }

  /** 模拟 main 广播 cwb:event:task-activity（经 initListeners 注册的回调） */
  function fireActivity(api: ReturnType<typeof installCwbMock>, taskId: string, activity: 'busy' | 'awaiting' | 'idle'): void {
    act(() => {
      for (const cb of api.activityCallbacks) cb({ taskId, activity })
    })
  }

  it('busy：onTaskActivity 广播 → 黄转圈 data-visual=busy +「正在执行」', async () => {
    const api = await renderWithProject(gitProject, [
      makeTask({ id: 'tv1', projectId: 'pg', name: '忙', status: 'running' })
    ])
    openTab("tv1")
    expect(visual('tv1')).toBe('idle') // 无条目且无字节 → 兜底绿
    fireActivity(api, 'tv1', 'busy')
    expect(visual('tv1')).toBe('busy')
    expect(dotTitle('tv1')).toBe('正在执行')
  })

  it('awaiting：onTaskActivity 广播 → 红 data-visual=awaiting +「等待答复」', async () => {
    const api = await renderWithProject(gitProject, [
      makeTask({ id: 'tv2', projectId: 'pg', name: '待', status: 'running' })
    ])
    openTab("tv2")
    fireActivity(api, 'tv2', 'awaiting')
    expect(visual('tv2')).toBe('awaiting')
    expect(dotTitle('tv2')).toBe('等待答复（权限/选项确认）')
  })

  it('idle：onTaskActivity 广播 → 绿 data-visual=idle +「空闲就绪」（刚 spawn/resume 的默认态）', async () => {
    const api = await renderWithProject(gitProject, [
      makeTask({ id: 'tv3', projectId: 'pg', name: '闲', status: 'running' })
    ])
    openTab("tv3")
    fireActivity(api, 'tv3', 'idle')
    expect(visual('tv3')).toBe('idle')
    expect(dotTitle('tv3')).toBe('空闲就绪')
    // busy → idle 的迁移（Stop/Esc 合成）
    fireActivity(api, 'tv3', 'busy')
    fireActivity(api, 'tv3', 'idle')
    expect(visual('tv3')).toBe('idle')
  })

  it('stopped（已停止可恢复）→ data-visual=stopped +「已停止（可恢复）」（与 idle 同绿异文案）', async () => {
    await renderWithProject(gitProject, [
      makeTask({ id: 'tv4', projectId: 'pg', name: '停', status: 'stopped' })
    ])
    openTab("tv4")
    expect(visual('tv4')).toBe('stopped')
    expect(dotTitle('tv4')).toBe('已停止（可恢复）')
  })

  it('exited → data-visual=exited（灰空心环）；data-status 语义锚保留', async () => {
    await renderWithProject(gitProject, [
      makeTask({ id: 'tv5', projectId: 'pg', name: '退', status: 'exited' })
    ])
    openTab("tv5")
    expect(visual('tv5')).toBe('exited')
    expect(dotTitle('tv5')).toBe('已退出')
    expect(taskRow('tv5')!.querySelector('.status-dot')!.getAttribute('data-status')).toBe('exited')
  })

  it('兜底字节启发（activityMap 无条目）：最近有 PTY 输出 → busy；安静 → idle（永不红）', async () => {
    const r = makeTask({ id: 'tv6', projectId: 'pg', name: '兜底', status: 'running' })
    const quiet = makeTask({ id: 'tv7', projectId: 'pg', name: '安静', status: 'running' })
    await renderWithProject(gitProject, [r, quiet])
    openTab("tv7")
    openTab("tv6")
    await act(async () => {
      emitTaskData({ taskId: 'tv6', data: 'working...' })
    })
    // 字节启发是渲染期计算（useNow 1s 自刷新驱动重渲染），等下一跳再断言
    await waitFor(() => expect(visual('tv6')).toBe('busy'), { timeout: 4_000, interval: 200 })
    expect(visual('tv7')).toBe('idle') // 无字节记录 → 绿（兜底永不产生红）
  })

  it('「最近」区块行渲染 TaskStatusDot（v3.2 补齐：最近行同享四态视觉）', async () => {
    const api = await renderWithProject(gitProject, [
      makeTask({ id: 'tr1', projectId: 'pg', name: '最近忙', status: 'running' })
    ])
    openTab('tr1') // v0.4.5：最近行同享 tab 开合语义（未开 → closed 灰）
    const recentDot = document.querySelector('li[data-recent-task-id="tr1"] .status-dot') as HTMLElement
    expect(recentDot).not.toBeNull()
    expect(recentDot.getAttribute('data-visual')).toBe('idle')
    fireActivity(api, 'tr1', 'busy')
    expect(
      (document.querySelector('li[data-recent-task-id="tr1"] .status-dot') as HTMLElement).getAttribute('data-visual')
    ).toBe('busy')
  })

  it('Tab 行与任务行共用同一视觉（TaskStatusDot 统一组件）', async () => {
    const api = await renderWithProject(gitProject, [
      makeTask({ id: 'tv8', projectId: 'pg', name: 'tab任务', status: 'running' })
    ])
    fireEvent.click((taskRow('tv8') as HTMLElement).querySelector('.task-main') as HTMLElement)
    const tab = await screen.findByRole('tab', { name: /tab任务/ })
    const tabDot = tab.querySelector('.status-dot') as HTMLElement
    expect(tabDot.getAttribute('data-visual')).toBe('idle')
    fireActivity(api, 'tv8', 'awaiting')
    expect((tab.querySelector('.status-dot') as HTMLElement).getAttribute('data-visual')).toBe('awaiting')
    expect(visual('tv8')).toBe('awaiting')
  })
})

describe('点击自动恢复（v0.4.1：非 running 任务/最近记录单击 → 自动 --resume 加载上下文）', () => {
  function recentRowEl(id: string): HTMLElement {
    return document.querySelector(`li[data-recent-task-id="${id}"]`) as HTMLElement
  }

  it('stopped 任务行单击（250ms 判别后）→ resumeTask + 开 tab', async () => {
    const s = makeTask({ id: 'ta', projectId: 'pg', name: '停任务', status: 'stopped' })
    const api = await renderWithProject(gitProject, [s])
    fireEvent.click(within(taskRow('ta')!).getByRole('button', { name: /停任务/ }))
    await waitFor(() => expect(api.resumeTask).toHaveBeenCalledWith('ta'), { timeout: 2_000 })
    expect(await screen.findByRole('tab', { name: /停任务/ })).toBeDefined()
  })

  it('running 任务行单击 → 只开 tab 不触发 resume', async () => {
    const r = makeTask({ id: 'tb', projectId: 'pg', name: '跑着', status: 'running' })
    const api = await renderWithProject(gitProject, [r])
    fireEvent.click(within(taskRow('tb')!).getByRole('button', { name: /跑着/ }))
    expect(await screen.findByRole('tab', { name: /跑着/ })).toBeDefined()
    await new Promise((res) => setTimeout(res, 400))
    expect(api.resumeTask).not.toHaveBeenCalled()
  })

  it('exited 任务行单击 → resume；最近记录（stopped）单击 → resume', async () => {
    const e = makeTask({ id: 'tc', projectId: 'pg', name: '退任务', status: 'exited' })
    const api = await renderWithProject(gitProject, [e])
    fireEvent.click(within(taskRow('tc')!).getByRole('button', { name: /退任务/ }))
    await waitFor(() => expect(api.resumeTask).toHaveBeenCalledWith('tc'), { timeout: 2_000 })
  })

  it('最近记录单击（stopped）→ resume + 开 tab', async () => {
    const s = makeTask({ id: 'te', projectId: 'pg', name: '最近停', status: 'stopped' })
    const api = await renderWithProject(gitProject, [s])
    await waitFor(() => expect(recentRowEl('te')).toBeDefined())
    fireEvent.click(within(recentRowEl('te')).getByRole('button'))
    await waitFor(() => expect(api.resumeTask).toHaveBeenCalledWith('te'), { timeout: 2_000 })
    expect(await screen.findByRole('tab', { name: /最近停/ })).toBeDefined()
  })

  it('双击重命名不触发 resume（单击判别被取消）', async () => {
    const s = makeTask({ id: 'td', projectId: 'pg', name: '双击我', status: 'stopped' })
    const api = await renderWithProject(gitProject, [s])
    fireEvent.doubleClick(within(taskRow('td')!).getByRole('button', { name: /双击我/ }))
    await new Promise((res) => setTimeout(res, 450))
    expect(api.resumeTask).not.toHaveBeenCalled()
    expect(within(taskRow('td')!).getByDisplayValue('双击我')).toBeDefined() // 已进入重命名
  })
})

describe('v0.4.5 closed 视觉态（tab 未打开/已从标题栏关闭 → 灰）+ busy 滞回', () => {
  function visual(id: string): string | null {
    return taskRow(id)!.querySelector('.status-dot')!.getAttribute('data-visual')
  }

  it('running 任务未开 tab → closed 灰；打开 tab → 恢复活动色；从标题栏关闭 → 回灰', async () => {
    await renderWithProject(gitProject, [
      makeTask({ id: 'tc1', projectId: 'pg', name: '未开', status: 'running' })
    ])
    expect(visual('tc1')).toBe('closed')
    expect(taskRow('tc1')!.querySelector('.status-dot')!.getAttribute('title')).toBe('未打开终端')
    act(() => {
      useAppStore.getState().openTask('tc1')
    })
    expect(visual('tc1')).toBe('idle') // 开 tab 后按活动裁决（无条目兜底=绿）
    act(() => {
      useAppStore.getState().closeTab('tc1') // 模拟标题栏 × 关闭（仅关视图）
    })
    expect(visual('tc1')).toBe('closed')
  })

  it('stopped 未开 tab → closed 灰（不再显示绿）；exited 未开 tab 仍空心环（优先级高于 closed）', async () => {
    await renderWithProject(gitProject, [
      makeTask({ id: 'tc2', projectId: 'pg', name: '停未开', status: 'stopped' }),
      makeTask({ id: 'tc3', projectId: 'pg', name: '退未开', status: 'exited' })
    ])
    expect(visual('tc2')).toBe('closed')
    expect(visual('tc3')).toBe('exited')
  })
})
