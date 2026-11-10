import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import type { AppSettings } from '../../shared/types'
import { App } from './App'
import { terminalCache } from './components/TerminalPanel'
import { installCwbMock, makeConnection, makeProject, makeTask } from './test-helpers'
import type { CwbApiMock } from './test-helpers'
import { useAppStore } from './store'

/**
 * S6 L2 组件测试：分组树渲染（3.5/3.6/3.11）/ 服务器菜单（3.9）/ 折叠持久化
 * （3.8/3.10）/ 断连冻结层（5.3）/ 注册表单校验（3.1=C）/ 删除级联文案（3.9）/
 * server 安装弹窗（6.7）/ 设置「远程连接」分类。
 * mock 驱动：preload/main 通道由 installCwbMock 提供（S1 契约桩 + S6 扩真实行为）。
 */

const conn = makeConnection({ id: 'c1', name: 'UBUNTU-VM', host: '192.168.80.128', user: 'dev' })
const pLocal = makeProject({ id: 'pl', name: 'LocalProj', dir: 'D:\\local' })
const pRemote = makeProject({ id: 'pr', name: 'RemoteProj', dir: '/home/dev/app', connectionId: 'c1' })
const tRemote = makeTask({
  id: 'tr',
  projectId: 'pr',
  name: '远程任务',
  status: 'running',
  cwd: '/home/dev/app'
})

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
  vi.restoreAllMocks()
  cleanup()
  for (const t of terminalCache.values()) t.dispose()
  terminalCache.clear()
})

async function renderApp(
  opts: {
    projects?: ReturnType<typeof makeProject>[]
    tasks?: ReturnType<typeof makeTask>[]
    connections?: ReturnType<typeof makeConnection>[]
    /** installCwbMock 的 getAppSettings 预置（侧栏持久化键等） */
    appSettings?: Partial<AppSettings>
  } = {}
): Promise<CwbApiMock> {
  const api = installCwbMock({
    projects: opts.projects ?? [pLocal, pRemote],
    tasks: opts.tasks ?? [tRemote],
    connections: opts.connections ?? [conn],
    ...(opts.appSettings !== undefined ? { appSettings: opts.appSettings } : {})
  })
  render(<App />)
  await waitFor(() => expect(document.querySelector('.sidebar')).toBeDefined())
  return api
}

function serverNode(id: string): HTMLElement | null {
  return document.querySelector(`li[data-connection-id="${id}"]`)
}
function projectNode(id: string): HTMLElement | null {
  return document.querySelector(`li[data-project-id="${id}"]`)
}
function sidebarVisible(): boolean {
  const el = document.querySelector('.sidebar') as HTMLElement | null
  return el !== null && el.style.display !== 'none'
}

describe('分组树渲染（3.5/3.6/3.11=a 轻分组头）', () => {
  it('本机项目根级平铺；服务器=轻分组头（名称+未连接胶囊），远程项目挂其下', async () => {
    await renderApp()
    // 本机项目在根级
    const local = projectNode('pl')
    expect(local).not.toBeNull()
    // 服务器分组头：名称 + 四态胶囊（无状态事件=offline）
    const server = serverNode('c1') as HTMLElement
    expect(server).not.toBeNull()
    expect(within(server).getByText('UBUNTU-VM')).toBeDefined()
    const pill = server.querySelector('.conn-pill') as HTMLElement
    expect(pill.getAttribute('data-state')).toBe('offline')
    expect(pill.textContent).toBe('未连接')
    // 远程项目在服务器节点内，且沿用项目>任务树（任务行可达）
    const remote = projectNode('pr') as HTMLElement
    expect(server.contains(remote)).toBe(true)
    expect(server.contains(document.querySelector('li[data-task-id="tr"]') as HTMLElement)).toBe(true)
    // DOM 顺序：本机项目在前、服务器分组在后（基础设施沉下去）
    expect(
      (local as HTMLElement).compareDocumentPosition(server) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('无连接档案时树与现状一致（无服务器节点）', async () => {
    await renderApp({ projects: [pLocal], tasks: [], connections: [] })
    expect(serverNode('c1')).toBeNull()
    expect(projectNode('pl')).not.toBeNull()
    expect(document.querySelector('.server-node')).toBeNull()
  })

  // S8 升级兼容（9.1）UI 半边：孤儿远程项目（connectionId 指向已删/不存在档案）
  // 回根级兜底——升级/删除档案后树仍可管理，项目不消失
  it('孤儿远程项目回根级平铺（connectionId 指向不存在档案）', async () => {
    const orphan = makeProject({
      id: 'p-orphan', name: 'OrphanRemote', dir: '/home/dev/gone', connectionId: 'ghost-conn'
    })
    await renderApp({ projects: [pLocal, orphan], tasks: [], connections: [conn] })
    expect(serverNode('ghost-conn')).toBeNull() // 不凭空造服务器分组
    const node = projectNode('p-orphan') as HTMLElement
    expect(node).not.toBeNull()
    const sidebar = document.querySelector('.sidebar') as HTMLElement
    expect(sidebar.contains(node)).toBe(true) // 根级可达可管理
    expect((node.closest('ul') as HTMLElement).className).toContain('project-list') // 与本机项目同列表
  })

  it('状态胶囊随 onConnectionState 事件更新（reconnecting 附第 n 次）', async () => {
    const api = await renderApp()
    act(() => {
      api.connectionStateCallbacks.forEach((cb) =>
        cb({ connectionId: 'c1', state: 'reconnecting', attempt: 3 })
      )
    })
    await waitFor(() => {
      const pill = (serverNode('c1') as HTMLElement).querySelector('.conn-pill') as HTMLElement
      expect(pill.getAttribute('data-state')).toBe('reconnecting')
      expect(pill.textContent).toContain('第 3 次')
    })
  })

  it('断连置灰（data-conn=offline）但子项目仍可点击管理（3.5）', async () => {
    const api = await renderApp()
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'offline' }))
    })
    await waitFor(() =>
      expect((serverNode('c1') as HTMLElement).getAttribute('data-conn')).toBe('offline')
    )
    // 子项目可点击（选中远程项目）——project-main 按钮含 git 徽标文本，用类名锚点
    fireEvent.click(
      (projectNode('pr') as HTMLElement).querySelector('.project-main') as HTMLElement
    )
    expect(useAppStore.getState().selectedProjectId).toBe('pr')
  })
})

describe('服务器节点菜单（3.9=a：⋯ + 右键双入口）', () => {
  it('⋯ 菜单项：连接/编辑连接…/新建远程项目…/删除；连接 → connectConnection', async () => {
    const api = await renderApp()
    fireEvent.click(within(serverNode('c1') as HTMLElement).getByRole('button', { name: '服务器操作' }))
    const menu = await waitFor(() => screen.getByRole('menu'))
    for (const label of ['连接', '编辑连接…', '新建远程项目…', '删除']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeDefined()
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: '连接' }))
    await waitFor(() => expect(api.connectConnection).toHaveBeenCalledWith('c1'))
  })

  it('右键同样打开菜单；connected 态菜单首项变为「断开」', async () => {
    const api = await renderApp()
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connected' }))
    })
    fireEvent.contextMenu(
      (serverNode('c1') as HTMLElement).querySelector('.server-row') as HTMLElement
    )
    const menu = await waitFor(() => screen.getByRole('menu'))
    fireEvent.click(within(menu).getByRole('menuitem', { name: '断开' }))
    await waitFor(() => expect(api.disconnectConnection).toHaveBeenCalledWith('c1'))
  })

  it('编辑连接… → 设置中心直达「远程连接」分类并预载档案', async () => {
    await renderApp()
    fireEvent.click(within(serverNode('c1') as HTMLElement).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑连接…' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    // 直达远程连接分类（nav aria-current）且表单预载既有档案名
    const navItem = within(dialog).getByRole('button', { name: '远程连接' })
    expect(navItem.getAttribute('aria-current')).toBe('true')
    await waitFor(() =>
      expect((within(dialog).getByLabelText('名称') as HTMLInputElement).value).toBe('UBUNTU-VM')
    )
  })
})

describe('折叠与宽度持久化（3.7/3.8/3.10）', () => {
  it('服务器节点折叠 → children 隐藏 + setAppSettings({serverNodesCollapsed})', async () => {
    const api = await renderApp()
    const server = serverNode('c1') as HTMLElement
    const children = server.querySelector('.server-children') as HTMLElement
    expect(children.style.display).toBe('')
    fireEvent.click(within(server).getByRole('button', { name: '折叠 UBUNTU-VM' }))
    await waitFor(() => expect(children.style.display).toBe('none'))
    await waitFor(() =>
      expect(api.setAppSettings).toHaveBeenCalledWith({ serverNodesCollapsed: { c1: true } })
    )
  })

  it('serverNodesCollapsed 持久化跨挂载生效（重启折叠态还原）', async () => {
    await renderApp({ appSettings: { serverNodesCollapsed: { c1: true } } })
    await waitFor(() => {
      const server = serverNode('c1') as HTMLElement
      expect((server.querySelector('.server-children') as HTMLElement).style.display).toBe('none')
      const caret = server.querySelector('.tree-caret') as HTMLElement
      expect(caret.getAttribute('aria-expanded')).toBe('false')
    })
  })

  it('整栏折叠（Ctrl+B）→ setAppSettings({sidebarCollapsedPersist})；持久化还原折叠态（3.10，推翻 A17）', async () => {
    const api = await renderApp()
    expect(sidebarVisible()).toBe(true)
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await waitFor(() => expect(sidebarVisible()).toBe(false))
    await waitFor(() =>
      expect(api.setAppSettings).toHaveBeenCalledWith({ sidebarCollapsedPersist: true })
    )
    cleanup()
    // 重启：折叠态从 settings 还原（rail 可见、展开态隐藏）
    await renderApp({ appSettings: { sidebarCollapsedPersist: true } })
    await waitFor(() => {
      expect(sidebarVisible()).toBe(false)
      expect(
        (document.querySelector('.sidebar-rail') as HTMLElement).style.display
      ).not.toBe('none')
    })
  })

  it('宽度拖拽 240–480 clamp + sidebarWidth 落盘（3.7）', async () => {
    const api = await renderApp()
    const resizer = document.querySelector('.sidebar-resizer') as HTMLElement
    expect(resizer).not.toBeNull()
    fireEvent.mouseDown(resizer, { clientX: 300 })
    fireEvent.mouseMove(window, { clientX: 900 }) // 超上限 → 480
    fireEvent.mouseUp(window, { clientX: 900 })
    await waitFor(() =>
      expect((document.querySelector('.sidebar') as HTMLElement).style.width).toBe('480px')
    )
    fireEvent.mouseDown(resizer, { clientX: 300 })
    fireEvent.mouseMove(window, { clientX: 0 }) // 低于下限 → 240
    fireEvent.mouseUp(window, { clientX: 0 })
    await waitFor(() =>
      expect((document.querySelector('.sidebar') as HTMLElement).style.width).toBe('240px')
    )
    // 落盘去抖 300ms 后一次性写 sidebarWidth
    await waitFor(
      () => expect(api.setAppSettings).toHaveBeenCalledWith({ sidebarWidth: 240 }),
      { timeout: 2_000 }
    )
  })
})

describe('断连冻结层（5.3/5.5）', () => {
  async function openRemoteTerminal(api: CwbApiMock): Promise<void> {
    fireEvent.click(
      (document.querySelector('li[data-task-id="tr"]') as HTMLElement).querySelector(
        '.task-main'
      ) as HTMLElement
    )
    await waitFor(() => expect(document.querySelector('.term-host')).not.toBeNull())
    // 懒连接（2.5=a）：点开远程任务先确保连接建立
    await waitFor(() => expect(api.connectConnection).toHaveBeenCalledWith('c1'))
  }

  it('offline → 冻结层出现、键入无效；connected → 自动解冻恢复键入', async () => {
    const api = await renderApp()
    await openRemoteTerminal(api)
    const term = terminalCache.get('tr') as Terminal

    // 正常态键入可达 PTY
    term.paste('hello')
    await waitFor(() =>
      expect(api.ptyWrite).toHaveBeenCalledWith('tr', expect.stringContaining('hello'))
    )
    expect(document.querySelector('.term-frozen')).toBeNull()

    // 断连 → 冻结层（文案+状态）且键入被丢弃
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'offline' }))
    })
    await waitFor(() => expect(document.querySelector('.term-frozen')).not.toBeNull())
    expect(
      (document.querySelector('.term-frozen') as HTMLElement).getAttribute('data-conn')
    ).toBe('offline')
    expect(screen.getByText('连接已断开：输入已冻结，重连后自动恢复')).toBeDefined()
    const before = vi.mocked(api.ptyWrite).mock.calls.length
    term.paste('while-frozen')
    await new Promise((r) => setTimeout(r, 50))
    expect(vi.mocked(api.ptyWrite).mock.calls.length).toBe(before)

    // 重连中（第 n 次）文案 + 立即重试按钮（5.5/5.7）
    act(() => {
      api.connectionStateCallbacks.forEach((cb) =>
        cb({ connectionId: 'c1', state: 'reconnecting', attempt: 2 })
      )
    })
    await waitFor(() =>
      expect(document.querySelectorAll('.term-frozen-sub').length).toBeGreaterThan(0)
    )
    expect(
      (document.querySelector('.term-frozen-sub') as HTMLElement).textContent
    ).toBe('重连中（第 2 次）')
    fireEvent.click(screen.getByRole('button', { name: '立即重试' }))
    await waitFor(() => expect(api.connectConnection).toHaveBeenCalledTimes(2))

    // 恢复 → 冻结层消失、键入恢复
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'connected' }))
    })
    await waitFor(() => expect(document.querySelector('.term-frozen')).toBeNull())
    term.paste('after-reconnect')
    await waitFor(() =>
      expect(api.ptyWrite).toHaveBeenCalledWith('tr', expect.stringContaining('after-reconnect'))
    )
  })

  it('本机任务不受连接状态影响（无冻结层）', async () => {
    const tLocal = makeTask({ id: 'tl', projectId: 'pl', name: '本机任务', status: 'running' })
    const api = await renderApp({ tasks: [tLocal] })
    fireEvent.click(
      (document.querySelector('li[data-task-id="tl"]') as HTMLElement).querySelector(
        '.task-main'
      ) as HTMLElement
    )
    await waitFor(() => expect(document.querySelector('.term-host')).not.toBeNull())
    act(() => {
      api.connectionStateCallbacks.forEach((cb) => cb({ connectionId: 'c1', state: 'offline' }))
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('.term-frozen')).toBeNull()
  })
})

describe('远程项目注册对话框（3.1=C：手输+浏览）', () => {
  async function openRegisterDialog(): Promise<HTMLElement> {
    fireEvent.click(within(serverNode('c1') as HTMLElement).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '新建远程项目…' }))
    return screen.findByRole('dialog', { name: '新建远程项目…' })
  }

  it('路径校验：非 / 开头提示且注册禁用；空路径禁用', async () => {
    await renderApp()
    const dialog = await openRegisterDialog()
    const pathInput = within(dialog).getByLabelText('VM 内绝对路径') as HTMLInputElement
    const register = within(dialog).getByRole('button', { name: '注册' })
    expect((register as HTMLButtonElement).disabled).toBe(true) // 空
    fireEvent.change(pathInput, { target: { value: 'D:\\not-vm' } })
    await waitFor(() => expect(within(dialog).getByText('路径须为以 / 开头的 VM 绝对路径')).toBeDefined())
    expect((register as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(pathInput, { target: { value: '/home/dev/app2' } })
    await waitFor(() => expect((register as HTMLButtonElement).disabled).toBe(false))
  })

  it('注册 → addProject(path, connectionId)，项目落入服务器分组', async () => {
    const api = await renderApp()
    vi.mocked(api.addProject).mockImplementation(async () =>
      makeProject({ id: 'pr2', name: 'App2', dir: '/home/dev/app2', connectionId: 'c1' })
    )
    const dialog = await openRegisterDialog()
    fireEvent.change(within(dialog).getByLabelText('VM 内绝对路径'), {
      target: { value: '/home/dev/app2' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '注册' }))
    await waitFor(() =>
      expect(api.addProject).toHaveBeenCalledWith('/home/dev/app2', 'c1')
    )
    await waitFor(() => expect(projectNode('pr2')).not.toBeNull())
    expect((serverNode('c1') as HTMLElement).contains(projectNode('pr2') as HTMLElement)).toBe(true)
  })

  it('「浏览」= browseRemoteDir 目录弹层：进入子目录、选择回填路径', async () => {
    const api = await renderApp()
    const dialog = await openRegisterDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: '浏览…' }))
    const browser = await screen.findByRole('dialog', { name: '浏览远程目录' })
    // 默认从远端 home 列目录（mock：/home/dev，含 projects 目录）
    await waitFor(() => expect(api.browseRemoteDir).toHaveBeenCalledWith('c1', undefined))
    await waitFor(() => expect(within(browser).getByText('📁 projects')).toBeDefined())
    // 进入子目录
    fireEvent.click(within(browser).getByRole('button', { name: '📁 projects' }))
    await waitFor(() => expect(api.browseRemoteDir).toHaveBeenCalledWith('c1', '/home/dev/projects'))
    // 选择当前目录 → 回填并关闭浏览器
    fireEvent.click(within(browser).getByRole('button', { name: '选择当前目录' }))
    await waitFor(() =>
      expect((within(dialog).getByLabelText('VM 内绝对路径') as HTMLInputElement).value).toBe(
        '/home/dev/projects'
      )
    )
    expect(screen.queryByRole('dialog', { name: '浏览远程目录' })).toBeNull()
  })
})

describe('折叠 rail：远程项目角标与悬停预览（3.10/3.11）', () => {
  it('远程项目=首字母圆标+服务器归属角标（rail-server-dot）；本机项目无角标', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await waitFor(() => expect(sidebarVisible()).toBe(false))
    const remoteAvatar = document.querySelector(
      '.sidebar-rail button[data-project-id="pr"]'
    ) as HTMLElement
    const localAvatar = document.querySelector(
      '.sidebar-rail button[data-project-id="pl"]'
    ) as HTMLElement
    expect(remoteAvatar.querySelector('.rail-server-dot')).not.toBeNull()
    expect(remoteAvatar.getAttribute('data-remote')).toBe('1')
    expect(remoteAvatar.getAttribute('title')).toContain('UBUNTU-VM')
    expect(localAvatar.querySelector('.rail-server-dot')).toBeNull()
    expect(localAvatar.getAttribute('data-remote')).toBeNull()
  })

  it('悬停远程头像 400ms → peek 浮层（服务器归属+任务状态点）；离开关闭', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await waitFor(() => expect(sidebarVisible()).toBe(false))
    const remoteAvatar = document.querySelector(
      '.sidebar-rail button[data-project-id="pr"]'
    ) as HTMLElement
    fireEvent.mouseEnter(remoteAvatar)
    await waitFor(() => expect(document.querySelector('.rail-peek')).not.toBeNull(), {
      timeout: 2_000
    })
    const peek = document.querySelector('.rail-peek') as HTMLElement
    expect(peek.querySelector('.rail-peek-title')?.textContent).toBe('RemoteProj')
    expect(peek.querySelector('.rail-peek-server')?.textContent).toBe('UBUNTU-VM')
    expect(peek.querySelector('.rail-peek-task-name')?.textContent).toBe('远程任务')
    expect(peek.querySelector('.status-dot')).not.toBeNull()
    fireEvent.mouseLeave(remoteAvatar)
    await waitFor(() => expect(document.querySelector('.rail-peek')).toBeNull())
  })

  it('本机项目头像悬停不出 peek', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    const localAvatar = document.querySelector(
      '.sidebar-rail button[data-project-id="pl"]'
    ) as HTMLElement
    fireEvent.mouseEnter(localAvatar)
    await new Promise((r) => setTimeout(r, 600))
    expect(document.querySelector('.rail-peek')).toBeNull()
  })
})

describe('删除服务器级联确认（3.9=A）', () => {
  it('文案明示「仅删客户端记录，不删 VM 文件」+受影响记录数；确认 → removeConnection', async () => {
    const api = await renderApp()
    fireEvent.click(within(serverNode('c1') as HTMLElement).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: /删除服务器/ })
    expect(
      within(dialog).getByText('仅删除客户端记录与连接档案，不删除 VM 内任何文件')
    ).toBeDefined()
    expect(within(dialog).getByText(/将一并移除 1 个远程项目记录与 1 个任务记录/)).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(api.removeConnection).toHaveBeenCalledWith('c1'))
  })
})

describe('server 安装/升级确认弹窗（6.7=A，mock 驱动）', () => {
  it('connectFlow 报 needInstall → 弹窗；确认 → installRemoteServer + 进度日志 + 自动重连', async () => {
    const api = await renderApp()
    vi.mocked(api.connectConnection).mockRejectedValue(new Error('needInstall: cwb-server 组件缺失'))
    vi.mocked(api.installRemoteServer).mockResolvedValue({ ok: true })
    fireEvent.click(within(serverNode('c1') as HTMLElement).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '连接' }))
    const dialog = await screen.findByRole('dialog', { name: '安装 cwb-server' })
    expect(within(dialog).getByText(/推送到 VM 的用户目录/)).toBeDefined()
    // 确认安装 → installRemoteServer(connectionId)
    fireEvent.click(within(dialog).getByRole('button', { name: '推送并安装' }))
    await waitFor(() => expect(api.installRemoteServer).toHaveBeenCalledWith('c1'))
    // 进度日志（onRemoteServerLog → serverLogs 环形）滚动展示
    act(() => {
      api.remoteServerLogCallbacks.forEach((cb) =>
        cb({ connectionId: 'c1', level: 'info', message: '[install] pushed tgz (1.2MB)' })
      )
    })
    await waitFor(() => expect(within(dialog).getByText('[install] pushed tgz (1.2MB)')).toBeDefined())
    // 安装成功 → 自动重连（第二次 connectConnection）
    await waitFor(() => expect(api.connectConnection).toHaveBeenCalledTimes(2))
  })

  it('非 needInstall 错误不弹安装窗', async () => {
    const api = await renderApp()
    vi.mocked(api.connectConnection).mockRejectedValue(new Error('conn.err.timeout'))
    fireEvent.click(within(serverNode('c1') as HTMLElement).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '连接' }))
    await waitFor(() => expect(api.connectConnection).toHaveBeenCalled())
    expect(screen.queryByRole('dialog', { name: '安装 cwb-server' })).toBeNull()
  })
})

describe('设置中心「远程连接」分类', () => {
  async function openConnectionsSection(): Promise<{ api: CwbApiMock; section: HTMLElement }> {
    const api = await renderApp()
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    const section = (await screen.findByText('新增连接')).closest('.dialog-section') as HTMLElement
    return { api, section }
  }

  it('连接档案 CRUD：新增表单校验+保存 → saveConnection（私钥认证）', async () => {
    const { api, section } = await openConnectionsSection()
    fireEvent.click(within(section).getByRole('button', { name: '新增连接' }))
    const form = screen.getByRole('form', { name: '远程连接' })
    const name = within(form).getByLabelText('名称') as HTMLInputElement
    const host = within(form).getByLabelText('主机') as HTMLInputElement
    const user = within(form).getByLabelText('用户名') as HTMLInputElement
    const keyPath = within(form).getByLabelText('私钥路径') as HTMLInputElement
    // 空名称保存被前端校验拦截（save 按钮禁用）
    expect((within(form).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(name, { target: { value: 'VM' } })
    fireEvent.change(host, { target: { value: '192.168.80.200' } })
    fireEvent.change(user, { target: { value: 'dev' } })
    fireEvent.change(keyPath, { target: { value: 'C:\\Users\\me\\.ssh\\id_ed25519' } })
    fireEvent.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalled())
    const saved = vi.mocked(api.saveConnection).mock.calls[0][0]
    expect(saved.name).toBe('VM')
    expect(saved.host).toBe('192.168.80.200')
    expect(saved.port).toBe(22)
    expect(saved.user).toBe('dev')
    expect(saved.authMethod).toBe('key')
    expect(saved.keyPath).toBe('C:\\Users\\me\\.ssh\\id_ed25519')
  })

  it('测试连接（2.1/2.2）：连接类失败展示分级错误 + 四类排障提示（9.2）', async () => {
    const api = await renderApp()
    vi.mocked(api.testConnection).mockResolvedValue({
      ok: false,
      error: '连接被拒绝：sshd 未启动或未安装',
      kind: 'refused'
    })
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    // 编辑既有档案 c1 → 测试按钮可用
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledWith('c1'))
    expect(await screen.findByText('连接被拒绝：sshd 未启动或未安装')).toBeDefined()
    // 四类排障提示：VM 未启动 / sshd 未装 / NAT 未转发 / 密钥未授权
    expect(screen.getByText('常见排障提示')).toBeDefined()
    expect(screen.getByText('VM 未启动或被挂起——启动虚拟机后重试')).toBeDefined()
    expect(screen.getByText(/sshd 未安装或未启动/)).toBeDefined()
    expect(screen.getByText(/NAT 网络未转发/)).toBeDefined()
    expect(screen.getByText(/密钥未授权/)).toBeDefined()
  })

  it('自检清单（S2 超集 checks）：✓/✗ 逐项 + 版本 detail，结构化清单取代四类提示', async () => {
    const api = await renderApp()
    vi.mocked(api.testConnection).mockResolvedValue({
      ok: false,
      error: 'self-check failed (missing: node, server)',
      kind: 'selfCheckFailed',
      checks: [
        { id: 'sshd', status: 'ok' },
        { id: 'claude', status: 'ok', detail: '2.1.301' },
        { id: 'node', status: 'missing', detail: 'exit 127' },
        { id: 'server', status: 'missing' }
      ]
    })
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const result = await screen.findByTestId('conn-test-result')
    // 四项清单逐条渲染（条目名=conn.check.*，✓/✗ 状态标记，detail 版本回显）
    const items = Array.from(result.querySelectorAll('.conn-check-item')) as HTMLElement[]
    expect(items.length).toBe(4)
    expect(items.filter((i) => i.getAttribute('data-status') === 'ok').length).toBe(2)
    expect(items.filter((i) => i.getAttribute('data-status') === 'missing').length).toBe(2)
    expect(within(result).getByText('sshd 可达')).toBeDefined()
    expect(within(result).getByText('cwb-server 组件/版本')).toBeDefined()
    expect(within(result).getByText('2.1.301')).toBeDefined()
    // 结构化清单在场 → 四类通用排障提示不再叠加（避免噪音）
    expect(within(result).queryByText('常见排障提示')).toBeNull()
  })

  it('TOFU 首连（1.5=A）：指纹原串回显 + 确认并锁定 → 档案写 lastHostKeyFingerprint + 自动重测', async () => {
    const api = await renderApp()
    const FP = 'SHA256:AbCdEf1234567890AbCdEf1234567890AbCdEf1234567'
    vi.mocked(api.testConnection)
      .mockResolvedValueOnce({ ok: false, kind: 'hostKeyConfirm', hostKeyFingerprint: FP })
      // 确认锁定后的重测走默认（全通过清单）
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const result = await screen.findByTestId('conn-test-result')
    // 指纹原串直接回显（不做再格式化）
    expect(within(result).getByText(FP)).toBeDefined()
    // 确认并锁定 → saveConnection 落档案 → 自动重测（第二次 testConnection → 通过）
    fireEvent.click(within(result).getByRole('button', { name: '确认并锁定指纹' }))
    await waitFor(() =>
      expect(api.saveConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1', lastHostKeyFingerprint: FP })
      )
    )
    await waitFor(() => expect(api.testConnection).toHaveBeenCalledTimes(2))
    expect(await within(result).findByText('连接测试通过')).toBeDefined()
  })

  it('指纹变更（hostKeyChanged）：指纹回显 + 阻断告警文案', async () => {
    const api = await renderApp()
    vi.mocked(api.testConnection).mockResolvedValue({
      ok: false,
      error: '主机指纹变更，连接已阻断（疑似中间人或重装系统）',
      kind: 'hostKeyChanged',
      hostKeyFingerprint: 'SHA256:DeadBeef0000000000000000000000000000000000'
    })
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const result = await screen.findByTestId('conn-test-result')
    expect(
      within(result).getByText('SHA256:DeadBeef0000000000000000000000000000000000')
    ).toBeDefined()
    expect(within(result).getByText(/指纹与已锁定值不一致/)).toBeDefined()
    // hostKeyChanged ≠ 待确认：不出现「确认并锁定」按钮
    expect(within(result).queryByRole('button', { name: '确认并锁定指纹' })).toBeNull()
  })

  it('私钥认证可选口令（S2 语义）：key 模式填口令 → saveConnection 带 passwordEncrypted', async () => {
    const api = await renderApp()
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '编辑' }))
    const form = screen.getByRole('form', { name: '远程连接' })
    fireEvent.change(within(form).getByLabelText('私钥路径'), {
      target: { value: 'C:\\Users\\me\\.ssh\\id_ed25519' }
    })
    fireEvent.change(within(form).getByLabelText('密钥口令（可选）'), {
      target: { value: 'ssh-pass-123' }
    })
    fireEvent.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalled())
    expect(vi.mocked(api.saveConnection).mock.calls[0][0]).toMatchObject({
      id: 'c1',
      authMethod: 'key',
      keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
      passwordEncrypted: 'ssh-pass-123'
    })
  })

  it('远程代理面板（6.4=c）：状态卡读取 + 配置保存回环（A5 UI 桩测）', async () => {
    const api = await renderApp()
    vi.mocked(api.getRemoteProxyStatus).mockResolvedValue({
      running: true,
      port: 18080,
      startedAt: new Date().toISOString(),
      stats: { total: 12, active: 1, direct: 9, viaProxy: 3 },
      config: { proxyUrl: 'http://10.0.0.2:7890' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    const panel = await screen.findByTestId('remote-proxy-panel')
    await waitFor(() => expect(api.getRemoteProxyStatus).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(within(panel).getByText(/18080/)).toBeDefined())
    // 配置表单回显 config.proxyUrl；保存走 setRemoteProxyConfig
    const urlInput = within(panel).getByLabelText('网络代理（HTTP_PROXY）') as HTMLInputElement
    await waitFor(() => expect(urlInput.value).toBe('http://10.0.0.2:7890'))
    fireEvent.change(urlInput, { target: { value: '' } })
    fireEvent.click(within(panel).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.setRemoteProxyConfig).toHaveBeenCalledWith('c1', { proxyUrl: '' }))
  })

  // S8 A5 UI 侧联测补桩：set→get 回环——保存后经状态重读（切换连接触发 refresh）
  // 拿回同一值（mock 升级为有状态：get 返回最近一次 set 的终态，等价 server 持久化）
  it('远程代理面板（A5 联测）：set→get 回环——保存后重读回填同值', async () => {
    const conn2 = makeConnection({ id: 'c2', name: 'VM-2' })
    const api = await renderApp({ connections: [conn, conn2] })
    let savedConfig: { proxyUrl?: string } | undefined = undefined
    vi.mocked(api.setRemoteProxyConfig).mockImplementation(
      async (_id: string, patch: { proxyUrl?: string }) => {
        savedConfig = { ...patch }
        return { ...patch }
      }
    )
    vi.mocked(api.getRemoteProxyStatus).mockImplementation(async () => ({
      running: false,
      stats: { total: 0, active: 0, direct: 0, viaProxy: 0 },
      config: savedConfig
    }))
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '远程连接' }))
    const panel = await screen.findByTestId('remote-proxy-panel')
    const urlInput = within(panel).getByLabelText('网络代理（HTTP_PROXY）') as HTMLInputElement
    await waitFor(() => expect(urlInput.value).toBe('')) // 初始无配置
    // set：填值保存
    fireEvent.change(urlInput, { target: { value: 'http://10.0.0.9:7890' } })
    fireEvent.click(within(panel).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.setRemoteProxyConfig).toHaveBeenCalledWith('c1', {
      proxyUrl: 'http://10.0.0.9:7890'
    }))
    expect(await within(panel).findByText('已保存')).toBeDefined()
    // get：切走再切回 c1（connId 变化触发 refresh）→ 拿回 set 的终态并回填
    fireEvent.change(within(panel).getByLabelText('远程连接'), { target: { value: 'c2' } })
    await waitFor(() => expect(api.getRemoteProxyStatus).toHaveBeenCalledWith('c2'))
    fireEvent.change(within(panel).getByLabelText('远程连接'), { target: { value: 'c1' } })
    await waitFor(() => expect(urlInput.value).toBe('http://10.0.0.9:7890'))
  })

  it('claude CLI 分类远程上下文占位说明（6.3/6.5）', async () => {
    await renderApp()
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'claude CLI' }))
    expect(
      await within(dialog).findByText(/远程任务使用 VM 内的 claude CLI/)
    ).toBeDefined()
  })
})
