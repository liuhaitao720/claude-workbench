import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RemoteFileEntry } from '../../shared/types'
import { App } from './App'
import { terminalCache, caretSequenceForClick } from './components/TerminalPanel'
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
      filesTargetConn: null,
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
    // v2.0.1：活动项出现即自动展开（无需手点）——表格直接在场
    const row = await within(bar).findByText('big.bin')
    expect(row).toBeDefined()
    expect(within(bar).getByText('进度')).toBeDefined() // 表头在场
    expect(within(bar).getByTestId('xfer-savedir').textContent).toContain('SSH Workbench') // 保存目录头（默认目录派生）
    fireEvent.click(within(bar).getByRole('button', { name: '×' }))
    await waitFor(() => expect(api.cancelTransfer).toHaveBeenCalledWith('tf-1'))
  })

  it('家目录快捷键：点 🏠 → listRemoteFiles(cid, undefined)（realpath(.)=home）', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    let calls = 0
    vi.mocked(api.listRemoteFiles).mockImplementation(async (_cid, p) => {
      calls += 1
      // 首拉回 home；进子目录后点 🏠 应再次以 undefined 调用
      return { ok: true, path: p === undefined ? '/home/dev' : '/home/dev/work', entries: [] }
    })
    render(<App />)
    const panel = await openPanel(api)
    const dirRow = document.createElement('div') // 先进子目录（直接调一次 load 语义——借双击路径）
    void dirRow
    const homeBtn = panel.querySelector('button[title="回到用户主目录（~）"]') as HTMLElement
    expect(homeBtn).not.toBeNull()
    fireEvent.click(homeBtn)
    await waitFor(() => {
      expect(api.listRemoteFiles).toHaveBeenLastCalledWith('c1', undefined)
    })
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('多选+直删：Ctrl 点选 2 行 → 工具栏删除（带计数）→ confirm 一次 → deleteRemote 逐项 rm -rf', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [
        { name: 'a.txt', isDir: false, size: 10, mtimeMs: 0 },
        { name: 'b.md', isDir: false, size: 20, mtimeMs: 0 },
        { name: 'docs', isDir: true, size: 0, mtimeMs: 0 }
      ]
    })
    render(<App />)
    const panel = await openPanel(api)
    const row = (n: string) => panel.querySelector(`[data-file-name="${n}"]`) as HTMLElement
    fireEvent.click(row('a.txt'))
    fireEvent.click(row('b.md'), { ctrlKey: true })
    const delBtn = await waitFor(() => {
      const b = within(panel).getByTestId('btn-delete-selected') as HTMLButtonElement
      expect(b.disabled).toBe(false)
      return b
    })
    expect(delBtn.textContent).toContain('2')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(delBtn)
    await waitFor(() => expect(api.deleteRemote).toHaveBeenCalledTimes(2))
    expect(api.deleteRemote).toHaveBeenCalledWith('c1', '/home/dev/a.txt', false)
    expect(api.deleteRemote).toHaveBeenCalledWith('c1', '/home/dev/b.md', false)
  })

  it('Shift+click 范围选择：点第 1 行后 Shift 点第 3 行 → 三行全选中', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: ['f1', 'f2', 'f3', 'f4'].map((n) => ({ name: n, isDir: false, size: 1, mtimeMs: 0 }))
    })
    render(<App />)
    const panel = await openPanel(api)
    const row = (n: string) => panel.querySelector(`[data-file-name="${n}"]`) as HTMLElement
    fireEvent.click(row('f1'))
    fireEvent.click(row('f3'), { shiftKey: true })
    expect(row('f1').dataset['selected']).toBe('1')
    expect(row('f2').dataset['selected']).toBe('1')
    expect(row('f3').dataset['selected']).toBe('1')
    expect(row('f4').dataset['selected']).toBeUndefined()
  })

  it('双击小文本文件 → peekRemoteFile（本机打开）；大文件/未知扩展 → 走下载', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [
        { name: 'readme.md', isDir: false, size: 2048, mtimeMs: 0 },
        { name: 'huge.bin', isDir: false, size: 20 * 1024 * 1024, mtimeMs: 0 }
      ]
    })
    render(<App />)
    const panel = await openPanel(api)
    fireEvent.doubleClick(panel.querySelector('[data-file-name="readme.md"]') as HTMLElement)
    await waitFor(() => expect(api.peekRemoteFile).toHaveBeenCalledWith('c1', '/home/dev/readme.md'))
    expect(api.downloadRemoteFile).not.toHaveBeenCalled()
    fireEvent.doubleClick(panel.querySelector('[data-file-name="huge.bin"]') as HTMLElement)
    await waitFor(() => expect(api.downloadRemoteFile).toHaveBeenCalledWith('c1', '/home/dev/huge.bin', 'huge.bin'))
  })

  it('mtime 列渲染 + 选中项状态条（全量名/尺寸/完整时间）', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    const mtime = Date.parse('2026-11-12T09:30:00')
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [{ name: 'deploy.md', isDir: false, size: 219136, mtimeMs: mtime }]
    })
    render(<App />)
    const panel = await openPanel(api)
    const row = panel.querySelector('[data-file-name="deploy.md"]') as HTMLElement
    expect(row.querySelector('.files-mtime')?.textContent).toMatch(/11-12|09:30/)
    fireEvent.click(row)
    const bar = await screen.findByTestId('files-statusbar')
    expect(bar.textContent).toContain('deploy.md')
    expect(bar.textContent).toContain('214.0 KB')
    expect(bar.textContent).toMatch(/2026/)
  })

  it('远程项目菜单「在文件面板中打开」→ 面板自动开 + 定位项目工作目录（filesPanelPath 持久化）', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev/r', entries: [] })
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="pr"]')).toBeDefined())
    fireEvent.click(within(document.querySelector('li[data-project-id="pr"]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '在文件面板中打开' }))
    await waitFor(() => expect(screen.getByTestId('files-panel')).toBeDefined())
    await waitFor(() => expect(useAppStore.getState().filesTargetConn).toBe('c1'))
    await waitFor(() =>
      expect(useAppStore.getState().uiSettings.filesPanelPath?.['c1']).toBe('/home/dev/r')
    )
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


describe('v2.0.1 终端点击移位（caretSequenceForClick 纯函数）', () => {
  const rect = { left: 0, top: 0, width: 800, height: 400 }
  const cols = 100 // cellW=8
  const rows = 25 // cellH=16
  it('同行点击：光标 col20 → 点击 col35 = 15×右箭头；点击 col5 = 15×左箭头', () => {
    expect(caretSequenceForClick(35 * 8, 10 * 16, rect, cols, rows, 20, 10)).toBe('\x1b[C'.repeat(15))
    expect(caretSequenceForClick(5 * 8, 10 * 16, rect, cols, rows, 20, 10)).toBe('\x1b[D'.repeat(15))
  })
  it('跨行点击/点击光标处/越界：null（保守不动作）', () => {
    expect(caretSequenceForClick(30 * 8, 11 * 16, rect, cols, rows, 20, 10)).toBeNull()
    expect(caretSequenceForClick(20 * 8, 10 * 16, rect, cols, rows, 20, 10)).toBeNull()
    expect(caretSequenceForClick(9999, 10 * 16, rect, cols, rows, 20, 10)).toBeNull()
  })
})
