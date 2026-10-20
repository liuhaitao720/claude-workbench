import { useEffect } from 'react'
import { useAppStore } from '../store'

/**
 * S4 冒烟回执桥（仅 ?smoke=1 时激活；正常渲染零副作用）。
 * main.ts --smoke 模式经 loadFile({search:'smoke=1'}) 通知 renderer；
 * 本组件订阅 onPtyData，收到首个 PTY 数据即截前 200 字符经 reportSmoke
 * 回报 main（main 侧断言非空后走 kill/清理/exit(0)）。
 * smoke 由 App 计算 URL query 注入（可测性：jsdom 无法改写 location.search）。
 *
 * v0.4.3：smoke 模式追加 __cwbTest.openTask 测试钩子——探针/冒烟经 main 侧
 * createTask 建的任务不在 renderer store（无项目广播），UI 上无 tab 可点；
 * 探针用它驱动真实 openTaskAutoResume 路径（含自动恢复与终端聚焦）。
 */
export function SmokeBridge({ smoke }: { smoke: boolean }) {
  useEffect(() => {
    if (!smoke) return
    let reported = false
    const off = window.cwb.onPtyData((e) => {
      if (reported) return // 仅报首个数据事件
      reported = true
      window.cwb.reportSmoke(e.data.slice(0, 200))
    })
    ;(window as unknown as { __cwbTest?: { openTask: (id: string) => void } }).__cwbTest = {
      openTask: (id: string) => useAppStore.getState().openTaskAutoResume(id)
    }
    return off
  }, [smoke])

  return null
}
