import { useEffect } from 'react'
import { initListeners, useAppStore } from './store'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TabBar } from './components/TabBar'
import { TerminalPanel, focusActiveTerminal } from './components/TerminalPanel'
import { SmokeBridge } from './components/SmokeBridge'
import { SkillsDialog } from './components/SkillsDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { useI18n, syncLanguageToMain } from './i18n'

/** ?smoke=1：--smoke 冒烟模式下 main 注入的 URL query（模块加载时解析一次，运行期不变） */
const isSmokeMode = new URLSearchParams(window.location.search).get('smoke') === '1'

/**
 * 布局（v0.1.2 重构）：左 sidebar（项目树，任务为可折叠子节点）+ 右主区
 * （TabBar + 终端面板 + 底部状态栏——主区全部留给终端，任务管理不再占用上方空间）。
 * mount：loadAll + initListeners；unmount：全部退订。
 * v0.5①③：底部状态栏（仅版本号，点击开 About）；About/Skills 弹窗状态在 store
 * （StatusBar、折叠 rail、侧栏按钮多入口），onClose 统一关弹窗+焦点还终端。
 * v0.9：Settings 设置中心弹窗同族（About 瘦身为身份页 + 「打开设置」入口）。
 * v1.2.1：关于并入设置中心（左栏末项分类）——独立 AboutDialog 下线，ⓘ 入口直达
 * 「关于」分类；store 里只有 skillsOpen / settingsOpen 两个弹窗开关。
 */
export function App() {
  const t = useI18n()
  useEffect(() => {
    void useAppStore.getState().loadAll()
    const dispose = initListeners()
    // v1.2.0：启动把界面语言同步给 main（托盘/退出确认取同一语言）
    syncLanguageToMain()
    return dispose
  }, [])

  // v1.1.0 启动静默检查应用更新：仅正常模式（smoke 不发网络请求）；结果落 store 供
  // 侧栏版本按钮角标消费，失败静默（手动检查入口在设置中心，会显示具体错误）。
  // v1.2.1：main 侧启动即自动检查（有新版本还会后台下载并在任务结束后自动升级），
  // 这里取的是同一份缓存结果，不会重复打网络。
  useEffect(() => {
    if (isSmokeMode) return
    void window.cwb
      .checkAppUpdate()
      .then((info) => {
        useAppStore.getState().setAppUpdateInfo(info)
      })
      .catch(() => {})
  }, [])

  const projects = useAppStore((s) => s.projects)
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const skillsOpen = useAppStore((s) => s.skillsOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)

  return (
    <div className="app">
      <SmokeBridge smoke={isSmokeMode} />
      <ProjectSidebar />
      <div className="main-area">
        {/* A3：仅零项目且无打开 tab 时显示（主区中部绝对定位，不再占 TabBar 上方布局）；
            有项目无 tab 时由 TerminalPanel 空态接管提示 */}
        {projects.length === 0 && openTaskIds.length === 0 && (
          <div className="empty-hint">{t('app.emptyHint')}</div>
        )}
        <TabBar />
        <TerminalPanel />
      </div>
      {skillsOpen && (
        <SkillsDialog
          onClose={() => {
            useAppStore.getState().closeSkills()
            focusActiveTerminal()
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            useAppStore.getState().closeSettings()
            focusActiveTerminal()
          }}
        />
      )}
    </div>
  )
}
