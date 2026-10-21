/**
 * 终端字体族（v0.9④）：白名单四选（对齐 claude CLI 真实终端观感的既有回退链），
 * localStorage（键 cwb-font-family）持久化。纯函数独立成模块便于单测（仿
 * font-size.ts 先例）；应用入口（遍历 terminalCache set options.fontFamily +
 * 活动 fit/ptyResize + 隐藏实例 dirty 补偿）见 TerminalPanel.changeFontFamily。
 * 白名单外一律回 'Cascadia Mono'（默认——Windows Terminal 默认字体，观感基准）。
 */

/** 白名单（设计定稿 spec-v09-settings.md 第 4 项）：UI select 与存储校验共用 */
export const FONT_FAMILY_WHITELIST = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Courier New'
] as const

export type FontFamily = (typeof FONT_FAMILY_WHITELIST)[number]

export const FONT_FAMILY_DEFAULT: FontFamily = 'Cascadia Mono'

/** localStorage 持久化键（v0.9 契约） */
const STORAGE_KEY = 'cwb-font-family'

/** 白名单成员判定（select 值/存储值统一走此校验） */
export function isFontFamily(v: string): v is FontFamily {
  return (FONT_FAMILY_WHITELIST as readonly string[]).includes(v)
}

/** 读取持久化字体族；缺失/白名单外 → 默认值（localStorage 不可用也回默认） */
export function loadFontFamily(): FontFamily {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return FONT_FAMILY_DEFAULT
  }
  if (raw === null || !isFontFamily(raw)) return FONT_FAMILY_DEFAULT
  return raw
}

export function persistFontFamily(family: FontFamily): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, family)
  } catch {
    // 隐私模式等不可写场景静默——字体族会话内可用即可
  }
}
