import { useEffect, useState } from 'react'
import type { ConnectionRecord, RemoteProxyStatus } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'

/**
 * S2 testConnection 实际返回超集（TestConnectionOutcome：ok/error/kind/
 * hostKeyFingerprint/checks）——shared/types.ts 的 CWBApi.testConnection 仍声明
 * {ok,error}（契约面未同步），超集字段经 IPC 透传仍在，renderer 以本地宽类型消费
 * （{ok,error} 对本类型结构可赋值，无需断言）。契约升格待主控（见 S6 报告）。
 */
interface ConnTestResult {
  ok: boolean
  error?: string
  /** 结构化错误类（hostKeyConfirm=TOFU 待确认 / hostKeyChanged=指纹变更阻断…） */
  kind?: string
  /** hostKeyConfirm=待确认指纹 / hostKeyChanged=实际指纹 / ok=true=已验证指纹（原串回显） */
  hostKeyFingerprint?: string
  /** 只读自检四项清单（2.1/2.2：sshd/claude/node/server） */
  checks?: Array<{ id: string; status: 'ok' | 'missing' | 'unknown'; detail?: string }>
}

/** 自检项 id → 文案键（conn.check.*，S2 填值区） */
const CHECK_LABEL_KEYS: Record<string, MessageKey> = {
  sshd: 'conn.check.sshd',
  claude: 'conn.check.claude',
  node: 'conn.check.node',
  server: 'conn.check.server'
}
import { connStateText } from './statusVisual'

/** 连接档案表单态（password 为明文输入；保存时经 passwordEncrypted 字段
 *  传给 main 由 S2 safeStorage 加密落盘——编辑时留空=保持原值不回显。
 *  S2 语义：authMethod='key' 时该字段复用为可选的私钥口令密文） */
interface ConnFormState {
  id: string
  name: string
  host: string
  port: string
  user: string
  authMethod: 'key' | 'password'
  keyPath: string
  password: string
}

const emptyConnForm = (): ConnFormState => ({
  id: '',
  name: '',
  host: '',
  port: '22',
  user: '',
  authMethod: 'key',
  keyPath: '',
  password: ''
})

const connFormOf = (c: ConnectionRecord): ConnFormState => ({
  id: c.id,
  name: c.name,
  host: c.host,
  port: String(c.port),
  user: c.user,
  authMethod: c.authMethod,
  keyPath: c.keyPath ?? '',
  // 密码不回读展示（契约注：passwordEncrypted 仅 S2 connections-store 读写）
  password: ''
})

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 设置中心「远程连接」分类（S6）：
 * - 连接档案 CRUD（1.2=A/1.3=B：名称/host/port/user/认证方式=私钥+密码）；
 *   「测试连接」=只读自检（2.1/2.2）——现契约返回单条 {ok,error}（分级文案由 S2
 *   产生），结构化逐项清单待 S2 定形（见报告 concerns）；失败旁附 9.2 四类排障提示
 * - 远程代理面板（6.4=c）：getRemoteProxyStatus 状态卡 + setRemoteProxyConfig
 *   配置表单（本批 mock 驱动；S3/S4 联通后即活）
 */
export function ConnectionsSection({
  initialEditId,
  startInAdd = false
}: {
  initialEditId: string | null
  /** v1.7.0：__new__ 伪作用域——直接展开新建表单（保存成功切到新档案作用域） */
  startInAdd?: boolean
}) {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const connectionStates = useAppStore((s) => s.connectionStates)
  const saveConnectionFlow = useAppStore((s) => s.saveConnectionFlow)
  const removeConnectionFlow = useAppStore((s) => s.removeConnectionFlow)
  const setSettingsScope = useAppStore((s) => s.setSettingsScope)
  const connectFlow = useAppStore((s) => s.connectFlow)
  const disconnectFlow = useAppStore((s) => s.disconnectFlow)
  const [form, setForm] = useState<ConnFormState | null>(() => {
    if (startInAdd) return emptyConnForm()
    if (initialEditId === null) return null
    const target = useAppStore.getState().connections.find((c) => c.id === initialEditId)
    return target !== undefined ? connFormOf(target) : null
  })
  const [formError, setFormError] = useState('')
  /** v2.1.1 连接类型（'dev' 缺省；编辑预填）——纯 SSH：仅控制台+文件 */
  const [kind, setKind] = useState<'dev' | 'ssh'>('dev')
  const [savedMsg, setSavedMsg] = useState('')
  /** 保存进行中（2.0.2：防连点双建——空 id 表单双击保存会经 IPC 各建一条档案） */
  const [saving, setSaving] = useState(false)
  /** 测试连接结果（2.2：ok=通过；error=分级文案） */
  const [testResult, setTestResult] = useState<ConnTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const startAdd = (): void => {
    setForm(emptyConnForm())
    setKind('dev')
    setFormError('')
    setSavedMsg('')
    setTestResult(null)
  }
  const startEdit = (c: ConnectionRecord): void => {
    setForm(connFormOf(c))
    setKind(c.kind === 'ssh' ? 'ssh' : 'dev')
    setFormError('')
    setSavedMsg('')
    setTestResult(null)
  }

  const validate = (): string => {
    if (form === null) return ''
    if (form.name.trim() === '') return t('settings.providerName')
    if (form.host.trim() === '') return t('conn.dialog.host')
    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return t('conn.dialog.port')
    if (form.user.trim() === '') return t('conn.dialog.user')
    if (form.authMethod === 'key' && form.keyPath.trim() === '') return t('conn.dialog.keyPath')
    return ''
  }

  const save = async (): Promise<void> => {
    if (form === null || saving) return
    const missing = validate()
    if (missing !== '') {
      setFormError(t('s6.fieldInvalid', { field: missing }))
      return
    }
    const editing = connections.find((c) => c.id === form.id)
    const rec: ConnectionRecord = {
      id: form.id,
      name: form.name.trim(),
      ...(kind === 'ssh' ? { kind: 'ssh' as const } : {}),
      host: form.host.trim(),
      port: Number(form.port),
      user: form.user.trim(),
      authMethod: form.authMethod,
      ...(form.authMethod === 'key' ? { keyPath: form.keyPath.trim() } : {}),
      // 明文仅经 IPC 单程传递（main 侧 parseConnectionInput 读取后即刻 safeStorage
      // 加密；字段名必须用一次性 password——放进 passwordEncrypted 会被
      // main 当作既有密文透传而在 save 合并时丢弃 → 新建密码认证连接必失败）。
      // 留空=保持原值。
      ...(form.password !== '' ? { password: form.password } : {}),
      createdAt: editing?.createdAt ?? new Date().toISOString()
    }
    setFormError('')
    setSaving(true)
    let saved: ConnectionRecord | null
    try {
      saved = await saveConnectionFlow(rec)
    } finally {
      setSaving(false)
    }
    if (saved === null) {
      // 具体错误（「密码认证必须提供密码」等）透传展示——打包态用户无法开 DevTools
      // 看运行日志，「详见运行日志」等于没有信息
      const detail = useAppStore.getState().connectionSaveError
      setFormError(detail !== '' ? `${t('s6.saveFailed')}${detail}` : t('s6.saveFailed'))
      return
    }
    setForm(null)
    setSavedMsg(t('settings.providerSaved'))
    // v1.7.0：新建态保存成功 → 作用域从 __new__ 切到新档案（后续配置直接落右侧）
    if (startInAdd && useAppStore.getState().settingsScope === '__new__') {
      setSettingsScope(saved.id)
    }
  }

  const runTest = async (): Promise<void> => {
    if (form !== null && form.id === '') {
      setTestResult({ ok: false, error: t('s6.connTestNeedSave') })
      return
    }
    const id = form?.id ?? ''
    if (id === '') return
    setTesting(true)
    setTestResult(null)
    try {
      // 返回为 S2 超集（kind/fingerprint/checks）——{ok,error} 声明型对本类型可赋值
      const r: ConnTestResult = await window.cwb.testConnection(id)
      setTestResult(r)
    } catch (err) {
      setTestResult({ ok: false, error: errMsg(err) })
    } finally {
      setTesting(false)
    }
  }

  /**
   * TOFU 首连确认（1.5=A / S2 语义）：testConnection 返回 kind='hostKeyConfirm' +
   * 待确认指纹 → 用户确认后写入档案 lastHostKeyFingerprint 锁定 → 自动重测
   * （指纹为公开值，SHA256:xxx 原串回显与落盘，不做再格式化）。
   */
  const confirmHostKey = async (fingerprint: string): Promise<void> => {
    const id = form?.id ?? ''
    const existing = connections.find((c) => c.id === id)
    if (existing === undefined) return
    const saved = await saveConnectionFlow({ ...existing, lastHostKeyFingerprint: fingerprint })
    if (saved !== null) void runTest()
  }

  return (
    <div className="dialog-section">
      <p className="section-title">{t('conn.dialog.title')}</p>
      {/* v1.7.2（用户实测反馈）：当前作用域连接状态卡——「连接与自检」页必须自带
          连接/断开入口（此前仅锁定页 CTA 与侧栏菜单可达）；__new__/本机作用域不渲染 */}
      {(() => {
        const scope = useAppStore.getState().settingsScope
        const cur = connections.find((c) => c.id === scope)
        if (cur === undefined) return null
        const st = connectionStates[cur.id]?.state ?? 'offline'
        return (
          <div className="conn-scope-card" data-testid="conn-scope-card">
            <span className="conn-pill" data-state={st} title={connStateText(t, st)}>
              {connStateText(t, st)}
            </span>
            <span className="provider-url" title={`${cur.user}@${cur.host}:${cur.port}`}>
              {cur.user}@{cur.host}:{cur.port}
            </span>
            <span className="conn-scope-acts">
              {st === 'connected' ? (
                <button type="button" className="btn" onClick={() => void disconnectFlow(cur.id)}>
                  {t('conn.menu.disconnect')}
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={() => void connectFlow(cur.id)}>
                  {t('conn.menu.connect')}
                </button>
              )}
            </span>
          </div>
        )
      })()}
      {form === null ? (
        <>
          {connections.length === 0 && <p className="muted">{t('s6.connEmpty')}</p>}
          {connections.length > 0 && (
            <ul className="provider-list conn-list">
              {connections.map((c) => {
                const st = connectionStates[c.id]?.state
                return (
                  <li key={c.id} className="provider-row conn-row" data-connection-id={c.id}>
                    <span className="conn-pill" data-state={st ?? 'offline'} title={connStateText(t, st ?? 'offline')}>
                      {connStateText(t, st ?? 'offline')}
                    </span>
                    <span className="provider-name">{c.name}</span>
                    <span className="provider-url" title={`${c.user}@${c.host}:${c.port}`}>
                      {c.user}@{c.host}:{c.port}
                    </span>
                    <span className="provider-actions">
                      <button type="button" className="btn small" onClick={() => startEdit(c)}>
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn small danger"
                        title={t('conn.menu.removeConfirm')}
                        onClick={() => {
                          if (window.confirm(`${t('conn.menu.removeConfirm')}\n\n${c.name}`)) {
                            void removeConnectionFlow(c.id)
                          }
                        }}
                      >
                        {t('common.remove')}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={startAdd}>
              {t('s6.addConnection')}
            </button>
          </div>
          {savedMsg !== '' && (
            <p className="muted ok" role="status">
              {savedMsg}
            </p>
          )}
        </>
      ) : (
        <div className="provider-form" role="form" aria-label={t('conn.dialog.title')}>
          <p className="section-title">
            {form.id === '' ? t('s6.addConnection') : t('conn.menu.edit')}
          </p>
          <div className="settings-form">
            <div className="form-row">
              <span className="form-label">{t('settings.providerName')}</span>
              <div className="form-control">
                <input
                  className="settings-input grow"
                  type="text"
                  aria-label={t('settings.providerName')}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.host')}</span>
              <div className="form-control">
                <input
                  className="settings-input grow mono"
                  type="text"
                  aria-label={t('conn.dialog.host')}
                  placeholder="192.168.142.128"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.port')}</span>
              <div className="form-control">
                <input
                  className="settings-num"
                  type="number"
                  min={1}
                  max={65535}
                  aria-label={t('conn.dialog.port')}
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.user')}</span>
              <div className="form-control">
                <input
                  className="settings-input grow mono"
                  type="text"
                  aria-label={t('conn.dialog.user')}
                  placeholder="dev"
                  value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value })}
                />
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t('conn.kindLabel')}</span>
              <div className="form-control ssh-kind-row">
                <label className="dialog-check">
                  <input
                    type="radio"
                    name="conn-kind"
                    value="dev"
                    checked={kind === 'dev'}
                    onChange={() => setKind('dev')}
                  />
                  {t('conn.kindDev')}
                </label>
                <label className="dialog-check">
                  <input
                    type="radio"
                    name="conn-kind"
                    value="ssh"
                    checked={kind === 'ssh'}
                    onChange={() => setKind('ssh')}
                  />
                  {t('conn.kindSsh')}
                </label>
                {kind === 'ssh' && <span className="hint-inline">{t('conn.kindHint')}</span>}
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.authMethod')}</span>
              <div className="form-control theme-choice" role="radiogroup" aria-label={t('conn.dialog.authMethod')}>
                <label>
                  <input
                    type="radio"
                    name="conn-auth"
                    checked={form.authMethod === 'key'}
                    onChange={() => setForm({ ...form, authMethod: 'key' })}
                  />
                  {t('s6.authKey')}
                </label>
                <label>
                  <input
                    type="radio"
                    name="conn-auth"
                    checked={form.authMethod === 'password'}
                    onChange={() => setForm({ ...form, authMethod: 'password' })}
                  />
                  {t('conn.dialog.password')}
                </label>
              </div>
            </div>
            {form.authMethod === 'key' && (
              <div className="form-row">
                <span className="form-label">{t('conn.dialog.keyPath')}</span>
                <div className="form-control">
                  <input
                    className="settings-input grow mono"
                    type="text"
                    aria-label={t('conn.dialog.keyPath')}
                    placeholder="C:\Users\you\.ssh\id_ed25519"
                    value={form.keyPath}
                    onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                  />
                </div>
              </div>
            )}
            {form.authMethod === 'password' && (
              <div className="form-row">
                <span className="form-label">{t('conn.dialog.password')}</span>
                <div className="form-control">
                  <input
                    className="settings-input grow mono"
                    type="password"
                    autoComplete="new-password"
                    aria-label={t('conn.dialog.password')}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                  <span className="hint-inline">{t('s6.pwdHint')}</span>
                </div>
              </div>
            )}
            {/* S2 语义：私钥认证下 password 字段复用为可选的私钥口令（留空=无口令/保持原值） */}
            {form.authMethod === 'key' && (
              <div className="form-row">
                <span className="form-label">{t('s6.keyPassphrase')}</span>
                <div className="form-control">
                  <input
                    className="settings-input grow mono"
                    type="password"
                    autoComplete="new-password"
                    aria-label={t('s6.keyPassphrase')}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                  <span className="hint-inline">{t('s6.keyPassphraseHint')}</span>
                </div>
              </div>
            )}
          </div>
          {formError !== '' && <p className="inline-error">{formError}</p>}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn primary"
              disabled={saving || form.name.trim() === '' || form.host.trim() === ''}
              onClick={() => void save()}
            >
              {t('common.save')}
            </button>
            {/* 只读自检（2.1/2.2）：按已保存档案测试（新增未保存时禁用并提示） */}
            <button
              type="button"
              className="btn"
              disabled={testing || form.id === ''}
              title={form.id === '' ? t('s6.connTestNeedSave') : undefined}
              onClick={() => void runTest()}
            >
              {testing ? t('common.detecting') : t('conn.dialog.test')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setForm(null)
                setFormError('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
          {testResult !== null && (
            <div role="status" data-testid="conn-test-result">
              {testResult.ok ? (
                <p className="muted ok">{t('s6.connTestOk')}</p>
              ) : (
                <p className="inline-error">{testResult.error}</p>
              )}
              {/* 自检清单（S2 超集字段；✓=通过 / ✗=缺失（阻断） / ？=未探测） */}
              {testResult.checks !== undefined && testResult.checks.length > 0 && (
                <ul className="conn-checks">
                  {testResult.checks.map((c) => (
                    <li
                      key={c.id}
                      className="conn-check-item"
                      data-status={c.status}
                      title={c.detail ?? ''}
                    >
                      <span className="conn-check-mark">
                        {c.status === 'ok' ? '✓' : c.status === 'missing' ? '✗' : '？'}
                      </span>
                      {t(CHECK_LABEL_KEYS[c.id] ?? 'conn.check.sshd')}
                      {c.detail !== undefined && c.detail !== '' && (
                        <span className="conn-check-detail">{c.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {/* 主机指纹：原串回显（SHA256:xxx 不再格式化）；TOFU 待确认时提供
                  「确认并锁定」（写档案 lastHostKeyFingerprint 后自动重测）；变更=阻断告警 */}
              {testResult.hostKeyFingerprint !== undefined && (
                <p className="conn-fingerprint">
                  {t('s6.hostKeyFingerprint')}：
                  <code className="mono">{testResult.hostKeyFingerprint}</code>
                  {testResult.kind === 'hostKeyConfirm' && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void confirmHostKey(testResult.hostKeyFingerprint ?? '')}
                    >
                      {t('s6.confirmHostKey')}
                    </button>
                  )}
                </p>
              )}
              {testResult.kind === 'hostKeyChanged' && (
                <p className="inline-error">{t('s6.hostKeyChangedWarn')}</p>
              )}
              {/* 9.2=A 排障提示四类（连接类失败旁；结构化清单在场时由清单取代）：
                  VM 未启动 / sshd 未装 / NAT 未转发 / 密钥未授权 */}
              {!testResult.ok && testResult.checks === undefined && (
                <p className="hint-small conn-hints">
                  <b>{t('s6.connHintsTitle')}</b>
                  <span className="conn-hint-line">{t('s6.hintVmDown')}</span>
                  <span className="conn-hint-line">{t('s6.hintNoSshd')}</span>
                  <span className="conn-hint-line">{t('s6.hintNat')}</span>
                  <span className="conn-hint-line">{t('s6.hintKeyDenied')}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 远程代理面板（6.4=c）：代理由远程 server 内置，配置存 VM 侧；客户端经 SSH/
 * server 协议读写（getRemoteProxyStatus/setRemoteProxyConfig——本批 mock 驱动，
 * S3/S4 联通后即活）。连接选择 + 状态卡 + proxyUrl 配置表单。
 */
export function RemoteProxyPanel() {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const requestServerInstall = useAppStore((s) => s.requestServerInstall)
  const [connId, setConnId] = useState(connections[0]?.id ?? '')
  const [status, setStatus] = useState<RemoteProxyStatus | null>(null)
  const [proxyUrl, setProxyUrl] = useState('')
  /** v1.5.3：server 未安装（needInstall）不再显示原始错误——转安装确认弹窗 + 轻提示 */
  const [needInstall, setNeedInstall] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    if (connections.length > 0 && (connId === '' || !connections.some((c) => c.id === connId))) {
      setConnId(connections[0].id)
    }
  }, [connections, connId])

  const refresh = (id: string): void => {
    if (id === '') return
    setLoadError('')
    setNeedInstall(false)
    window.cwb
      .getRemoteProxyStatus(id)
      .then((s) => {
        setStatus(s)
        setProxyUrl(s.config?.proxyUrl ?? '')
      })
      .catch((err: unknown) => {
        setStatus(null)
        const message = errMsg(err)
        // 与 connectFlow 的 NEED_INSTALL_RE 同语义：server 缺失 → 安装确认弹窗
        // （面板留轻提示，不展示原始 IPC 错误串）
        if (/needinstall|cwb-server/i.test(message)) {
          setNeedInstall(true)
          requestServerInstall(id)
          return
        }
        setLoadError(message)
      })
  }

  // 选中连接即拉状态（面板打开/切换连接都走这里）
  useEffect(() => {
    refresh(connId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按连接 id 拉取
  }, [connId])

  const saveConfig = async (): Promise<void> => {
    if (connId === '') return
    setSaveMsg('')
    try {
      const saved = await window.cwb.setRemoteProxyConfig(connId, { proxyUrl: proxyUrl.trim() })
      setProxyUrl(saved.proxyUrl ?? '')
      setSaveMsg(t('settings.providerSaved'))
    } catch (err) {
      setSaveMsg(errMsg(err))
    }
  }

  // v1.6.1：VM 侧代理启停（server 帧 proxy.start/stop——S6 遗留缺口：此前状态卡
  // 永远「已停止」且无启用入口）。返回值即动作后状态，直接落卡。
  const [proxyBusy, setProxyBusy] = useState(false)
  const runProxyAction = async (action: 'start' | 'stop'): Promise<void> => {
    if (connId === '' || proxyBusy) return
    setLoadError('')
    setProxyBusy(true)
    try {
      setStatus(
        action === 'start'
          ? await window.cwb.startRemoteProxy(connId)
          : await window.cwb.stopRemoteProxy(connId)
      )
    } catch (err) {
      setLoadError(errMsg(err))
    } finally {
      setProxyBusy(false)
    }
  }

  return (
    <div className="remote-proxy-block" data-testid="remote-proxy-panel">
      <p className="section-title">{t('s6.remoteProxy')}</p>
      {connections.length === 0 ? (
        <p className="muted">{t('s6.connEmpty')}</p>
      ) : (
        <>
          <div className="settings-form">
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.title')}</span>
              <div className="form-control">
                <select
                  className="settings-select val"
                  aria-label={t('conn.dialog.title')}
                  value={connId}
                  onChange={(e) => setConnId(e.target.value)}
                >
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className={status?.running === true ? 'proxy-card' : 'proxy-card off'}>
            <span className="proxy-dot" />
            <div className="proxy-info">
              <b>{t('s6.remoteProxy')}</b>
              <span className="proxy-meta">
                {status === null
                  ? t('common.detecting')
                  : status.running
                    ? `${status.port ?? ''} · ${t('settings.proxyRunForMin', {
                        m: Math.max(0, Math.floor((Date.now() - new Date(status.startedAt ?? Date.now()).getTime()) / 60_000))
                      })}`
                    : t('settings.proxyStopped')}
              </span>
              <span className="proxy-meta soft">{t('s6.remoteProxyHint')}</span>
            </div>
            {status?.running === true && (
              <span className="proxy-stats">
                {t('settings.proxyRequests', { n: status.stats.total })}
                {' · '}
                {t('settings.proxyActive', { n: status.stats.active })}
                <br />
                {t('settings.proxySplit', { d: status.stats.direct, v: status.stats.viaProxy })}
              </span>
            )}
            {status !== null && (
              <span className="proxy-actions">
                {status.running ? (
                  <button
                    type="button"
                    className="btn small"
                    disabled={proxyBusy}
                    onClick={() => void runProxyAction('stop')}
                  >
                    {t('settings.proxyStopBtn')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    disabled={proxyBusy}
                    onClick={() => void runProxyAction('start')}
                  >
                    {t('settings.proxyStartBtn')}
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="settings-form">
            <div className="form-row">
              <span className="form-label">{t('settings.providerProxy')}</span>
              <div className="form-control">
                <input
                  className="settings-input grow mono"
                  type="text"
                  aria-label={t('settings.providerProxy')}
                  placeholder={t('settings.providerProxyPlaceholder')}
                  value={proxyUrl}
                  onChange={(e) => {
                    setProxyUrl(e.target.value)
                    setSaveMsg('')
                  }}
                />
                <button type="button" className="btn small" onClick={() => void saveConfig()}>
                  {t('common.save')}
                </button>
              </div>
            </div>
          </div>
          {needInstall && (
            <p className="muted" data-testid="proxy-need-install">
              {t('s6.serverMissingHint')}
              <button
                type="button"
                className="btn small"
                onClick={() => requestServerInstall(connId)}
              >
                {t('s6.installTitle')}
              </button>
            </p>
          )}
          {loadError !== '' && <p className="inline-error">{loadError}</p>}
          {saveMsg !== '' && (
            <p className="muted ok" role="status">
              {saveMsg}
            </p>
          )}
        </>
      )}
    </div>
  )
}
