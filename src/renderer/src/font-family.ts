/**
 * 终端字体族（v0.9④ → v0.9.3 扩容）：免费商用等宽字体白名单，
 * localStorage（键 cwb-font-family）持久化。纯函数独立成模块便于单测（仿
 * font-size.ts 先例）；应用入口（遍历 terminalCache set options.fontFamily +
 * 活动 fit/ptyResize + 隐藏实例 dirty 补偿）见 TerminalPanel.changeFontFamily。
 * 白名单外一律回 'Cascadia Mono'（默认——Windows Terminal 默认字体，观感基准）。
 *
 * v0.9.3：扩容免费商用（OFL/Apache/MIT 许可）等宽字体。本机未安装的字体
 * 浏览器自动回退系统等宽（xterm 按实际渲染字体测量栅格，不错位）；
 * SettingsDialog 下拉经 document.fonts.check 标注「未安装」。
 * 中日韩友好项（更纱/霞鹜/思源/Noto）对 claude CLI 的中文输出对齐尤其有价值。
 */

/** 白名单：UI select 与存储校验共用（顺序=下拉展示顺序；前 4 项为本机 Windows 预装） */
export const FONT_FAMILY_WHITELIST = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Courier New',
  // —— 以下为免费商用第三方字体（未安装时回退系统等宽，下拉标注「未安装」）——
  'JetBrains Mono',
  'Fira Code',
  'Sarasa Mono SC',
  'LXGW WenKai Mono',
  'Maple Mono NF CN',
  'Source Code Pro',
  'IBM Plex Mono',
  'Iosevka Fixed',
  'Victor Mono',
  'Martian Mono',
  'Geist Mono',
  'Noto Sans Mono CJK SC',
  'Roboto Mono',
  'DejaVu Sans Mono',
  'Intel One Mono',
  'Commit Mono'
] as const

export type FontFamily = (typeof FONT_FAMILY_WHITELIST)[number]

export const FONT_FAMILY_DEFAULT: FontFamily = 'Cascadia Mono'

/** localStorage 持久化键（v0.9 契约） */
const STORAGE_KEY = 'cwb-font-family'

/** 白名单成员判定（select 值/存储值统一走此校验） */
export function isFontFamily(v: string): v is FontFamily {
  return (FONT_FAMILY_WHITELIST as readonly string[]).includes(v)
}

/**
 * 本机字体可用性探测（v0.9.3）：document.fonts.check 对本地已装字体返回 true。
 * API 不可用/异常 → null（调用方视为未知，不标注）。
 * 注：check 对含引号族名敏感——12px 基准尺寸任意，仅探测族名存在性。
 */
export function isFontInstalled(family: string): boolean | null {
  try {
    return document.fonts.check(`12px "${family}"`)
  } catch {
    return null
  }
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
