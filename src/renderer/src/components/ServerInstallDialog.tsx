import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'

/**
 * cwb-server 安装/升级确认弹窗（6.7=A 首连推送；①F5 弹窗 UI 归 S6）。
 * 触发：connectFlow 失败命中 needInstall 信号（store.pendingServerInstall——S2
 * 联通前以错误文案标记判定，见 store.ts NEED_INSTALL_RE 注释）。
 * 消费 installRemoteServer 的 promise 形态（S7 main 侧实现）；进度经
 * onRemoteServerLog → store.serverLogs（S6 已订阅）滚动展示；成功后自动重连。
 */
export function ServerInstallDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const pending = useAppStore((s) => s.pendingServerInstall)
  const serverLogs = useAppStore((s) => s.serverLogs)
  const connectFlow = useAppStore((s) => s.connectFlow)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const logBoxRef = useRef<HTMLDivElement>(null)
  useEscapeClose(onClose)

  const connectionId = pending?.connectionId ?? ''
  const connection = connections.find((c) => c.id === connectionId)
  const logs = serverLogs.filter((e) => e.connectionId === connectionId)

  // 新日志到达自动滚到底（安装输出通常一屏放不下）
  useEffect(() => {
    const box = logBoxRef.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }, [logs.length])

  if (pending === null) return null

  const runInstall = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await window.cwb.installRemoteServer(connectionId)
      setResult(r)
      if (r.ok) {
        // 安装成功 → 自动重连（6.7：首连推送完成后继续原连接流）
        await connectFlow(connectionId)
      }
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog install-dialog" role="dialog" aria-label={t('s6.installTitle')}>
        <p className="dialog-title">
          {t('s6.installTitle')}
          {connection !== undefined ? ` · ${connection.name}` : ''}
        </p>
        <p className="dialog-hint">{t('s6.installBody')}</p>
        {logs.length > 0 && (
          <div className="install-log" ref={logBoxRef} role="log">
            {logs.map((e, i) => (
              <div key={i} className={`install-log-line ${e.level}`}>
                {e.message}
              </div>
            ))}
          </div>
        )}
        {result !== null && !result.ok && (
          <p className="inline-error">{t('s6.installFailed', { error: result.error ?? '' })}</p>
        )}
        {result?.ok === true && <p className="muted ok">{t('s6.installOk')}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void runInstall()}
          >
            {busy ? t('s6.installing') : t('s6.installBtn')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy && result === null}
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
