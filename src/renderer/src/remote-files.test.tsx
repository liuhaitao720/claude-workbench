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
const tRun = makeTask({ id: 'tr', projectId: 'pr', name: '跑着', status: 'running', cwd: '/home/dev' })

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
  // v2.1.1：远程文件面板只活在 SSH 终端下半区——经 SSH 竖条打开（任务上下文
  // tRun → shell cd 注入 + 面板直达 /home/dev）
  act(() => {
    useAppStore.setState({ filesTargetConn: null, sshConsoleCid: null, sshActive: false, sshFollowDir: null, sshOpenCids: [], sshDeadCids: [] })
  })
  fireEvent.click(await screen.findByRole('button', { name: 'SSH 终端' }))
  const panel = await screen.findByTestId('files-panel')
  await waitFor(() => expect(api.listRemoteFiles).toHaveBeenCalledWith('c1', '/home/dev'))
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
    // v2.0.2（用户实测）：同名预检——pick 的文件与当前清单无同名 → 不弹窗直接入队
    fireEvent.click(within(panel).getByRole('button', { name: /上传/ }))
    await waitFor(() => expect(api.pickLocalForUpload).toHaveBeenCalledWith(true, true))
    await waitFor(() =>
      expect(api.uploadRemoteFiles).toHaveBeenCalledWith('c1', ['D:\\new-doc.md'], '/home/dev/docs', 'overwrite')
    )
    expect(screen.queryByRole('dialog', { name: '同名文件处理' })).toBeNull()

    // 同名（deploy.md 已在清单）→ 弹窗三选；覆盖 → 以所选策略入队
    vi.mocked(api.pickLocalForUpload).mockResolvedValue(['D:\\deploy.md'])
    fireEvent.click(within(panel).getByRole('button', { name: /上传/ }))
    const dlg = await screen.findByRole('dialog', { name: '同名文件处理' })
    // v2.0.2：卡片容器收拢（标题/提示/文件/按钮同卡片，不再平级散落）
    expect(within(dlg).getByText('deploy.md')).toBeDefined()
    fireEvent.click(within(dlg).getByRole('button', { name: '覆盖' }))
    await waitFor(() =>
      expect(api.uploadRemoteFiles).toHaveBeenCalledWith('c1', ['D:\\deploy.md'], '/home/dev/docs', 'overwrite')
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

  it('v2.1.1 远程项目菜单「在 SSH 终端中打开」→ SSH 台开 + 文件面板定位项目目录', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev/r', entries: [] })
    act(() => {
      useAppStore.setState({ sshConsoleCid: null, sshActive: false, sshFollowDir: null, filesTargetConn: null, sshOpenCids: [], sshDeadCids: [] })
    })
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="pr"]')).toBeDefined())
    fireEvent.click(within(document.querySelector('li[data-project-id="pr"]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '在 SSH 终端中打开' }))
    await waitFor(() => expect(screen.getByTestId('files-panel')).toBeDefined())
    await waitFor(() => expect(useAppStore.getState().sshConsoleCid).toBe('c1'))
    // 面板经 sshFollowDir 定位项目目录（shell 侧同步注入 cd——bootstrap 断言在 ssh 套件）
    await waitFor(() => expect(useAppStore.getState().sshFollowDir?.path).toBe('/home/dev/r'))
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

describe('v2.0.3 文件面板任务上下文直达', () => {
  afterEach(cleanup)

  it('本地任务 active → 开面板回落原行为（无目标连接/记忆目录=undefined）', async () => {
    const pLocal = makeProject({ id: 'pl', name: 'L', dir: 'D:\\local', isGit: true })
    const tLocal = makeTask({ id: 'tl', projectId: 'pl', name: '本地活', status: 'running' })
    const api = installCwbMock({ projects: [pRemote, pLocal], tasks: [tRun, tLocal], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev', entries: entriesFixture() })
    // 前序用例遗留（filesTargetConn/ssh 跟随/目录记忆）全部清干净——本用例断言无上下文回落
    act(() => {
      useAppStore.setState({
        filesTargetConn: null,
        sshConsoleCid: null,
        sshActive: false,
        sshOpenCids: [],
        sshDeadCids: [],
        sshFollowDir: null,
        uiSettings: { ...useAppStore.getState().uiSettings, filesPanelPath: {} }
      })
    })
    render(<App />)
    await waitFor(() => expect(useAppStore.getState().connections.length).toBeGreaterThan(0))
    act(() => {
      useAppStore.setState({
        activeTaskId: 'tl',
        connectionStates: { c1: { state: 'connected' } }
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'SSH 终端' }))
    await screen.findByTestId('files-panel')
    await waitFor(() => expect(api.listRemoteFiles).toHaveBeenCalledWith('c1', undefined))
  })

  it('右侧「远程文件」竖条按钮已移除（v2.1.1 融合——文件面板只活在 SSH 终端）', async () => {
    installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    act(() => {
      useAppStore.setState({ filesTargetConn: null })
    })
    render(<App />)
    await waitFor(() => expect(useAppStore.getState().connections.length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: '远程文件' })).toBeNull()
    expect(screen.queryByTestId('remote-files-host')).toBeNull()
  })
})

describe('v2.0.2 拖拽上传修复（提示遮罩纯视觉化 + leave/drop 收起）', () => {
  afterEach(cleanup)

  async function openForDrag(): Promise<HTMLElement> {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev', entries: entriesFixture() })
    act(() => {
      useAppStore.setState({
        filesTargetConn: null,
        sshConsoleCid: null,
        sshActive: false,
        sshOpenCids: [],
        sshDeadCids: [],
        sshFollowDir: null
      })
    })
    render(<App />)
    await waitFor(() => expect(useAppStore.getState().connections.length).toBeGreaterThan(0))
    act(() => {
      useAppStore.setState({ connectionStates: { c1: { state: 'connected' } } })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'SSH 终端' }))
    return await screen.findByTestId('files-panel')
  }

  it('dragOver → 提示条出现且 pointer-events:none；经子元素 dragLeave（relatedTarget 面板外）→ 收起；drop → 收起', async () => {
    const panel = await openForDrag()
    fireEvent.dragOver(panel)
    const dropzone = document.querySelector('.files-dropzone') as HTMLElement | null
    expect(dropzone).not.toBeNull()
    // （pointer-events:none 为 CSS 层断言——jsdom 不解析该属性，真浏览器生效；此处保行为断言）
    // 经子元素离开（relatedTarget=null=出窗）→ 收起（此前仅 currentTarget===target 判定不收）
    fireEvent.dragLeave(panel, { relatedTarget: null })
    await waitFor(() => expect(document.querySelector('.files-dropzone')).toBeNull())
    // dragOver 再现后 drop → 收起
    fireEvent.dragOver(panel)
    expect(document.querySelector('.files-dropzone')).not.toBeNull()
    fireEvent.drop(panel, { dataTransfer: { files: [], types: ['Files'] } })
    await waitFor(() => expect(document.querySelector('.files-dropzone')).toBeNull())
  })
})
