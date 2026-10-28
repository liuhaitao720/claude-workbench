import { app, dialog, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { translate, type Language } from '../shared/i18n'
import { mainLanguage } from './language'

/**
 * v0.5⑥ 防误关闭：关窗默认最小化到托盘（close preventDefault + hide，任务 PTY
 * 后台续跑）；托盘右键菜单（显示/退出——运行中任务先 confirm）；托盘左键/双击
 * 还原；tooltip 实时显示运行任务数（组合根经 onTaskUpdate 旁路刷新——同 onPtyData
 * 先例）；before-quit dispose。
 *
 * v1.2.0 双语：文案取 language（组合根传 AppSettings.language，随设置变更刷新菜单）。
 */

/**
 * 32x32 占位图标（base64 内嵌，深底+中央亮块的最小可辨识图样）——正式图标后续替换。
 * 走 data URL 形式避免引入资源文件与打包配置改动。
 */
const PLACEHOLDER_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR4nO3OMQ0AIAwAsOlCAgbQPjXDBGGQ9OjfmCOrUwgIPBvIVUcJCAgICAgICAj8F7hFQKA9sAFuo7i3xTxl/gAAAABJRU5ErkJggg=='

export function trayTooltip(running: number, language: Language = 'zh'): string {
  return translate(language, 'tray.tooltip', { count: running })
}

/**
 * 关窗→托盘：拦截 close（preventDefault + hide）。isQuitting 为真（托盘退出/
 * app.quit 路径）时不拦截，放行真关闭。对所有窗口生效（activate 重建的窗口同样接上）。
 */
export function attachCloseToTray(
  win: BrowserWindow,
  isQuitting: () => boolean,
  shouldTray: () => boolean = () => true
): void {
  win.on('close', (event) => {
    if (isQuitting()) return
    if (!shouldTray()) return // v0.9⑧：设置=直接退出 → 放行真关闭
    event.preventDefault()
    win.hide()
  })
}

export interface TrayHandle {
  /** 运行任务数变化 → 刷新 tooltip */
  setRunningCount(n: number): void
  /** v1.2.0：界面语言变更 → 重建菜单与 tooltip */
  setLanguage(language: Language): void
  destroy(): void
}

export interface TrayOptions {
  win: BrowserWindow
  /** 当前运行任务数（退出确认与 tooltip 的真值源；组合根传 tasks 快照统计） */
  runningCount: () => number
  /** 当前界面语言（缺省读 main 进程级 mainLanguage()） */
  language?: () => Language
}

/** 创建托盘（图标+右键菜单+左键/双击还原）；返回 tooltip 刷新与销毁句柄 */
/** v0.5.1：托盘与文件管理器图标一致——优先打包资源 icon.png，回退 exe 图标，末位占位 */
async function resolveTrayIcon(): Promise<Electron.NativeImage> {
  const resIcon = join(process.resourcesPath ?? '', 'icon.png')
  if (process.resourcesPath && existsSync(resIcon)) {
    const img = nativeImage.createFromPath(resIcon)
    if (!img.isEmpty()) return img
  }
  // dev 环境 getFileIcon(electron.exe) 实测挂起（v0.5.2 smoke 卡死根因）——仅打包态调用，且 3s 超时兜底
  if (app.isPackaged) {
    try {
      const exeIcon = await Promise.race([
        app.getFileIcon(process.execPath, { size: 'small' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))
      ])
      if (exeIcon && !exeIcon.isEmpty()) return exeIcon
    } catch {
      // 回退占位
    }
  }
  return nativeImage.createFromDataURL(PLACEHOLDER_ICON_DATA_URL)
}

export async function setupTray(opts: TrayOptions): Promise<TrayHandle> {
  const tray = new Tray(await resolveTrayIcon())
  let language: Language = opts.language?.() ?? mainLanguage()
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
    translate(language, key, params)
  const show = (): void => {
    const win = opts.win
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  /** 退出流程：有运行任务先 confirm（误点保护）；取消则不退出 */
  const requestQuit = async (): Promise<void> => {
    const running = opts.runningCount()
    if (running > 0) {
      const choice = await dialog.showMessageBox(opts.win, {
        type: 'warning',
        buttons: [t('quit.confirm'), t('quit.cancel')],
        defaultId: 1,
        cancelId: 1,
        message: t('quit.message', { count: running }),
        detail: t('quit.detail')
      })
      if (choice.response !== 0) return
    }
    app.quit()
  }
  /** 菜单与 tooltip 同源重建（语言切换时整体刷新，避免半中半英） */
  let running = opts.runningCount()
  const rebuild = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('tray.show'), click: () => show() },
        { type: 'separator' },
        { label: t('tray.quit'), click: () => void requestQuit() }
      ])
    )
    tray.setToolTip(trayTooltip(running, language))
  }
  rebuild()
  tray.on('click', show)
  tray.on('double-click', show)
  return {
    setRunningCount(n: number): void {
      running = n
      tray.setToolTip(trayTooltip(n, language))
    },
    setLanguage(next: Language): void {
      if (next === language) return
      language = next
      rebuild()
    },
    destroy(): void {
      tray.destroy()
    }
  }
}
