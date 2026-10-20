import { useEffect, useRef, useState } from 'react'
import { APP_VERSION, BUILD_DATE } from '../app-info'
import { useAppStore } from '../store'
import type { Theme } from '../theme'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { CliOutputView } from './CliOutputView'

/** 5.1 安装方式展示模板（执行走 installClaudeCli 固定契约法，不经自由命令面；
 * spec R5：执行前完整展示命令 + 二次确认） */
const NATIVE_INSTALL_CMD =
  'powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
const NPM_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code'
const CLAUDE_DOCS_URL = 'https://claude.ai/docs/setup'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 「关于」弹窗（v0.5①⑤④N + v0.5.3 主题切换）：
 * - 应用版本+构建日期 / claude CLI 版本+实际路径（getClaudeVersionInfo 实调；
 *   未安装 → 5.1 下载安装区：方式选择（原生安装器推荐/npm）+ installClaudeCli）
 * - 检查更新（checkClaudeUpdate）→ 可更新时「更新」= runCliCommand('claude update')
 * - 通知设置（④N：getNotifyConfig/setNotifyWebhook/sendTestNotify，结果行内显示）
 * - 主题（v0.5.3）：三选 radio（跟随系统/深色/浅色）+「终端跟随界面主题」开关
 *   （默认关——claude TUI ANSI 彩色浅底不可读，评审④-1）
 * - 许可证 MIT / 作者 Liu Haitao（① 终版：版权作者只进 About，状态栏仅版本号）
 * - ⑤ 更新/安装输出经 CliOutputView 内嵌只读区；弹窗关闭 killCliCommand 防孤儿
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const termFollowsTheme = useAppStore((s) => s.termFollowsTheme)
  const setTermFollowsTheme = useAppStore((s) => s.setTermFollowsTheme)
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

  // npm 安装项禁用条件（S9 定夺）：S8 未提供 node 检测契约 → 暂用 false 默认可点；
  // 无 node 机器上安装失败经输出区回显报错（可接受的自愈路径），待后续契约补
  // node 检测后接入真实条件（concern 已记报告）
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

  // 打开即实测版本信息 + 读通知配置（读取失败保持默认值，不阻塞弹窗）
  useEffect(() => {
    void refreshCliInfo()
    window.cwb
      .getNotifyConfig()
      .then((c) => {
        setNotifyUrl(c.url)
        setNotifyEnabled(c.enabled)
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

  // A1：document 级 Escape——焦点留在触发按钮（版本按钮）上也能关
  useEscapeClose(onClose)

  const themeChoices: ReadonlyArray<{ value: Theme; label: string }> = [
    { value: 'system', label: '跟随系统' },
    { value: 'dark', label: '深色' },
    { value: 'light', label: '浅色' }
  ]

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

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog dialog-scroll" role="dialog" aria-label="关于">
        <p className="dialog-title">Claude Workbench</p>
        <div className="dialog-section">
          <div className="kv">
            版本 v{APP_VERSION}
            {BUILD_DATE !== '' && ` · 构建 ${BUILD_DATE}`}
          </div>
        </div>

        {/* v0.5.3 主题：三选 + 终端跟随开关（默认关——ANSI 彩色浅底不可读） */}
        <div className="dialog-section">
          <p className="section-title">主题</p>
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
                  <p className="muted">无法查询最新版本（未检测到 node 环境）——可直接执行 claude update</p>
                ) : (
                  <p className="muted">
                    当前 {updateInfo.current} · 最新 {updateInfo.latest} ·{' '}
                    {updateInfo.upToDate ? '已是最新' : '可更新'}
                  </p>
                ))}
              {updateError !== '' && <p className="inline-error">{updateError}</p>}
            </>
          )}
        </div>

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

        {/* ⑤ 更新/安装执行输出（轻量只读区，非完整 xterm） */}
        <CliOutputView
          commandId={commandId}
          onExit={() => {
            // 完成后刷新版本信息（安装/更新都会改变 CLI 版本；spec T9 对应动作）
            void refreshCliInfo()
          }}
        />

        <div className="dialog-section">
          <div className="kv">
            许可证{' '}
            <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noreferrer">
              MIT
            </a>
            （源码随仓库分发，见 LICENSE 文件）
          </div>
          <div className="kv">作者 Liu Haitao</div>
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
