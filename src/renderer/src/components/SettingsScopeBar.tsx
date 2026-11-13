import { useAppStore } from '../store'
import { useI18n } from '../i18n'

/**
 * v1.7.0 设置中心作用域条（用户确认的原型：顶部切换——本机 | 各连接 | ＋新建）：
 * - tab 集 = 连接档案列表（动态增删——删除连接即删除作用域）
 * - 状态点=连接四态胶囊同源（绿=已连接；灰=其余）
 * - ＋新建 = 进入 '__new__' 伪作用域（rail 仅「连接与自检」，ConnectionsSection
 *   直接展开新建表单；保存成功由调用方切到新档案作用域，取消回落本机）
 * - 右侧常显当前作用域数据源提示（本机 userData / VM ~/.cwb——结构性消灭
 *   "不知道在编辑哪侧"）
 */
export const NEW_SCOPE = '__new__'

export function SettingsScopeBar() {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const connectionStates = useAppStore((s) => s.connectionStates)
  const scope = useAppStore((s) => s.settingsScope)
  const setSettingsScope = useAppStore((s) => s.setSettingsScope)

  const isActive = (v: 'local' | string): boolean => scope === v
  const source =
    scope === 'local'
      ? t('settings.scopeSourceLocal')
      : scope === NEW_SCOPE
        ? t('settings.scopeSourceNew')
        : t('settings.scopeSourceRemote', {
            name: connections.find((c) => c.id === scope)?.name ?? ''
          })

  return (
    <div className="scope-bar" role="tablist" aria-label={t('settings.scopeBarLabel')} data-testid="settings-scope-bar">
      <button
        type="button"
        role="tab"
        aria-selected={isActive('local')}
        className={`scope-tab${isActive('local') ? ' active' : ''}`}
        onClick={() => setSettingsScope('local')}
      >
        {t('settings.scopeLocal')}
      </button>
      {/* v2.1.2 ②：设置作用域条无纯 SSH tab——纯 SSH 增删改在 SSH 视图完成 */}
      {connections.filter((c) => c.kind !== 'ssh').map((c) => {
        const st = connectionStates[c.id]?.state
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={isActive(c.id)}
            className={`scope-tab${isActive(c.id) ? ' active' : ''}`}
            onClick={() => setSettingsScope(c.id)}
            data-testid={`scope-tab-${c.id}`}
          >
            <span className="scope-dot" data-state={st ?? 'offline'} />
            {c.name}
            <span className="scope-sub">{c.host}</span>
          </button>
        )
      })}
      <button
        type="button"
        className="scope-tab add"
        onClick={() => setSettingsScope(NEW_SCOPE)}
        title={t('settings.scopeAddTitle')}
      >
        ＋
      </button>
      <span className="scope-src">{source}</span>
    </div>
  )
}
