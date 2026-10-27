import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import { App } from './App'
import { terminalCache } from './components/TerminalPanel'
import { emitTaskData, useAppStore } from './store'
import { installCwbMock, makeProject, makeTask } from './test-helpers'

const project = makeProject({ id: 'pt', name: 'TermProj' })
const task = makeTask({ id: 't-term', projectId: 'pt', name: '终端任务', status: 'running' })

function line0(term: Terminal): string {
  return term.buffer.active.getLine(0)?.translateToString(true) ?? ''
}

/** 单击任务行主区开终端 tab（S6-B：任务名同时出现在树行/最近区块，用 id 定位行后点 .task-main） */
function openTaskTab(taskId: string): void {
  const row = document.querySelector(`li[data-task-id="${taskId}"]`) as HTMLElement
  fireEvent.click(row.querySelector('.task-main') as HTMLElement)
}

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null
  })
})
afterEach(() => {
  cleanup()
  for (const t of terminalCache.values()) t.dispose()
  terminalCache.clear()
})

describe('TerminalPanel（xterm 实例管理）', () => {
  it('每任务创建 xterm 实例：unicode.activeVersion==="11"，term.write 后 buffer 可读回', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    openTaskTab('t-term')
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')
    expect(term).toBeDefined()
    // CJK/emoji 宽度修正验收锚点
    expect(term!.unicode.activeVersion).toBe('11')
    await new Promise<void>((resolve) => term!.write('hello 中文', () => resolve()))
    expect(line0(term!)).toContain('hello 中文')
  })

  it('PTY 数据分发链路：emitTaskData → subscribeTaskData → term.write', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    openTaskTab('t-term')
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    await act(async () => {
      emitTaskData({ taskId: 't-term', data: 'PONG' })
    })
    await waitFor(() => expect(line0(term)).toContain('PONG'))
  })

  it('App 接线：onPtyData 回调 → emitTaskData 分发器 → 终端 buffer', async () => {
    const api = installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    openTaskTab('t-term')
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    act(() => {
      for (const cb of api.ptyCallbacks) cb({ taskId: 't-term', data: 'WIRE' })
    })
    await waitFor(() => expect(line0(term)).toContain('WIRE'))
  })

  it('tab 切换不销毁实例：隐藏保留 buffer，回切实例不变', async () => {
    const task2 = makeTask({ id: 't-two', projectId: 'pt', name: '任务二', status: 'running' })
    installCwbMock({ projects: [project], tasks: [task, task2] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    openTaskTab('t-term')
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term1 = terminalCache.get('t-term')!
    await new Promise<void>((resolve) => term1.write('AAA', () => resolve()))
    // 打开第二个任务 → term1 隐藏（display:none）但实例仍在缓存、buffer 保留
    openTaskTab('t-two')
    await waitFor(() => expect(terminalCache.get('t-two')).toBeDefined())
    expect(terminalCache.get('t-term')).toBe(term1)
    expect(line0(term1)).toContain('AAA')
    // 回切第一个 tab
    fireEvent.click(screen.getByRole('tab', { name: /终端任务/ }))
    expect(useAppStore.getState().activeTaskId).toBe('t-term')
    expect(terminalCache.get('t-term')).toBe(term1)
  })

  it('close tab → dispose Terminal + 清缓存 + 退订；unmount 后 emit 数据无副作用', async () => {
    const api = installCwbMock({ projects: [project], tasks: [task] })
    const { unmount } = render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    openTaskTab('t-term')
    await waitFor(() => expect(terminalCache.size).toBe(1))
    expect(api.ptyCallbacks.length).toBe(1) // App 层已接分发器
    // × 关 tab：仅关视图，任务行保留、stopTask 不调
    fireEvent.click(screen.getByRole('button', { name: '×' }))
    await waitFor(() => expect(terminalCache.size).toBe(0))
    expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    expect(api.stopTask).not.toHaveBeenCalled()
    // App 卸载：退订全局事件；此后 emit 无订阅者、无实例，无副作用
    unmount()
    expect(api.ptyDisposer).toHaveBeenCalled()
    expect(() => emitTaskData({ taskId: 't-term', data: 'X' })).not.toThrow()
    expect(terminalCache.size).toBe(0)
  })

  it('任务恢复（v0.1.2 光标错位修复）：stopped→running 时 term.reset 清缓冲 + ptyResize 强制重同步', async () => {
    const api = installCwbMock({
      projects: [project],
      tasks: [{ ...task, status: 'stopped' }]
    })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    // v0.4.1：经 UI 打开 stopped 任务会触发自动 resume（tasks.test 已覆盖）——本测试
    // 专测过渡行为（reset+ptyResize），改直连 openTask 绕开自动恢复以保时序可控
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    const resetSpy = vi.spyOn(term, 'reset')
    await new Promise<void>((resolve) => term.write('旧会话残留', () => resolve()))
    expect(line0(term)).toContain('旧会话残留')

    // 模拟 resumeTask 成功后 onTaskUpdate 推送 running
    await act(async () => {
      for (const cb of api.taskUpdateCallbacks) cb({ ...task, status: 'running' })
    })
    await waitFor(() => expect(resetSpy).toHaveBeenCalledTimes(1))
    expect(line0(term)).not.toContain('旧会话残留') // 旧缓冲已清，claude 重绘干净帧
    expect(api.ptyResize).toHaveBeenCalledWith('t-term', term.cols, term.rows) // 无条件重同步（绕过去重）
  })
})

describe('v0.4.3 焦点管理（选完对话框选项后可正常输入）', () => {
  it('打开 tab 即聚焦终端（active 挂载→50ms 后 term.focus）', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    const focusSpy = vi.spyOn(term, 'focus')
    await new Promise((r) => setTimeout(r, 150))
    expect(focusSpy).toHaveBeenCalled()
  })

  it('切换 tab 聚焦新激活的终端；对话框关闭后焦点还给活跃终端', async () => {
    const task2 = makeTask({ id: 't-two', projectId: 'pt', name: '任务二', status: 'running' })
    installCwbMock({ projects: [project], tasks: [task, task2] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-two"]')).toBeDefined()
    )
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    act(() => {
      useAppStore.getState().openTask('t-two') // 切换激活 → t-two 挂载并聚焦
    })
    await waitFor(() => expect(terminalCache.get('t-two')).toBeDefined())
    await new Promise((r) => setTimeout(r, 150)) // 首次激活聚焦已发生——spy 需先挂再触发
    const term2Focus = vi.spyOn(terminalCache.get('t-two')!, 'focus')
    act(() => {
      useAppStore.getState().setActive('t-term')
    })
    await new Promise((r) => setTimeout(r, 120))
    act(() => {
      useAppStore.getState().setActive('t-two') // 重新激活 → 必再聚焦
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(term2Focus).toHaveBeenCalled()

    // 对话框关闭 → 活跃终端重新聚焦
    const activeFocus = vi.spyOn(terminalCache.get('t-two')!, 'focus')
    fireEvent.click(within(document.querySelector('li[data-project-id]') as HTMLElement).getByRole('button', { name: '项目操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建任务' }))
    expect(screen.getByRole('dialog', { name: '新建任务' })).toBeDefined()
    fireEvent.click(within(screen.getByRole('dialog', { name: '新建任务' })).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(activeFocus).toHaveBeenCalled()
  })
})

describe('v1.0.8 Shift+Enter 换行 / IME 组合缓冲 / 面板搜索', () => {
  async function openTermWithApi(): Promise<ReturnType<typeof installCwbMock>> {
    const api = installCwbMock({ projects: [project], tasks: [task] })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    return api
  }

  it('Shift+Enter → ptyWrite("\\x1b\\r")（claude /terminal-setup 同款序列）；组合中放行', async () => {
    const api = await openTermWithApi()
    const term = terminalCache.get('t-term')!
    const ta = term.element?.querySelector('textarea') as HTMLTextAreaElement
    ta.focus()
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    await waitFor(() => expect(api.ptyWrite).toHaveBeenCalledWith('t-term', '\x1b\r'))

    // IME 组合中的 Shift+Enter 是选字确认——不得翻译成换行序列
    const before = vi.mocked(api.ptyWrite).mock.calls.length
    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          isComposing: true
        })
      )
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(vi.mocked(api.ptyWrite).mock.calls.length).toBe(before)
  })

  it('IME 组合缓冲：compositionstart 后 PTY 输出挂起，compositionend 一次 flush', async () => {
    await openTermWithApi()
    const term = terminalCache.get('t-term')!
    const ta = term.element?.querySelector('textarea') as HTMLTextAreaElement

    act(() => {
      ta.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      emitTaskData({ taskId: 't-term', data: 'HOLD' })
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(line0(term)).not.toContain('HOLD') // 组合期不渲染——composition 锚点稳定

    act(() => {
      ta.dispatchEvent(new Event('compositionend', { bubbles: true }))
    })
    await waitFor(() => expect(line0(term)).toContain('HOLD')) // 结束后一次 flush，无丢失
  })

  it('Ctrl+Shift+F 打开面板搜索浮层，Esc 关闭', async () => {
    await openTermWithApi()
    const term = terminalCache.get('t-term')!
    await new Promise<void>((resolve) => term.write('searchable-text', () => resolve()))
    const ta = term.element?.querySelector('textarea') as HTMLTextAreaElement
    ta.focus()
    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true })
      )
    })
    const input = await screen.findByRole('textbox', { name: '终端搜索' })
    expect(useAppStore.getState().searchOpen).toBe(true)
    // 增量搜索：输入即高亮跳转（findNext incremental）
    fireEvent.change(input, { target: { value: 'searchable' } })
    await new Promise((r) => setTimeout(r, 50))
    expect(term.hasSelection()).toBe(true)
    // Esc 关闭并清装饰
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(useAppStore.getState().searchOpen).toBe(false))
    expect(screen.queryByRole('textbox', { name: '终端搜索' })).toBeNull()
  })
})

describe('v1.0.2 粘贴/复制（菜单移除后原生加速键不可靠——显式剪贴板路径）', () => {
  it('粘贴键（Ctrl+V/Ctrl+Shift+V/Shift+Insert）读剪贴板写 PTY', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    const readText = vi.fn(async () => 'pasted-text')
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { readText, writeText } })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    const host = document.querySelector('.term-host-active') as HTMLElement
    // xterm customKeyEventHandler 经 keydown 事件触发（attachCustomKeyEventHandler 注册在隐藏 textarea）
    const ta = term.element?.querySelector('textarea') as HTMLTextAreaElement
    expect(ta).toBeDefined()
    ta.focus()
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }))
    })
    await waitFor(() => expect(readText).toHaveBeenCalled())
    await waitFor(() => expect(window.cwb.ptyWrite).toHaveBeenCalledWith('t-term', 'pasted-text'))
    void writeText
    void host
  })

  it('Ctrl+C 无选中 → 放行（xterm 发 ^C 中断，不读剪贴板）', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    const readText = vi.fn(async () => 'x')
    Object.assign(navigator, { clipboard: { readText } })
    render(<App />)
    await waitFor(() =>
      expect(document.querySelector('li[data-task-id="t-term"]')).toBeDefined()
    )
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    const ta = term.element?.querySelector('textarea') as HTMLTextAreaElement
    ta.focus()
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(readText).not.toHaveBeenCalled() // 无选中不触发复制路径
  })
})

describe('v1.0.9 右键智能动作（Windows Terminal 默认语义：无选中=粘贴/有选中=复制；Shift+右键=完整菜单）', () => {
  function openTerm(): void {
    render(<App />)
    act(() => {
      useAppStore.getState().openTask('t-term')
    })
  }

  it('无选中右键 → 直接粘贴（readText→term.paste→ptyWrite），不弹菜单', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    const readText = vi.fn(async () => 'right-click-paste')
    Object.assign(navigator, { clipboard: { readText, writeText: vi.fn(async () => {}) } })
    openTerm()
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const host = document.querySelector('.term-host-active') as HTMLElement
    fireEvent.contextMenu(host)
    await waitFor(() => expect(readText).toHaveBeenCalled())
    await waitFor(() =>
      expect(window.cwb.ptyWrite).toHaveBeenCalledWith('t-term', 'right-click-paste')
    )
    expect(screen.queryByRole('menu')).toBeNull() // 智能动作直达，无菜单
  })

  it('有选中右键 → 直接复制+清选中+聚焦；Shift+右键才出完整菜单', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { readText: vi.fn(async () => ''), writeText } })
    openTerm()
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    await new Promise<void>((resolve) => term.write('hello-sel', () => resolve()))
    act(() => {
      term.selectAll()
    })
    const host = document.querySelector('.term-host-active') as HTMLElement
    fireEvent.contextMenu(host)
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('hello-sel'))
    )
    expect(term.hasSelection()).toBe(false) // 复制后清选中——下一次右键即粘贴
    expect(screen.queryByRole('menu')).toBeNull()
    // Shift+右键保留完整菜单（全选/清屏等低频项）
    fireEvent.contextMenu(host, { shiftKey: true })
    expect(await screen.findByRole('menu')).toBeDefined()
    expect(screen.getByRole('menuitem', { name: '粘贴' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: '全选' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: '清屏' })).toBeDefined()
  })

  it('Shift+右键菜单：「粘贴」读剪贴板写 PTY 并回焦终端（光标回位）；「清屏」调 term.clear', async () => {
    installCwbMock({ projects: [project], tasks: [task] })
    Object.assign(navigator, {
      clipboard: { readText: vi.fn(async () => 'menu-paste'), writeText: vi.fn(async () => {}) }
    })
    openTerm()
    await waitFor(() => expect(terminalCache.get('t-term')).toBeDefined())
    const term = terminalCache.get('t-term')!
    const clearSpy = vi.spyOn(term, 'clear')
    const focusSpy = vi.spyOn(term, 'focus')
    const host = document.querySelector('.term-host-active') as HTMLElement
    fireEvent.contextMenu(host, { shiftKey: true })
    fireEvent.click(await screen.findByRole('menuitem', { name: '粘贴' }))
    await waitFor(() => expect(window.cwb.ptyWrite).toHaveBeenCalledWith('t-term', 'menu-paste'))
    await waitFor(() => expect(focusSpy).toHaveBeenCalled()) // 粘贴完光标自动回位
    fireEvent.contextMenu(host, { shiftKey: true })
    fireEvent.click(await screen.findByRole('menuitem', { name: '清屏' }))
    await waitFor(() => expect(clearSpy).toHaveBeenCalled())
  })
})
