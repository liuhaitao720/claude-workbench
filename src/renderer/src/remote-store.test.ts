import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { initListeners, useAppStore, clampSidebarWidth } from './store'
import { installCwbMock, makeConnection, makeProject, makeTask } from './test-helpers'

/**
 * S6 L2.5 装配测试（A2 消费侧 / A4 UI 桩 / A5 UI 桩）：
 * initListeners → mock onConnectionState 回调触发 → store.connectionStates 断言
 * （照 installCwbMock 先例）；重连自动恢复流（5.6：connected 迁移 → 批量
 * openTaskAutoResume）；server 日志环形缓冲；侧栏持久化键读取映射。
 */

const conn = makeConnection({ id: 'c1', name: 'VM' })
const pRemote = makeProject({ id: 'pr', name: 'R', dir: '/home/dev/r', connectionId: 'c1' })
const pLocal = makeProject({ id: 'pl', name: 'L', dir: 'D:\\l' })
const tRunning = makeTask({ id: 'tr-run', projectId: 'pr', name: '跑着', status: 'running' })
const tStopped = makeTask({ id: 'tr-stop', projectId: 'pr', name: '停着', status: 'stopped' })

let dispose: (() => void) | null = null

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    activityMap: {},
    settingsOpen: false,
    connections: [],
    connectionStates: {},
    serverLogs: [],
    uiSettings: {},
    pendingServerInstall: null,
    settingsOpenSection: 'general',
    settingsEditConnectionId: null
  })
})
afterEach(() => {
  dispose?.()
  dispose = null
  vi.restoreAllMocks()
})

describe('A2 装配（消费侧）：initListeners → onConnectionState → store', () => {
  it('回调注册即触达：connecting/offline/connected(attempt) 落 connectionStates；卸载退订', async () => {
    const api = installCwbMock()
    dispose = initListeners()
    expect(api.connectionStateCallbacks.length).toBe(1)

    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connecting' }))
    })
    expect(useAppStore.getState().connectionStates['c1']).toEqual({ state: 'connecting' })

    act(() => {
      api.connectionStateCallbacks.forEach((cb) =>
        cb({ connectionId: 'c1', state: 'reconnecting', attempt: 4 })
      )
    })
    expect(useAppStore.getState().connectionStates['c1']).toEqual({
      state: 'reconnecting',
      attempt: 4
    })

    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connected' }))
    })
    expect(useAppStore.getState().connectionStates['c1']).toEqual({ state: 'connected' })

    // 卸载：退订函数被调用（App unmount 对齐）
    dispose?.()
    dispose = null
    expect(api.connectionStateDisposer).toHaveBeenCalled()
  })

  it('onRemoteServerLog → serverLogs 环形缓冲（≤100 条，超出丢最旧）', () => {
    const api = installCwbMock()
    dispose = initListeners()
    for (let i = 0; i < 105; i++) {
      act(() => {
        api.remoteServerLogCallbacks.forEach((cb) =>
          cb({ connectionId: 'c1', level: 'info', message: `log-${i}` })
        )
      })
    }
    const logs = useAppStore.getState().serverLogs
    expect(logs.length).toBe(100)
    expect(logs[0].message).toBe('log-5') // 保留最近 100 条（丢 log-0..4）
    expect(logs[99].message).toBe('log-104')
  })
})

describe('5.6 重连自动恢复：connected 迁移 → 视作运行中的远程任务批量恢复视图', () => {
  it('running 远程任务开 tab（不重复 resume）；stopped 远程任务与本机任务不动', async () => {
    const api = installCwbMock({ projects: [pRemote, pLocal], tasks: [tRunning, tStopped] })
    useAppStore.setState({
      projects: [pRemote, pLocal],
      tasks: [tRunning, tStopped],
      connections: [conn]
    })
    dispose = initListeners()

    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'offline' }))
    })
    expect(useAppStore.getState().openTaskIds).toEqual([])

    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connected' }))
    })
    const s = useAppStore.getState()
    // 「视作运行中」（5.9=b server 保活：断连期间 status 仍 running）→ 恢复视图
    expect(s.openTaskIds).toContain('tr-run')
    expect(s.activeTaskId).toBe('tr-run')
    // stopped 远程任务不自动开/resume；running 但非本连接的也不动
    expect(s.openTaskIds).not.toContain('tr-stop')
    expect(api.resumeTask).not.toHaveBeenCalled()
  })

  it('重复 connected 事件不重复触发（迁入判定幂等）', () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRunning] })
    useAppStore.setState({ projects: [pRemote], tasks: [tRunning], connections: [conn] })
    dispose = initListeners()
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connected' }))
    })
    expect(useAppStore.getState().openTaskIds).toEqual(['tr-run'])
    // 幂等：已 open 的不重复（openTask 本身去重，且迁入条件 prev!==connected 拦截）
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connected' }))
    })
    expect(useAppStore.getState().openTaskIds).toEqual(['tr-run'])
  })
})

describe('connectFlow needInstall 信号（6.7=A 弹窗触发）', () => {
  it('错误含 needInstall/cwb-server → pendingServerInstall；其他错误不弹', async () => {
    installCwbMock()
    useAppStore.setState({ connections: [conn] })
    const cwb = window.cwb
    vi.mocked(cwb.connectConnection).mockRejectedValue(new Error('needInstall: 缺 cwb-server'))
    await act(async () => {
      await useAppStore.getState().connectFlow('c1')
    })
    expect(useAppStore.getState().pendingServerInstall).toEqual({ connectionId: 'c1' })

    useAppStore.setState({ pendingServerInstall: null })
    vi.mocked(cwb.connectConnection).mockRejectedValue(new Error('conn.err.timeout: 45s'))
    await act(async () => {
      await useAppStore.getState().connectFlow('c1')
    })
    expect(useAppStore.getState().pendingServerInstall).toBeNull()
  })
})

describe('侧栏持久化键（3.7/3.10/3.8：getAppSettings → uiSettings 映射）', () => {
  it('loadSidebarPrefs：宽度 clamp 240–480、折叠/服务器折叠键直通', async () => {
    installCwbMock({
      appSettings: {
        sidebarWidth: 9999,
        sidebarCollapsedPersist: true,
        serverNodesCollapsed: { c1: true }
      }
    })
    await act(async () => {
      await useAppStore.getState().loadSidebarPrefs()
    })
    const prefs = useAppStore.getState().uiSettings
    expect(prefs.sidebarWidth).toBe(480) // clamp 上限
    expect(prefs.sidebarCollapsedPersist).toBe(true)
    expect(prefs.serverNodesCollapsed).toEqual({ c1: true })
  })

  it('clampSidebarWidth 边界与非法输入', () => {
    expect(clampSidebarWidth(100)).toBe(240)
    expect(clampSidebarWidth(600)).toBe(480)
    expect(clampSidebarWidth(320.6)).toBe(321)
    expect(clampSidebarWidth(Number.NaN)).toBe(280)
  })
})

describe('懒连接（2.5=a renderer 半边）', () => {
  it('openTaskAutoResume 点开远程任务 → connectFlow（未连接/非 connecting 时）', async () => {
    installCwbMock()
    useAppStore.setState({
      projects: [pRemote],
      tasks: [tStopped],
      connections: [conn]
    })
    await act(async () => {
      useAppStore.getState().openTaskAutoResume('tr-stop')
    })
    expect(window.cwb.connectConnection).toHaveBeenCalledWith('c1')
    // stopped 任务照常走 resume（既有语义不因远程归属改变）
    expect(window.cwb.resumeTask).toHaveBeenCalledWith('tr-stop')
  })
})
