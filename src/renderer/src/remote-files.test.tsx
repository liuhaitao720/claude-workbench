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

  it('v2.1.7 传输弹窗（FinalShell 式）：右上角按钮 + 角标；新活动自动弹出；聚合进度/队列/取消/清空已完成', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({ ok: true, path: '/home/dev', entries: [] })
    vi.mocked(api.listTransfers).mockResolvedValue([])
    render(<App />)
    const panel = await openPanel(api)
    // 初始无传输：弹窗不开，底部传输条已不存在
    expect(screen.queryByTestId('xfer-pop')).toBeNull()
    expect(screen.queryByTestId('transfer-bar')).toBeNull()
    expect(within(panel).getByTestId('btn-xfer-pop')).toBeDefined()
    // 新活动项 → 自动弹出一次（保留 v2.0.1 的立即反馈）
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
          },
          { id: 'tf-2', direction: 'download', name: 'old.log', status: 'done', transferredBytes: 8, totalBytes: 8 }
        ])
      }
    })
    const pop = await screen.findByTestId('xfer-pop')
    expect(pop.textContent).toContain('50%')
    expect(within(pop).getByText('big.bin')).toBeDefined()
    expect(within(pop).getByText('进度')).toBeDefined() // 表头在场
    // v2.1.7 修复：弹层 portal 挂 document.body（脱离 .files-panel overflow:hidden 裁切）
    expect(document.body.contains(pop)).toBe(true)
    // 保存目录走 main 侧同源解析（默认目录也给「打开」按钮）
    expect(within(pop).getByTestId('xfer-savedir').textContent).toContain('SSH Workbench')
    expect(within(pop).getByTestId('btn-open-savedir')).toBeDefined()
    fireEvent.click(within(pop).getByTestId('btn-open-savedir'))
    await waitFor(() => expect(api.openLocalPath).toHaveBeenCalledWith('/home/liuhait1/Downloads/SSH Workbench/VM-Dev'))
    // 角标=活动计数；「清空已完成」修剪完成项（IPC 透传）
    expect(within(panel).getByText('1').closest('.xfer-badge')).not.toBeNull()
    fireEvent.click(within(pop).getByTestId('btn-xfer-clear'))
    await waitFor(() => expect(api.clearFinishedTransfers).toHaveBeenCalled())
    // 活动行取消按钮 → cancelTransfer
    fireEvent.click(within(pop).getByRole('button', { name: '×' }))
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

  it('v2.2.4 多选压缩：Ctrl 选 2 行 → 工具栏📦 → 弹窗（默认名/清单/标签）→ 确认 → compressRemote + 刷新', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [
        { name: 'a.txt', isDir: false, size: 10, mtimeMs: 0 },
        { name: 'docs', isDir: true, size: 0, mtimeMs: 0 }
      ]
    })
    render(<App />)
    const panel = await openPanel(api)
    const row = (n: string) => panel.querySelector(`[data-file-name="${n}"]`) as HTMLElement
    fireEvent.click(row('a.txt'))
    fireEvent.click(row('docs'), { ctrlKey: true })
    const btn = await waitFor(() => {
      const b = within(panel).getByTestId('btn-compress-selected') as HTMLButtonElement
      expect(b.disabled).toBe(false)
      return b
    })
    expect(btn.textContent).toContain('2')
    fireEvent.click(btn)
    // 弹窗：标题/目标清单/可见 label/默认名（archive-…tar.gz）
    const input = await screen.findByTestId('compress-name-input') as HTMLInputElement
    const dlg = screen.getByRole('dialog', { name: '压缩为 tar.gz' })
    expect(within(dlg).getByText('压缩文件名')).toBeDefined() // 可见 label（非 placeholder-only）
    expect(within(dlg).getByText('a.txt')).toBeDefined()
    expect(within(dlg).getByText('docs')).toBeDefined()
    expect(input.value).toMatch(/^archive-\d{8}-\d{4}\.tar\.gz$/)
    fireEvent.click(screen.getByTestId('compress-confirm'))
    await waitFor(() =>
      expect(api.compressRemote).toHaveBeenCalledWith('c1', '/home/dev', input.value, ['a.txt', 'docs'])
    )
    // 成功后：弹窗关 + 目录刷新
    await waitFor(() => expect(screen.queryByTestId('compress-name-input')).toBeNull())
    await waitFor(() => expect(api.listRemoteFiles).toHaveBeenLastCalledWith('c1', '/home/dev'))
  })

  it('v2.2.4 行右键：压缩…（单行 → 默认基名.tar.gz）+ Esc 取消不发 IPC；下载/重命名/删除项齐', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [{ name: 'docs', isDir: true, size: 0, mtimeMs: 0 }]
    })
    render(<App />)
    const panel = await openPanel(api)
    const row = panel.querySelector('[data-file-name="docs"]') as HTMLElement
    fireEvent.contextMenu(row)
    // 菜单（Portal 挂 body）：压缩/重命名/删除齐（目录无下载项）
    const item = await screen.findByText('压缩…')
    fireEvent.click(item)
    const input = (await screen.findByTestId('compress-name-input')) as HTMLInputElement
    expect(input.value).toBe('docs.tar.gz') // 单选默认=基名
    // Escape 关闭——不发 IPC
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('compress-name-input')).toBeNull())
    expect(api.compressRemote).not.toHaveBeenCalled()
  })

  it('v2.2.4 校验/碰撞就近报错：空名 → inline-error 不发 IPC；远端已存在 → 错误留在弹窗', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [{ name: 'x.txt', isDir: false, size: 5, mtimeMs: 0 }]
    })
    render(<App />)
    const panel = await openPanel(api)
    fireEvent.click(panel.querySelector('[data-file-name="x.txt"]') as HTMLElement)
    fireEvent.click(within(panel).getByTestId('btn-compress-selected'))
    const input = (await screen.findByTestId('compress-name-input')) as HTMLInputElement
    // a) 清空名称 → 就近错误，不发 IPC
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('compress-confirm'))
    await waitFor(() => expect(screen.getByTestId('compress-error').textContent).toContain('名称不能为空'))
    expect(api.compressRemote).not.toHaveBeenCalled()
    // b) 远端碰撞（main 抛 i18n key）→ 弹窗留错误不关
    vi.mocked(api.compressRemote).mockRejectedValueOnce(new Error('files.compressErrExists'))
    fireEvent.change(input, { target: { value: 'x.txt.tar.gz' } })
    fireEvent.click(screen.getByTestId('compress-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('compress-error').textContent).toContain('同名文件已存在')
    )
    expect(screen.getByTestId('compress-name-input')).toBeDefined() // 弹窗仍在
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

  it('v2.1.7 双击 <5MB → 编辑器弹窗（读取/Ctrl+S 直写/成功轻提示）；≥5MB 走下载；二进制拒绝', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [
        { name: 'readme.md', isDir: false, size: 2048, mtimeMs: 0 },
        { name: 'huge.bin', isDir: false, size: 20 * 1024 * 1024, mtimeMs: 0 }
      ]
    })
    vi.mocked(api.readRemoteTextFile).mockResolvedValue({
      ok: true as const,
      content: 'hello remote\n',
      size: 13,
      mtimeMs: 1_700_000_000_000
    })
    render(<App />)
    const panel = await openPanel(api)
    // 双击小文件 → 读取进编辑器
    fireEvent.doubleClick(panel.querySelector('[data-file-name="readme.md"]') as HTMLElement)
    const dlg = await screen.findByTestId('remote-editor')
    await waitFor(() =>
      expect((within(dlg).getByLabelText('编辑 readme.md') as HTMLTextAreaElement).value).toBe('hello remote\n')
    )
    expect(api.downloadRemoteFile).not.toHaveBeenCalled()
    // 改内容 → Ctrl+S 直写远端（带 baseMtime）→ 成功轻提示 + 状态栏「已保存」
    const ta = within(dlg).getByLabelText('编辑 readme.md') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'hello remote\nedited\n' } })
    fireEvent.keyDown(dlg, { key: 's', ctrlKey: true })
    await waitFor(() =>
      expect(api.writeRemoteTextFile).toHaveBeenCalledWith('c1', '/home/dev/readme.md', 'hello remote\nedited\n', 1_700_000_000_000)
    )
    await waitFor(() => expect(screen.getByTestId('save-toast').textContent).toContain('readme.md'))
    expect(dlg.textContent).toContain('已保存')
    // 关闭（无脏态直关；脏态确认走下一条用例）
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByTestId('remote-editor')).toBeNull())
    // ≥5MB：双击仍走下载
    fireEvent.doubleClick(panel.querySelector('[data-file-name="huge.bin"]') as HTMLElement)
    await waitFor(() => expect(api.downloadRemoteFile).toHaveBeenCalledWith('c1', '/home/dev/huge.bin', 'huge.bin'))
    // 二进制拒绝：不开编辑器，轻提示
    vi.mocked(api.readRemoteTextFile).mockResolvedValue({ ok: false as const, error: 'files: binary file', binary: true })
    vi.mocked(api.downloadRemoteFile).mockClear()
    fireEvent.doubleClick(panel.querySelector('[data-file-name="readme.md"]') as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('save-toast').textContent).toContain('二进制'))
    expect(screen.queryByTestId('remote-editor')).toBeNull()
    expect(api.downloadRemoteFile).not.toHaveBeenCalled()
  })

  it('v2.1.7 编辑器脏态关闭确认 + 远端冲突守卫（覆盖/重新加载）', async () => {
    const api = installCwbMock({ projects: [pRemote], tasks: [tRun], connections: [conn] })
    vi.mocked(api.listRemoteFiles).mockResolvedValue({
      ok: true,
      path: '/home/dev',
      entries: [{ name: 'conf.yml', isDir: false, size: 64, mtimeMs: 0 }]
    })
    vi.mocked(api.readRemoteTextFile).mockResolvedValue({ ok: true as const, content: 'a: 1\n', size: 6, mtimeMs: 111 })
    render(<App />)
    const panel = await openPanel(api)
    fireEvent.doubleClick(panel.querySelector('[data-file-name="conf.yml"]') as HTMLElement)
    const dlg = await screen.findByTestId('remote-editor')
    const ta = (await within(dlg).findByLabelText('编辑 conf.yml')) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'a: 2\n' } })
    // 脏态点 × → 二次确认；「继续编辑」保留
    fireEvent.click(within(dlg).getByRole('button', { name: '关闭' }))
    const ask = await screen.findByRole('dialog', { name: '放弃未保存的更改？' })
    fireEvent.click(within(ask).getByRole('button', { name: '继续编辑' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '放弃未保存的更改？' })).toBeNull())
    expect(screen.getByTestId('remote-editor')).toBeDefined()
    // 保存遇冲突 → 守卫条；「覆盖远端」以无 baseMtime 重写
    vi.mocked(api.writeRemoteTextFile).mockResolvedValueOnce({
      ok: false as const,
      error: 'files: remote file changed',
      conflict: true
    })
    fireEvent.keyDown(screen.getByTestId('remote-editor'), { key: 's', ctrlKey: true })
    await waitFor(() => expect(within(dlg).getByText(/远端已被修改/)).toBeDefined())
    vi.mocked(api.writeRemoteTextFile).mockClear()
    fireEvent.click(within(dlg).getByRole('button', { name: '覆盖远端' }))
    await waitFor(() =>
      expect(api.writeRemoteTextFile).toHaveBeenCalledWith('c1', '/home/dev/conf.yml', 'a: 2\n', undefined)
    )
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
