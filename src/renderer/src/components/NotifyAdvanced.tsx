import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useAppStore } from '../store'
import type { AnswerConfig, NotifyEventFlags } from '../../../shared/types'

/**
 * v2.2.0 设置页「推送事件开关 + 手机答复」区（webhook 配置之后）。
 *
 * - 事件开关：awaiting / stop / stopFailure / exit（子任务停止永不推送）；
 *   v2.2.2（用户 2026-11-17 指令）：exit 开关现仅管进程**自行退出**——显式停止
 *   （关窗/菜单/手机停止）与退出应用的「已停止/已退出」一律不推；
 *   且**全部事件按「桌面在场」门控**——presenceMin 分钟内有键入=人在电脑前，
 *   一切推送静默（本地/远程两侧对称；测试推送不经门控）；
 * - 手机答复：enabled / ttlSec / presenceMin + 通道状态（隧道/挂起数，main 经
 *   answer.state 帧推送）；
 * - 写路径按作用域 cid：本地 userData/notify.json / VM ~/.cwb/notify.json。
 */
export function NotifyEventsAnswer({ cid }: { cid?: string }) {
  const t = useI18n()
  const [events, setEvents] = useState<NotifyEventFlags | null>(null)
  const [answer, setAnswer] = useState<AnswerConfig | null>(null)
  const [error, setError] = useState('')
  const [ttlDraft, setTtlDraft] = useState('')
  const [presenceDraft, setPresenceDraft] = useState('')
  const answerStates = useAppStore((s) => s.answerStates)
  const state = answerStates[cid ?? 'local']

  useEffect(() => {
    let alive = true
    setEvents(null)
    setAnswer(null)
    setError('')
    void window.cwb
      .getNotifySettings(cid)
      .then((s) => {
        if (!alive) return
        setEvents(s.events)
        setAnswer(s.answer)
        setTtlDraft(String(s.answer.ttlSec))
        setPresenceDraft(String(s.answer.presenceMin))
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cid])

  async function patchEvents(patch: Partial<NotifyEventFlags>): Promise<void> {
    if (events === null) return
    setEvents({ ...events, ...patch })
    try {
      setEvents(await window.cwb.setNotifyEvents(patch, cid))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function patchAnswer(patch: Partial<AnswerConfig>): Promise<void> {
    if (answer === null) return
    setAnswer({ ...answer, ...patch })
    try {
      const next = await window.cwb.setAnswerConfig(patch, cid)
      setAnswer(next)
      setTtlDraft(String(next.ttlSec))
      setPresenceDraft(String(next.presenceMin))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (events === null || answer === null) {
    return error !== '' ? <p className="inline-error">{error}</p> : null
  }

  const tunnelText = (): string => {
    if (state === undefined) return t('settings.answerNeedServer')
    const s = state
    if (s.tunnel === 'up') return t('settings.answerTunnelUp', { url: s.baseUrl ?? '' })
    if (s.tunnel === 'starting') return t('settings.answerTunnelStarting')
    if (s.tunnel === 'down') return t('settings.answerTunnelDown')
    if (s.tunnel === 'missing') return t('settings.answerTunnelMissing')
    return t('settings.answerTunnelOff')
  }

  return (
    <div className="notify-advanced" data-testid="notify-advanced">
      <p className="form-subtitle">{t('settings.notifyEventsTitle')}</p>
      {(
        [
          ['awaiting', 'settings.notifyEventAwaiting'],
          ['stop', 'settings.notifyEventStop'],
          ['stopFailure', 'settings.notifyEventStopFailure'],
          ['exit', 'settings.notifyEventExit']
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="dialog-check">
          <input
            type="checkbox"
            checked={events[key]}
            onChange={(e) => void patchEvents({ [key]: e.target.checked })}
          />
          {t(label)}
        </label>
      ))}
      <p className="hint-small">{t('settings.notifyEventsHint')}</p>

      <p className="form-subtitle" style={{ marginTop: 12 }}>
        {t('settings.answerTitle')}
      </p>
      <label className="dialog-check">
        <input
          type="checkbox"
          checked={answer.enabled}
          onChange={(e) => void patchAnswer({ enabled: e.target.checked })}
        />
        {t('settings.answerEnable')}
      </label>
      <p className="hint-small">
        {t('settings.answerEnableHint', {
          ttl: Math.round(answer.ttlSec / 60),
          presence: answer.presenceMin
        })}
      </p>
      <div className="form-row">
        <label className="form-field">
          <span>{t('settings.answerTtl')}</span>
          <input
            type="number"
            min={60}
            max={86400}
            value={ttlDraft}
            onChange={(e) => setTtlDraft(e.target.value)}
            onBlur={() => {
              const n = Number(ttlDraft)
              if (Number.isInteger(n) && n !== answer.ttlSec) void patchAnswer({ ttlSec: n })
              else setTtlDraft(String(answer.ttlSec))
            }}
          />
        </label>
        <label className="form-field">
          <span>{t('settings.answerPresence')}</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={presenceDraft}
            onChange={(e) => setPresenceDraft(e.target.value)}
            onBlur={() => {
              const n = Number(presenceDraft)
              if (Number.isInteger(n) && n !== answer.presenceMin) void patchAnswer({ presenceMin: n })
              else setPresenceDraft(String(answer.presenceMin))
            }}
          />
        </label>
      </div>
      <p className="hint-small" data-testid="answer-channel-state">
        {tunnelText()}
        {state !== undefined ? ` · ${t('settings.answerPendingCount', { count: state.pendingCount })}` : ''}
      </p>
      {error !== '' && <p className="inline-error">{error}</p>}
    </div>
  )
}