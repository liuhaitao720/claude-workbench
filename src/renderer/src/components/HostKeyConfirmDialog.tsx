import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'

/**
 * TOFU 首连确认弹窗（侧栏/终端等直连入口补齐——设置页「测试连接」路径的同等语义）。
 * 触发：connectFlow 失败命中 main 侧 [cwb:host-key-confirm] token
 * （store.pendingHostKeyConfirm）。确认 → confirmHostKeyFlow：指纹写入档案
 * lastHostKeyFingerprint 锁定 → 自动重连；取消仅关闭（连接保持 offline）。
 */
export function HostKeyConfirmDialog() {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const pending = useAppStore((s) => s.pendingHostKeyConfirm)
  const confirmHostKeyFlow = useAppStore((s) => s.confirmHostKeyFlow)
  const dismissHostKeyConfirm = useAppStore((s) => s.dismissHostKeyConfirm)
  useEscapeClose(dismissHostKeyConfirm)

  if (pending === null) return null
  const connection = connections.find((c) => c.id === pending.connectionId)

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismissHostKeyConfirm()
      }}
    >
      <div className="dialog" role="dialog" aria-label={t('s6.hostKeyConfirmTitle')}>
        <p className="dialog-title">
          {t('s6.hostKeyConfirmTitle')}
          {connection !== undefined ? ` · ${connection.name}` : ''}
        </p>
        <p className="dialog-hint">{t('s6.hostKeyConfirmBody')}</p>
        <p className="conn-fingerprint">
          {t('s6.hostKeyFingerprint')}：
          <code className="mono" data-testid="hostkey-confirm-fp">
            {pending.fingerprint}
          </code>
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void confirmHostKeyFlow(pending.fingerprint)}
          >
            {t('s6.confirmHostKey')}
          </button>
          <button type="button" className="btn" onClick={dismissHostKeyConfirm}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 连接失败轻提示（connectFlow 非 needInstall/hostKeyConfirm 失败的具体文案浮出） */
export function ConnectErrorToast() {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const connectError = useAppStore((s) => s.connectError)
  const dismissConnectError = useAppStore((s) => s.dismissConnectError)
  if (connectError === null) return null
  const connection = connections.find((c) => c.id === connectError.connectionId)

  return (
    <div
      className="connect-error-toast"
      role="alert"
      data-testid="connect-error-toast"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismissConnectError()
      }}
    >
      <div className="connect-error-head">
        <b>
          {t('s6.connectFailedToast')}
          {connection !== undefined ? ` · ${connection.name}` : ''}
        </b>
        <button
          type="button"
          className="btn small"
          aria-label={t('common.close')}
          onClick={dismissConnectError}
        >
          ×
        </button>
      </div>
      <div className="connect-error-msg">{connectError.message}</div>
    </div>
  )
}
