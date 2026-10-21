import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { Theme } from '../theme'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { CliOutputView } from './CliOutputView'
import { changeFontFamily, changeFontSize } from './TerminalPanel'
import { FONT_FAMILY_WHITELIST, loadFontFamily } from '../font-family'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize, loadFontSize } from '../font-size'

/** 5.1 安装方式展示模板（执行走 installClaudeCli 固定契约法，不经自由命令面；
 * spec R5：执行前完整展示命令 + 二次确认）——迁自 AboutDialog */
const NATIVE_INSTALL_CMD =
  'powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
const NPM_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code'
const CLAUDE_DOCS_URL = 'https://claude.ai/docs/setup'

/** S14 双栏导航：五个分类（id 稳定作 activeSection 锚点；label 即左栏项名，
 * aria-label 同 label 保证测试按精确名可达）。顺序即左栏自上而下顺序 */
const SETTINGS_SECTIONS = [
  { id: 'appearance', label: '外观' },
  { id: 'terminal', label: '终端' },
  { id: 'notify', label: '通知' },
  { id: 'cli', label: 'claude CLI' },
  { id: 'startup', label: '启动' }
] as const

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

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
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const termFollowsTheme = useAppStore((s) => s.termFollowsTheme)
  const setTermFollowsTheme = useAppStore((s) => s.setTermFollowsTheme)

  const [fontFamily, setFontFamily] = useState<string>(() => loadFontFamily())
  const [fontSizeInput, setFontSizeInput] = useState<string>(() => String(loadFontSize()))

  const [cliInfo, setCliInfo] = useState<{ version: string; path: string } | null>(null)
  const [cliError, setCliError] = useState('')
  const [updateInfo, setUpdateInfo] = useState<{
    current: string
    latest: string
    upToDate: boolean
    degraded?: boolean
  } | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [checking, setChecking] = useState(false)
  const [installMethod, setInstallMethod] = useState<'native' | 'npm'>('native')
  const [installError, setInstallError] = useState('')
  /** runCliCommand/installClaudeCli 的当前命令（同一时刻至多一个，共用输出区） */
  const [commandId, setCommandId] = useState<string | null>(null)
  const [notifyUrl, setNotifyUrl] = useState('')
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [notifyMsg, setNotifyMsg] = useState('')
  const [notifyTest, setNotifyTest] = useState<{ ok: boolean; error?: string } | null>(null)
  const [closeToTray, setCloseToTray] = useState(true)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  /** S14：当前展示的分类（默认首项「外观」） */
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance')

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

  // 打开即实测版本信息 + 读通知配置 + 读应用设置（读取失败保持默认值，不阻塞弹窗）
  useEffect(() => {
    void refreshCliInfo()
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
    { value: 'system', label: '跟随系统' },
    { value: 'dark', label: '深色' },
    { value: 'light', label: '浅色' }
  ]

  // S14 左栏当前值摘要：全部从既有 state 派生（字号输入清空的中间态回退到实际
  // 生效值；CLI 检测中/失败均不属于「已装」——失败与未装同示「未安装」）
  const sectionSummaries: Record<SettingsSectionId, string> = {
    appearance: themeChoices.find((c) => c.value === theme)?.label ?? '',
    terminal: `${fontFamily} · ${fontSizeInput === '' ? String(loadFontSize()) : fontSizeInput}`,
    notify: notifyUrl.trim() === '' ? '未配置' : notifyEnabled ? '已启用' : '未启用',
    cli: installed ? cliInfo.version : cliInfo !== null || cliError !== '' ? '未安装' : '检测中…',
    startup: closeToTray ? '托盘常驻' : '退出应用'
  }

  const checkUpdate = async () => {
    setChecking(true)
    setUpdateError('')
    try {
      setUpdateInfo(await window.cwb.checkClaudeUpdate())
    } catch (err) {
      setUpdateError(errMsg(err))
    } finally {
      setChecking(false)
    }
  }

  const runUpdate = async () => {
    setUpdateError('')
    try {
      const r = await window.cwb.runCliCommand('claude update')
      setCommandId(r.commandId)
    } catch (err) {
      setUpdateError(errMsg(err))
    }
  }

  const runInstall = async () => {
    const cmd = installMethod === 'native' ? NATIVE_INSTALL_CMD : NPM_INSTALL_CMD
    if (!window.confirm(`即将执行安装命令：\n\n  ${cmd}\n\n确认执行？（请确认来源可信）`)) return
    setInstallError('')
    try {
      const r = await window.cwb.installClaudeCli(installMethod)
      setCommandId(r.commandId)
    } catch (err) {
      setInstallError(errMsg(err))
    }
  }

  const saveNotify = async () => {
    try {
      await window.cwb.setNotifyWebhook(notifyUrl.trim(), notifyEnabled)
      setNotifyMsg('已保存')
    } catch (err) {
      setNotifyMsg(`保存失败：${errMsg(err)}`)
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
      <div className="dialog settings-dialog" role="dialog" aria-label="设置">
        <p className="dialog-title">设置</p>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {SETTINGS_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={
                  activeSection === sec.id ? 'settings-nav-item active' : 'settings-nav-item'
                }
                aria-label={sec.label}
                aria-current={activeSection === sec.id ? 'true' : undefined}
                onClick={() => setActiveSection(sec.id)}
              >
                <span className="settings-nav-label">{sec.label}</span>
                <span className="settings-nav-summary">{sectionSummaries[sec.id]}</span>
              </button>
            ))}
          </nav>
          <div className="settings-body">
            {/* 外观：主题三选（迁自 About）+ 终端跟随开关（默认关——ANSI 彩色浅底不可读） */}
            {activeSection === 'appearance' && (
              <div className="dialog-section">
                <p className="section-title">外观</p>
                <div className="theme-choice" role="radiogroup" aria-label="界面主题">
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
                  终端跟随界面主题
                </label>
                <p className="hint-small">
                  默认关闭——claude CLI 的 ANSI 彩色输出在浅色底上对比不足，终端保持深色更可读
                </p>
              </div>
            )}

            {/* 终端：字体族白名单 select + 字号 stepper（持久化 localStorage） */}
            {activeSection === 'terminal' && (
              <div className="dialog-section">
                <p className="section-title">终端</p>
                <div className="notify-row">
                  <select
                    className="notify-url"
                    aria-label="终端字体"
                    value={fontFamily}
                    onChange={(e) => {
                      const applied = changeFontFamily(e.target.value)
                      setFontFamily(applied)
                    }}
                  >
                    {FONT_FAMILY_WHITELIST.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="notify-row">
                  <input
                    className="notify-url"
                    type="number"
                    aria-label="终端字号"
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    step={1}
                    style={{ flex: '0 0 96px' }}
                    value={fontSizeInput}
                    onChange={(e) => applyFontSize(e.target.value)}
                  />
                  <p className="hint-small" style={{ margin: 0 }}>
                    字号 {FONT_SIZE_MIN}-{FONT_SIZE_MAX}，终端内 Ctrl+滚轮可即时调整
                  </p>
                </div>
              </div>
            )}

            {/* 通知：webhook 推送（迁自 About） */}
            {activeSection === 'notify' && (
              <div className="dialog-section">
                <p className="section-title">通知设置（webhook 推送）</p>
                <div className="notify-row">
                  <input
                    className="notify-url"
                    type="text"
                    placeholder="企业微信/钉钉群机器人 webhook URL"
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
                    启用
                  </label>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn" onClick={() => void saveNotify()}>
                    保存
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={notifyUrl.trim() === ''}
                    title={notifyUrl.trim() === '' ? '先填写 URL' : undefined}
                    onClick={() => void sendTest()}
                  >
                    测试推送
                  </button>
                </div>
                {notifyMsg !== '' && (
                  <p className="muted" role="status">
                    {notifyMsg}
                  </p>
                )}
                {notifyTest !== null && (
                  <p className={notifyTest.ok ? 'muted ok' : 'inline-error'} role="status">
                    {notifyTest.ok ? '测试推送成功' : `测试推送失败：${notifyTest.error ?? '未知错误'}`}
                  </p>
                )}
                <p className="hint-small">URL 属凭据，仅保存在本机（userData），不入仓库、不上传</p>
              </div>
            )}

            {/* claude CLI：版本/路径/更新/安装（迁自 About） */}
            {activeSection === 'cli' && (
              <div className="dialog-section">
                <p className="section-title">claude CLI</p>
                {cliInfo === null && cliError === '' && <p className="muted">检测中…</p>}
                {cliError !== '' && <p className="inline-error">{cliError}</p>}
                {installed && (
                  <>
                    <div className="kv">版本 {cliInfo.version}</div>
                    <div className="kv path" title={cliInfo.path}>
                      路径 {cliInfo.path}
                    </div>
                  </>
                )}
                {cliInfo !== null && !installed && (
                  <>
                    <div className="kv warn">未安装 claude CLI</div>
                    {/* 5.1 下载安装区：方式选择 + 二次确认 + 固定模板契约法 */}
                    <div className="install-methods" role="radiogroup" aria-label="安装方式">
                      <label>
                        <input
                          type="radio"
                          name="install-method"
                          checked={installMethod === 'native'}
                          onChange={() => setInstallMethod('native')}
                        />
                        原生安装器（推荐，无需 Node）
                      </label>
                      <label title={npmInstallDisabled ? '未检测到 node/npm' : undefined}>
                        <input
                          type="radio"
                          name="install-method"
                          checked={installMethod === 'npm'}
                          disabled={npmInstallDisabled}
                          onChange={() => setInstallMethod('npm')}
                        />
                        npm 安装（需本机已有 Node/npm）
                      </label>
                    </div>
                    <div className="dialog-actions">
                      <button type="button" className="btn primary" onClick={() => void runInstall()}>
                        下载安装
                      </button>
                      <a className="btn" href={CLAUDE_DOCS_URL} target="_blank" rel="noreferrer">
                        打开官方文档手动安装
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
                        检查更新
                      </button>
                      {updateInfo !== null && !updateInfo.upToDate && (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={commandId !== null}
                          onClick={() => void runUpdate()}
                        >
                          更新
                        </button>
                      )}
                    </div>
                    {updateInfo !== null &&
                      (updateInfo.degraded === true ? (
                        <p className="muted">
                          无法查询最新版本（未检测到 node 环境）——可直接执行 claude update
                        </p>
                      ) : (
                        <p className="muted">
                          当前 {updateInfo.current} · 最新 {updateInfo.latest} ·{' '}
                          {updateInfo.upToDate ? '已是最新' : '可更新'}
                        </p>
                      ))}
                    {updateError !== '' && <p className="inline-error">{updateError}</p>}
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

            {/* 启动与窗口：关闭行为 + 开机自启（第 31-32 法；main 接线后续落地） */}
            {activeSection === 'startup' && (
              <div className="dialog-section">
                <p className="section-title">启动与窗口</p>
                <div className="theme-choice" role="radiogroup" aria-label="关闭按钮行为">
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
                    最小化到托盘（常驻）
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
                    退出应用
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
                  开机自启
                </label>
                <p className="hint-small">
                  退出应用时如有运行中任务仍会先确认；开机自启仅安装版实际生效
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
