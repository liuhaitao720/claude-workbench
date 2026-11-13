import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ConnectionRecord } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'

/**
 * v2.1.2 ①：新建/编辑「纯 SSH 连接」对话框（SSH 视图专属；kind 恒 'ssh'）。
 * - 外壳照抄 RemoteProjectDialog 的 dialog-overlay/dialog/settings-form 惯例；
 *   标题右侧固定 SSH 徽标（.ssh-kind-badge），副标题说明纯 SSH 能力边界
 * - 表单字段对齐 ConnectionsSettings 的 form-row 惯例，但校验贴字段：
 *   失焦（onBlur）后校验，错误文案经 aria-describedby 关联到字段
 * - 认证单选与字段联动与 ConnectionsSettings 同构：密钥→密钥路径必填；
 *   密码→密码输入 + 👁 显示切换（不回显已存密文——留空=保持原值）
 * - 「测试连接」按已保存档案测试（对齐 ConnectionsSettings runTest 语义：
 *   新建未保存时提示先保存）；结果按 ConnTestResult 形态展示
 * - 保存经 saveConnectionFlow（失败文案落 store.connectionSaveError 并透传
 *   展示）；密码仅在非空时作为一次性明文 `password` 字段传入（字段名必须
 *   用 password——放 passwordEncrypted 会被 main 当既有密文在合并时丢弃）；
 *   保存进行中禁用按钮防连点
 */
interface ConnTestResult {
  ok: boolean
  error?: string
}

/** 表单字段键（校验/touched 追踪用） */
type FieldKey = 'name' | 'host' | 'port' | 'user' | 'keyPath'

export function SshConnectionDialog({
  initial,
  onClose
}: {
  /** 编辑态目标档案（缺省=新建；预填并保留 id/createdAt） */
  initial?: ConnectionRecord
  onClose: () => void
}) {
  const t = useI18n()
  const saveConnectionFlow = useAppStore((s) => s.saveConnectionFlow)
  const editing = initial !== undefined
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial !== undefined ? String(initial.port) : '22')
  const [user, setUser] = useState(initial?.user ?? '')
  const [authMethod, setAuthMethod] = useState<'key' | 'password'>(initial?.authMethod ?? 'key')
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? '')
  /** 明文密码/私钥口令（不回显；留空=保持原值，仅非空时随保存单程传递） */
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  /** 失焦后才校验的字段集（避免一打开就满屏红） */
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set())
  /** 保存失败文案（saveConnectionFlow 返回 null 时取 store.connectionSaveError） */
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<ConnTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  useEscapeClose(onClose)

  const fieldLabel = (f: FieldKey): string =>
    t(
      f === 'name'
        ? 'settings.providerName'
        : f === 'host'
          ? 'conn.dialog.host'
          : f === 'port'
            ? 'conn.dialog.port'
            : f === 'user'
              ? 'conn.dialog.user'
              : 'conn.dialog.keyPath'
    )

  /** 单字段校验：返回错误文案（空串=通过）；仅在失焦后展示 */
  const errorOf = (f: FieldKey): string => {
    if (!touched.has(f)) return ''
    let invalid = false
    if (f === 'name') invalid = name.trim() === ''
    else if (f === 'host') invalid = host.trim() === ''
    else if (f === 'port') {
      const p = Number(port)
      invalid = !Number.isInteger(p) || p < 1 || p > 65535
    } else if (f === 'user') invalid = user.trim() === ''
    else if (f === 'keyPath') invalid = authMethod === 'key' && keyPath.trim() === ''
    return invalid ? t('s6.fieldInvalid', { field: fieldLabel(f) }) : ''
  }

  const touch = (f: FieldKey): void => {
    setTouched((prev) => (prev.has(f) ? prev : new Set(prev).add(f)))
  }

  /** 全量校验（保存时用）：返回未通过字段集 */
  const invalidFields = (): FieldKey[] => {
    const out: FieldKey[] = []
    if (name.trim() === '') out.push('name')
    if (host.trim() === '') out.push('host')
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) out.push('port')
    if (user.trim() === '') out.push('user')
    if (authMethod === 'key' && keyPath.trim() === '') out.push('keyPath')
    return out
  }

  const save = async (): Promise<void> => {
    if (saving) return
    const invalid = invalidFields()
    if (invalid.length > 0) {
      // 报错贴字段：全部标 touched 让字段错误可见，不落盘
      setTouched(new Set(invalid))
      return
    }
    const rec: ConnectionRecord = {
      id: initial?.id ?? '',
      name: name.trim(),
      // kind 恒 'ssh'——本对话框只创建/编辑纯 SSH 连接
      kind: 'ssh',
      host: host.trim(),
      port: Number(port),
      user: user.trim(),
      authMethod,
      ...(authMethod === 'key' ? { keyPath: keyPath.trim() } : {}),
      // 明文仅经 IPC 单程传递（main 侧读取后即刻 safeStorage 加密）；留空=保持原值
      ...(password !== '' ? { password } : {}),
      createdAt: initial?.createdAt ?? new Date().toISOString(),
      ...(initial?.lastHostKeyFingerprint !== undefined
        ? { lastHostKeyFingerprint: initial.lastHostKeyFingerprint }
        : {})
    }
    setSaveError('')
    setSaving(true)
    let saved: ConnectionRecord | null
    try {
      saved = await saveConnectionFlow(rec)
    } finally {
      setSaving(false)
    }
    if (saved === null) {
      const detail = useAppStore.getState().connectionSaveError
      setSaveError(detail !== '' ? `${t('s6.saveFailed')}${detail}` : t('s6.saveFailed'))
      return
    }
    onClose()
  }

  /** 测试连接：按已保存档案测试（对齐 ConnectionsSettings runTest 语义） */
  const runTest = async (): Promise<void> => {
    if (initial === undefined) {
      setTestResult({ ok: false, error: t('s6.connTestNeedSave') })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.cwb.testConnection(initial.id)
      setTestResult({ ok: r.ok, error: r.error })
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const fieldInput = (f: FieldKey, input: ReactNode): ReactNode => {
    const err = errorOf(f)
    const errId = `ssh-conn-err-${f}`
    return (
      <div className="form-row">
        <span className="form-label">
          {fieldLabel(f)}
          <span aria-hidden="true"> *</span>
        </span>
        <div className="form-control">
          {input}
          {err !== '' && (
            <p className="ssh-field-error" id={errId} role="alert">
              {err}
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-label={t(editing ? 'ssh.connDialogTitleEdit' : 'ssh.connDialogTitleNew')}
      >
        <div className="ssh-conn-title-row">
          <p className="dialog-title">
            {t(editing ? 'ssh.connDialogTitleEdit' : 'ssh.connDialogTitleNew')}
          </p>
          <span className="ssh-kind-badge" title={t('ssh.connKindFixed')}>
            {t('conn.pureBadge')}
          </span>
        </div>
        <p className="dialog-hint">{t('ssh.connKindFixed')}</p>
        <div className="settings-form">
          {fieldInput(
            'name',
            <input
              className="settings-input grow"
              type="text"
              aria-label={t('settings.providerName')}
              aria-invalid={errorOf('name') !== ''}
              aria-describedby={errorOf('name') !== '' ? 'ssh-conn-err-name' : undefined}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => touch('name')}
            />
          )}
          {fieldInput(
            'host',
            <input
              className="settings-input grow mono"
              type="text"
              placeholder="192.168.80.128"
              aria-label={t('conn.dialog.host')}
              aria-invalid={errorOf('host') !== ''}
              aria-describedby={errorOf('host') !== '' ? 'ssh-conn-err-host' : undefined}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onBlur={() => touch('host')}
            />
          )}
          {fieldInput(
            'port',
            <input
              className="settings-num"
              type="number"
              min={1}
              max={65535}
              aria-label={t('conn.dialog.port')}
              aria-invalid={errorOf('port') !== ''}
              aria-describedby={errorOf('port') !== '' ? 'ssh-conn-err-port' : undefined}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onBlur={() => touch('port')}
            />
          )}
          {fieldInput(
            'user',
            <input
              className="settings-input grow mono"
              type="text"
              placeholder="dev"
              aria-label={t('conn.dialog.user')}
              aria-invalid={errorOf('user') !== ''}
              aria-describedby={errorOf('user') !== '' ? 'ssh-conn-err-user' : undefined}
              value={user}
              onChange={(e) => setUser(e.target.value)}
              onBlur={() => touch('user')}
            />
          )}
          <div className="form-row">
            <span className="form-label">{t('conn.dialog.authMethod')}</span>
            <div
              className="form-control theme-choice"
              role="radiogroup"
              aria-label={t('conn.dialog.authMethod')}
            >
              <label>
                <input
                  type="radio"
                  name="ssh-conn-auth"
                  checked={authMethod === 'key'}
                  onChange={() => setAuthMethod('key')}
                />
                {t('s6.authKey')}
              </label>
              <label>
                <input
                  type="radio"
                  name="ssh-conn-auth"
                  checked={authMethod === 'password'}
                  onChange={() => setAuthMethod('password')}
                />
                {t('conn.dialog.password')}
              </label>
            </div>
          </div>
          {authMethod === 'key' &&
            fieldInput(
              'keyPath',
              <input
                className="settings-input grow mono"
                type="text"
                placeholder="C:\Users\you\.ssh\id_ed25519"
                aria-label={t('conn.dialog.keyPath')}
                aria-invalid={errorOf('keyPath') !== ''}
                aria-describedby={errorOf('keyPath') !== '' ? 'ssh-conn-err-keyPath' : undefined}
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                onBlur={() => touch('keyPath')}
              />
            )}
          {authMethod === 'password' && (
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.password')}</span>
              <div className="form-control">
                <input
                  className="settings-input grow mono"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  aria-label={t('conn.dialog.password')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="btn small"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  👁
                </button>
                <span className="hint-inline">{t('s6.pwdHint')}</span>
              </div>
            </div>
          )}
        </div>
        {saveError !== '' && <p className="inline-error">{saveError}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="btn"
            disabled={testing || saving}
            title={editing ? undefined : t('s6.connTestNeedSave')}
            onClick={() => void runTest()}
          >
            {testing ? t('common.detecting') : t('conn.dialog.test')}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {t('common.save')}
          </button>
        </div>
        {testResult !== null && (
          <div role="status" data-testid="ssh-conn-test-result">
            {testResult.ok ? (
              <p className="muted ok">{t('s6.connTestOk')}</p>
            ) : (
              <p className="inline-error">{testResult.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
