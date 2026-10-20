import { useEffect } from 'react'

/**
 * A1 Escape 统一修复：document 级 keydown 监听 Escape → onClose。
 *
 * 旧实现是 overlay div 的 React onKeyDown——合成事件只在焦点位于弹窗子树内才
 * 触发；焦点留在触发按钮（侧栏/版本按钮）上时 Escape 完全失效。document 级
 * 监听不依赖焦点位置，覆盖鼠标点开、键盘全路径。
 *
 * 多弹窗同时打开的边角（本项目 UI 语义上互斥）下会一起关——与逐弹窗独立
 * 监听的行为一致，可接受。行内重命名等非弹窗 Escape 处理不受影响（弹窗
 * 未挂载时本 hook 不在监听）。
 */
export function useEscapeClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
}
