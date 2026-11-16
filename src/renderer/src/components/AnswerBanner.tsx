import { useEffect } from 'react'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'

/**
 * v2.2.0 手机答复：桌面横幅（全局）。
 *
 * 有挂起（本地任务交 server 代持 / 远程任务 server 直接持有）时浮于底部：
 * 显示任务/项目 + 问题数 + 手机页面链接；「回电脑处理」释放 hook（claude 回落 TUI）。
 * 手机作答成功后 server 广播 answer.resolved → 横幅自动消失 + 提示 toast。
 */
export function AnswerBanner() {
  const t = useI18n()
  const pendings = useAppStore((s) => s.answerPendings)
  const tasks = useAppStore((s) => s.tasks)
  const projects = useAppStore((s) => s.projects)
  const cancelAnswer = useAppStore((s) => s.cancelAnswer)
  const openExternal = window.cwb.openExternal

  if (pendings.length === 0) return null
  return (
    <div className="answer-banner" role="status" data-testid="answer-banner">
      <div className="answer-banner-head">{t('answer.bannerTitle')}</div>
      {pendings.map((p) => {
        const task = tasks.find((x) => x.id === p.pending.taskId)
        const project = task !== undefined ? projects.find((x) => x.id === task.projectId) : undefined
        return (
          <div
            key={p.pending.pendingId}
            className="answer-banner-item"
            data-testid={`answer-pending-${p.pending.pendingId}`}
          >
            <span className="answer-banner-meta">
              {t('answer.bannerMeta', {
                task: task?.name ?? p.pending.taskName,
                project: project?.name ?? p.pending.projectName ?? ''
              })}
              {p.pending.questions.length > 0
                ? ` · ${t('answer.bannerQuestionCount', { count: p.pending.questions.length })}`
                : ''}
            </span>
            <span className="answer-banner-acts">
              {p.url !== undefined && p.url !== '' ? (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void openExternal(p.url!)}
                >
                  {t('answer.openPage')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn small primary"
                onClick={() =>
                  cancelAnswer(p.pending.pendingId, p.pending.taskId, p.connectionId)
                }
              >
                {t('answer.backToDesktop')}
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * v2.2.0：手机已代答提示（by=phone & action=answered）；10 秒自动收起。
 */
export function AnswerNoticeToast() {
  const t = useI18n()
  const notice = useAppStore((s) => s.answerNotice)
  const dismiss = useAppStore((s) => s.dismissAnswerNotice)
  const tasks = useAppStore((s) => s.tasks)

  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => dismiss(), 10_000)
    return () => window.clearTimeout(timer)
  }, [notice, dismiss])

  if (notice === null) return null
  const task = tasks.find((x) => x.id === notice.taskId)
  return (
    <div className="review-hint-toast" role="status" data-testid="answer-notice-toast">
      <span>{t('answer.notice', { task: task?.name ?? notice.taskId.slice(0, 8) })}</span>
      <button type="button" className="btn small" onClick={dismiss}>
        {t('common.close')}
      </button>
    </div>
  )
}