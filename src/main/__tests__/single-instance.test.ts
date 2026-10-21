import { describe, expect, it, vi } from 'vitest'
import type { App, BrowserWindow } from 'electron'
import { initSingleInstance } from '../single-instance'

/**
 * v1.0.7 单实例锁单测：注入假 App/窗口（模块只 import 类型，无需 vi.mock
 * electron）——锁未拿到 → exit(0) 直退且不注册 second-instance；拿到 →
 * second-instance 唤起主窗口（最小化先 restore，恒 show+focus）。
 */

type Handler = (...args: unknown[]) => void

function fakeApp(lock: boolean): {
  app: Pick<App, 'requestSingleInstanceLock' | 'exit' | 'on'>
  exitCalls: number[]
  handlers: Map<string, Handler>
} {
  const exitCalls: number[] = []
  const handlers = new Map<string, Handler>()
  const appLike = {
    requestSingleInstanceLock: () => lock,
    exit: (code: number) => void exitCalls.push(code),
    on: (name: string, cb: Handler) => {
      handlers.set(name, cb)
    }
  }
  return { app: appLike as unknown as Pick<App, 'requestSingleInstanceLock' | 'exit' | 'on'>, exitCalls, handlers }
}

function fakeWin(opts?: { minimized?: boolean; destroyed?: boolean }): BrowserWindow {
  return {
    isMinimized: () => opts?.minimized === true,
    isDestroyed: () => opts?.destroyed === true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  } as unknown as BrowserWindow
}

describe('initSingleInstance（v1.0.7 不能双开，重复启动唤起既有实例）', () => {
  it('锁未拿到（已有实例）→ app.exit(0) 直退，不注册 second-instance，返回 false', () => {
    const f = fakeApp(false)
    const got = initSingleInstance(f.app, () => null)
    expect(got).toBe(false)
    expect(f.exitCalls).toEqual([0])
    expect(f.handlers.has('second-instance')).toBe(false)
  })

  it('拿到锁 → 返回 true；second-instance 唤起窗口：最小化先 restore，恒 show+focus', () => {
    const f = fakeApp(true)
    const win = fakeWin({ minimized: true })
    const got = initSingleInstance(f.app, () => win)
    expect(got).toBe(true)
    expect(f.exitCalls).toEqual([])
    f.handlers.get('second-instance')!()
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('非最小化不调 restore；窗口为 null / 已销毁 → 静默不抛', () => {
    const f = fakeApp(true)
    const win = fakeWin()
    initSingleInstance(f.app, () => win)
    f.handlers.get('second-instance')!()
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.show).toHaveBeenCalledTimes(1)

    const f2 = fakeApp(true)
    initSingleInstance(f2.app, () => null)
    expect(() => f2.handlers.get('second-instance')!()).not.toThrow()

    const f3 = fakeApp(true)
    const dead = fakeWin({ destroyed: true })
    initSingleInstance(f3.app, () => dead)
    expect(() => f3.handlers.get('second-instance')!()).not.toThrow()
    expect(dead.show).not.toHaveBeenCalled()
  })
})
