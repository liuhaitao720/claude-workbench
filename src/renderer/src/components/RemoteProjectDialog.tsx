import { useEffect, useRef, useState } from 'react'
import type { ConnectionRecord, SftpBrowseResult } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'

/**
 * 远程项目注册对话框（3.1=C：手输 VM 绝对路径 + SFTP 目录浏览器）。
 * - 连接选择（store.connections）+ VM 绝对路径手输；路径校验须以 / 开头
 * - 「浏览」= browseRemoteDir 目录弹层（进入子目录/上一级/选择当前目录）；
 *   浏览失败展示分级错误文案（conn.err.*，S2 产生）
 * - 注册=registerRemoteProjectFlow（addProject 接线桩，见 store 注释）；存在性/
 *   git 检测反馈：成功落树（isGit 徽标）/失败展示 error
 */
export function RemoteProjectDialog({
  presetConnectionId,
  onClose
}: {
  /** 服务器菜单入口预选的连接档案 id（侧栏入口直开时已定） */
  presetConnectionId?: string
  onClose: () => void
}) {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const registerRemoteProjectFlow = useAppStore((s) => s.registerRemoteProjectFlow)
  // v2.1.1：纯 SSH 连接不可注册远程项目——候选只留开发机
  const devConns = connections.filter((c) => c.kind !== 'ssh')
  const [connectionId, setConnectionId] = useState(
    presetConnectionId ?? devConns[0]?.id ?? ''
  )
  const [dir, setDir] = useState('')
  const [error, setError] = useState('')
  const [browseOpen, setBrowseOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  useEscapeClose(onClose)

  const pathInvalid = dir.trim() !== '' && !dir.trim().startsWith('/')

  const submit = async (): Promise<void> => {
    const target = dir.trim()
    if (connectionId === '') return
    if (target === '' || !target.startsWith('/')) {
      setError(t('s6.pathInvalid'))
      return
    }
    setError('')
    setSubmitting(true)
    const r = await registerRemoteProjectFlow(connectionId, target)
    setSubmitting(false)
    if (r.ok) {
      onClose()
      return
    }
    setError(r.error)
  }

  return (
    <>
      <div
        className="dialog-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="dialog" role="dialog" aria-label={t('conn.menu.newProject')}>
          <p className="dialog-title">{t('conn.menu.newProject')}</p>
          <div className="settings-form">
            <div className="form-row">
              <span className="form-label">{t('conn.dialog.title')}</span>
              <div className="form-control">
                <select
                  className="settings-select val"
                  aria-label={t('conn.dialog.title')}
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  {devConns.length === 0 && <option value="">{t('s6.connEmpty')}</option>}
                  {devConns.map((c: ConnectionRecord) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.user}@{c.host})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <span className="form-label">{t('s6.remotePathLabel')}</span>
              <div className="form-control">
                <input
                  className="settings-input grow mono"
                  type="text"
                  aria-label={t('s6.remotePathLabel')}
                  placeholder="/home/dev/my-project"
                  value={dir}
                  onChange={(e) => {
                    setDir(e.target.value)
                    setError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={connectionId === ''}
                  onClick={() => setBrowseOpen(true)}
                >
                  {t('s6.browse')}
                </button>
              </div>
            </div>
          </div>
          {(pathInvalid || error !== '') && (
            <p className="inline-error">{error !== '' ? error : t('s6.pathInvalid')}</p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="btn primary"
              disabled={connectionId === '' || dir.trim() === '' || pathInvalid || submitting}
              onClick={() => void submit()}
            >
              {submitting ? t('common.detecting') : t('s6.register')}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
      {browseOpen && connectionId !== '' && (
        <RemoteDirBrowser
          connectionId={connectionId}
          onPick={(path) => {
            setDir(path)
            setBrowseOpen(false)
          }}
          onClose={() => setBrowseOpen(false)}
        />
      )}
    </>
  )
}

/**
 * SFTP 目录浏览器弹层（browseRemoteDir 目录树/列表形态）：目录可进入，文件仅展示
 * （远程项目根必须是目录——选择目标=当前目录）。请求失败展示分级错误（2.3）。
 */
function RemoteDirBrowser({
  connectionId,
  onPick,
  onClose
}: {
  connectionId: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const t = useI18n()
  const [result, setResult] = useState<SftpBrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const lastPathRef = useRef<string | undefined>(undefined)
  useEscapeClose(onClose)

  const load = (path?: string): void => {
    setLoading(true)
    lastPathRef.current = path
    window.cwb
      .browseRemoteDir(connectionId, path)
      .then((r) => setResult(r))
      .catch((err: unknown) =>
        setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
      )
      .finally(() => setLoading(false))
  }

  // 打开即从远端 home 开始（path 缺省语义，S1 契约）
  useEffect(() => {
    load(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时首载
  }, [])

  const dirs = (result?.entries ?? []).filter((e) => e.isDir)

  return (
    <div className="dialog-overlay sftp-overlay" role="dialog" aria-label={t('s6.browseTitle')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog sftp-dialog">
        <p className="dialog-title">{t('s6.browseTitle')}</p>
        <div className="sftp-path-row">
          <button
            type="button"
            className="btn small"
            disabled={loading || result?.path === undefined || result.path === '/'}
            title={t('s6.browseUp')}
            onClick={() => {
              const cur = result?.path
              if (cur === undefined) return
              load(cur.replace(/\/[^/]+$/, '') || '/')
            }}
          >
            ↑
          </button>
          <span className="sftp-path mono" title={result?.path}>
            {loading ? t('common.detecting') : (result?.path ?? '')}
          </span>
        </div>
        <ul className="sftp-list" data-testid="sftp-entries">
          {result?.ok === false && <li className="sftp-error">{result.error}</li>}
          {result?.ok === true && dirs.length === 0 && !loading && (
            <li className="sftp-empty">{t('s6.browseEmpty')}</li>
          )}
          {result?.ok === true &&
            dirs.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  className="sftp-entry"
                  onClick={() => load(`${result.path === '/' ? '' : result.path}/${e.name}`)}
                >
                  📁 {e.name}
                </button>
              </li>
            ))}
          {/* v1.5.4（用户指令）：只显示目录——main 侧 list() 已只返回目录（含
              指向目录的符号链接，LNK 跟链 stat 复核），文件不再展示 */}
        </ul>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn primary"
            disabled={result?.ok !== true}
            onClick={() => {
              if (result?.path !== undefined) onPick(result.path)
            }}
          >
            {t('s6.browsePick')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
