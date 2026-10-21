/**
 * 应用元信息（v0.5①）：状态栏与 About 弹窗共用的事实源。
 * APP_VERSION 与 package.json version 手工同步（主控定夺：不做构建期注入，
 * 改版本时两处同改；package.json 已 bump 至 0.8.0）。
 */
export const APP_VERSION = '1.0.5'

/**
 * 构建日期：electron.vite.config.ts renderer define 注入（ISO 字符串）。
 * vitest 不走该 define → typeof 守卫回退空串（jsdom 测试只断言版本号）。
 */
export const BUILD_DATE: string = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : ''
