import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'

// zustand 模块级单例：测试间重置状态（actions 合并保留）
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

/** 项目侧栏行（项目名同时出现在侧栏行与任务区标题，统一用 id 定位防多匹配） */
function projectRow(id: string): HTMLElement {
  return document.querySelector(`li[data-project-id="${id}"]`) as HTMLElement
}

describe('App（布局与侧栏）', () => {
  it('renders the version button（v0.5.1：顶部菜单移除，版本入口取代标题）', () => {
    installCwbMock()
    render(<App />)
    expect(screen.getByRole('button', { name: 'v1.0.3' })).toBeDefined()
  })

  it('mount 时并行加载 projects 与 tasks（均调用一次）', async () => {
    const api = installCwbMock({
      projects: [makeProject({ id: 'p1', name: 'Alpha', dir: 'D:\\alpha' })],
      tasks: [makeTask({ id: 't1', projectId: 'p1', name: '任务A' })]
    })
    render(<App />)
    await waitFor(() => expect(projectRow('p1')).toBeDefined())
    // S6：任务名同时出现在树行与「最近」区块——用 li[data-task-id] 锚点防多匹配
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t1"]')).toBeDefined()
    )
    expect(api.listProjects).toHaveBeenCalledTimes(1)
    expect(api.listTasks).toHaveBeenCalledTimes(1)
    expect(api.listTasks).toHaveBeenCalledWith() // 全量列表（不带 projectId）
  })

  it('侧栏渲染项目行：名称 + git 徽标（dir 移 tooltip，S6-B）；非 git 无徽标', async () => {
    installCwbMock({
      projects: [
        makeProject({ id: 'pg', name: 'GitProj', dir: 'D:\\gitproj', isGit: true }),
        makeProject({ id: 'pn', name: 'PlainProj', dir: 'D:\\plain', isGit: false })
      ]
    })
    render(<App />)
    await waitFor(() => expect(projectRow('pg')).toBeDefined())
    const gitRow = projectRow('pg')
    expect(gitRow.querySelector('.git-badge')?.textContent).toBe('git')
    expect(gitRow.querySelector('.project-main')?.getAttribute('title')).toBe('D:\\gitproj')
    const plainRow = projectRow('pn')
    expect(plainRow.querySelector('.git-badge')).toBeNull()
    expect(plainRow.querySelector('.project-main')?.getAttribute('title')).toBe('D:\\plain')
  })

  it('点击项目行选中该项目', async () => {
    installCwbMock({
      projects: [
        makeProject({ id: 'pa', name: 'First' }),
        makeProject({ id: 'pb', name: 'Second' })
      ]
    })
    render(<App />)
    await waitFor(() => expect(projectRow('pb')).toBeDefined())
    fireEvent.click(projectRow('pb').querySelector('.project-main') as HTMLElement)
    expect(useAppStore.getState().selectedProjectId).toBe('pb')
  })

  it('打开目录流：pickDirectory 返回路径 → addProject(路径) 且选中新项目', async () => {
    const api = installCwbMock({ projects: [] })
    vi.mocked(api.pickDirectory).mockResolvedValue('D:\\newproj')
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '打开目录' }))
    })
    await waitFor(() => expect(api.addProject).toHaveBeenCalledWith('D:\\newproj'))
    const state = useAppStore.getState()
    expect(
      state.projects.some((p) => p.dir === 'D:\\newproj' && p.id === state.selectedProjectId)
    ).toBe(true)
  })

  it('打开目录流：pickDirectory 取消（null）→ 中止，addProject 不被调用', async () => {
    const api = installCwbMock({ projects: [] })
    vi.mocked(api.pickDirectory).mockResolvedValue(null)
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '打开目录' }))
    })
    expect(api.addProject).not.toHaveBeenCalled()
  })

  it('项目行重命名（S6-B 经 ⋯ 菜单）：Enter 提交 → renameProject(id, 新名)', async () => {
    const api = installCwbMock({ projects: [makeProject({ id: 'p1', name: 'Old' })] })
    render(<App />)
    await waitFor(() => expect(projectRow('p1')).toBeDefined())
    const row = projectRow('p1')
    fireEvent.click(within(row).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = within(row).getByDisplayValue('Old')
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith('p1', 'New'))
  })

  it('双击项目行名=重命名（S6-B）：Enter 提交 → renameProject(id, 新名)', async () => {
    const api = installCwbMock({ projects: [makeProject({ id: 'p1', name: 'Old' })] })
    render(<App />)
    await waitFor(() => expect(projectRow('p1')).toBeDefined())
    const row = projectRow('p1')
    fireEvent.doubleClick(row.querySelector('.project-main') as HTMLElement)
    const input = within(row).getByDisplayValue('Old')
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameProject).toHaveBeenCalledWith('p1', 'New'))
  })

  it('项目移除（S6-B 经 ⋯ 菜单）：confirm → removeProject(id)', async () => {
    const api = installCwbMock({ projects: [makeProject({ id: 'p1', name: 'Bye' })] })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await waitFor(() => expect(projectRow('p1')).toBeDefined())
    fireEvent.click(within(projectRow('p1')).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移除' }))
    await waitFor(() => expect(api.removeProject).toHaveBeenCalledWith('p1'))
  })

  it('unmount 后事件全部退订（onPtyData/onTaskUpdate/onTaskActivity disposer 均被调）', () => {
    const api = installCwbMock()
    const { unmount } = render(<App />)
    expect(api.ptyCallbacks.length).toBe(1)
    expect(api.taskUpdateCallbacks.length).toBe(1)
    expect(api.activityCallbacks.length).toBe(1)
    unmount()
    expect(api.ptyDisposer).toHaveBeenCalled()
    expect(api.taskDisposer).toHaveBeenCalled()
    expect(api.activityDisposer).toHaveBeenCalled()
  })
})
