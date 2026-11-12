import { useEffect , useState } from 'react'
import { initListeners, useAppStore } from './store'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TabBar } from './components/TabBar'
import { TerminalPanel, focusActiveTerminal } from './components/TerminalPanel'
import { SmokeBridge } from './components/SmokeBridge'
import { SettingsDialog } from './components/SettingsDialog'
import { ServerInstallDialog } from './components/ServerInstallDialog'
import { ConnectErrorToast, HostKeyConfirmDialog } from './components/HostKeyConfirmDialog'
import { RemoteFilesPanel } from './components/RemoteFilesPanel'
import { ReviewHintToast } from './components/DiffReview'
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
 * v1.2.1：关于并入设置中心（左栏末项分类）——独立 AboutDialog 下线；
 * store 里只有 skillsOpen / settingsOpen 两个弹窗开关。
 * v1.2.2：侧栏 ⓘ 入口删除（版本号后只留 Skills / 设置两个图标），关于仍从设置左栏进。
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

  // v2.0.2 审查开关快捷键：Ctrl+Shift+D（未开=打开选中/git 项目审查 / 已开未活跃=
  // 激活 / 活跃=回上一个任务终端）。焦点在输入框/终端宿主时不劫持（对齐 Ctrl+N/F/B 先例）。
  useEffect(() => {
    const isTypingTarget = (e: KeyboardEvent): boolean => {
      const el = e.target
      if (!(el instanceof HTMLElement)) return false
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true
      return el.closest('.term-host') !== null
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      if (e.key.toLowerCase() !== 'd') return
      if (isTypingTarget(e)) return
      const s = useAppStore.getState()
      if (s.reviewState === null) {
        const pid = s.selectedProjectId ?? s.projects.find((p) => p.isGit)?.id ?? null
        if (pid !== null) {
          e.preventDefault()
          void s.openReview(pid)
        }
        return
      }
      e.preventDefault()
      if (s.reviewActive) {
        // 回终端：有任务切 active（setActive 落 reviewActive=false）；无任务直接收起
        if (s.activeTaskId !== null) s.setActive(s.activeTaskId)
        else useAppStore.setState({ reviewActive: false })
      } else s.activateReview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const projects = useAppStore((s) => s.projects)
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // v2.0 远程文件面板开合 + 目标连接（首个已连接远程；面板内目录记忆 per-cid）
  const [filesOpen, setFilesOpen] = useState(false)
  const connectionsForFiles = useAppStore((s) => s.connections)
  const connectionStates = useAppStore((s) => s.connectionStates)
  const connectedConn =
    connectionsForFiles.find((c) => connectionStates[c.id]?.state === 'connected')?.id ?? null
  // v2.0.1：显式目标（远程项目「在文件面板中打开」）优先；目标未连接回落 null
  const filesTargetConn = useAppStore((s) => s.filesTargetConn)
  // 显式指定目标（含目录）即自动开面板（store 动作由项目菜单触发）
  useEffect(() => {
    if (filesTargetConn !== null) setFilesOpen(true)
  }, [filesTargetConn])
  const filesConnId =
    filesOpen && filesTargetConn !== null && connectionStates[filesTargetConn]?.state === 'connected'
      ? filesTargetConn
      : filesOpen && connectedConn !== null
        ? connectedConn
        : null
  // S6（6.7=A）：连接流程触发 needInstall 时的 server 安装/升级确认弹窗
  const pendingServerInstall = useAppStore((s) => s.pendingServerInstall)

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
        <div className="main-workspace">
        <TerminalPanel />
        {/* v2.0 远程文件面板（FinalShell 式右侧——用户确认原型）：开合状态 +
            目标连接为 renderer 态（第一个已连接远程；记忆 per-connection 目录） */}
        {filesConnId === null ? (
          connectedConn !== null && (
            <button
              type="button"
              className="files-rail-toggle"
              title={t('files.openPanel')}
              onClick={() => setFilesOpen(true)}
            >
              {t('files.openPanel')}
            </button>
          )
        ) : (
          <div className="remote-files-host" data-testid="remote-files-host">
            <RemoteFilesPanel connectionId={filesConnId} />
            <button
              type="button"
              className="files-rail-toggle"
              title={t('files.closePanel')}
              onClick={() => setFilesOpen(false)}
            >
              ✕ {t('files.closePanel')}
            </button>
          </div>
        )}
        </div>
      </div>
      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            useAppStore.getState().closeSettings()
            focusActiveTerminal()
          }}
        />
      )}
      {pendingServerInstall !== null && (
        <ServerInstallDialog
          onClose={() => useAppStore.getState().dismissServerInstall()}
        />
      )}
      {/* TOFU 首连确认（侧栏/终端直连入口；设置页测试连接路径已有同等 UI） */}
      <HostKeyConfirmDialog />
      {/* 连接失败具体文案浮出（此前仅 console.error——用户侧「点了没反应」） */}
      <ConnectErrorToast />
      {/* v2.0.2 任务结束审查提示（main ReviewHint 推送；10s 自动收起） */}
      <ReviewHintToast />
    </div>
  )
}
