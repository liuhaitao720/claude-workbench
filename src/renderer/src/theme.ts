import type { ITheme } from '@xterm/xterm'

/**
 * 主题（v0.5.3 三态切换 + FOUC 防护）：
 * - 三态偏好：'system' | 'dark' | 'light'，localStorage 键 'cwb-theme' 持久化，
 *   缺失/坏值回 'dark'（骨架先例：暗色为既有视觉行为，system 为可选项）
 * - 生效解析：resolveTheme 经 matchMedia('(prefers-color-scheme: dark)') 解析
 *   system；matchMedia 不可用（异常）回 dark
 * - DOM：document.documentElement.dataset.theme（CSS [data-theme='light'] 覆盖）；
 *   首帧前的 FOUC 防护由 index.html 内联脚本完成（同语义的 vanilla 副本）
 * - 终端与 UI 主题解耦（评审④-1）：claude TUI 的 ANSI 彩色在浅底上对比不足，
 *   浅色 UI 下终端默认仍深色；About 内「终端跟随界面主题」开关（默认关，
 *   键 'cwb-term-theme-follow'）开启后终端用界面同色
 * - load/persist 对齐 font-size.ts 先例：try/catch，localStorage 不可用静默回默认
 */

export type Theme = 'system' | 'dark' | 'light'
export type EffectiveTheme = 'dark' | 'light'

const THEME_KEY = 'cwb-theme'
const TERM_FOLLOW_KEY = 'cwb-term-theme-follow'

export function loadTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_KEY)
    return raw === 'system' || raw === 'dark' || raw === 'light' ? raw : 'dark'
  } catch {
    return 'dark'
  }
}

export function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 隐私模式等不可写场景静默——主题会话内可用即可
  }
}

export function loadTermFollowsTheme(): boolean {
  try {
    return window.localStorage.getItem(TERM_FOLLOW_KEY) === '1'
  } catch {
    return false
  }
}

export function persistTermFollowsTheme(on: boolean): void {
  try {
    window.localStorage.setItem(TERM_FOLLOW_KEY, on ? '1' : '0')
  } catch {
    // 同上：不可写静默
  }
}

/** 解析生效主题：显式 dark/light 原样；system 经 matchMedia 判定（异常回 dark） */
export function resolveTheme(pref: Theme): EffectiveTheme {
  if (pref === 'dark' || pref === 'light') return pref
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

/** 订阅系统主题切换（theme='system' 时 store 据此重算 effectiveTheme）；返回退订 */
export function onSystemThemeChange(cb: () => void): () => void {
  let mq: MediaQueryList | null = null
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)')
  } catch {
    return () => {}
  }
  const onChange = () => cb()
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export function applyDomTheme(effective: EffectiveTheme): void {
  document.documentElement.dataset.theme = effective
}

/** xterm 主题配色：dark 保持既有观感（含 cursor）；light 白底深字 */
const TERMINAL_DARK: ITheme = {
  background: '#14151a',
  foreground: '#d7d7db',
  cursor: '#d7d7db'
}

const TERMINAL_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#33363d',
  cursor: '#33363d'
}

/** 返回副本防共享对象被 xterm 内部改写串色 */
export function terminalThemeFor(effective: EffectiveTheme): ITheme {
  return { ...(effective === 'light' ? TERMINAL_LIGHT : TERMINAL_DARK) }
}
