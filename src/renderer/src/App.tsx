import { useEffect } from 'react'
import { initListeners, useAppStore } from './store'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TabBar } from './components/TabBar'
import { TerminalPanel, focusActiveTerminal } from './components/TerminalPanel'
import { SmokeBridge } from './components/SmokeBridge'
import { AboutDialog } from './components/AboutDialog'
import { SkillsDialog } from './components/SkillsDialog'

/** ?smoke=1：--smoke 冒烟模式下 main 注入的 URL query（模块加载时解析一次，运行期不变） */
const isSmokeMode = new URLSearchParams(window.location.search).get('smoke') === '1'

/**
 * 布局（v0.1.2 重构）：左 sidebar（项目树，任务为可折叠子节点）+ 右主区
 * （TabBar + 终端面板 + 底部状态栏——主区全部留给终端，任务管理不再占用上方空间）。
 * mount：loadAll + initListeners；unmount：全部退订。
 * v0.5①③：底部状态栏（仅版本号，点击开 About）；About/Skills 弹窗状态在 store
 * （StatusBar、折叠 rail、侧栏按钮多入口），onClose 统一关弹窗+焦点还终端。
 */
export function App() {
  useEffect(() => {
    void useAppStore.getState().loadAll()
    const dispose = initListeners()
    return dispose
  }, [])

  const projects = useAppStore((s) => s.projects)
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const aboutOpen = useAppStore((s) => s.aboutOpen)
  const skillsOpen = useAppStore((s) => s.skillsOpen)

  return (
    <div className="app">
      <SmokeBridge smoke={isSmokeMode} />
      <ProjectSidebar />
      <div className="main-area">
        {/* A3：仅零项目且无打开 tab 时显示（主区中部绝对定位，不再占 TabBar 上方布局）；
            有项目无 tab 时由 TerminalPanel 空态接管提示 */}
        {projects.length === 0 && openTaskIds.length === 0 && (
          <div className="empty-hint">从左侧“打开目录”注册一个项目开始</div>
        )}
        <TabBar />
        <TerminalPanel />
      </div>
      {aboutOpen && (
        <AboutDialog
          onClose={() => {
            useAppStore.getState().closeAbout()
            // v0.4.3 焦点管理③：弹窗关闭把键盘焦点还给活跃终端（NewTaskDialog 先例）
            focusActiveTerminal()
          }}
        />
      )}
      {skillsOpen && (
        <SkillsDialog
          onClose={() => {
            useAppStore.getState().closeSkills()
            focusActiveTerminal()
          }}
        />
      )}
    </div>
  )
}
