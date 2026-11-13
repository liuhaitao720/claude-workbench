import { useEffect, useMemo, useRef } from 'react'
import { initListeners, useAppStore } from './store'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TabBar } from './components/TabBar'
import { TerminalPanel, focusActiveTerminal } from './components/TerminalPanel'
import { SmokeBridge } from './components/SmokeBridge'
import { SettingsDialog } from './components/SettingsDialog'
import { ServerInstallDialog } from './components/ServerInstallDialog'
import { ConnectErrorToast, HostKeyConfirmDialog } from './components/HostKeyConfirmDialog'
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

  // v2.1.0 SSH 纯终端开关：Ctrl+Shift+S（未开=打开首个已连接/首个；开着未活跃=
  // 激活；活跃=回任务终端）。输入态不劫持（对齐 Ctrl+Shift/D 先例）
  useEffect(() => {
    const isTypingTarget = (e: KeyboardEvent): boolean => {
      const el = e.target
      if (!(el instanceof HTMLElement)) return false
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true
      return el.closest('.term-host') !== null || el.closest('.ssh-term-host') !== null
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      if (e.key.toLowerCase() !== 's') return
      if (isTypingTarget(e)) return
      e.preventDefault()
      const s = useAppStore.getState()
      if (s.sshConsoleCid === null) {
        const target =
          s.connections.find((c) => s.connectionStates[c.id]?.state === 'connected')?.id ??
          s.connections[0]?.id
        if (target !== undefined) void s.openSshConsole(target)
        return
      }
      if (s.sshActive) {
        if (s.activeTaskId !== null) s.setActive(s.activeTaskId)
        else useAppStore.setState({ sshActive: false })
      } else s.activateSshConsole()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const projects = useAppStore((s) => s.projects)
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  // v2.1.1（用户指令融合）：右侧「远程文件」面板与竖条按钮移除——远程文件只活在
  // SSH 终端下半区；原 filesTargetConn/filesOpen 流废弃（项目菜单直达 openSshConsole）
  const connectionsForFiles = useAppStore((s) => s.connections)
  /**
   * v2.1.1 SSH 竖条/快捷键目标与定位：当前任务所属远程项目（shell cd 注入 +
   * 文件面板直达其工作目录，worktree 任务带 worktree 路径）→ 已连接 → 首个。
   */
  const openSshFromContext = (): Promise<void> => {
    const st = useAppStore.getState()
    const task = st.tasks.find((x) => x.id === st.activeTaskId)
    const project = task !== undefined ? st.projects.find((p) => p.id === task.projectId) : undefined
    if (task !== undefined && project?.connectionId !== undefined) {
      return st.openSshConsole(project.connectionId, task.worktreePath ?? task.cwd)
    }
    const target =
      st.connections.find((c) => st.connectionStates[c.id]?.state === 'connected')?.id ??
      st.connections[0]?.id
    return target !== undefined ? st.openSshConsole(target) : Promise.resolve()
  }
  /** effect(闭包稳定)与竖条共用——ref 防每渲染重建闭包过期 */
  const openSshFromContextRef = useRef(openSshFromContext)
  openSshFromContextRef.current = openSshFromContext

  // v2.0.3 审查竖条入口目标：当前任务的项目（git——worktree 任务带 worktree 目录）
  // 优先，回落选中项目；两者皆非 git 则不显示
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const tasks = useAppStore((s) => s.tasks)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const reviewEntry = useMemo(() => {
    const task = tasks.find((x) => x.id === activeTaskId)
    const byTask =
      task !== undefined ? projects.find((p) => p.id === task.projectId && p.isGit) : undefined
    if (byTask !== undefined && task !== undefined) {
      return { projectId: byTask.id, cwd: task.worktreePath ?? task.cwd }
    }
    const bySel = projects.find((p) => p.id === selectedProjectId && p.isGit)
    return bySel !== undefined ? { projectId: bySel.id, cwd: bySel.dir } : null
  }, [activeTaskId, tasks, projects, selectedProjectId])
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
        {/* v2.0.3 右缘竖条：审查改动常驻入口（此前仅项目菜单⋯/快捷键/AI 完成 toast，
            用户实测「看不见进入方式」）+ 远程文件入口。任务窗口上下文优先：审查=当前
            任务的项目（worktree 任务带 worktree 目录）；文件面板=直达该任务项目工作目录 */}
        <div className="rail-stack">
          {/* v2.1.1 SSH 纯终端入口：任务上下文优先（当前任务所属远程项目——shell cd
              注入 + 文件面板直达其工作目录）；无任务回落已连接/首个连接 */}
          {connectionsForFiles.length > 0 && (
            <button
              type="button"
              className="files-rail-toggle"
              title={t('ssh.railToggleTitle')}
              data-testid="btn-ssh-rail"
              onClick={() => void openSshFromContextRef.current()}
            >
              {t('ssh.railToggle')}
            </button>
          )}
          {reviewEntry !== null && (
            <button
              type="button"
              className="files-rail-toggle"
              title={t('review.railToggleTitle')}
              data-testid="btn-review-rail"
              onClick={() => void useAppStore.getState().openReview(reviewEntry.projectId, reviewEntry.cwd)}
            >
              {t('review.railToggle')}
            </button>
          )}
        </div>
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
