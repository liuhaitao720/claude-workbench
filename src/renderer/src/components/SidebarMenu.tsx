import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItemDef {
  label: string
  onClick: () => void
  danger?: boolean
}

/**
 * 轻量溢出菜单（S6-B）：项目/任务行 hover 出「⋯」触发。
 * - createPortal 挂 body + position:fixed 定位到触发按钮下方——逃出
 *   .project-list 的 overflow-y:auto 裁剪（评审 F8）
 * - 点击外部（含触发按钮自身——开合由按钮 click 语义接管）或 Escape 关闭
 * - 同树互斥由父级 MenuOpenCtx 控制（见 ProjectTree），本组件只管自关
 * - role=menu / menuitem 供测试与读屏锚定
 */
export function SidebarMenu({
  triggerRef,
  items,
  onClose,
  anchor
}: {
  triggerRef: RefObject<HTMLButtonElement | null>
  items: MenuItemDef[]
  onClose: () => void
  /** v1.0.4：可选光标锚点（终端右键菜单）——提供时按此坐标定位，忽略 trigger 矩形 */
  anchor?: { x: number; y: number }
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // 打开时按触发按钮位置算一次浮层坐标（jsdom 下 rect 全 0，退到安全原点）。
  // 评审 F3：下缘溢出翻到按钮上方；scroll/resize 期间浮层与按钮脱锚——直接关闭（重算成本高且场景少）
  useEffect(() => {
    const MENU_WIDTH = 176
    const EST_ITEM_H = 30
    const estHeight = Math.max(1, items.length) * EST_ITEM_H + 8
    if (anchor) {
      let top = anchor.y + 2
      if (top + estHeight > window.innerHeight - 8) top = Math.max(8, anchor.y - estHeight - 2)
      setPos({ top, left: Math.min(Math.max(4, anchor.x), window.innerWidth - MENU_WIDTH - 4) })
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      let top = rect.bottom + 2
      if (top + estHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - estHeight - 2) // 放不下 → 翻上方
      }
      setPos({ top, left: Math.max(4, rect.right - MENU_WIDTH) })
    } else {
      setPos({ top: 4, left: 4 })
    }
  }, [triggerRef, items.length, anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target
      if (menuRef.current?.contains(t as Node)) return
      if (triggerRef.current?.contains(t as Node)) return // 触发按钮交给其 click 开合
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // capture=true：捕获 .project-list 等滚动容器的 scroll（不冒泡）——滚动即关（评审 F3）
    const onReflow = () => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [onClose, triggerRef])

  if (!pos) return null

  return createPortal(
    <div className="ctx-menu" role="menu" ref={menuRef} style={pos}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={it.danger ? 'ctx-menu-item danger' : 'ctx-menu-item'}
          onClick={() => {
            onClose() // 先关菜单再执行动作（动作可能开重命名/对话框）
            it.onClick()
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
