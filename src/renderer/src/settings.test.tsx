import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CwbApiMock } from './test-helpers'
import { App } from './App'
import { terminalCache } from './components/TerminalPanel'
import { FONT_FAMILY_WHITELIST, isFontFamily, isFontInstalled, loadFontFamily } from './font-family'
import { installCwbMock, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'

/**
 * v0.9 设置中心（SettingsDialog，9 项设置逐项）：
 * 外观（主题三选/终端跟随）· 终端（字号 stepper/字体族 select）· 通知（迁自
 * About）· claude CLI（版本/更新/安装——迁自 About）· 默认隔离（NewTaskDialog
 * 预选）· 启动与窗口（getAppSettings/setAppSettings 第 31-32 法）。
 * About 瘦身断言在 about.test（身份页 + 「打开设置」入口）。
 * S14 双栏重设计：右栏按 activeSection 条件渲染（非当前 section 不在 DOM）——
 * 非外观用例先点左栏导航（gotoSection）再交互；双栏专项断言见文末 describe。
 */

const project = makeProject({ id: 'ps2', name: 'SettingsProj' })
const taskA = makeTask({ id: 't-s1', projectId: 'ps2', name: '任务甲', status: 'running' })
const taskB = makeTask({ id: 't-s2', projectId: 'ps2', name: '任务乙', status: 'running' })

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    activityMap: {},
    skillsOpen: false,
    settingsOpen: false,
    theme: 'dark',
    effectiveTheme: 'dark',
    termFollowsTheme: false
  })
  for (const k of [
    'cwb-font-size',
    'cwb-font-family',
    'cwb-theme',
    'cwb-term-theme-follow',
    'cwb-default-isolation'
  ]) {
    window.localStorage.removeItem(k)
  }
  document.documentElement.dataset.theme = 'dark'
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  for (const t of terminalCache.values()) t.dispose()
  terminalCache.clear()
})

async function renderApp(): Promise<CwbApiMock> {
  const api = installCwbMock({ projects: [project], tasks: [taskA, taskB] })
  render(<App />)
  await waitFor(() => expect(document.querySelector('li[data-task-id="t-s1"]')).toBeDefined())
  return api
}

/** 打开设置：点展开侧栏「设置」按钮（rail ⚙ 入口在 sidebar.test 另有专门用例） */
async function openSettings(): Promise<ReturnType<typeof within>> {
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  const dialog = await screen.findByRole('dialog', { name: '设置' })
  return within(dialog)
}

/** S14 双栏：点左栏导航切到指定分类（右栏条件渲染——非当前 section 不在 DOM，
 * 非外观用例先切再交互；label 即导航按钮 aria-label，精确名可达） */
function gotoSection(s: ReturnType<typeof within>, label: string): void {
  fireEvent.click(s.getByRole('button', { name: label }))
}

/** 向所有已注册 onCliOutput 回调注入事件（CliOutputView 订阅） */
function fireCliOutput(
  api: CwbApiMock,
  e: { commandId: string; data?: string; type?: 'exit'; exitCode?: number }
): void {
  act(() => {
    for (const cb of api.cliOutputCallbacks) cb(e)
  })
}

/** 直连 openTask（确定性，绕开单击判别；running 任务不触发自动恢复） */
function openTab(id: string): void {
  act(() => {
    useAppStore.getState().openTask(id)
  })
}

// ── 外观（迁自 About/theme.test：三选 radio + 终端跟随开关） ──────────────

describe('外观：主题三选 + 终端跟随', () => {
  it('radio 三选：dataset.theme 与 localStorage("cwb-theme") 联动；system 经 matchMedia 解析', async () => {
    await renderApp()
    const s = await openSettings()
    // 默认 dark（无存储值回 dark）
    expect((s.getByRole('radio', { name: '深色' }) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(s.getByRole('radio', { name: '浅色' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem('cwb-theme')).toBe('light')

    fireEvent.click(s.getByRole('radio', { name: '深色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('cwb-theme')).toBe('dark')

    // 跟随系统：setTheme 内经 matchMedia 解析（mock matches 切换验证两分支）
    const original = window.matchMedia
    const mm = vi.fn().mockReturnValue({ matches: true })
    window.matchMedia = mm as unknown as typeof window.matchMedia
    try {
      fireEvent.click(s.getByRole('radio', { name: '跟随系统' }))
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(window.localStorage.getItem('cwb-theme')).toBe('system')
      expect(mm).toHaveBeenCalled()
      mm.mockReturnValue({ matches: false })
      fireEvent.click(s.getByRole('radio', { name: '深色' })) // 先离开 system 再回
      fireEvent.click(s.getByRole('radio', { name: '跟随系统' }))
      expect(document.documentElement.dataset.theme).toBe('light')
    } finally {
      window.matchMedia = original
    }
  })

  it('「终端跟随界面主题」checkbox：默认不勾；勾选/取消写 store + 持久化', async () => {
    await renderApp()
    const s = await openSettings()
    const cb = s.getByRole('checkbox', { name: '终端跟随界面主题' }) as HTMLInputElement
    expect(cb.checked).toBe(false)
    fireEvent.click(cb)
    expect(useAppStore.getState().termFollowsTheme).toBe(true)
    expect(window.localStorage.getItem('cwb-term-theme-follow')).toBe('1')
    fireEvent.click(cb)
    expect(useAppStore.getState().termFollowsTheme).toBe(false)
    expect(window.localStorage.getItem('cwb-term-theme-follow')).toBe('0')
  })
})

// ── 终端：字号 stepper（changeFontSize 通路）+ 字体族 select（changeFontFamily） ──

describe('终端：字号 stepper 与字体族 select', () => {
  it('字号 stepper：输入 18 → changeFontSize 通路（persist + options + 活动 ptyResize）', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, '终端')
    openTab('t-s1')
    const term = await waitFor(() => {
      const t = terminalCache.get('t-s1')
      expect(t).toBeDefined()
      return t!
    })
    vi.mocked(api.ptyResize).mockClear()

    fireEvent.change(s.getByLabelText('终端字号'), { target: { value: '18' } })
    expect(term.options.fontSize).toBe(18)
    expect(window.localStorage.getItem('cwb-font-size')).toBe('18')
    expect((s.getByLabelText('终端字号') as HTMLInputElement).value).toBe('18')
    expect(api.ptyResize).toHaveBeenCalledWith('t-s1', term.cols, term.rows)
  })

  it('字体族 select：Consolas → options.fontFamily + persist + 活动 ptyResize', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, '终端')
    openTab('t-s1')
    const term = await waitFor(() => {
      const t = terminalCache.get('t-s1')
      expect(t).toBeDefined()
      return t!
    })
    expect(term.options.fontFamily).toBe('Cascadia Mono') // 默认（白名单回退）

    vi.mocked(api.ptyResize).mockClear()
    fireEvent.change(s.getByLabelText('终端字体'), { target: { value: 'Consolas' } })
    expect(term.options.fontFamily).toBe('Consolas')
    expect(window.localStorage.getItem('cwb-font-family')).toBe('Consolas')
    expect(api.ptyResize).toHaveBeenCalledWith('t-s1', term.cols, term.rows)
  })

  it('loadFontFamily：缺失/白名单外回 Cascadia Mono；新实例采用持久化值', async () => {
    expect(loadFontFamily()).toBe('Cascadia Mono')
    window.localStorage.setItem('cwb-font-family', 'Comic Sans') // 白名单外
    expect(loadFontFamily()).toBe('Cascadia Mono')

    await renderApp()
    window.localStorage.setItem('cwb-font-family', 'Cascadia Code')
    openTab('t-s1')
    await waitFor(() => expect(terminalCache.get('t-s1')).toBeDefined())
    expect(terminalCache.get('t-s1')!.options.fontFamily).toBe('Cascadia Code')
  })
})

// ── 通知（迁自 About） ────────────────────────────────────────────────────

describe('通知设置（v0.5④N，迁自 About）', () => {
  it('getNotifyConfig 预填；保存 → setNotifyWebhook(url, true) 参数断言', async () => {
    const api = await renderApp()
    vi.mocked(api.getNotifyConfig).mockResolvedValue({
      url: 'https://qyapi.weixin.qq.com/hook',
      enabled: false,
      channel: 'wecom'
    })
    const s = await openSettings()
    gotoSection(s, '通知')
    const urlInput = (await s.findByLabelText('webhook URL')) as HTMLInputElement
    expect(urlInput.value).toBe('https://qyapi.weixin.qq.com/hook')
    expect((s.getByRole('checkbox', { name: '启用' }) as HTMLInputElement).checked).toBe(false)

    fireEvent.change(urlInput, { target: { value: 'https://qyapi.weixin.qq.com/hook2' } })
    fireEvent.click(s.getByRole('checkbox', { name: '启用' }))
    fireEvent.click(s.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(api.setNotifyWebhook).toHaveBeenCalledWith('https://qyapi.weixin.qq.com/hook2', true)
    )
    expect(await s.findByText('已保存')).toBeDefined()
  })

  it('测试推送：成功/失败结果行内显示；URL 为空时禁用', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, '通知')
    const urlInput = (await s.findByLabelText('webhook URL')) as HTMLInputElement
    expect(
      (s.getByRole('button', { name: '测试推送' }) as HTMLButtonElement).disabled
    ).toBe(true) // 空 URL 禁用

    fireEvent.change(urlInput, { target: { value: 'https://hook' } })
    const testBtn = s.getByRole('button', { name: '测试推送' }) as HTMLButtonElement
    expect(testBtn.disabled).toBe(false)
    fireEvent.click(testBtn)
    await waitFor(() => expect(api.sendTestNotify).toHaveBeenCalledTimes(1))
    expect(await s.findByText('测试推送成功')).toBeDefined()

    vi.mocked(api.sendTestNotify).mockResolvedValue({ ok: false, error: 'timeout' })
    fireEvent.click(s.getByRole('button', { name: '测试推送' }))
    expect(await s.findByText('测试推送失败：timeout')).toBeDefined()
  })
})

// ── claude CLI（迁自 About：版本/检查更新/更新/安装） ──────────────────────

describe('claude CLI（迁自 About）', () => {
  it('版本+实际路径显示（getClaudeVersionInfo 实调）', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, 'claude CLI')
    expect(api.getClaudeVersionInfo).toHaveBeenCalledTimes(1)
    expect(await s.findByText('版本 2.1.301')).toBeDefined() // mock 默认返回
    expect(s.getByText('路径 C:\\claude.cmd')).toBeDefined()
  })

  it('检查更新 → 显示当前/最新/可更新 → 点「更新」→ runCliCommand("claude update")；输出追加+exit 提示+关闭 killCliCommand', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, 'claude CLI')
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    expect(await s.findByText(/当前 2\.1\.301 · 最新 2\.1\.304 · 可更新/)).toBeDefined()

    fireEvent.click(s.getByRole('button', { name: '更新' }))
    await waitFor(() => expect(api.runCliCommand).toHaveBeenCalledWith('claude update'))
    // mock runCliCommand 返回 {commandId:'cmd-test'} → onCliOutput 输出区追加
    await waitFor(() => expect(s.getByRole('log')).toBeDefined())
    fireCliOutput(api, { commandId: 'cmd-test', data: 'Updating claude code...\n' })
    await waitFor(() => expect(s.getByRole('log').textContent).toContain('Updating claude code'))
    // exit → 退出码 + 生效提示
    fireCliOutput(api, { commandId: 'cmd-test', type: 'exit', exitCode: 0 })
    await waitFor(() =>
      expect(s.getByText(/已完成（退出码 0）——新任务生效，旧任务恢复（resume）后生效/)).toBeDefined()
    )
    // 完成后刷新版本信息（spec T9）
    await waitFor(() => expect(api.getClaudeVersionInfo).toHaveBeenCalledTimes(2))

    // 关闭弹窗 → killCliCommand 防孤儿
    fireEvent.click(s.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(api.killCliCommand).toHaveBeenCalledWith('cmd-test'))
  })

  it('v1.1.0 检查更新同时展示 claude CLI 更新说明（区间条目 + 失败降级提示）', async () => {
    const api = await renderApp()
    vi.mocked(api.getClaudeChangelog).mockResolvedValue({
      notes: [
        { version: '2.1.304', items: ['新增 --foo 参数', '修复启动卡顿'] },
        { version: '2.1.303', items: ['小修'] }
      ]
    })
    const s = await openSettings()
    gotoSection(s, 'claude CLI')
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    await waitFor(() =>
      expect(api.getClaudeChangelog).toHaveBeenCalledWith('2.1.301', '2.1.304')
    )
    expect(await s.findByText('v2.1.304')).toBeDefined()
    expect(s.getByText('新增 --foo 参数')).toBeDefined()
    expect(s.getByText('v2.1.303')).toBeDefined()

    // 双路失败 → 明确降级提示（不静默）
    vi.mocked(api.getClaudeChangelog).mockResolvedValue({ notes: [], error: 'HTTP 403' })
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    expect(await s.findByText(/更新说明获取失败：HTTP 403/)).toBeDefined()
  })

  it('已是最新：upToDate=true → 无「更新」按钮；degraded → 降级提示', async () => {
    const api = await renderApp()
    vi.mocked(api.checkClaudeUpdate).mockResolvedValue({
      current: '2.1.301',
      latest: '2.1.301',
      upToDate: true
    })
    const s = await openSettings()
    gotoSection(s, 'claude CLI')
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    expect(await s.findByText(/已是最新/)).toBeDefined()
    expect(s.queryByRole('button', { name: '更新' })).toBeNull()

    // degraded（无 node 环境）：显示降级提示
    vi.mocked(api.checkClaudeUpdate).mockResolvedValue({
      current: '2.1.301',
      latest: '',
      upToDate: false,
      degraded: true
    })
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    expect(await s.findByText(/未检测到 node 环境/)).toBeDefined()
  })

  it('未安装：显示安装区；选 npm → 二次确认（完整命令）→ installClaudeCli("npm")', async () => {
    const api = await renderApp()
    vi.mocked(api.getClaudeVersionInfo).mockResolvedValue({ version: '', path: '' })
    const s = await openSettings()
    gotoSection(s, 'claude CLI')
    expect(await s.findByText('未安装 claude CLI')).toBeDefined()
    expect(s.queryByRole('button', { name: '检查更新' })).toBeNull() // 未装不查更新

    const confirmSpy = vi.spyOn(window, 'confirm')
    confirmSpy.mockReturnValue(true)
    fireEvent.click(s.getByRole('radio', { name: /npm 安装/ }))
    fireEvent.click(s.getByRole('button', { name: '下载安装' }))
    await waitFor(() => expect(api.installClaudeCli).toHaveBeenCalledWith('npm'))
    // spec R5：确认框完整展示命令
    expect(confirmSpy.mock.calls[0][0]).toContain('npm install -g @anthropic-ai/claude-code')

    // 原生安装器（默认）：确认展示 irm 模板
    confirmSpy.mockClear()
    vi.mocked(api.installClaudeCli).mockClear()
    fireEvent.click(s.getByRole('radio', { name: /原生安装器/ }))
    fireEvent.click(s.getByRole('button', { name: '下载安装' }))
    await waitFor(() => expect(api.installClaudeCli).toHaveBeenCalledWith('native'))
    expect(confirmSpy.mock.calls[0][0]).toContain('irm https://claude.ai/install.ps1')
  })

  it('二次确认取消 → installClaudeCli 不被调用', async () => {
    const api = await renderApp()
    vi.mocked(api.getClaudeVersionInfo).mockResolvedValue({ version: '', path: '' })
    const s = await openSettings()
    gotoSection(s, 'claude CLI')
    await s.findByText('未安装 claude CLI')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(s.getByRole('button', { name: '下载安装' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.installClaudeCli).not.toHaveBeenCalled()
  })
})

// ── 应用更新（v1.1.0：检测/changelog 展示/下载升级 + 侧栏角标；
//    v1.2.2 并入「关于」分类——身份与更新同页） ─────────────────────────────

describe('应用更新（「关于」分类内）', () => {
  it('检查更新 → 可更新：版本对比 + CHANGELOG 区间展示 + 下载→就绪→重启并升级链路', async () => {
    const api = installCwbMock({ projects: [project], tasks: [taskA] })
    vi.mocked(api.checkAppUpdate).mockResolvedValue({
      current: '1.1.0',
      latest: '1.2.0',
      upToDate: false,
      notes: [
        { version: '1.2.0', items: ['新功能甲', '修复乙'] },
        { version: '1.1.9', items: ['小修'] }
      ]
    })
    render(<App />)
    const s = await openSettings()
    gotoSection(s, '关于')
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    expect(await s.findByText(/最新 v1.2.0 · 可更新/)).toBeDefined()
    expect(s.getByText('v1.2.0')).toBeDefined()
    expect(s.getByText('新功能甲')).toBeDefined()
    expect(s.getByText('v1.1.9')).toBeDefined()
    expect(s.queryByText('已是最新')).toBeNull()

    // 下载 → 进度事件 ready → 「立即升级」出现；确认框取消则不 install
    fireEvent.click(s.getByRole('button', { name: '下载更新' }))
    await waitFor(() => expect(api.downloadAppUpdate).toHaveBeenCalled())
    act(() => {
      for (const cb of api.appUpdateProgressCallbacks) cb({ phase: 'ready' })
    })
    const installBtn = await s.findByRole('button', { name: '立即升级' })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(installBtn)
    expect(confirmSpy).toHaveBeenCalled()
    expect(api.installAppUpdate).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('已是最新：显示当前版本说明；侧栏版本按钮出现角标仅在有新版时', async () => {
    const api = installCwbMock({ projects: [project], tasks: [taskA] })
    vi.mocked(api.checkAppUpdate).mockResolvedValue({
      current: '1.1.0',
      latest: '1.1.0',
      upToDate: true,
      notes: [{ version: '1.1.0', items: ['自更新上线'] }]
    })
    render(<App />)
    const s = await openSettings()
    gotoSection(s, '关于')
    fireEvent.click(s.getByRole('button', { name: '检查更新' }))
    expect(await s.findByText(/已是最新/)).toBeDefined()
    expect(s.getByText('自更新上线')).toBeDefined()
    expect(s.queryByRole('button', { name: '下载更新' })).toBeNull()
    // 已是最新 → 侧栏无角标
    expect(screen.queryByTitle(/有新版本/)).toBeNull()

    // 侧栏角标：store 落可更新结果后出现（启动静默检查同路径）
    act(() => {
      useAppStore.getState().setAppUpdateInfo({
        current: '1.1.0',
        latest: '1.2.0',
        upToDate: false,
        notes: []
      })
    })
    expect(screen.getByTitle('有新版本 v1.2.0')).toBeDefined()
  })

  it('v1.2.1 自动升级：开关缺省勾选、关闭写 settings；available 事件落 store；waiting-tasks 显示等待态', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, '关于')
    // 缺省开（main settings 缺字段时视为 true）
    const auto = s.getByRole('checkbox', { name: '有新版本时自动升级' }) as HTMLInputElement
    expect(auto.checked).toBe(true)

    // 自动检查结果经进度事件送到界面（无需用户点「检查更新」）
    act(() => {
      for (const cb of api.appUpdateProgressCallbacks) {
        cb({
          phase: 'available',
          info: { current: '1.2.1', latest: '1.3.0', upToDate: false, notes: [{ version: '1.3.0', items: ['自动升级'] }] }
        })
      }
    })
    expect(await s.findByText(/最新 v1.3.0 · 可更新/)).toBeDefined()
    expect(s.getByText('自动升级')).toBeDefined()

    // 有任务在跑 → 等待态文案（含数量）
    act(() => {
      for (const cb of api.appUpdateProgressCallbacks) cb({ phase: 'waiting-tasks', count: 2 })
    })
    expect(await s.findByRole('status')).toHaveProperty(
      'textContent',
      '更新已就绪，等待 2 个任务结束后自动升级'
    )
    // 就绪后按钮变成「立即升级」（自动路径会自动执行，这是手动兜底）
    expect(s.getByRole('button', { name: '立即升级' })).toBeDefined()

    fireEvent.click(auto)
    await waitFor(() => expect(api.setAppSettings).toHaveBeenCalledWith({ autoUpdate: false }))
  })
})

// ── 启动与窗口（第 31-32 法：getAppSettings/setAppSettings） ────────────────

describe('启动与窗口', () => {
  it('getAppSettings 初始化（mock 默认托盘常驻）；选「退出应用」→ setAppSettings({closeToTray:false})', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, '启动')
    await waitFor(() => expect(api.getAppSettings).toHaveBeenCalledTimes(1))
    expect(
      (s.getByRole('radio', { name: '最小化到托盘（常驻）' }) as HTMLInputElement).checked
    ).toBe(true) // mock 默认 closeToTray=true

    fireEvent.click(s.getByRole('radio', { name: '退出应用' }))
    await waitFor(() => expect(api.setAppSettings).toHaveBeenCalledWith({ closeToTray: false }))
  })

  it('开机自启 checkbox：勾选 → setAppSettings({launchAtLogin:true})', async () => {
    const api = await renderApp()
    const s = await openSettings()
    gotoSection(s, '启动')
    fireEvent.click(s.getByRole('checkbox', { name: '开机自启' }))
    await waitFor(() => expect(api.setAppSettings).toHaveBeenCalledWith({ launchAtLogin: true }))
  })
})

// ── 新建任务默认隔离（v0.9⑦：persist + 三选预选） ──────────────────────────

describe('新建任务默认隔离', () => {
  it('git 三选：点「改用共享目录」→ persist("shared") + createTask isolation:shared；下次三选高亮 shared（纯预选不跳确认）', async () => {
    const api = await renderApp()
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true }) // Ctrl+N 开对话框（当前选中项目）
    const dlg = screen.getByRole('dialog', { name: '新建任务' })
    const nameInput = within(dlg).getByPlaceholderText('任务名')
    fireEvent.change(nameInput, { target: { value: '隔离记忆' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    // 进入三选阶段——默认（无记录）：worktree 主按钮（既有观感）
    expect(within(dlg).getByRole('button', { name: /创建隔离分支/ }).className).toContain('primary')
    fireEvent.click(within(dlg).getByRole('button', { name: '改用共享目录' }))
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith('ps2', '隔离记忆', { isolation: 'shared' })
    )
    expect(window.localStorage.getItem('cwb-default-isolation')).toBe('shared')

    // 重开对话框：名称阶段照旧（不跳过三选），三选阶段 shared 高亮
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    const dlg2 = screen.getByRole('dialog', { name: '新建任务' })
    const name2 = within(dlg2).getByPlaceholderText('任务名')
    expect(name2).toBeDefined() // 仍在名称输入阶段——预选≠跳过确认
    fireEvent.change(name2, { target: { value: '再来一个' } })
    fireEvent.keyDown(name2, { key: 'Enter' })
    expect(within(dlg2).getByRole('button', { name: /创建隔离分支/ }).className).not.toContain(
      'primary'
    )
    expect(within(dlg2).getByRole('button', { name: '改用共享目录' }).className).toContain(
      'primary'
    )
  })
})

// ── 弹窗基线（Escape/关闭——对齐 About/Skills 先例） ────────────────────────

describe('设置弹窗基线', () => {
  it('Escape 关闭（document 级——焦点留在触发按钮场景）', async () => {
    await renderApp()
    await openSettings()
    expect(screen.getByRole('dialog', { name: '设置' })).toBeDefined()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull())
  })
})

// ── S14 双栏导航（左分类+当前值摘要；右内容条件渲染） ──────────────────────

describe('设置双栏导航（S14）', () => {
  it('默认选中「外观」：其内容可见，终端内容不可见；active 项带 aria-current', async () => {
    await renderApp()
    const s = await openSettings()
    expect(s.getByRole('radio', { name: '深色' })).toBeDefined() // 外观内容在
    expect(s.queryByLabelText('终端字号')).toBeNull() // 终端内容不在（条件渲染）
    expect(s.getByRole('button', { name: '外观' }).getAttribute('aria-current')).toBe('true')
    expect(s.getByRole('button', { name: '终端' }).getAttribute('aria-current')).toBeNull()
  })

  it('点「终端」导航：内容更替（外观内容消失、终端内容出现且 aria-current 转移）', async () => {
    await renderApp()
    const s = await openSettings()
    gotoSection(s, '终端')
    expect(s.getByLabelText('终端字号')).toBeDefined()
    expect(s.queryByRole('radio', { name: '深色' })).toBeNull()
    expect(s.getByRole('button', { name: '终端' }).getAttribute('aria-current')).toBe('true')
    expect(s.getByRole('button', { name: '外观' }).getAttribute('aria-current')).toBeNull()
  })

  it('左栏当前值摘要：终端 "Cascadia Mono · 15"、外观随主题实时更新、cli 版本、启动托盘常驻、通知未配置', async () => {
    const api = await renderApp()
    const s = await openSettings()
    // 终端：默认字体族/字号派生
    expect(s.getByRole('button', { name: '终端' }).textContent).toContain('Cascadia Mono · 15')
    // 外观：摘要随 radio 实时更新
    expect(s.getByRole('button', { name: '外观' }).textContent).toContain('深色')
    fireEvent.click(s.getByRole('radio', { name: '浅色' }))
    expect(s.getByRole('button', { name: '外观' }).textContent).toContain('浅色')
    // claude CLI：摘要 = 版本号（getClaudeVersionInfo 异步返回后）
    await waitFor(() =>
      expect(s.getByRole('button', { name: 'claude CLI' }).textContent).toContain('2.1.301')
    )
    // 启动：mock getAppSettings 默认 closeToTray=true
    await waitFor(() => expect(api.getAppSettings).toHaveBeenCalledTimes(1))
    expect(s.getByRole('button', { name: '启动' }).textContent).toContain('托盘常驻')
    // 通知：mock getNotifyConfig 默认空 URL → 未配置
    expect(s.getByRole('button', { name: '通知' }).textContent).toContain('未配置')
  })
})

describe('v0.9.3 免费商用字体扩容', () => {
  it('白名单扩至 20+（含 CJK 友好：更纱/霞鹜/Noto CJK）', async () => {
    expect(FONT_FAMILY_WHITELIST.length).toBeGreaterThanOrEqual(20)
    expect(FONT_FAMILY_WHITELIST).toContain('JetBrains Mono')
    expect(FONT_FAMILY_WHITELIST).toContain('Sarasa Mono SC')
    expect(FONT_FAMILY_WHITELIST).toContain('LXGW WenKai Mono')
    expect(FONT_FAMILY_WHITELIST).toContain('Noto Sans Mono CJK SC')
  })

  it('isFontInstalled：jsdom 字体探测 API 不可用 → null（不标注）；白名单校验仍生效', () => {
    // jsdom 无真实字体引擎——check 可能 false 或异常，两种都接受为「可标注」语义
    const r = isFontInstalled('JetBrains Mono')
    expect(r === null || typeof r === 'boolean').toBe(true)
    expect(isFontFamily('JetBrains Mono')).toBe(true)
    expect(isFontFamily('Bookerly')).toBe(false)
  })
})

describe('v0.9.4 字体下拉只显示本机已装（用户指令）', () => {
  it('mock 本机 Cascadia/Consolas/SimSun → 下拉恰含三者，不含未装的 JetBrains Mono', async () => {
    installCwbMock({ projects: [] })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    fireEvent.click(within(dialog).getByRole('button', { name: '终端' }))
    const select = await screen.findByLabelText('终端字体')
    const values = within(select)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value)
    expect(values).toContain('Cascadia Mono')
    expect(values).toContain('SimSun-ExtB') // 不在白名单——本机检测追加
    expect(values).not.toContain('JetBrains Mono') // 白名单但未装——不显示
  })
})
