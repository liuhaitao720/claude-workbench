import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

/**
 * v0.5⑥ 托盘/关窗最小化单测：vi.mock electron（Tray/Menu/dialog/app/nativeImage
 * 记录型桩）+ 假窗口，断言 close→hide、isQuitting 流转、退出确认路径、tooltip 刷新。
 */

const h = vi.hoisted(() => {
  return {
    trayInstances: [] as Array<{
      setToolTipCalls: string[]
      contextMenu: unknown
      clickCbs: Array<(...a: unknown[]) => void>
      doubleClickCbs: Array<(...a: unknown[]) => void>
      destroyed: boolean
    }>,
    menuTemplates: [] as Array<Array<Record<string, unknown>>>,
    quitCalls: 0,
    dialogResponse: 0,
    dialogCalls: [] as Array<{ message: string; detail: string }>
  }
})

vi.mock('electron', () => ({
  app: { quit: () => void (h.quitCalls += 1) },
  dialog: {
    showMessageBox: vi.fn(async (_win: unknown, opts: { message: string; detail: string }) => {
      h.dialogCalls.push({ message: opts.message, detail: opts.detail })
      return { response: h.dialogResponse }
    })
  },
  Menu: {
    buildFromTemplate: (template: Array<Record<string, unknown>>) => {
      h.menuTemplates.push(template)
      return { template }
    }
  },
  nativeImage: { createFromDataURL: vi.fn(() => ({ width: 32, height: 32 })) },
  Tray: class {
    readonly setToolTipCalls: string[] = []
    contextMenu: unknown = null
    readonly clickCbs: Array<(...a: unknown[]) => void> = []
    readonly doubleClickCbs: Array<(...a: unknown[]) => void> = []
    destroyed = false
    constructor(_image: unknown) {
      h.trayInstances.push(this)
    }
    setContextMenu(menu: unknown): void {
      this.contextMenu = menu
    }
    setToolTip(text: string): void {
      this.setToolTipCalls.push(text)
    }
    on(event: string, cb: (...a: unknown[]) => void): this {
      if (event === 'click') this.clickCbs.push(cb)
      if (event === 'double-click') this.doubleClickCbs.push(cb)
      return this
    }
    destroy(): void {
      this.destroyed = true
    }
  }
}))

import { attachCloseToTray, setupTray, trayTooltip } from '../tray'

/** 假窗口（记录 on/close/hide/show，可手动派发事件） */
function fakeWindow(): {
  win: BrowserWindow
  events: Map<string, Array<(e: { preventDefault: () => void }) => void>>
  hidden: () => number
  shown: () => number
} {
  const events = new Map<string, Array<(e: { preventDefault: () => void }) => void>>()
  let hidden = 0
  let shown = 0
  const win = {
    on: (event: string, cb: (e: { preventDefault: () => void }) => void) => {
      const list = events.get(event) ?? []
      list.push(cb)
      events.set(event, list)
    },
    hide: () => void (hidden += 1),
    show: () => void (shown += 1),
    focus: () => {},
    isMinimized: () => false,
    restore: () => {}
  } as unknown as BrowserWindow
  return { win, events, hidden: () => hidden, shown: () => shown }
}

function fireClose(events: Map<string, Array<(e: { preventDefault: () => void }) => void>>): {
  prevented: boolean
} {
  let prevented = false
  ;(events.get('close') ?? []).forEach((cb) => cb({ preventDefault: () => void (prevented = true) }))
  return { prevented }
}

/** 从托盘右键菜单模板中取菜单项 click */
function menuItem(label: string): Record<string, unknown> {
  const template = h.menuTemplates.at(-1) ?? []
  const item = template.find((i) => i['label'] === label)
  if (!item) throw new Error(`menu item not found: ${label}（模板：${JSON.stringify(template.map((i) => i['label']))}）`)
  return item
}

describe('attachCloseToTray（close→hide；isQuitting 放行真关闭）', () => {
  it('普通关闭：preventDefault + win.hide（窗口不销毁，任务 PTY 后台续跑）', () => {
    const { win, events, hidden } = fakeWindow()
    attachCloseToTray(win, () => false)
    const r = fireClose(events)
    expect(r.prevented).toBe(true)
    expect(hidden()).toBe(1)
  })

  it('isQuitting=true：不拦截不隐藏（真退出路径放行）', async () => {
    const { win, events, hidden } = fakeWindow()
    attachCloseToTray(win, () => true)
    const r = fireClose(events)
    expect(r.prevented).toBe(false)
    expect(hidden()).toBe(0)
  })
})

describe('setupTray（菜单/还原/退出确认/tooltip）', () => {
  it('托盘创建：图标链 + 右键菜单（显示/退出）+ 左键/双击还原 + 初始 tooltip', async () => {
    const { win, shown } = fakeWindow()
    const handle = await setupTray({ win, runningCount: () => 2 })
    const tray = h.trayInstances.at(-1)
    expect(tray).toBeDefined()
    expect(tray?.contextMenu).toBeDefined()
    expect(h.menuTemplates.at(-1)?.map((i) => i['label'])).toEqual([
      '显示 Claude Workbench',
      undefined, // separator 无 label
      '退出（结束所有任务）'
    ])
    expect(tray?.setToolTipCalls).toEqual([trayTooltip(2)])

    tray?.clickCbs[0]?.()
    tray?.doubleClickCbs[0]?.()
    expect(shown()).toBe(2)

    handle.setRunningCount(5)
    expect(tray?.setToolTipCalls.at(-1)).toBe(trayTooltip(5))

    handle.destroy()
    expect(tray?.destroyed).toBe(true)
  })

  it('tooltip 文案：Claude Workbench（N 个任务运行中）', () => {
    expect(trayTooltip(0)).toBe('Claude Workbench（0 个任务运行中）')
    expect(trayTooltip(3)).toBe('Claude Workbench（3 个任务运行中）')
  })

  it('退出：无运行任务 → 直接 app.quit（无确认框）', async () => {
    const { win } = fakeWindow()
    await setupTray({ win, runningCount: () => 0 })
    const before = h.quitCalls
    const click = menuItem('退出（结束所有任务）')['click'] as () => void
    click()
    expect(h.quitCalls).toBe(before + 1)
    expect(h.dialogCalls.length).toBe(0)
  })

  it('退出：有运行任务 → 先 confirm；取消则不退出、确认则 app.quit', async () => {
    const { win } = fakeWindow()
    await setupTray({ win, runningCount: () => 2 })
    const click = menuItem('退出（结束所有任务）')['click'] as () => void
    const before = h.quitCalls
    const dialogBefore = h.dialogCalls.length

    h.dialogResponse = 1 // 取消
    click()
    await vi.waitFor(() => expect(h.dialogCalls.length).toBe(dialogBefore + 1))
    expect(h.dialogCalls.at(-1)?.message).toContain('2 个任务在运行')
    // response=1 取消 → 不 quit（等一拍微任务确保 dialog promise 已决）
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.quitCalls).toBe(before)

    h.dialogResponse = 0 // 确认退出
    click()
    await vi.waitFor(() => expect(h.quitCalls).toBe(before + 1))
  })

  it('「显示」菜单项 → 还原窗口', async () => {
    const { win, shown } = fakeWindow()
    await setupTray({ win, runningCount: () => 0 })
    const click = menuItem('显示 Claude Workbench')['click'] as () => void
    click()
    expect(shown()).toBe(1)
  })

  // ── v1.2.0 双语托盘 ─────────────────────────────────────────
  it('language=en：菜单/tooltip 英文；setLanguage 切换后重建菜单与提示', async () => {
    const { win } = fakeWindow()
    const handle = await setupTray({ win, runningCount: () => 3, language: () => 'en' })
    const tray = h.trayInstances.at(-1)
    expect(h.menuTemplates.at(-1)?.map((i) => i['label'])).toEqual([
      'Show Claude Workbench',
      undefined,
      'Quit (ends all tasks)'
    ])
    expect(tray?.setToolTipCalls.at(-1)).toBe('Claude Workbench (3 task(s) running)')

    handle.setRunningCount(4)
    expect(tray?.setToolTipCalls.at(-1)).toBe('Claude Workbench (4 task(s) running)')

    // 切回中文 → 菜单与 tooltip 同源重建（tooltip 保留当前计数）
    handle.setLanguage('zh')
    expect(h.menuTemplates.at(-1)?.map((i) => i['label'])).toEqual([
      '显示 Claude Workbench',
      undefined,
      '退出（结束所有任务）'
    ])
    expect(tray?.setToolTipCalls.at(-1)).toBe('Claude Workbench（4 个任务运行中）')

    // 同语言重复设置是 no-op（不重建菜单）
    const menus = h.menuTemplates.length
    handle.setLanguage('zh')
    expect(h.menuTemplates).toHaveLength(menus)
  })

  it('language=en：退出确认框按钮/正文英文，计数仍来自 runningCount', async () => {
    const { win } = fakeWindow()
    await setupTray({ win, runningCount: () => 2, language: () => 'en' })
    const click = menuItem('Quit (ends all tasks)')['click'] as () => void
    const dialogBefore = h.dialogCalls.length
    h.dialogResponse = 1
    click()
    await vi.waitFor(() => expect(h.dialogCalls.length).toBe(dialogBefore + 1))
    expect(h.dialogCalls.at(-1)?.message).toBe('2 task(s) still running')
    expect(h.dialogCalls.at(-1)?.detail).toContain('Quit anyway?')
  })
})
