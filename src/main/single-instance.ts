import type { App, BrowserWindow } from 'electron'

/**
 * v1.0.7 单实例（用户指令：不能同时启动多个实例，重复启动直接打开既有实例）：
 * - requestSingleInstanceLock 未拿到 = 已有实例在跑 → 本实例 app.exit(0) 直退
 *   （不走 before-quit——本实例尚未创建 PTY/托盘/窗口，二段式清理无对象；
 *   app.exit 不发 before-quit/will-quit，与退出清理语义天然隔离）
 * - 拿到锁的实例注册 second-instance：唤起主窗口（托盘隐藏/最小化都恢复置前）
 * - 锁键 = userData 路径：冒烟/探针经 CWB_USER_DATA 注入独立 userData，与用户
 *   常驻实例天然互不冲突（打包实测可并行跑，不受本锁影响）
 */
export function initSingleInstance(
  appLike: Pick<App, 'requestSingleInstanceLock' | 'exit' | 'on'>,
  getWindow: () => BrowserWindow | null
): boolean {
  const got = appLike.requestSingleInstanceLock()
  if (!got) {
    appLike.exit(0)
    return false
  }
  appLike.on('second-instance', () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  return true
}
