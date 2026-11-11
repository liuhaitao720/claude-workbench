import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RemoteFileEntry } from '../../shared/types'
import { App } from './App'
import { terminalCache } from './components/TerminalPanel'
import { installCwbMock, makeConnection, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'

/**
 * v2.0 远程文件面板 L2.5（真组件树装配）：开合入口 → 面板挂载 → 目录清单/面包屑
 * → 上传冲突弹窗三选 → 传输条经 onTransfersProgress 订阅驱动。IPC 面 mock，
 * main 侧引擎/装配由 file-transfer.test 与 --smoke 家族覆盖。
 */

const conn = makeConnection({ id: 'c1', name: 'VM-Dev' })
const pRemote = makeProject({ id: 'pr', name: 'R', dir: '/home/dev/r', connectionId: 'c1' })
const tRun = makeTask({ id: 'tr', projectId: 'pr', name: '跑着', status: 'running' })

function entriesFixture(): RemoteFileEntry[] {
  return [
    { name: 'docs', isDir: true, size: 0, mtimeMs: Date.parse('2026-11-10T09:12:00') },
    { name: 'deploy.md', isDir: false, size: 214 * 1024, mtimeMs: Date.now() - 60_000 },
    { name: 'dump.sql.gz', isDir: false, size: 47 * 1024 * 1024, mtimeMs: Date.now() - 86_400_000 }
  ]
}

async function openPanel(api: ReturnType<typeof installCwbMock>): Promise<HTMLElement> {
  // 连接态随事件推送语义——loadAll（mount）完成后落 connected 再找入口
  await waitFor(() => expect(useAppStore.getState().connections.length).toBeGreaterThan(0))
  act(() => {
    useAppStore.setState({ connectionStates: { c1: { state: 'connected' } } })
  })
  const toggle = await screen.findByRole('button', { name: '远程文件' })
  fireEvent.click(toggle)
  // eslint-disable-next-line no-console
  const panel = await screen.findByTestId('files-panel')
  await waitFor(() => expect(api.listRemoteFiles).toHaveBeenCalledWith('c1', undefined))
  return panel
}

describe('v2.0 远程文件面板（L2.5 装配）', () => {
  beforeEach(() => {
    useAppStore.setState({
      projects: [pRemote],
      tasks: [tRun],
      openTaskIds: ['tr'],
      activeTaskId: 'tr',
      selectedProjectId: 'pr',
      activityMap: {},
      settingsOpen: false,
      connections: [conn],
      connectionStates: { c1: { state: 'connected' } },
      serverLogs: [],
      uiSettings: {},
      pendingServerInstall: null,
      settingsScope: 'local'
    })
    localStorage.removeItem('cwb-language')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
    for (const t of terminalCache.values()) t.dispose()
    terminalCache.clear()
  })

  it('已连接远程 → 竖条入口可见；开面板 → 清单渲染（目录优先+大小/时间），面包屑到位', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: entriesFixture()
    })
    render(<App />)
    const panel = await openPanel(api)
    // 目录行在前（.dir 类）+ 名称/大小渲染
    const rows = panel.querySelectorAll('.files-row')
    expect(rows.length).toBe(3)
    expect(rows[0].className).toContain('dir')
    expect((rows[0] as HTMLElement).textContent).toContain('docs')
    expect((rows[2] as HTMLElement).textContent).toContain('47.0 MB')
    // 面包屑：⌂ / home / dev（当前级高亮）
    expect(panel.querySelectorAll('.crumb button').length).toBeGreaterThanOrEqual(3)
  })

  it('双击目录 → listRemoteFiles(cid, 子路径)；上传按钮 → pick → 冲突弹窗 → 覆盖入队', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockImplementation(async (_cid, p) => ({
      ok: true,
      path: typeof p === 'string' && p !== '' ? p : '/home/dev',
      entries: entriesFixture()
    }))
    vi.mocked(api.pickLocalForUpload).mockResolvedValue(['D:\\new-doc.md'])
    vi.mocked(api.uploadRemoteFiles).mockResolvedValue({ items: [], conflicts: [] })
    render(<App />)
    const panel = await openPanel(api)
    // 双击 docs → 面包屑/清单落到子路径（mock 回显请求路径）
    const dirRow = panel.querySelector('.files-row.dir') as HTMLElement
    fireEvent.doubleClick(dirRow)
    await waitFor(() => expect(api.listRemoteFiles).toHaveBeenLastCalledWith('c1', '/home/dev/docs'))
    await waitFor(() => expect(panel.textContent).toContain('docs'))
    // 上传：pick 返回 → 冲突弹窗（引擎侧预检在真实链路——mock 下弹窗仍前置问策略）
    fireEvent.click(within(panel).getByRole('button', { name: /上传/ }))
    await waitFor(() => expect(api.pickLocalForUpload).toHaveBeenCalledWith(true, true))
    const dlg = await screen.findByRole('dialog', { name: '同名文件处理' })
    fireEvent.click(within(dlg).getByRole('button', { name: '覆盖' }))
    await waitFor(() =>
      expect(api.uploadRemoteFiles).toHaveBeenCalledWith('c1', ['D:\\new-doc.md'], '/home/dev/docs', 'overwrite')
    )
  })

  it('传输条：进度事件驱动渲染（active 进度 + 展开队列 + 取消按钮）', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev', entries: [] })
    vi.mocked(api.listTransfers).mockResolvedValue([])
    render(<App />)
    await openPanel(api)
    // 初始无传输 → 传输条不渲染；事件注入后出现
    expect(screen.queryByTestId('transfer-bar')).toBeNull()
    act(() => {
      for (const cb of api.transfersProgressCallbacks) {
        cb([
          {
            id: 'tf-1',
            direction: 'upload',
            name: 'big.bin',
            status: 'active',
            transferredBytes: 512,
            totalBytes: 1024
          }
        ])
      }
    })
    const bar = await screen.findByTestId('transfer-bar')
    expect(bar.textContent).toContain('50%')
    fireEvent.click(bar.querySelector('.xfer-bar') as HTMLElement) // 展开
    const row = await within(bar).findByText('big.bin')
    expect(row).toBeDefined()
    fireEvent.click(within(bar).getByRole('button', { name: '×' }))
    await waitFor(() => expect(api.cancelTransfer).toHaveBeenCalledWith('tf-1'))
  })

  it('面板目录记忆：uiSettings.filesPanelPath 持久化（setAppSettings 携带路径表）', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev/work',
      entries: []
    })
    render(<App />)
    await openPanel(api)
    await waitFor(() =>
      expect(api.setAppSettings).toHaveBeenCalledWith(
        expect.objectContaining({ filesPanelPath: expect.objectContaining({ c1: '/home/dev/work' }) })
      )
    )
  })
})
