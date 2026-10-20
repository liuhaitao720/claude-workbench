import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { App } from './App'
import { changeFontSize, terminalCache } from './components/TerminalPanel'
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize } from './font-size'
import { useAppStore } from './store'
import { installCwbMock, makeProject, makeTask } from './test-helpers'

/**
 * v0.5② 字号三件套：默认 15 / 持久化 localStorage（cwb-font-size）/
 * changeFontSize 单一入口（options 更新+ptyResize+隐藏实例 dirty 补偿）。
 * 真 refit（栅格重算）jsdom 不可测——人工验证步骤见任务书：
 * dev 起 app 多开 tab → Ctrl+= 调字号 → 切换各 tab 尺寸正常无错位。
 */

const project = makeProject({ id: 'pf', name: 'FontProj' })
const taskA = makeTask({ id: 't-fa', projectId: 'pf', name: '任务甲', status: 'running' })
const taskB = makeTask({ id: 't-fb', projectId: 'pf', name: '任务乙', status: 'running' })

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
  window.localStorage.removeItem('cwb-font-size')
})
afterEach(() => {
  cleanup()
  for (const t of terminalCache.values()) t.dispose()
  terminalCache.clear()
  window.localStorage.removeItem('cwb-font-size')
})

async function renderApp() {
  const api = installCwbMock({ projects: [project], tasks: [taskA, taskB] })
  render(<App />)
  await waitFor(() =>
    expect(document.querySelector('li[data-task-id="t-fa"]')).toBeDefined()
  )
  return api
}

function openTab(id: string): void {
  // 直连 openTask（确定性）：绕开 250ms 单击判别；running 任务本就不触发自动恢复
  act(() => {
    useAppStore.getState().openTask(id)
  })
}

describe('纯函数（font-size.ts）', () => {
  it('clamp：收敛 [10,22] 整数；非法输入回默认 15', () => {
    expect(clampFontSize(14.6)).toBe(15)
    expect(clampFontSize(9)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(100)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_DEFAULT)
    expect(FONT_SIZE_DEFAULT).toBe(15) // v0.5②：13→15 锚点
  })
})

describe('默认字号与持久化读取', () => {
  it('新终端实例默认 fontSize=15（v0.5② 13→15）', async () => {
    await renderApp()
    openTab('t-fa')
    await waitFor(() => expect(terminalCache.get('t-fa')).toBeDefined())
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(15)
  })

  it('localStorage 持久化字号被新实例采用；坏值回默认', async () => {
    window.localStorage.setItem('cwb-font-size', '18')
    await renderApp()
    openTab('t-fa')
    await waitFor(() => expect(terminalCache.get('t-fa')).toBeDefined())
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(18)

    // 越界坏值 → 回默认（重建实例验证：关 tab 再开）
    act(() => {
      useAppStore.getState().closeTab('t-fa')
    })
    await waitFor(() => expect(terminalCache.get('t-fa')).toBeUndefined())
    window.localStorage.setItem('cwb-font-size', '99')
    openTab('t-fa')
    await waitFor(() => expect(terminalCache.get('t-fa')).toBeDefined())
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(15)
  })
})

describe('changeFontSize 单一入口（Ctrl+=/-、Ctrl+滚轮共用）', () => {
  it('活动实例：options.fontSize 更新 + ptyResize + localStorage 写入', async () => {
    const api = await renderApp()
    openTab('t-fa')
    const term = await waitFor(() => {
      const t = terminalCache.get('t-fa')
      expect(t).toBeDefined()
      return t!
    })
    const next = changeFontSize(1)
    expect(next).toBe(16)
    expect(term.options.fontSize).toBe(16)
    expect(window.localStorage.getItem('cwb-font-size')).toBe('16')
    expect(api.ptyResize).toHaveBeenCalledWith('t-fa', term.cols, term.rows)
  })

  it('隐藏实例标 dirty：options 同步更新但不 ptyResize；激活时补 ptyResize', async () => {
    const api = await renderApp()
    openTab('t-fa')
    openTab('t-fb') // 激活乙 → 甲隐藏
    const termA = await waitFor(() => {
      const t = terminalCache.get('t-fa')
      expect(t).toBeDefined()
      return t!
    })
    const termB = await waitFor(() => {
      const t = terminalCache.get('t-fb')
      expect(t).toBeDefined()
      return t!
    })
    vi.mocked(api.ptyResize).mockClear()

    changeFontSize(-1)
    expect(termA.options.fontSize).toBe(14) // 隐藏实例 options 也更新
    expect(window.localStorage.getItem('cwb-font-size')).toBe('14')
    // 仅活动实例 t-fb 被 ptyResize；隐藏的 t-fa 没有
    expect(api.ptyResize).toHaveBeenCalledTimes(1)
    expect(api.ptyResize).toHaveBeenCalledWith('t-fb', termB.cols, termB.rows)

    // 激活 t-fa → dirty 补偿：fit + ptyResize
    act(() => {
      useAppStore.getState().setActive('t-fa')
    })
    await waitFor(() => expect(api.ptyResize).toHaveBeenCalledWith('t-fa', termA.cols, termA.rows))
    expect(api.ptyResize).toHaveBeenCalledTimes(2)
  })

  it('边界短路：到达边界后继续调整不再发 ptyResize', async () => {
    const api = await renderApp()
    openTab('t-fa')
    await waitFor(() => expect(terminalCache.get('t-fa')).toBeDefined())
    changeFontSize(-100) // 15 → 10（MIN）
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(10)
    vi.mocked(api.ptyResize).mockClear()
    expect(changeFontSize(-1)).toBe(10) // 已在边界 → 短路
    expect(api.ptyResize).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('cwb-font-size')).toBe('10')
  })
})

describe('交互入口', () => {
  it('Ctrl+滚轮（host wheel 捕获）：上滚放大、下滚缩小；无 Ctrl 不响应', async () => {
    await renderApp()
    openTab('t-fa')
    await waitFor(() => expect(terminalCache.get('t-fa')).toBeDefined())
    const host = document.querySelector('.term-host.term-host-active') as HTMLElement
    fireEvent.wheel(host, { ctrlKey: true, deltaY: -100 })
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(16)
    fireEvent.wheel(host, { ctrlKey: true, deltaY: 100 })
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(15)
    fireEvent.wheel(host, { deltaY: -100 })
    expect(terminalCache.get('t-fa')!.options.fontSize).toBe(15) // 非 Ctrl 放行
  })

  it('Ctrl+= / Ctrl+-（attachCustomKeyEventHandler）：keydown 到 xterm textarea 生效', async () => {
    await renderApp()
    openTab('t-fa')
    const term = await waitFor(() => {
      const t = terminalCache.get('t-fa')
      expect(t).toBeDefined()
      return t!
    })
    const textarea = term.textarea
    expect(textarea).toBeDefined() // xterm 键入焦点的隐藏 textarea
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: '=', ctrlKey: true })
    expect(term.options.fontSize).toBe(16)
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: '-', ctrlKey: true })
    expect(term.options.fontSize).toBe(15)
    // 无 Ctrl 的 = 原样放行（不调字号）
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: '=' })
    expect(term.options.fontSize).toBe(15)
  })
})
