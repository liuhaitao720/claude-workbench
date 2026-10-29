import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CwbApiMock } from './test-helpers'
import { App } from './App'
import { installCwbMock, makeProject } from './test-helpers'
import { useAppStore } from './store'

/**
 * v1.2.1：关于并入设置中心（用户指令「合并关于和设置这 2 个弹窗」）。
 * 独立 AboutDialog 下线——应用身份信息成为设置中心左栏末项「关于」分类，
 * ⓘ 图标保留为直达该分类的快捷入口（不再是另一个弹窗）。
 */

const project = makeProject({ id: 'pa', name: 'AboutProj' })

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    skillsOpen: false,
    settingsOpen: false,
    settingsSection: 'appearance'
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

/** ⓘ 图标入口（侧栏头部）→ 设置弹窗，直接落在「关于」分类 */
async function openAbout(): Promise<ReturnType<typeof within>> {
  const header = document.querySelector('.sidebar-header') as HTMLElement
  fireEvent.click(within(header).getByRole('button', { name: '关于 Claude Workbench' }))
  const dialog = await screen.findByRole('dialog', { name: '设置' })
  return within(dialog)
}

describe('关于并入设置中心（v1.2.1）', () => {
  it('ⓘ 打开的是设置弹窗（唯一弹窗），且直接停在「关于」分类', async () => {
    await renderApp()
    const s = await openAbout()
    const nav = s.getByRole('button', { name: /^关于/ })
    expect(nav.getAttribute('aria-current')).toBe('true')
    // 身份信息在右栏
    expect(s.getByText('Claude Workbench')).toBeDefined()
    expect(s.getByText(/版本 v1\.2\.1/)).toBeDefined()
    expect(s.getByText('作者 Liu Haitao')).toBeDefined()
    expect(s.getByText('MIT')).toBeDefined() // 许可证链接锚点
    // 只有一个 dialog（不存在并列的两个弹窗）
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('侧栏显示 v1.2.1 纯文本版本号（仍不可点）', async () => {
    await renderApp()
    expect(document.querySelector('.version-text')?.textContent).toContain('v1.2.1')
    expect(screen.queryByRole('button', { name: /^v1\./ })).toBeNull()
  })

  it('折叠态 rail 底部 ⓘ 同样落到设置弹窗的「关于」分类', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // 折叠走 Ctrl+B
    const rail = document.querySelector('.sidebar-rail') as HTMLElement
    fireEvent.click(within(rail).getByTitle('关于 Claude Workbench'))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    expect(within(dialog).getByRole('button', { name: /^关于/ }).getAttribute('aria-current')).toBe(
      'true'
    )
  })

  it('⚙ 仍从「外观」进；左栏可按分类切换（关于 ↔ 外观 同一弹窗）', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    const s = within(dialog)
    expect(s.getByRole('button', { name: /^外观/ }).getAttribute('aria-current')).toBe('true')

    fireEvent.click(s.getByRole('button', { name: /^关于/ }))
    expect(s.getByText(/版本 v1\.2\.1/)).toBeDefined()
    expect(s.getByRole('button', { name: /^关于/ }).getAttribute('aria-current')).toBe('true')

    fireEvent.click(s.getByRole('button', { name: /^外观/ }))
    expect(s.queryByText(/版本 v1\.2\.1/)).toBeNull() // 关于分类内容随切换卸载
    expect(s.getByRole('radiogroup', { name: '界面主题' })).toBeDefined()
  })

  it('关闭按钮收掉整个设置弹窗（关于页不再有「打开设置」这种内部跳转）', async () => {
    await renderApp()
    const s = await openAbout()
    expect(s.queryByRole('button', { name: '打开设置' })).toBeNull()
    fireEvent.click(s.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull())
  })
})
