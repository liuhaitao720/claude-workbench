/// <reference types="node" />
import './test-setup'
// css 契约断言需 node fs 直读（见下）——单独引入 node 类型，不进 tsconfig.web 全局
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { terminalCache } from './components/TerminalPanel'
import { useAppStore } from './store'
import { loadTermFollowsTheme, loadTheme, resolveTheme, terminalThemeFor } from './theme'
import { installCwbMock, makeProject, makeTask } from './test-helpers'

// 样式表原始文本（A3 CSS 契约断言用）：vitest 对 css 导入一律 no-op（?raw 也被
// 吞成空串），走 node fs 直读——测试进程仍在 Node，jsdom 只是 DOM 全局层
const cssRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8'
)

/**
 * v0.5.3 主题切换 + UI 评审应修项（A1/A3/A4）。
 *
 * FOUC 内联脚本（index.html head）不进 jsdom 测试环境——测试环境不加载
 * index.html，内联脚本无法被执行，故不测（人工/e2e 验证：dev 起应用切浅色
 * 后刷新，首帧应直接浅色无闪白）。三层防护中 store 初始化与 main.tsx 层
 * 的语义由下方 loadTheme/resolveTheme 单测覆盖。
 */

const project = makeProject({ id: 'p-th', name: 'ThemeProj' })
const taskA = makeTask({ id: 't-a', projectId: 'p-th', name: '任务甲', status: 'running' })
const taskB = makeTask({ id: 't-b', projectId: 'p-th', name: '任务乙', status: 'running' })

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    aboutOpen: false,
    skillsOpen: false,
    theme: 'dark',
    effectiveTheme: 'dark',
    termFollowsTheme: false
  })
  window.localStorage.removeItem('cwb-theme')
  window.localStorage.removeItem('cwb-term-theme-follow')
  document.documentElement.dataset.theme = 'dark'
})
afterEach(() => {
  cleanup()
  for (const t of terminalCache.values()) t.dispose()
  terminalCache.clear()
})

async function renderApp() {
  const api = installCwbMock({ projects: [project], tasks: [taskA, taskB] })
  render(<App />)
  await waitFor(() => expect(document.querySelector('li[data-task-id="t-a"]')).toBeDefined())
  return api
}

/** 打开 About（点侧栏版本按钮，对齐 about.test 先例） */
async function openAbout(): Promise<ReturnType<typeof within>> {
  fireEvent.click(screen.getByRole('button', { name: 'v1.0.4' }))
  const dialog = await screen.findByRole('dialog', { name: '关于' })
  return within(dialog)
}

describe('theme.ts 纯函数（对齐 font-size.ts 先例的持久化语义）', () => {
  it('loadTheme：缺失/坏值回 dark；system/dark/light 合法值原样返回', () => {
    expect(loadTheme()).toBe('dark')
    window.localStorage.setItem('cwb-theme', 'garbage')
    expect(loadTheme()).toBe('dark')
    for (const v of ['system', 'dark', 'light'] as const) {
      window.localStorage.setItem('cwb-theme', v)
      expect(loadTheme()).toBe(v)
    }
  })

  it('resolveTheme：显式 dark/light 直返；system 经 matchMedia 解析（true→dark / false→light）', () => {
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    const original = window.matchMedia
    const mm = vi.fn().mockReturnValue({ matches: true })
    window.matchMedia = mm as unknown as typeof window.matchMedia
    try {
      expect(resolveTheme('system')).toBe('dark')
      mm.mockReturnValue({ matches: false })
      expect(resolveTheme('system')).toBe('light')
    } finally {
      window.matchMedia = original
    }
  })

  it('terminalThemeFor：dark 保持既有观感（含 cursor）；light 白底深字；返回副本防串色', () => {
    const dark = terminalThemeFor('dark')
    expect(dark.background).toBe('#14151a')
    expect(dark.foreground).toBe('#d7d7db')
    expect(dark.cursor).toBe('#d7d7db')
    const light = terminalThemeFor('light')
    expect(light.background).toBe('#ffffff')
    expect(light.foreground).toBe('#33363d')
    expect(light.cursor).toBe('#33363d')
    dark.background = '#mutated'
    expect(terminalThemeFor('dark').background).toBe('#14151a') // 副本——共享对象被改不串色
  })

  it('termFollowsTheme 持久化：默认关（非 "1" 皆关）；写入 "1"/"0" 对应开关', () => {
    expect(loadTermFollowsTheme()).toBe(false)
    window.localStorage.setItem('cwb-term-theme-follow', '1')
    expect(loadTermFollowsTheme()).toBe(true)
    window.localStorage.setItem('cwb-term-theme-follow', '0')
    expect(loadTermFollowsTheme()).toBe(false)
  })
})

describe('终端主题与 UI 主题解耦（评审④-1：浅 UI 下终端默认仍深色）', () => {
  it('既有终端实例：UI 切浅色终端保持深色；跟随开关切换即时换色（无需重开 tab）', async () => {
    await renderApp()
    act(() => {
      useAppStore.getState().openTask('t-a')
    })
    await waitFor(() => expect(terminalCache.get('t-a')).toBeDefined())
    const term = terminalCache.get('t-a')!
    expect(term.options.theme?.background).toBe('#14151a') // 初始深色

    act(() => {
      useAppStore.getState().setTheme('light')
    })
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(term.options.theme?.background).toBe('#14151a') // 跟随关——终端不动

    act(() => {
      useAppStore.getState().setTermFollowsTheme(true)
    })
    await waitFor(() => expect(term.options.theme?.background).toBe('#ffffff')) // 开启即浅

    act(() => {
      useAppStore.getState().setTermFollowsTheme(false)
    })
    await waitFor(() => expect(term.options.theme?.background).toBe('#14151a')) // 关闭回深
  })

  it('新建终端实例：创建路径按当前生效取主题（不再硬编码深色）', async () => {
    await renderApp()
    act(() => {
      useAppStore.getState().setTheme('light')
    })
    act(() => {
      useAppStore.getState().setTermFollowsTheme(true)
    })
    act(() => {
      useAppStore.getState().openTask('t-a')
    })
    await waitFor(() => expect(terminalCache.get('t-a')).toBeDefined())
    expect(terminalCache.get('t-a')!.options.theme?.background).toBe('#ffffff')
    expect(terminalCache.get('t-a')!.options.theme?.cursor).toBe('#33363d')
  })
})

describe('A1：Escape 统一修复（document 级——焦点不在弹窗内也关闭）', () => {
  it('About：Escape 关闭（焦点留在弹窗外的触发按钮场景）', async () => {
    await renderApp()
    await openAbout()
    expect(screen.getByRole('dialog', { name: '关于' })).toBeDefined()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '关于' })).toBeNull())
  })

  it('Skills：Escape 关闭', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    expect(await screen.findByRole('dialog', { name: 'Skills 管理' })).toBeDefined()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Skills 管理' })).toBeNull())
  })

  it('删除确认：Escape 关闭且 removeTask 不被调用；遮罩空白 mousedown 也关闭', async () => {
    const api = await renderApp()
    const row = document.querySelector('li[data-task-id="t-a"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '任务操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(screen.getByRole('dialog', { name: '确认删除任务' })).toBeDefined()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认删除任务' })).toBeNull())
    expect(api.removeTask).not.toHaveBeenCalled()

    // 遮罩空白点击（A1 补齐：对齐 About/Skills/新建任务基线）
    fireEvent.click(within(row).getByRole('button', { name: '任务操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const overlay = screen.getByRole('dialog', { name: '确认删除任务' }).parentElement as HTMLElement
    fireEvent.mouseDown(overlay)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认删除任务' })).toBeNull())
    expect(api.removeTask).not.toHaveBeenCalled()
  })
})

describe('A3：行操作可达（row-more focus-within 显现 + 命中区）', () => {
  it('CSS 契约：.row-more 显现规则含 :focus-within（hover 之外键盘可达）', async () => {
    await renderApp()
    // jsdom 不加载样式表（vitest css 默认 no-op）——computed style 不可断言，
    // 以样式表原始文本锚定规则存在（回归防线：规则被删/改名即红）
    expect(cssRaw).toContain('.task-row:hover .row-more')
    expect(cssRaw).toContain('.task-row:focus-within .row-more')
    expect(cssRaw).toContain('.project-node-main:focus-within .row-more')
    // 命中区：透明 padding 扩到 ≥24（负边距抵消布局影响）
    expect(cssRaw).toMatch(/\.tree-caret\s*{[^}]*min-width:\s*24px/)
    expect(cssRaw).toMatch(/\.row-more\s*{[^}]*min-width:\s*24px/)
  })

  it('焦点入行使行匹配 :focus-within（键盘 Tab 进 task-main 即满足显现条件）', async () => {
    await renderApp()
    const row = document.querySelector('li[data-task-id="t-a"]') as HTMLElement
    expect(row.matches(':focus-within')).toBe(false)
    ;(row.querySelector('.task-main') as HTMLElement).focus()
    expect(row.matches(':focus-within')).toBe(true)
    // ⋯ 按钮在 DOM 中且可聚焦（原生 button）——focus-within 下经 CSS 显现
    const more = row.querySelector('.row-more') as HTMLButtonElement
    expect(more).not.toBeNull()
    expect(more.tagName).toBe('BUTTON')
  })
})

describe('A4：TabBar 键盘（roving tabindex + 方向键切换）', () => {
  it('active tab tabIndex=0 其余 -1；ArrowLeft/Right 切换相邻（含 wrap）+ 焦点随动', async () => {
    await renderApp()
    act(() => {
      useAppStore.getState().openTask('t-a')
    })
    act(() => {
      useAppStore.getState().openTask('t-b') // 后开为 active
    })
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].tabIndex).toBe(-1)
    expect(tabs[1].tabIndex).toBe(0)

    fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' })
    await waitFor(() => expect(useAppStore.getState().activeTaskId).toBe('t-a'))
    // roving：tabIndex 翻转 + 焦点移到新 active tab
    await waitFor(() => expect(document.activeElement?.getAttribute('data-task-id')).toBe('t-a'))
    const after = screen.getAllByRole('tab')
    expect(after[0].tabIndex).toBe(0)
    expect(after[1].tabIndex).toBe(-1)

    // wrap：首个 tab 上按左 → 回到最后一个
    fireEvent.keyDown(after[0], { key: 'ArrowLeft' })
    await waitFor(() => expect(useAppStore.getState().activeTaskId).toBe('t-b'))
    // 右移 wrap：最后按右 → 回到首个
    fireEvent.keyDown(screen.getAllByRole('tab')[1], { key: 'ArrowRight' })
    await waitFor(() => expect(useAppStore.getState().activeTaskId).toBe('t-a'))
  })
})
