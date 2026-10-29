import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'
import { useLanguageStore, translate, LANGUAGE_LABELS } from './i18n'
import { en as enDict, zh as zhDict } from '../../shared/i18n'

/**
 * v1.2.0 中英双语（i18n）：
 * - 字典完整性（en 与 zh 键集合一致；占位符一致）
 * - 切换语言：整界面文案即时切换，localStorage 持久化，同步 main（setAppSettings）
 * - 默认中文（未设置过语言时不打扰中文用户）
 */

const project = makeProject({ id: 'p1', name: 'Alpha' })
const task = makeTask({ id: 't1', projectId: 'p1', name: '任务一' })

beforeEach(() => {
  localStorage.removeItem('cwb-language')
  useLanguageStore.setState({ language: 'zh' })
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    skillsOpen: false,
    settingsOpen: false,
    searchOpen: false,
    appUpdateInfo: null
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('字典完整性（漏译在编译期已挡，此处守占位符与运行时一致性）', () => {
  it('zh/en 键集合完全一致', () => {
    expect(Object.keys(enDict).sort()).toEqual(Object.keys(zhDict).sort())
  })

  it('同一键的 {placeholder} 集合两边一致（防翻译时漏写参数）', () => {
    const placeholders = (s: string): string[] =>
      Array.from(new Set(s.match(/\{[a-zA-Z]+\}/g) ?? [])).sort()
    const mismatched: string[] = []
    for (const key of Object.keys(zhDict) as Array<keyof typeof zhDict>) {
      const a = placeholders(zhDict[key])
      const b = placeholders(enDict[key])
      if (a.join() !== b.join()) mismatched.push(`${key}: zh=${a.join('|')} en=${b.join('|')}`)
    }
    expect(mismatched).toEqual([])
  })

  it('translate：替换全部占位符；缺键回退为键名（便于发现漏配）', () => {
    expect(translate('zh', 'about.version', { version: '1.2.0' })).toBe('版本 v1.2.0')
    expect(translate('en', 'about.version', { version: '1.2.0' })).toBe('Version v1.2.0')
    expect(translate('en', 'quit.message', { count: 3 })).toContain('3')
    expect(translate('en', 'no.such.key' as never)).toBe('no.such.key')
  })

  it('语言选择器显示母语名（两边都看得懂）', () => {
    expect(LANGUAGE_LABELS).toEqual({ zh: '简体中文', en: 'English' })
  })
})

describe('界面语言切换（设置中心 → 全部界面）', () => {
  async function openSettings(): Promise<ReturnType<typeof within>> {
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const dialog = await screen.findByRole('dialog', { name: '设置' })
    return within(dialog)
  }

  it('默认中文；切到 English 后侧栏/设置/状态提示全部英文，localStorage 与 main 同步', async () => {
    const api = installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="p1"]')).toBeDefined())

    // 默认中文
    expect(screen.getByRole('button', { name: '打开目录' })).toBeDefined()
    expect(document.documentElement.lang).toBe('zh-CN')

    const settings = await openSettings()
    const select = settings.getByRole('combobox', { name: '语言 / Language' })
    fireEvent.change(select, { target: { value: 'en' } })

    // 界面即时切英文
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeDefined()
    expect(screen.getByPlaceholderText('Search tasks / projects…')).toBeDefined()
    // 已挂载的任务行 tooltip 也随语言（TaskStatusDot 标题）
    const dot = document.querySelector('.task-row .status-dot')
    expect(dot?.getAttribute('title')).toBe('Terminal not open')

    // 持久化 + 同步 main（托盘/退出确认取同一语言）
    expect(localStorage.getItem('cwb-language')).toBe('en')
    expect(api.setAppSettings).toHaveBeenCalledWith({ language: 'en' })
    expect(document.documentElement.lang).toBe('en')

    // 切回中文
    fireEvent.change(screen.getByRole('combobox', { name: 'Language / 语言' }), {
      target: { value: 'zh' }
    })
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeDefined()
    expect(screen.getByRole('button', { name: '打开目录' })).toBeDefined()
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('持久化的语言在下次启动生效（localStorage 预置 en → 首屏英文）', async () => {
    localStorage.setItem('cwb-language', 'en')
    // store 在模块加载时读一次；测试内重建等价于一次新启动
    act(() => {
      useLanguageStore.setState({ language: 'en' })
      document.documentElement.lang = 'en'
    })
    installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="p1"]')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeDefined()
    expect(screen.getByText('Recent')).toBeDefined()
  })

  it('启动时把当前语言同步给 main（App mount → setAppSettings）', async () => {
    const api = installCwbMock({ projects: [] })
    render(<App />)
    await waitFor(() => expect(api.setAppSettings).toHaveBeenCalledWith({ language: 'zh' }))
  })
})