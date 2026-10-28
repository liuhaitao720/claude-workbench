import { APP_VERSION, BUILD_DATE } from '../app-info'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'
import { useEscapeClose } from '../hooks/useEscapeClose'

/**
 * 「关于」弹窗（v0.9 瘦身为应用身份页）：
 * - 应用版本+构建日期 / 许可证 MIT / 作者 Liu Haitao（① 终版：版权作者只进
 *   About，状态栏仅版本号——沿革保留）
 * - 一行「claude CLI / 更多配置 → 打开设置」：v0.5 主题/通知/CLI 诸区全部
 *   迁往 SettingsDialog（openSettings + 关闭自身）
 * - 纯静态只读——无异步获取、无 CLI 子进程（CliOutputView/kill 逻辑随迁删除）
 * - v1.2.0：文案随界面语言（useI18n）
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n()
  const openSettings = useAppStore((s) => s.openSettings)

  // A1：document 级 Escape——焦点留在触发按钮（版本按钮）上也能关
  useEscapeClose(onClose)

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog dialog-scroll" role="dialog" aria-label={t('about.aria')}>
        <p className="dialog-title">Claude Workbench</p>
        <div className="dialog-section">
          <div className="kv">
            {t('about.version', { version: APP_VERSION })}
            {BUILD_DATE !== '' && t('about.build', { date: BUILD_DATE })}
          </div>
        </div>

        <div className="dialog-section">
          <div className="kv">
            {t('about.license')}{' '}
            <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noreferrer">
              MIT
            </a>
            {t('about.licenseTail')}
          </div>
          <div className="kv">{t('about.author')}</div>
        </div>

        {/* v0.9：配置入口收敛到设置中心——主题/通知/claude CLI 等均迁往 SettingsDialog */}
        <div className="dialog-section">
          <div className="kv">
            {t('about.settingsEntry')}{' '}
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => {
                openSettings()
                onClose()
              }}
            >
              {t('about.openSettings')}
            </button>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}