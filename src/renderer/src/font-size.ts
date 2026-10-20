/**
 * 终端字号（v0.5②）：默认 13→15px（claude CLI 在 Windows Terminal 默认 12pt=16px，
 * 13px 偏小约 20%），运行时可调 10-22px，localStorage（键 cwb-font-size）持久化。
 * 纯函数独立成模块便于单测；应用入口（遍历 terminalCache + fit/ptyResize +
 * 隐藏实例 dirty 补偿）见 TerminalPanel.changeFontSize。
 */

export const FONT_SIZE_DEFAULT = 15
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 22

/** localStorage 持久化键（v0.5 契约） */
const STORAGE_KEY = 'cwb-font-size'

/** 收敛到 [MIN, MAX] 整数；非法输入回默认值 */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return FONT_SIZE_DEFAULT
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)))
}

/** 读取持久化字号；缺失/非整数/越界 → 默认值（localStorage 不可用也回默认） */
export function loadFontSize(): number {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return FONT_SIZE_DEFAULT
  }
  if (raw === null) return FONT_SIZE_DEFAULT
  const n = Number(raw)
  return Number.isInteger(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX ? n : FONT_SIZE_DEFAULT
}

export function persistFontSize(size: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampFontSize(size)))
  } catch {
    // 隐私模式等不可写场景静默——字号会话内可用即可
  }
}
