import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeConnection, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'

/**
 * v2.1.0 SSH 纯终端（不启 claude CLI）：入口/虚拟 tab/三态互斥/数据流装配/
 * 冻结与重开/分栏键盘调高。
 */

const conn1 = makeConnection({ id: 'c1', name: 'VM-Dev' })
const conn2 = makeConnection({ id: 'c2', name: 'VM-Test' })
const pRemote = makeProject({ id: 'pr', name: 'R', dir: '/home/dev/r', connectionId: 'c1' })
const tRun = makeTask({ id: 'tr', projectId: 'pr', name: '跑着', status: 'running', cwd: '/home/dev/r' })

beforeEach(() => {
  useAppStore.setState({
    projects: [pRemote],
    tasks: [tRun],
    connections: [conn1, conn2],
    connectionStates: { c1: { state: 'connected' } },
    openTaskIds: ['tr'],
    activeTaskId: 'tr',
    sshConsoleCid: null,
    sshActive: false,
    sshSessionDead: false,
    reviewState: null,
    reviewActive: false,
    reviewHint: null,
    settingsOpen: false
  })
})
afterEach(cleanup)

async function renderApp(): Promise<ReturnType<typeof installCwbMock>> {
  const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn1, conn2] })
  vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev', entries: [] })
  render(<App />)
  await waitFor(() => expect(useAppStore.getState().connections.length).toBeGreaterThan(0))
  return api
}

describe('v2.1.0 SSH 纯终端：入口与三态互斥', () => {
  it('竖条「SSH 终端」→ openSshShell + 虚拟 tab + 前台（任务 tab 退后台）；文件面板同台渲染', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshActive).toBe(true))
    expect(useAppStore.getState().sshConsoleCid).toBe('c1')
    expect(api.openSshShell).toHaveBeenCalledWith('c1')
    const tab = screen.getByTestId('ssh-tab')
    expect(tab.textContent).toContain('VM-Dev')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    // 任务 tab 退后台（aria-selected=false）；SSH 前台：控制台 + 文件面板
    expect(screen.getByRole('tab', { name: /跑着/ }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('ssh-console')).toBeDefined()
    expect(screen.getByTestId('files-panel')).toBeDefined()
  })

  it('点任务 tab → SSH 退后台（tab 留存）；点 SSH tab → 回前台（状态留存不重开）', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshActive).toBe(true))
    fireEvent.click(screen.getByRole('tab', { name: /跑着/ }))
    await waitFor(() => expect(useAppStore.getState().sshActive).toBe(false))
    expect(useAppStore.getState().sshConsoleCid).toBe('c1') // 台留存
    expect(screen.getByTestId('ssh-tab').getAttribute('aria-selected')).toBe('false')
    expect(api.openSshShell).toHaveBeenCalledTimes(1) // 不重开
    fireEvent.click(screen.getByTestId('ssh-tab'))
    await waitFor(() => expect(useAppStore.getState().sshActive).toBe(true))
    expect(api.openSshShell).toHaveBeenCalledTimes(1)
  })

  it('SSH tab × → closeSshShell + 台清空', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBe('c1'))
    fireEvent.click(within(screen.getByTestId('ssh-tab')).getByText('×'))
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBeNull())
    expect(screen.queryByTestId('ssh-tab')).toBeNull()
    expect(api.closeSshShell).toHaveBeenCalledWith('c1')
  })

  it('Ctrl+Shift+S 开关（输入态不劫持）', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBe('c1'))
    fireEvent.keyDown(window, { key: 'S', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(useAppStore.getState().sshActive).toBe(false))
    // 输入框聚焦不劫持
    const input = screen.getByPlaceholderText('搜索任务/项目…')
    input.focus()
    fireEvent.keyDown(input, { key: 'S', ctrlKey: true, shiftKey: true })
    expect(useAppStore.getState().sshActive).toBe(false)
  })
})

describe('v2.1.0 数据流与状态', () => {
  it('SshData 事件 → xterm 渲染（订阅链装配）；下拉换连接=关旧开新', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(screen.getByTestId('ssh-console')).toBeDefined())
    // 数据流装配：事件 → 缓冲/冲放 → xterm 文本
    const emit = vi.mocked(api.onSshData).mock.calls[0]?.[0]
    expect(emit).toBeDefined()
    act(() => emit!({ connectionId: 'c1', data: 'hello-ssh\r\n' }))
    await waitFor(() =>
      expect(document.querySelector('.ssh-term-host')?.textContent).toContain('hello-ssh')
    )
    // 换连接：关旧 + 开新
    const select = screen.getByRole('combobox', { name: '目标连接' }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'c2' } })
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBe('c2'))
    expect(api.closeSshShell).toHaveBeenCalledWith('c1')
    expect(api.openSshShell).toHaveBeenCalledWith('c2')
  })

  it('会话结束（SshClosed）→ 冻结层「会话已结束/重开」→ 重开按钮再 open；断连态显示重连', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBe('c1'))
    const emitClosed = vi.mocked(api.onSshClosed).mock.calls[0]?.[0]
    act(() => emitClosed!({ connectionId: 'c1' }))
    await waitFor(() => expect(useAppStore.getState().sshSessionDead).toBe(true))
    expect(screen.getByText('会话已结束（远端退出）')).toBeDefined()
    const before = vi.mocked(api.openSshShell).mock.calls.length
    fireEvent.click(screen.getAllByRole('button', { name: '重开会话' })[0]!)
    await waitFor(() => expect(vi.mocked(api.openSshShell).mock.calls.length).toBe(before + 1))
    await waitFor(() => expect(useAppStore.getState().sshSessionDead).toBe(false))
    // 断连态：offline → 冻结层「连接已断开」+ 重连
    act(() => {
      useAppStore.setState({ connectionStates: {}, sshSessionDead: false })
    })
    await waitFor(() => expect(screen.getByText('连接已断开：输入已冻结，重连后自动恢复')).toBeDefined())
  })
})

describe('v2.1.0 分栏分隔条（WCAG 键盘替代）', () => {
  it('↑/↓ 键盘调高（56% ↔ 回落）+ 双击复位 50%', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    const splitter = await screen.findByRole('separator', { name: '控制台与文件面板分栏' })
    const wrap = document.querySelector('.ssh-term-wrap') as HTMLElement
    await waitFor(() => expect(wrap.style.height).toBe('50%'))
    fireEvent.keyDown(splitter, { key: 'ArrowUp' })
    await waitFor(() => expect(wrap.style.height).toBe('56%'))
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    await waitFor(() => expect(wrap.style.height).toBe('50%'))
    fireEvent.keyDown(splitter, { key: 'ArrowUp' })
    await waitFor(() => expect(wrap.style.height).toBe('56%'))
    fireEvent.dblClick(splitter)
    await waitFor(() => expect(wrap.style.height).toBe('50%'))
  })
})

describe('v2.1.0 评审修复回归（F2/F3/F4）', () => {
  afterEach(cleanup)

  it('F2：open 失败 → dead 态 +「重开会话」入口；重试成功即恢复', async () => {
    const api = await renderApp()
    let fail = true
    vi.mocked(api.openSshShell).mockImplementation(async () =>
      fail ? { ok: false, error: 'shell rejected' } : { ok: true }
    )
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshSessionDead).toBe(true))
    expect(screen.getByText('会话已结束（远端退出）')).toBeDefined()
    fail = false
    fireEvent.click(screen.getAllByRole('button', { name: '重开会话' })[0]!)
    await waitFor(() => expect(useAppStore.getState().sshSessionDead).toBe(false))
    expect(useAppStore.getState().sshActive).toBe(true)
  })

  it('F3：零任务开 SSH → tab 栏仍渲染（可切可关）——主打场景「不建任务」', async () => {
    await renderApp()
    act(() => {
      useAppStore.setState({ tasks: [], openTaskIds: [], activeTaskId: null })
    })
    // 零任务+无虚拟台 → tab 栏不渲染（原行为保留）
    expect(document.querySelector('.tabbar')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshActive).toBe(true))
    // 开着 SSH 台 → tab 栏渲染、SSH tab 可点可关
    expect(document.querySelector('.tabbar')).not.toBeNull()
    fireEvent.click(within(screen.getByTestId('ssh-tab')).getByText('×'))
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBeNull())
    expect(document.querySelector('.tabbar')).toBeNull()
  })

  it('F4：删除目标连接 → SSH 台级联关闭（不留空名 tab/死按钮）', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getByTestId('btn-ssh-rail'))
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBe('c1'))
    vi.mocked(api.removeConnection).mockResolvedValue(undefined)
    vi.mocked(api.listProjects).mockResolvedValue([]) // 级联后清单为空
    await act(async () => {
      await useAppStore.getState().removeConnectionFlow('c1')
    })
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBeNull())
    expect(screen.queryByTestId('ssh-tab')).toBeNull()
    expect(api.closeSshShell).toHaveBeenCalledWith('c1')
  })
})
