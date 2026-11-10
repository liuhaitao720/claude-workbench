import { create } from 'zustand'
import { useCallback } from 'react'
import { LANGUAGE_LABELS, translate, type Language, type MessageKey } from '../../../shared/i18n'

export { LANGUAGE_LABELS, translate }
export type { Language, MessageKey }

/**
 * S8 遗留清理：原 renderer 侧 s6 补充字典（src/renderer/src/i18n/s6.ts）的 40 键已
 * 逐字升格进 src/shared/i18n.ts「S6 升格区」——键名/文案零变化，取文案统一走
 * shared translate（本文件不再有第二字典路由）。
 */
export type AnyMessageKey = MessageKey

/** 统一取文案（升格后=shared translate 直通；保留别名避免全量改调用点） */
export function translateAny(
  lang: Language,
  key: AnyMessageKey,
  params?: Record<string, string | number>
): string {
  return translate(lang, key, params)
}

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

/** 组件内取翻译函数：`const t = useI18n()`（键=shared 全量，含 S6 升格区） */
export type TFn = (key: AnyMessageKey, params?: Record<string, string | number>) => string

export function useI18n(): TFn {
  const language = useLanguageStore((s) => s.language)
  return useCallback<TFn>((key, params) => translateAny(language, key, params), [language])
}

/** 非组件环境（store action / 模块级常量）取翻译：读当前 store 值，语言切换后自动生效 */
export function t(key: AnyMessageKey, params?: Record<string, string | number>): string {
  return translateAny(useLanguageStore.getState().language, key, params)
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