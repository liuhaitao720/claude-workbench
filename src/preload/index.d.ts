import type { CWBApi } from '../shared/types'

export {}

declare global {
  interface Window {
    /** Claude Workbench preload 桥接 API（契约：src/shared/types.ts 的 CWBApi，16 法） */
    cwb: CWBApi
  }
}
