import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CwbApiMock } from './test-helpers'
import { App } from './App'
import { installCwbMock, makeProject } from './test-helpers'
import { useAppStore } from './store'

/**
 * v0.5①⑤④N：About 弹窗入口与身份信息。v0.9 瘦身：主题/通知/CLI/更新/安装
 * 断言平移至 settings.test.tsx（经设置弹窗交互）；本文件只测身份页 +
 * 「打开设置」入口。
 */

const project = makeProject({ id: 'pa', name: 'AboutProj' })

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    aboutOpen: false,
    skillsOpen: false,
    settingsOpen: false
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
  fireEvent.click(screen.getByRole('button', { name: 'v1.0.7' }))
  const dialog = await screen.findByRole('dialog', { name: '关于' })
  return within(dialog)
}

describe('About 渲染（v0.5.1：侧栏顶部版本按钮入口；v0.9 瘦身为身份页）', () => {
  it('状态栏显示 v1.0.7；点击开 About：应用名/版本/作者/许可证 MIT', async () => {
    await renderApp()
    expect(screen.getByText('v1.0.7')).toBeDefined()
    const about = await openAbout()
    expect(about.getByText('Claude Workbench')).toBeDefined()
    expect(about.getByText(/版本 v1.0.7/)).toBeDefined()
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

  it('关闭：点「关闭」按钮弹窗消失', async () => {
    await renderApp()
    const about = await openAbout()
    fireEvent.click(about.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '关于' })).toBeNull())
  })
})

describe('About 瘦身（v0.9：配置项迁往设置中心）', () => {
  it('无主题/通知/CLI 区（不发任何异步获取）；「打开设置」开 Settings 且关闭自身', async () => {
    const api = await renderApp()
    const about = await openAbout()
    // 迁出断言：主题三选、终端跟随、webhook、CLI 版本/更新区均不存在
    expect(about.queryByRole('radiogroup', { name: '界面主题' })).toBeNull()
    expect(about.queryByRole('checkbox', { name: '终端跟随界面主题' })).toBeNull()
    expect(about.queryByLabelText('webhook URL')).toBeNull()
    expect(about.queryByRole('button', { name: '检查更新' })).toBeNull()
    expect(api.getClaudeVersionInfo).not.toHaveBeenCalled()
    expect(api.getNotifyConfig).not.toHaveBeenCalled()
    expect(api.getAppSettings).not.toHaveBeenCalled()

    // 「打开设置」入口：开 Settings 并关闭 About（等价于用户从 About 跳转）
    fireEvent.click(about.getByRole('button', { name: '打开设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '关于' })).toBeNull())
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeDefined()
    await waitFor(() => expect(api.getClaudeVersionInfo).toHaveBeenCalledTimes(1)) // 设置侧实调
  })
})
