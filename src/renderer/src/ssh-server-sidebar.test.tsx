import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { terminalCache } from './components/TerminalPanel'
import { installCwbMock, makeConnection } from './test-helpers'
import type { CwbApiMock } from './test-helpers'
import { useAppStore } from './store'

/**
 * v2.1.2 ① L2 组件测试：SSH 视图左侧「SSH 服务器」列表 + 纯 SSH 连接对话框。
 * 覆盖：两组分组渲染与组头计数 / 当前连接行高亮（aria-current）/ 行点击装配
 * openSshConsole（openSshShell mock 断言）/ ⋯ 菜单（纯 SSH=专属对话框编辑、
 * 开发行=openSettings 直达）/ ＋ 新建（必填缺失报错不落盘）/ 空态 / L2.5
 * 对话框保存成功路径（kind 恒 'ssh'、password 仅输入时出现）。
 * 套路对齐 remote-sidebar.test.tsx（installCwbMock/makeConnection + App 渲染）。
 */

const connSsh = makeConnection({
  id: 'cs',
  name: '跳板机',
  host: '10.0.0.5',
  user: 'root',
  kind: 'ssh',
  keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519'
})
const connSsh2 = makeConnection({
  id: 'cs2',
  name: '备用机',
  host: '10.0.0.6',
  user: 'admin',
  kind: 'ssh',
  keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519'
})
/** 无 kind（=开发连接，v2.1.1 缺省语义） */
const connDev = makeConnection({ id: 'cd', name: 'dev-ubuntu', host: '192.168.1.20', user: 'dev' })

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    activityMap: {},
    settingsOpen: false,
    connections: [connSsh, connSsh2, connDev],
    connectionStates: {},
    serverLogs: [],
    uiSettings: {},
    pendingServerInstall: null,
    settingsOpenSection: 'general',
    settingsEditConnectionId: null,
    settingsScope: 'local',
    connectionSaveError: '',
    // SSH 视图：sshActive 置真后 App 渲染 SshServerSidebar（ProjectSidebar 卸载）
    sshActive: true,
    sshConsoleCid: null,
    sshSessionDead: false,
    sshOpenCids: [],
    sshDeadCids: [],
    sshFollowDir: null,
    reviewState: null,
    reviewActive: false,
    reviewHint: null
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  for (const t of terminalCache.values()) t.dispose()
  terminalCache.clear()
})

/** SSH 视图渲染辅助：installCwbMock + App；等待 SSH 侧栏主体出现 */
async function renderSshView(
  opts: { connections?: ReturnType<typeof makeConnection>[]; sshConsoleCid?: string } = {}
): Promise<CwbApiMock> {
  const conns = opts.connections ?? [connSsh, connSsh2, connDev]
  if (opts.sshConsoleCid !== undefined) {
    useAppStore.setState({ sshConsoleCid: opts.sshConsoleCid })
  }
  const api = installCwbMock({ projects: [], tasks: [], connections: conns })
  render(<App />)
  await waitFor(() => expect(document.querySelector('.ssh-srv-body')).toBeDefined())
  return api
}

function row(id: string): HTMLElement {
  const el = document.querySelector(`li[data-connection-id="${id}"]`) as HTMLElement | null
  if (el === null) throw new Error(`ssh-srv row ${id} not found`)
  return el
}
function group(kind: 'pure' | 'dev'): HTMLElement {
  const el = document.querySelector(
    `.ssh-srv-group[data-group="${kind}"]`
  ) as HTMLElement | null
  if (el === null) throw new Error(`ssh-srv group ${kind} not found`)
  return el
}

describe('v2.1.2 ① SSH 视图侧栏：分组渲染', () => {
  it('kind ssh 与无 kind 分别落两组；组头 ×N 计数；开发行带 DEV 角标 + 地址 mono 小字', async () => {
    await renderSshView()
    // ProjectSidebar 已被替代：无作用域 chips / 项目树
    expect(document.querySelector('.scope-chips')).toBeNull()
    expect(document.querySelector('.project-list')).toBeNull()
    const pure = group('pure')
    const dev = group('dev')
    // 组头标题 + 计数
    expect(within(pure).getByText('纯 SSH 连接')).toBeDefined()
    expect(within(pure).getByText('×2')).toBeDefined()
    expect(within(dev).getByText('开发服务器')).toBeDefined()
    expect(within(dev).getByText('×1')).toBeDefined()
    expect(within(dev).getByText('承载远程项目 · 亦可开纯终端')).toBeDefined()
    // 行落组：两条纯 SSH 在 pure；开发行在 dev
    expect(pure.contains(row('cs'))).toBe(true)
    expect(pure.contains(row('cs2'))).toBe(true)
    expect(dev.contains(row('cd'))).toBe(true)
    // 开发行名后 DEV 小角标；纯 SSH 行不带
    expect(within(row('cd')).getByText('DEV')).toBeDefined()
    expect(row('cs').querySelector('.ssh-srv-kind')).toBeNull()
    // 地址行 user@host:port
    expect(within(row('cs')).getByText('root@10.0.0.5:22')).toBeDefined()
    // 状态点缺省 offline（data-state 语义对齐 .sb-chip-dot）
    expect((row('cs').querySelector('.ssh-srv-dot') as HTMLElement).getAttribute('data-state')).toBe(
      'offline'
    )
  })
})

describe('当前连接高亮与行点击', () => {
  it('预置 sshConsoleCid 后该行 aria-current="true" + active 类；其余行无', async () => {
    await renderSshView({ sshConsoleCid: 'cs' })
    expect(row('cs').getAttribute('aria-current')).toBe('true')
    expect(row('cs').className).toContain('active')
    expect(row('cs2').getAttribute('aria-current')).toBeNull()
    expect(row('cd').getAttribute('aria-current')).toBeNull()
  })

  it('行点击 → openSshConsole 装配（openSshShell 被调）+ 行转为高亮', async () => {
    const api = await renderSshView()
    fireEvent.click(row('cs').querySelector('.ssh-srv-main') as HTMLElement)
    await waitFor(() => expect(api.openSshShell).toHaveBeenCalledWith('cs'))
    await waitFor(() => expect(row('cs').getAttribute('aria-current')).toBe('true'))
    expect(useAppStore.getState().sshConsoleCid).toBe('cs')
  })
})

describe('⋯ 菜单（SidebarMenu 装配）', () => {
  it('菜单项：打开终端/连接/编辑 SSH 连接/删除；「打开终端」→ openSshShell', async () => {
    const api = await renderSshView()
    fireEvent.click(within(row('cs')).getByRole('button', { name: '服务器操作' }))
    const menu = await waitFor(() => screen.getByRole('menu'))
    for (const label of ['打开终端', '连接', '编辑 SSH 连接', '删除']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeDefined()
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: '打开终端' }))
    await waitFor(() => expect(api.openSshShell).toHaveBeenCalledWith('cs'))
  })

  it('纯 SSH 行「编辑」打开 SshConnectionDialog（预填）；保存 record 带 kind:"ssh"', async () => {
    const api = await renderSshView()
    fireEvent.click(within(row('cs')).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑 SSH 连接' }))
    const dialog = await screen.findByRole('dialog', { name: '编辑 SSH 连接' })
    // 编辑态预填（id/名称/主机保留）
    expect((within(dialog).getByLabelText('主机') as HTMLInputElement).value).toBe('10.0.0.5')
    expect((within(dialog).getByLabelText('名称') as HTMLInputElement).value).toBe('跳板机')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(api.saveConnection).mock.calls[0][0]
    expect(saved.kind).toBe('ssh')
    expect(saved.id).toBe('cs')
    // 保存成功 → 对话框关闭
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '编辑 SSH 连接' })).toBeNull()
    )
  })

  it('开发行「编辑连接…」→ openSettings("connections", id)（settingsOpen + 直达态落 store）', async () => {
    await renderSshView()
    fireEvent.click(within(row('cd')).getByRole('button', { name: '服务器操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑连接…' }))
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useAppStore.getState().settingsOpenSection).toBe('connections')
    expect(useAppStore.getState().settingsEditConnectionId).toBe('cd')
  })
})

describe('＋ 新建与空态', () => {
  it('＋ 打开新建对话框；必填缺失点保存 → 字段错误可见且不落盘', async () => {
    const api = await renderSshView()
    fireEvent.click(screen.getByTestId('ssh-srv-new'))
    const dialog = await screen.findByRole('dialog', { name: '新建 SSH 连接' })
    // 空表单（名称/主机/用户名/密钥路径缺失；端口缺省 22 合法）→ 保存报错贴字段
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const alerts = within(dialog).getAllByRole('alert')
    expect(alerts.length).toBe(4)
    expect(alerts[0].textContent).toContain('名称')
    expect(alerts[0].id).toBe('ssh-conn-err-name')
    // 错误经 aria-describedby 关联字段
    expect(
      (within(dialog).getByLabelText('名称') as HTMLInputElement).getAttribute('aria-describedby')
    ).toBe('ssh-conn-err-name')
    expect(api.saveConnection).not.toHaveBeenCalled()
    // 对话框保持打开（报错不关）
    expect(screen.getByRole('dialog', { name: '新建 SSH 连接' })).toBeDefined()
  })

  it('零连接 → 空态提示 + 「新建连接」按钮直达对话框', async () => {
    await renderSshView({ connections: [] })
    expect(await screen.findByText('还没有 SSH 服务器')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /新建连接/ }))
    expect(await screen.findByRole('dialog', { name: '新建 SSH 连接' })).toBeDefined()
  })
})

describe('L2.5 装配：SshConnectionDialog 保存成功路径', () => {
  it('保存成功调 saveConnectionFlow：kind 恒 "ssh"；password 仅输入时出现（一次性明文字段）', async () => {
    const api = await renderSshView()
    // ① 密钥认证、未输入口令 → 无 password 字段
    fireEvent.click(screen.getByTestId('ssh-srv-new'))
    const dialog = await screen.findByRole('dialog', { name: '新建 SSH 连接' })
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '新跳板' } })
    fireEvent.change(within(dialog).getByLabelText('主机'), { target: { value: '10.0.0.9' } })
    fireEvent.change(within(dialog).getByLabelText('用户名'), { target: { value: 'root' } })
    fireEvent.change(within(dialog).getByLabelText('私钥路径'), { target: { value: 'C:\\k' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledTimes(1))
    const savedKey = vi.mocked(api.saveConnection).mock.calls[0][0]
    expect(savedKey.kind).toBe('ssh')
    expect(savedKey.authMethod).toBe('key')
    expect(savedKey.port).toBe(22)
    expect('password' in savedKey).toBe(false)
    // 成功即关
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '新建 SSH 连接' })).toBeNull()
    )

    // ② 密码认证 + 输入密码 → 一次性明文 password 字段（非 passwordEncrypted）
    fireEvent.click(screen.getByTestId('ssh-srv-new'))
    const dialog2 = await screen.findByRole('dialog', { name: '新建 SSH 连接' })
    fireEvent.change(within(dialog2).getByLabelText('名称'), { target: { value: 'pw 机' } })
    fireEvent.change(within(dialog2).getByLabelText('主机'), { target: { value: '10.0.0.8' } })
    fireEvent.change(within(dialog2).getByLabelText('用户名'), { target: { value: 'admin' } })
    fireEvent.click(within(dialog2).getByRole('radio', { name: '密码' }))
    // 「密码」同时命中 radio（label 包裹文本）与密码输入框（aria-label）——selector 限定
    fireEvent.change(
      within(dialog2).getByLabelText('密码', { selector: 'input[type="password"]' }),
      { target: { value: 'pw-plain-123' } }
    )
    fireEvent.click(within(dialog2).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledTimes(2))
    const savedPw = vi.mocked(api.saveConnection).mock.calls[1][0]
    expect(savedPw.kind).toBe('ssh')
    expect(savedPw.authMethod).toBe('password')
    expect(savedPw.password).toBe('pw-plain-123')
    expect(savedPw.passwordEncrypted).toBeUndefined()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '新建 SSH 连接' })).toBeNull()
    )
  })
})
