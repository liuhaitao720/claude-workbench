import type { Language } from '../shared/i18n'

/**
 * main 进程当前界面语言（v1.2.0）。
 *
 * renderer 是语言的权威源（localStorage `cwb-language`）；它在启动与每次切换时经
 * `setAppSettings({ language })` 同步到 main。组合根（ipc.ts）在构造时写入、
 * 设置变更时更新，其余 main 模块（托盘/通知/CLI 校验/更新器）直接读 `mainLanguage()`
 * ——避免把语言参数穿过一长串调用链。
 *
 * 缺省中文：settings.json 缺失（首启）时与界面默认一致。
 */
let current: Language = 'zh'

export function mainLanguage(): Language {
  return current
}

export function setMainLanguage(language: Language): void {
  current = language === 'en' ? 'en' : 'zh'
}