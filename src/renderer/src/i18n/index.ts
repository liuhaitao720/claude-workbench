import { create } from 'zustand'
import { useCallback } from 'react'
import { LANGUAGE_LABELS, translate, type Language, type MessageKey } from '../../../shared/i18n'

export { LANGUAGE_LABELS, translate }
export type { Language, MessageKey }

/**
 * 语言状态（v1.2.0）：localStorage 持久化（键 cwb-language），默认中文。
 * 与主题同模式——store 是唯一事实源，组件经 useI18n() 取 t()。
 *
 * 同一份字典（src/shared/i18n.ts）也被 main 进程使用（托盘菜单/退出确认/推送文案），
 * 语言以 renderer 为准：切换时经 setAppSettings({ language }) 同步到 main。
 */
const STORAGE_KEY = 'cwb-language'

export function loadLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

export function persistLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // 存储不可用（隐私模式）→ 仅本次会话生效
  }
}

/** 应用语言到 <html lang>（读屏与 CJK 字体回退用；index.html 初始值写 zh-CN） */
function applyHtmlLang(lang: Language): void {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
}

interface LanguageState {
  language: Language
  setLanguage: (lang: Language) => void
}

const initialLanguage = loadLanguage()
applyHtmlLang(initialLanguage)

export const useLanguageStore = create<LanguageState>()((set) => ({
  language: initialLanguage,
  setLanguage: (lang) => {
    persistLanguage(lang)
    set({ language: lang })
    applyHtmlLang(lang)
    // main 侧（托盘/退出确认/推送文案）同语言；失败静默——界面语言不受影响
    syncLanguageToMain()
  }
}))

export type TFn = (key: MessageKey, params?: Record<string, string | number>) => string

/** 组件内取翻译函数：`const t = useI18n()` */
export function useI18n(): TFn {
  const language = useLanguageStore((s) => s.language)
  return useCallback<TFn>((key, params) => translate(language, key, params), [language])
}

/** 非组件环境（store action / 模块级常量）取翻译：读当前 store 值，语言切换后自动生效 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(useLanguageStore.getState().language, key, params)
}

/**
 * 启动时把当前语言同步给 main（settings.json）——用户可能清过 localStorage 或
 * 换过机器；托盘/退出确认文案须与界面一致。失败静默（界面语言不受影响）。
 */
export function syncLanguageToMain(): void {
  try {
    void Promise.resolve(
      window.cwb?.setAppSettings?.({ language: useLanguageStore.getState().language })
    ).catch(() => {})
  } catch {
    // 无 preload（纯浏览器/jsdom 早期）→ 跳过
  }
}