import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CwbApiMock } from './test-helpers'
import { App } from './App'
import { installCwbMock, makeProject } from './test-helpers'
import { useAppStore } from './store'

/** v0.5①⑤④N：StatusBar + About 弹窗（版本/作者/MIT、CLI 版本与更新、5.1 安装、通知设置） */

const project = makeProject({ id: 'pa', name: 'AboutProj' })

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    aboutOpen: false,
    skillsOpen: false
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

async function renderApp(): Promise<CwbApiMock> {
  const api = installCwbMock({ projects: [project] })
  render(<App />)
  await waitFor(() => expect(document.querySelector('li[data-project-id="pa"]')).toBeDefined())
  return api
}

/** 打开 About：点侧栏顶部版本按钮（rail ⓘ 入口在折叠态，另有专门用例） */
async function openAbout(): Promise<ReturnType<typeof within>> {
  fireEvent.click(screen.getByRole('button', { name: 'v0.8.0' }))
  const dialog = await screen.findByRole('dialog', { name: '关于' })
  return within(dialog)
}

/** 向所有已注册 onCliOutput 回调注入事件（CliOutputView 订阅） */
function fireCliOutput(api: CwbApiMock, e: { commandId: string; data?: string; type?: 'exit'; exitCode?: number }): void {
  act(() => {
    for (const cb of api.cliOutputCallbacks) cb(e)
  })
}

describe('About 渲染（v0.5.1：侧栏顶部版本按钮入口）', () => {
  it('状态栏显示 v0.8.0；点击开 About：应用名/版本/作者/许可证 MIT', async () => {
    await renderApp()
    expect(screen.getByText('v0.8.0')).toBeDefined()
    const about = await openAbout()
    expect(about.getByText('Claude Workbench')).toBeDefined()
    expect(about.getByText(/版本 v0\.8\.0/)).toBeDefined()
    expect(about.getByText('作者 Liu Haitao')).toBeDefined()
    expect(about.getByText('MIT')).toBeDefined() // 许可证链接锚点
  })

  it('折叠态 rail 底部 ⓘ 同开 About', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // v0.5.1：顶部 ☰ 已移除，折叠走 Ctrl+B
    const rail = document.querySelector('.sidebar-rail') as HTMLElement
    fireEvent.click(within(rail).getByTitle('关于 Claude Workbench'))
    expect(await screen.findByRole('dialog', { name: '关于' })).toBeDefined()
  })

  it('claude CLI 版本+实际路径显示（getClaudeVersionInfo 实调）', async () => {
    const api = await renderApp()
    const about = await openAbout()
    expect(api.getClaudeVersionInfo).toHaveBeenCalledTimes(1)
    expect(await about.findByText('版本 2.1.301')).toBeDefined() // mock 默认返回
    expect(about.getByText('路径 C:\\claude.cmd')).toBeDefined()
  })

  it('关闭：点「关闭」按钮弹窗消失', async () => {
    await renderApp()
    const about = await openAbout()
    fireEvent.click(about.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '关于' })).toBeNull())
  })
})

describe('检查更新流（v0.5⑤）', () => {
  it('检查更新 → 显示当前/最新/可更新 → 点「更新」→ runCliCommand("claude update")；输出追加+exit 提示+关闭 killCliCommand', async () => {
    const api = await renderApp()
    const about = await openAbout()
    fireEvent.click(about.getByRole('button', { name: '检查更新' }))
    expect(await about.findByText(/当前 2\.1\.301 · 最新 2\.1\.304 · 可更新/)).toBeDefined()

    fireEvent.click(about.getByRole('button', { name: '更新' }))
    await waitFor(() => expect(api.runCliCommand).toHaveBeenCalledWith('claude update'))
    // mock runCliCommand 返回 {commandId:'cmd-test'} → onCliOutput 输出区追加
    await waitFor(() => expect(about.getByRole('log')).toBeDefined())
    fireCliOutput(api, { commandId: 'cmd-test', data: 'Updating claude code...\n' })
    await waitFor(() => expect(about.getByRole('log').textContent).toContain('Updating claude code'))
    // exit → 退出码 + 生效提示
    fireCliOutput(api, { commandId: 'cmd-test', type: 'exit', exitCode: 0 })
    await waitFor(() =>
      expect(about.getByText(/已完成（退出码 0）——新任务生效，旧任务恢复（resume）后生效/)).toBeDefined()
    )
    // 完成后刷新版本信息（spec T9）
    await waitFor(() => expect(api.getClaudeVersionInfo).toHaveBeenCalledTimes(2))

    // 关闭弹窗 → killCliCommand 防孤儿
    fireEvent.click(about.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(api.killCliCommand).toHaveBeenCalledWith('cmd-test'))
  })

  it('已是最新：upToDate=true → 无「更新」按钮；degraded → 降级提示', async () => {
    const api = await renderApp()
    vi.mocked(api.checkClaudeUpdate).mockResolvedValue({
      current: '2.1.301',
      latest: '2.1.301',
      upToDate: true
    })
    const about = await openAbout()
    fireEvent.click(about.getByRole('button', { name: '检查更新' }))
    expect(await about.findByText(/已是最新/)).toBeDefined()
    expect(about.queryByRole('button', { name: '更新' })).toBeNull()

    // degraded（无 node 环境）：显示降级提示
    vi.mocked(api.checkClaudeUpdate).mockResolvedValue({
      current: '2.1.301',
      latest: '',
      upToDate: false,
      degraded: true
    })
    fireEvent.click(about.getByRole('button', { name: '检查更新' }))
    expect(await about.findByText(/未检测到 node 环境/)).toBeDefined()
  })
})

describe('未安装 → 5.1 下载安装区', () => {
  it('未安装：显示安装区；选 npm → 二次确认（完整命令）→ installClaudeCli("npm")', async () => {
    const api = await renderApp()
    vi.mocked(api.getClaudeVersionInfo).mockResolvedValue({ version: '', path: '' })
    const about = await openAbout()
    expect(await about.findByText('未安装 claude CLI')).toBeDefined()
    expect(about.queryByRole('button', { name: '检查更新' })).toBeNull() // 未装不查更新

    const confirmSpy = vi.spyOn(window, 'confirm')
    confirmSpy.mockReturnValue(true)
    fireEvent.click(about.getByRole('radio', { name: /npm 安装/ }))
    fireEvent.click(about.getByRole('button', { name: '下载安装' }))
    await waitFor(() => expect(api.installClaudeCli).toHaveBeenCalledWith('npm'))
    // spec R5：确认框完整展示命令
    expect(confirmSpy.mock.calls[0][0]).toContain('npm install -g @anthropic-ai/claude-code')

    // 原生安装器（默认）：确认展示 irm 模板
    confirmSpy.mockClear()
    vi.mocked(api.installClaudeCli).mockClear()
    fireEvent.click(about.getByRole('radio', { name: /原生安装器/ }))
    fireEvent.click(about.getByRole('button', { name: '下载安装' }))
    await waitFor(() => expect(api.installClaudeCli).toHaveBeenCalledWith('native'))
    expect(confirmSpy.mock.calls[0][0]).toContain('irm https://claude.ai/install.ps1')
  })

  it('二次确认取消 → installClaudeCli 不被调用', async () => {
    const api = await renderApp()
    vi.mocked(api.getClaudeVersionInfo).mockResolvedValue({ version: '', path: '' })
    const about = await openAbout()
    await about.findByText('未安装 claude CLI')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(about.getByRole('button', { name: '下载安装' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.installClaudeCli).not.toHaveBeenCalled()
  })
})

describe('通知设置（v0.5④N）', () => {
  it('getNotifyConfig 预填；保存 → setNotifyWebhook(url, true) 参数断言', async () => {
    const api = await renderApp()
    vi.mocked(api.getNotifyConfig).mockResolvedValue({
      url: 'https://qyapi.weixin.qq.com/hook',
      enabled: false,
      channel: 'wecom'
    })
    const about = await openAbout()
    const urlInput = (await about.findByLabelText('webhook URL')) as HTMLInputElement
    expect(urlInput.value).toBe('https://qyapi.weixin.qq.com/hook')
    expect((about.getByRole('checkbox', { name: '启用' }) as HTMLInputElement).checked).toBe(false)

    fireEvent.change(urlInput, { target: { value: 'https://qyapi.weixin.qq.com/hook2' } })
    fireEvent.click(about.getByRole('checkbox', { name: '启用' }))
    fireEvent.click(about.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(api.setNotifyWebhook).toHaveBeenCalledWith('https://qyapi.weixin.qq.com/hook2', true)
    )
    expect(await about.findByText('已保存')).toBeDefined()
  })

  it('测试推送：成功/失败结果行内显示；URL 为空时禁用', async () => {
    const api = await renderApp()
    const about = await openAbout()
    const urlInput = (await about.findByLabelText('webhook URL')) as HTMLInputElement
    expect(
      (about.getByRole('button', { name: '测试推送' }) as HTMLButtonElement).disabled
    ).toBe(true) // 空 URL 禁用

    fireEvent.change(urlInput, { target: { value: 'https://hook' } })
    const testBtn = about.getByRole('button', { name: '测试推送' }) as HTMLButtonElement
    expect(testBtn.disabled).toBe(false)
    fireEvent.click(testBtn)
    await waitFor(() => expect(api.sendTestNotify).toHaveBeenCalledTimes(1))
    expect(await about.findByText('测试推送成功')).toBeDefined()

    vi.mocked(api.sendTestNotify).mockResolvedValue({ ok: false, error: 'timeout' })
    fireEvent.click(about.getByRole('button', { name: '测试推送' }))
    expect(await about.findByText('测试推送失败：timeout')).toBeDefined()
  })
})
