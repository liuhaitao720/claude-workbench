import { useEffect, useState } from 'react'
import type { RemoteProxyStatus } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * v1.7.0 cwb-server 分类（远程作用域专属——原型确认的新增页面）：
 * - 状态卡：经 proxy.status 探活（代理跑在 server 进程内——running 即 server 存活
 *   且协议可达），显示监听端口/请求统计
 * - 日志尾部：serverLogs 环形缓冲（安装弹窗同源数据，脱敏元数据）
 * - 「安装/升级/重装」：复用 ServerInstallDialog 全流程（SFTP 推送→sha256→
 *   健康探测→保版本回退），按钮只负责唤起确认弹窗
 * - 版本展示：安装/升级完成的日志行含版本号（无独立版本通道——不展示无据数据）
 */
export function ServerSection({ cid }: { cid: string }) {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const serverLogs = useAppStore((s) => s.serverLogs)
  const requestServerInstall = useAppStore((s) => s.requestServerInstall)
  const [status, setStatus] = useState<RemoteProxyStatus | null>(null)
  const [error, setError] = useState('')

  const name = connections.find((c) => c.id === cid)?.name ?? ''
  const logs = serverLogs.filter((e) => e.connectionId === cid).slice(-30)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.cwb
        .getRemoteProxyStatus(cid)
        .then((s) => {
          if (alive) {
            setStatus(s)
            setError('')
          }
        })
        .catch((err: unknown) => {
          if (alive) {
            setStatus(null)
            setError(errMsg(err))
          }
        })
    }
    load()
    const timer = window.setInterval(load, 10_000) // 轻量轮询（server 状态非推送语义）
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [cid])

  return (
    <div className="dialog-section" data-testid="server-section">
      <p className="section-title">
        {t('settings.sectionServer')}
        <span className="scope-suffix">{t('settings.scopeSuffixRemote')}</span>
      </p>
      <div className={status?.running === true ? 'proxy-card' : 'proxy-card off'}>
        <span className="proxy-dot" />
        <div className="proxy-info">
          <b>cwb-server{name !== '' ? ` · ${name}` : ''}</b>
          <span className="proxy-meta">
            {status === null
              ? error !== ''
                ? t('settings.serverDown')
                : t('common.detecting')
              : status.running
                ? `127.0.0.1:17717 · ${t('settings.proxyRunForMin', {
                    m: Math.max(0, Math.floor((Date.now() - new Date(status.startedAt ?? Date.now()).getTime()) / 60_000))
                  })}`
                : t('settings.serverDown')}
          </span>
          {status?.running === true && (
            <span className="proxy-meta soft">{t('settings.proxyRequests', { n: status.stats.total })}</span>
          )}
        </div>
        <button
          type="button"
          className={status?.running === true ? 'btn' : 'btn primary'}
          onClick={() => requestServerInstall(cid)}
        >
          {status?.running === true ? t('settings.serverReinstall') : t('settings.serverInstall')}
        </button>
      </div>
      {error !== '' && <p className="inline-error">{error}</p>}
      {logs.length > 0 && (
        <div className="install-log" role="log">
          {logs.map((e, i) => (
            <div key={i} className={`install-log-line ${e.level}`}>
              {e.message}
            </div>
          ))}
        </div>
      )}
      <p className="hint-small">{t('settings.serverHint')}</p>
    </div>
  )
}
