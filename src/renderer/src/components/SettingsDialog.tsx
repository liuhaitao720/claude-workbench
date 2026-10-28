import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { Theme } from '../theme'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { CliOutputView } from './CliOutputView'
import { changeFontFamily, changeFontSize } from './TerminalPanel'
import { FONT_FAMILY_WHITELIST, loadFontFamily } from '../font-family'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize, loadFontSize } from '../font-size'
import { APP_VERSION } from '../app-info'
import { useI18n, useLanguageStore, LANGUAGE_LABELS } from '../i18n'
import type { Language, MessageKey } from '../i18n'
import type { AppChangelogEntry, AppUpdateInfo, AppUpdateProgressEvent } from '../../../shared/types'

/** 5.1 安装方式展示模板（执行走 installClaudeCli 固定契约法，不经自由命令面；
 * spec R5：执行前完整展示命令 + 二次确认）——迁自 AboutDialog */
const NATIVE_INSTALL_CMD =
  'powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
const NPM_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code'
const CLAUDE_DOCS_URL = 'https://claude.ai/docs/setup'

/** S14 双栏导航：六个分类（id 稳定作 activeSection 锚点；label 经 i18n）。
 * 顺序即左栏自上而下顺序 */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; labelKey: MessageKey }> = [
  { id: 'appearance', labelKey: 'settings.sectionAppearance' },
  { id: 'terminal', labelKey: 'settings.sectionTerminal' },
  { id: 'notify', labelKey: 'settings.sectionNotify' },
  { id: 'cli', labelKey: 'settings.sectionCli' },
  { id: 'update', labelKey: 'settings.sectionUpdate' },
  { id: 'startup', labelKey: 'settings.sectionStartup' }
]

type SettingsSectionId =
  | 'appearance'
  | 'terminal'
  | 'notify'
  | 'cli'
  | 'update'
  | 'startup'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 设置中心弹窗（v0.9 9 项设置 + S14 双栏重设计，/frontend-design 定稿）：
 * macOS 系统设置式左导航 + 右内容——
 * - 左栏 5 分类导航项，每项附当前值摘要（主题 / 字体·字号 / 通知 / CLI 版本 /
 *   启动行为），全部从既有 state 派生——不打开分类也能扫出当前值
 * - 右栏按 activeSection 条件渲染（默认「外观」；非当前 section 不渲染）；
 *   五个 section 内部 JSX 沿 v0.9 原样（交互/测试锚点不动，只重新分区布局）
 * - v0.9 全部保留项不动：外观 主题三选+终端跟随；终端 字体族+字号 stepper；
 *   通知 webhook；claude CLI 版本/更新/安装（CliOutputView 含 commandIdRef
 *   卸载 kill）；启动与窗口 关闭行为+开机自启
 * - Escape/遮罩关闭/useEscapeClose、底部「关闭」按钮（跨栏）全保留
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n()
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const termFollowsTheme = useAppStore((s) => s.termFollowsTheme)
  const setTermFollowsTheme = useAppStore((s) => s.setTermFollowsTheme)

  const [fontFamily, setFontFamily] = useState<string>(() => loadFontFamily())
  const [fontSizeInput, setFontSizeInput] = useState<string>(() => String(loadFontSize()))
  /** v0.9.4：本机已装等宽字体（main 扫描契约）——与白名单合并为下拉全集 */
  const [installedFonts, setInstalledFonts] = useState<string[]>([])

  const [cliInfo, setCliInfo] = useState<{ version: string; path: string } | null>(null)
  const [cliError, setCliError] = useState('')
  const [updateInfo, setUpdateInfo] = useState<{
    current: string
    latest: string
    upToDate: boolean
    degraded?: boolean
  } | null>(null)
  // v1.1.0 claude CLI 更新说明（checkUpdate 成功且非 degraded 时自动拉取）
  const [cliNotes, setCliNotes] = useState<{ notes: AppChangelogEntry[]; error?: string } | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [checking, setChecking] = useState(false)
  const [installMethod, setInstallMethod] = useState<'native' | 'npm'>('native')
  const [installError, setInstallError] = useState('')
  /** runCliCommand/installClaudeCli 的当前命令（同一时刻至多一个，共用输出区） */
  const [commandId, setCommandId] = useState<string | null>(null)
  /** v1.1.0：点击更新/安装后立即显示「正在执行」——原实现要等首个输出帧才出现
   *  输出区，用户以为点击没生效（claude update 冷启动 1~3s 无输出） */
  const [starting, setStarting] = useState(false)
  const [notifyUrl, setNotifyUrl] = useState('')
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [notifyMsg, setNotifyMsg] = useState('')
  const [notifyTest, setNotifyTest] = useState<{ ok: boolean; error?: string } | null>(null)
  const [closeToTray, setCloseToTray] = useState(true)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  // v1.1.0 应用自更新：检查结果（初值取启动静默检查落库值）/进度/已就绪标记
  const [appUpd, setAppUpd] = useState<AppUpdateInfo | null>(() => useAppStore.getState().appUpdateInfo)
  const [appUpdChecking, setAppUpdChecking] = useState(false)
  const [appUpdError, setAppUpdError] = useState('')
  const [appUpdProgress, setAppUpdProgress] = useState<AppUpdateProgressEvent | null>(null)
  const [appUpdReady, setAppUpdReady] = useState(false)
  /** v1.2.1 自动升级开关（main settings.json 持久化；缺省开） */
  const [autoUpdate, setAutoUpdate] = useState(true)
  /** S14：当前展示的分类（默认首项「外观」） */
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance')

  // v1.1.0 下载进度订阅（main 经 cwb:event:app-update-progress 推送；v1.2.1 增加
  // available=自动检查结果 / waiting-tasks=等任务结束）
  useEffect(() => {
    return window.cwb.onAppUpdateProgress((e) => {
      if (e.phase === 'available') {
        setAppUpd(e.info)
        useAppStore.getState().setAppUpdateInfo(e.info)
        return
      }
      setAppUpdProgress(e)
      setAppUpdReady(e.phase === 'ready' || e.phase === 'waiting-tasks' || e.phase === 'installing')
    })
  }, [])

  const checkAppUpd = async (): Promise<void> => {
    setAppUpdChecking(true)
    setAppUpdError('')
    try {
      // v1.2.1：手动点检查 → force 重新拉清单（不复用启动自动检查的缓存）
      const info = await window.cwb.checkAppUpdate(true)
      setAppUpd(info)
      setAppUpdReady(false)
      useAppStore.getState().setAppUpdateInfo(info) // 同步侧栏版本按钮角标
    } catch (err) {
      setAppUpdError(errMsg(err))
    } finally {
      setAppUpdChecking(false)
    }
  }

  const downloadAppUpd = async (): Promise<void> => {
    setAppUpdError('')
    setAppUpdReady(false)
    const r = await window.cwb.downloadAppUpdate()
    if (!r.ok) setAppUpdError(r.error ?? t('settings.appDownloadFailed'))
    // 下载成功由 main 的 ready 进度事件置 appUpdReady → 显示「立即升级」
    // （自动升级开关打开时，main 侧会自行完成重启，这个按钮是手动路径/兜底）
  }

  const installAppUpd = async (): Promise<void> => {
    if (!window.confirm(t('settings.appInstallConfirm'))) return
    const r = await window.cwb.installAppUpdate()
    if (!r.ok) setAppUpdError(r.error ?? t('settings.appInstallStartFailed'))
  }

  // npm 安装项禁用条件（S9 定夺）：S8 未提供 node 检测契约 → 暂用 false 默认可点；
  // 无 node 机器上安装失败经输出区回显报错（可接受的自愈路径），待后续契约补
  // node 检测后接入真实条件（concern 已记报告）——迁自 AboutDialog
  const npmInstallDisabled = false

  const refreshCliInfo = async () => {
    try {
      setCliInfo(await window.cwb.getClaudeVersionInfo())
      setCliError('')
    } catch (err) {
      setCliInfo(null)
      setCliError(errMsg(err))
    }
  }

  // 打开即实测版本信息 + 读通知配置 + 读应用设置 + 扫描本机字体（读取失败保持默认值，不阻塞弹窗）
  useEffect(() => {
    void refreshCliInfo()
    window.cwb
      .getInstalledMonoFonts()
      .then((list) => setInstalledFonts(list))
      .catch(() => {})
    window.cwb
      .getNotifyConfig()
      .then((c) => {
        setNotifyUrl(c.url)
        setNotifyEnabled(c.enabled)
      })
      .catch(() => {})
    window.cwb
      .getAppSettings()
      .then((s) => {
        setCloseToTray(s.closeToTray)
        setLaunchAtLogin(s.launchAtLogin)
        setAutoUpdate(s.autoUpdate !== false)
      })
      .catch(() => {})
  }, [])

  // 关闭防孤儿：卸载时终止仍在执行的 CLI 命令（覆盖 overlay/Escape/按钮全关闭路径）
  const commandIdRef = useRef(commandId)
  commandIdRef.current = commandId
  useEffect(
    () => () => {
      if (commandIdRef.current !== null) window.cwb.killCliCommand(commandIdRef.current)
    },
    []
  )

  const installed = cliInfo !== null && cliInfo.version !== ''

  // A1：document 级 Escape——焦点留在触发按钮（侧栏设置按钮）上也能关
  useEscapeClose(onClose)

  const themeChoices: ReadonlyArray<{ value: Theme; label: string }> = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'light', label: t('settings.themeLight') }
  ]

  // S14 左栏当前值摘要：全部从既有 state 派生（字号输入清空的中间态回退到实际
  // 生效值；CLI 检测中/失败均不属于「已装」——失败与未装同示「未安装」）
  const sectionSummaries: Record<SettingsSectionId, string> = {
    appearance: themeChoices.find((c) => c.value === theme)?.label ?? '',
    terminal: `${fontFamily} · ${fontSizeInput === '' ? String(loadFontSize()) : fontSizeInput}`,
    notify:
      notifyUrl.trim() === ''
        ? t('settings.notifyStateUnset')
        : notifyEnabled
          ? t('settings.notifyStateOn')
          : t('settings.notifyStateOff'),
    cli: installed
      ? cliInfo.version
      : cliInfo !== null || cliError !== ''
        ? t('settings.cliStateNotInstalled')
        : t('common.detecting'),
    update:
      appUpd === null
        ? t('settings.updateStateUnchecked')
        : appUpd.upToDate
          ? t('settings.updateStateLatest', { version: appUpd.current })
          : t('settings.updateStateAvailable', { version: appUpd.latest }),
    startup: closeToTray ? t('settings.closeToTraySummary') : t('settings.quitApp')
  }

  const checkUpdate = async () => {
    setChecking(true)
    setUpdateError('')
    setCliNotes(null)
    try {
      const info = await window.cwb.checkClaudeUpdate()
      setUpdateInfo(info)
      // v1.1.0：版本对比成功后拉更新说明（已是最新也展示当前版本段，和「应用更新」一致）
      if (info.current !== '' && info.latest !== '' && info.degraded !== true) {
        try {
          setCliNotes(await window.cwb.getClaudeChangelog(info.current, info.latest))
        } catch (err) {
          setCliNotes({ notes: [], error: errMsg(err) })
        }
      }
    } catch (err) {
      setUpdateError(errMsg(err))
    } finally {
      setChecking(false)
    }
  }

  const runUpdate = async () => {
    setUpdateError('')
    setStarting(true) // v1.1.0：立即给反馈（spawn 有 0.5~3s 冷启动，期间界面无变化）
    try {
      const r = await window.cwb.runCliCommand('claude update')
      setCommandId(r.commandId)
    } catch (err) {
      setUpdateError(errMsg(err))
    } finally {
      setStarting(false)
    }
  }

  const runInstall = async () => {
    const cmd = installMethod === 'native' ? NATIVE_INSTALL_CMD : NPM_INSTALL_CMD
    if (!window.confirm(t('settings.installConfirm', { cmd }))) return
    setInstallError('')
    setStarting(true)
    try {
      const r = await window.cwb.installClaudeCli(installMethod)
      setCommandId(r.commandId)
    } catch (err) {
      setInstallError(errMsg(err))
    } finally {
      setStarting(false)
    }
  }

  const saveNotify = async () => {
    try {
      await window.cwb.setNotifyWebhook(notifyUrl.trim(), notifyEnabled)
      setNotifyMsg(t('settings.notifySaved'))
    } catch (err) {
      setNotifyMsg(t('settings.notifySaveFailed', { error: errMsg(err) }))
    }
  }

  const sendTest = async () => {
    try {
      setNotifyTest(await window.cwb.sendTestNotify())
    } catch (err) {
      setNotifyTest({ ok: false, error: errMsg(err) })
    }
  }

  /** 字号 stepper（10-22）：经 changeFontSize 单一入口落地（clamp+persist+全实例
   *  options+活动 fit/ptyResize——与 Ctrl+=/-、Ctrl+滚轮同一通路）；显示值收敛回实际落地 */
  const applyFontSize = (raw: string): void => {
    if (raw === '') return // number 输入清空（含非数字中间态）不动当前值
    const applied = changeFontSize(clampFontSize(Number(raw)) - loadFontSize())
    setFontSizeInput(String(applied))
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog settings-dialog" role="dialog" aria-label={t('settings.aria')}>
        <p className="dialog-title">{t('settings.title')}</p>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('settings.navAria')}>
            {SETTINGS_SECTIONS.map((sec) => {
              const id = sec.id as SettingsSectionId
              const label = t(sec.labelKey)
              return (
                <button
                  key={id}
                  type="button"
                  className={activeSection === id ? 'settings-nav-item active' : 'settings-nav-item'}
                  aria-label={label}
                  aria-current={activeSection === id ? 'true' : undefined}
                  onClick={() => setActiveSection(id)}
                >
                  <span className="settings-nav-label">{label}</span>
                  <span className="settings-nav-summary">{sectionSummaries[id]}</span>
                </button>
              )
            })}
          </nav>
          <div className="settings-body">
            {/* 外观：主题三选（迁自 About）+ 终端跟随开关（默认关——ANSI 彩色浅底不可读）
                + 界面语言（v1.2.0 中英切换，即时生效并同步 main 侧托盘/退出文案） */}
            {activeSection === 'appearance' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.sectionAppearance')}</p>
                <div className="theme-choice" role="radiogroup" aria-label={t('settings.themeAria')}>
                  {themeChoices.map((c) => (
                    <label key={c.value}>
                      <input
                        type="radio"
                        name="ui-theme"
                        checked={theme === c.value}
                        onChange={() => setTheme(c.value)}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                <label className="dialog-check">
                  <input
                    type="checkbox"
                    checked={termFollowsTheme}
                    onChange={(e) => setTermFollowsTheme(e.target.checked)}
                  />
                  {t('settings.termFollow')}
                </label>
                <p className="hint-small">{t('settings.termFollowHint')}</p>
                <div className="notify-row">
                  <span>{t('settings.language')}</span>
                  <select
                    className="notify-url"
                    aria-label={t('settings.language')}
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as Language)}
                  >
                    {(Object.keys(LANGUAGE_LABELS) as Language[]).map((lang) => (
                      <option key={lang} value={lang}>
                        {LANGUAGE_LABELS[lang]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* 终端：字体族白名单 select + 字号 stepper（持久化 localStorage） */}
            {activeSection === 'terminal' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.sectionTerminal')}</p>
                <div className="notify-row">
                  <select
                    className="notify-url"
                    aria-label={t('settings.fontAria')}
                    value={fontFamily}
                    onChange={(e) => {
                      const applied = changeFontFamily(e.target.value)
                      setFontFamily(applied)
                    }}
                  >
                    {/* v0.9.4（用户指令：不显示本机不支持的字体）：仅显示已装——
                        白名单∩已装 + 本机检测到的其余等宽字体；扫描失败（空列表）回退白名单全集 */}
                    {(() => {
                      const fontOptions =
                        installedFonts.length > 0
                          ? installedFonts
                          : (FONT_FAMILY_WHITELIST as readonly string[])
                      return fontOptions.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))
                    })()}
                  </select>
                </div>
                <div className="notify-row">
                  <input
                    className="notify-url"
                    type="number"
                    aria-label={t('settings.fontSizeAria')}
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    step={1}
                    style={{ flex: '0 0 96px' }}
                    value={fontSizeInput}
                    onChange={(e) => applyFontSize(e.target.value)}
                  />
                  <p className="hint-small" style={{ margin: 0 }}>
                    {t('settings.fontSizeHint', { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
                  </p>
                </div>
              </div>
            )}

            {/* 通知：webhook 推送（迁自 About） */}
            {activeSection === 'notify' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.notifyTitle')}</p>
                <div className="notify-row">
                  <input
                    className="notify-url"
                    type="text"
                    placeholder={t('settings.notifyPlaceholder')}
                    aria-label="webhook URL"
                    value={notifyUrl}
                    onChange={(e) => {
                      setNotifyUrl(e.target.value)
                      setNotifyMsg('')
                    }}
                  />
                  <label className="dialog-check">
                    <input
                      type="checkbox"
                      checked={notifyEnabled}
                      onChange={(e) => {
                        setNotifyEnabled(e.target.checked)
                        setNotifyMsg('')
                      }}
                    />
                    {t('common.enable')}
                  </label>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn" onClick={() => void saveNotify()}>
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={notifyUrl.trim() === ''}
                    title={notifyUrl.trim() === '' ? t('settings.notifyNeedUrl') : undefined}
                    onClick={() => void sendTest()}
                  >
                    {t('settings.notifyTest')}
                  </button>
                </div>
                {notifyMsg !== '' && (
                  <p className="muted" role="status">
                    {notifyMsg}
                  </p>
                )}
                {notifyTest !== null && (
                  <p className={notifyTest.ok ? 'muted ok' : 'inline-error'} role="status">
                    {notifyTest.ok
                      ? t('settings.notifyTestOk')
                      : t('settings.notifyTestFailed', {
                          error: notifyTest.error ?? t('settings.notifyUnknownError')
                        })}
                  </p>
                )}
                <p className="hint-small">{t('settings.notifyHint')}</p>
              </div>
            )}

            {/* claude CLI：版本/路径/更新/安装（迁自 About） */}
            {activeSection === 'cli' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.sectionCli')}</p>
                {cliInfo === null && cliError === '' && <p className="muted">{t('common.detecting')}</p>}
                {cliError !== '' && <p className="inline-error">{cliError}</p>}
                {installed && (
                  <>
                    <div className="kv">{t('settings.cliVersion', { version: cliInfo.version })}</div>
                    <div className="kv path" title={cliInfo.path}>
                      {t('settings.cliPath', { path: cliInfo.path })}
                    </div>
                  </>
                )}
                {cliInfo !== null && !installed && (
                  <>
                    <div className="kv warn">{t('settings.cliNotInstalled')}</div>
                    {/* 5.1 下载安装区：方式选择 + 二次确认 + 固定模板契约法 */}
                    <div className="install-methods" role="radiogroup" aria-label={t('settings.installMethodsAria')}>
                      <label>
                        <input
                          type="radio"
                          name="install-method"
                          checked={installMethod === 'native'}
                          onChange={() => setInstallMethod('native')}
                        />
                        {t('settings.installNative')}
                      </label>
                      <label title={npmInstallDisabled ? t('settings.installNpmNoNode') : undefined}>
                        <input
                          type="radio"
                          name="install-method"
                          checked={installMethod === 'npm'}
                          disabled={npmInstallDisabled}
                          onChange={() => setInstallMethod('npm')}
                        />
                        {t('settings.installNpm')}
                      </label>
                    </div>
                    <div className="dialog-actions">
                      <button type="button" className="btn primary" onClick={() => void runInstall()}>
                        {t('settings.install')}
                      </button>
                      <a className="btn" href={CLAUDE_DOCS_URL} target="_blank" rel="noreferrer">
                        {t('settings.installDocs')}
                      </a>
                    </div>
                    {installError !== '' && <p className="inline-error">{installError}</p>}
                  </>
                )}
                {installed && (
                  <>
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={checking}
                        onClick={() => void checkUpdate()}
                      >
                        {checking ? t('common.detecting') : t('settings.checkUpdate')}
                      </button>
                      {updateInfo !== null && !updateInfo.upToDate && (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={commandId !== null || starting}
                          onClick={() => void runUpdate()}
                        >
                          {starting
                            ? t('settings.starting')
                            : commandId !== null
                              ? t('settings.updating')
                              : t('settings.update')}
                        </button>
                      )}
                    </div>
                    {updateInfo !== null &&
                      (updateInfo.degraded === true ? (
                        <p className="muted">{t('settings.cliDegraded')}</p>
                      ) : (
                        <p className="muted">
                          {t('settings.cliVersionLine', {
                            current: updateInfo.current,
                            latest: updateInfo.latest,
                            state: updateInfo.upToDate
                              ? t('settings.cliUpToDate')
                              : t('settings.cliUpdatable')
                          })}
                        </p>
                      ))}
                    {updateError !== '' && <p className="inline-error">{updateError}</p>}
                    {/* v1.1.0 claude CLI 更新说明（版本对比成功后自动拉取，与「应用更新」同款展示） */}
                    {cliNotes !== null && cliNotes.notes.length > 0 && (
                      <div className="upd-notes">
                        {cliNotes.notes.map((n) => (
                          <div key={n.version} className="upd-notes-ver">
                            <p className="upd-notes-title">v{n.version}</p>
                            <ul>
                              {n.items.map((it, i) => (
                                <li key={i}>{it}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                    {cliNotes !== null && cliNotes.notes.length === 0 && cliNotes.error === undefined && (
                      <p className="muted">{t('settings.notesNone')}</p>
                    )}
                    {cliNotes?.error !== undefined && (
                      <p className="muted">{t('settings.notesFailed', { error: cliNotes.error })}</p>
                    )}
                  </>
                )}
                {/* 更新/安装执行输出（轻量只读区，非完整 xterm） */}
                <CliOutputView
                  commandId={commandId}
                  onExit={() => {
                    // 完成后刷新版本信息（安装/更新都会改变 CLI 版本；spec T9 对应动作）
                    void refreshCliInfo()
                  }}
                />
              </div>
            )}

            {/* v1.1.0 应用自更新：检测 + 更新说明 + 一键升级 */}
            {activeSection === 'update' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.appUpdateTitle')}</p>
                {/* v1.2.1 自动升级开关（缺省开）：无需点按钮——下载就绪且无运行任务即自动重启升级 */}
                <label className="dialog-check">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(e) => {
                      setAutoUpdate(e.target.checked)
                      void window.cwb.setAppSettings({ autoUpdate: e.target.checked })
                    }}
                  />
                  {t('settings.autoUpdate')}
                </label>
                <p className="hint-small">{t('settings.autoUpdateHint')}</p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={appUpdChecking}
                    onClick={() => void checkAppUpd()}
                  >
                    {appUpdChecking ? t('common.detecting') : t('settings.checkUpdate')}
                  </button>
                  {appUpd !== null && !appUpd.upToDate && !appUpdReady && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={
                        appUpdProgress?.phase === 'downloading' || appUpdProgress?.phase === 'verifying'
                      }
                      onClick={() => void downloadAppUpd()}
                    >
                      {appUpdProgress?.phase === 'downloading'
                        ? t('settings.appDownloading', { percent: appUpdProgress.percent })
                        : appUpdProgress?.phase === 'verifying'
                          ? t('settings.appVerifying')
                          : t('settings.appDownload')}
                    </button>
                  )}
                  {appUpdReady && (
                    <button type="button" className="btn primary" onClick={() => void installAppUpd()}>
                      {t('settings.appInstallNow')}
                    </button>
                  )}
                </div>
                {/* 自动升级进行中状态：等待任务结束 / 正在退出升级 */}
                {appUpdProgress?.phase === 'waiting-tasks' && (
                  <p className="muted" role="status">
                    {t('settings.appWaitingTasks', { count: appUpdProgress.count })}
                  </p>
                )}
                {appUpdProgress?.phase === 'installing' && (
                  <p className="muted" role="status">
                    {t('settings.appAutoInstalling')}
                  </p>
                )}
                {appUpd !== null && (
                  <p className="muted">
                    {t('settings.appUpdateLine', {
                      current: appUpd.current,
                      latest: appUpd.latest,
                      state: appUpd.upToDate
                        ? t('settings.cliUpToDate')
                        : t('settings.cliUpdatable')
                    })}
                    {appUpd.manifestError !== undefined &&
                      t('settings.appManifestError', { error: appUpd.manifestError })}
                  </p>
                )}
                {appUpdProgress?.phase === 'downloading' && (
                  <progress className="upd-progress" max={100} value={appUpdProgress.percent} />
                )}
                {appUpd !== null && appUpd.notes.length > 0 && (
                  <div className="upd-notes">
                    {appUpd.notes.map((n) => (
                      <div key={n.version} className="upd-notes-ver">
                        <p className="upd-notes-title">v{n.version}</p>
                        <ul>
                          {n.items.map((it, i) => (
                            <li key={i}>{it}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                {appUpd !== null && appUpd.notesError !== undefined && (
                  <p className="muted">{t('settings.notesFailed', { error: appUpd.notesError })}</p>
                )}
                {appUpdError !== '' && <p className="inline-error">{appUpdError}</p>}
                <p className="hint-small">{t('settings.appUpdateHint', { version: APP_VERSION })}</p>
              </div>
            )}

            {/* 启动与窗口：关闭行为 + 开机自启（第 31-32 法；main 接线后续落地） */}
            {activeSection === 'startup' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.startupTitle')}</p>
                <div className="theme-choice" role="radiogroup" aria-label={t('settings.closeBehaviorAria')}>
                  <label>
                    <input
                      type="radio"
                      name="close-behavior"
                      checked={closeToTray}
                      onChange={() => {
                        setCloseToTray(true)
                        void window.cwb.setAppSettings({ closeToTray: true })
                      }}
                    />
                    {t('settings.closeToTray')}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="close-behavior"
                      checked={!closeToTray}
                      onChange={() => {
                        setCloseToTray(false)
                        void window.cwb.setAppSettings({ closeToTray: false })
                      }}
                    />
                    {t('settings.quitApp')}
                  </label>
                </div>
                <label className="dialog-check">
                  <input
                    type="checkbox"
                    checked={launchAtLogin}
                    onChange={(e) => {
                      setLaunchAtLogin(e.target.checked)
                      void window.cwb.setAppSettings({ launchAtLogin: e.target.checked })
                    }}
                  />
                  {t('settings.launchAtLogin')}
                </label>
                <p className="hint-small">{t('settings.startupHint')}</p>
              </div>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
