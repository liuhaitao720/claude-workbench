import { useEffect, useRef, useState } from 'react'
import type { SkillInfo, SkillMarketEntry, SkillMarketplaceInfo } from '../../../shared/types'
import { useAppStore } from '../store'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useI18n } from '../i18n'
import { CliOutputView } from './CliOutputView'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type SkillsTab = 'installed' | 'market' | 'import'

/**
 * Skills 管理弹窗（v0.5③；v1.2.0 在线搜索安装；v1.2.1 改为三页签）。
 *
 * 之前的单页布局把「已安装 / 在线搜索 / 导入」三块从上到下摞在一起，列表一长就要
 * 整页滚动、底部导入区常常看不见。现在拆成三个页签：弹窗高度固定，只有当前页签的
 * 列表内部滚动，标题栏（含数量）与关闭按钮恒定可见。
 *
 * - 已安装：用户级/项目级分组，行=名称+描述+版本/作者+移除（回收站）
 * - 在线搜索：本机 marketplace 目录（main 侧只读解析），关键词 + marketplace 过滤
 *   + 安装量排序；「安装」走 CLI 受控模板 `claude plugin install <id>@<mkt> -y`
 * - 导入：目标 scope 单选 + 导入文件夹 + CLI 命令输入 + 内嵌输出区
 * 三页签共用同一个命令输出区（commandId 生命周期跨页签，切页签不丢进度）。
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n()
  const projects = useAppStore((s) => s.projects)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

  const [tab, setTab] = useState<SkillsTab>('installed')

  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [listError, setListError] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [cliCommand, setCliCommand] = useState('')
  const [cliError, setCliError] = useState('')
  const [commandId, setCommandId] = useState<string | null>(null)
  const [toast, setToast] = useState(false)

  // ── 在线搜索（v1.2.0）─────────────────────────────────
  const [marketQuery, setMarketQuery] = useState('')
  const [marketFilter, setMarketFilter] = useState('')
  const [marketplaces, setMarketplaces] = useState<SkillMarketplaceInfo[]>([])
  const [entries, setEntries] = useState<SkillMarketEntry[] | null>(null)
  const [marketError, setMarketError] = useState('')
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** v1.2.1 正在切换启用状态的插件 id（按钮禁用防连点） */
  const [togglingPluginId, setTogglingPluginId] = useState<string | null>(null)

  // A1：document 级 Escape——焦点不在弹窗子树内也可靠关闭
  useEscapeClose(onClose)

  const refresh = async () => {
    try {
      setSkills(await window.cwb.listSkills())
      setListError('')
    } catch (err) {
      setListError(errMsg(err))
    }
  }

  /** 搜索（query/过滤变化即查——本地文件读取，毫秒级，无需防抖） */
  const searchMarket = async (query: string, filter: string): Promise<void> => {
    try {
      const list = await window.cwb.searchSkillMarket(query, filter === '' ? undefined : filter, 100)
      setEntries(list)
      setMarketError('')
    } catch (err) {
      setEntries([])
      setMarketError(errMsg(err))
    }
  }

  const loadMarketplaces = async (): Promise<void> => {
    try {
      setMarketplaces(await window.cwb.listSkillMarketplaces())
    } catch {
      setMarketplaces([]) // 过滤器缺失不阻塞搜索（全量仍可查）
    }
  }

  useEffect(() => {
    void refresh()
    void loadMarketplaces()
    // 首查由下方 [marketQuery, marketFilter] effect 负责（只发一次 IPC）
  }, [])

  useEffect(() => {
    void searchMarket(marketQuery, marketFilter)
  }, [marketQuery, marketFilter])

  // toast 一次性展示 6s 后自动消失
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(false), 6_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // 关闭防孤儿：卸载时终止仍在执行的 CLI 命令（覆盖 overlay/Escape/按钮全关闭路径）
  const commandIdRef = useRef(commandId)
  commandIdRef.current = commandId
  useEffect(
    () => () => {
      if (commandIdRef.current !== null) window.cwb.killCliCommand(commandIdRef.current)
    },
    []
  )

  const importFolder = async () => {
    // TS 无法跨 scope 相关条件收窄——先落 target 再走统一校验
    let target: { scope: 'user' } | { scope: 'project'; projectId: string }
    if (scope === 'project') {
      if (selectedProjectId === null) {
        setImportError(t('skills.noProject'))
        return
      }
      target = { scope: 'project', projectId: selectedProjectId }
    } else {
      target = { scope: 'user' }
    }
    let dir: string | null
    try {
      dir = await window.cwb.pickDirectory()
    } catch (err) {
      setImportError(errMsg(err))
      return
    }
    if (dir === null) return // 用户取消目录选择
    setImporting(true)
    setImportError('')
    try {
      await window.cwb.importSkillFolder(dir, target)
      await refresh()
      setToast(true)
    } catch (err) {
      setImportError(errMsg(err)) // 同名冲突/缺 SKILL.md 等行内显示
    } finally {
      setImporting(false)
    }
  }

  const runCli = async () => {
    const cmd = cliCommand.trim()
    if (cmd === '') return
    setCliError('')
    try {
      const r = await window.cwb.runCliCommand(cmd)
      setCommandId(r.commandId)
    } catch (err) {
      setCliError(errMsg(err)) // 校验失败（白名单/元字符）原因行内显示
    }
  }

  /** 安装市场条目：CLI 受控模板执行，输出复用同一输出区（切到「导入」页签可看进度） */
  const installEntry = async (entry: SkillMarketEntry): Promise<void> => {
    setInstallingId(entry.installId)
    setMarketError('')
    try {
      const r = await window.cwb.installMarketSkill(entry.installId)
      if (!r.ok) {
        setMarketError(t('skills.marketInstallFailed', { error: r.error ?? '' }))
        return
      }
      if (r.commandId !== undefined) setCommandId(r.commandId)
    } catch (err) {
      setMarketError(t('skills.marketInstallFailed', { error: errMsg(err) }))
    } finally {
      setInstallingId(null)
    }
  }

  /** 刷新 marketplace 目录（claude plugin marketplace update）；退出后重查出条目 */
  const refreshMarket = async (): Promise<void> => {
    setRefreshing(true)
    setMarketError('')
    try {
      const r = await window.cwb.refreshSkillMarket()
      if (!r.ok) {
        setMarketError(t('skills.marketInstallFailed', { error: r.error ?? '' }))
        return
      }
      if (r.commandId !== undefined) setCommandId(r.commandId)
    } catch (err) {
      setMarketError(t('skills.marketInstallFailed', { error: errMsg(err) }))
    } finally {
      setRefreshing(false)
    }
  }

  const removeSkill = async (skill: SkillInfo) => {
    if (!window.confirm(t('skills.removeConfirm', { name: skill.name }))) return
    try {
      await window.cwb.removeSkill(skill)
      await refresh()
    } catch (err) {
      setListError(errMsg(err)) // realpath 归属校验失败等行内提示
    }
  }

  /**
   * v1.2.1 插件 skill 启用/停用：`claude plugin enable|disable` 不改文件，只改
   * settings.json 的 enabledPlugins；命令退出后重扫列表（同一插件下多个 skill 一起变）。
   */
  const togglePlugin = async (skill: SkillInfo, enabled: boolean): Promise<void> => {
    if (skill.pluginId === undefined) return
    setTogglingPluginId(skill.pluginId)
    setListError('')
    try {
      const r = await window.cwb.setSkillPluginEnabled(skill.pluginId, enabled)
      if (!r.ok) {
        setListError(r.error ?? t('skills.marketInstallFailed', { error: '' }))
        return
      }
      if (r.commandId !== undefined) setCommandId(r.commandId)
    } catch (err) {
      setListError(errMsg(err))
    } finally {
      setTogglingPluginId(null)
    }
  }

  const projectNameOf = (projectId?: string): string =>
    projects.find((p) => p.id === projectId)?.name ?? ''

  const installedCount = skills?.length ?? 0

  /**
   * v1.2.1 用户指令：按「生效方式」分组，默认生效的排前面、需要显式指定的其次、
   * 停用的最后。同一技能在哪个根（用户级/项目级/插件）不再决定顺序——那是来源
   * 信息，写在行内 meta；这里排序的唯一依据是「你在会话里到底会不会自动用上它」。
   */
  const isInactive = (s: SkillInfo): boolean => s.source === 'plugin' && s.pluginEnabled === false
  const isManual = (s: SkillInfo): boolean => s.activation === 'manual'
  const effectiveSkills = (skills ?? []).filter((s) => !isInactive(s) && !isManual(s))
  const manualSkills = (skills ?? []).filter((s) => !isInactive(s) && isManual(s))
  const inactiveSkills = (skills ?? []).filter(isInactive)

  /** 行内来源标签（替代原按根分组的组头信息） */
  const sourceTag = (s: SkillInfo): string => {
    if (s.source === 'plugin') return t('skills.sourcePlugin', { id: s.pluginId ?? '' })
    if (s.source === 'project') return t('skills.sourceProject', { name: projectNameOf(s.projectId) })
    return t('skills.sourceUser')
  }

  const tabs: ReadonlyArray<{ id: SkillsTab; label: string; count?: number }> = [
    { id: 'installed', label: t('skills.tabInstalled'), count: installedCount },
    { id: 'market', label: t('skills.tabMarket') },
    { id: 'import', label: t('skills.tabImport') }
  ]

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog skills-dialog" role="dialog" aria-label={t('skills.aria')}>
        <div className="dialog-head">
          <p className="dialog-title">{t('skills.title')}</p>
          <button
            type="button"
            className="btn-icon dialog-close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="seg-tabs" role="tablist" aria-label={t('skills.tabsAria')}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'seg-tab active' : 'seg-tab'}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.count !== undefined && item.count > 0 && (
                <span className="seg-tab-count">{item.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="skills-body">
          {tab === 'installed' && (
            <div className="skills-pane">
              {skills === null && listError === '' && <p className="muted">{t('common.loading')}</p>}
              {listError !== '' && <p className="inline-error">{listError}</p>}
              {skills !== null && skills.length === 0 && (
                <div className="skills-empty">
                  <p>{t('skills.empty')}</p>
                  <div className="dialog-actions">
                    <button type="button" className="btn primary" onClick={() => setTab('market')}>
                      {t('skills.tabMarket')}
                    </button>
                    <button type="button" className="btn" onClick={() => setTab('import')}>
                      {t('skills.tabImport')}
                    </button>
                  </div>
                </div>
              )}
              {skills !== null && skills.length > 0 && (
                <p className="hint-small skills-installed-hint">{t('skills.installedHint')}</p>
              )}
              {effectiveSkills.length > 0 && (
                <>
                  <p className="skill-group-title">
                    {t('skills.groupEffective')}
                    <span className="skill-group-sub">{t('skills.groupEffectiveSub')}</span>
                  </p>
                  <ul className="skill-list">
                    {effectiveSkills.map((s) => (
                      <SkillRow
                        key={s.dir}
                        skill={s}
                        sourceTag={sourceTag(s)}
                        toggling={togglingPluginId === s.pluginId}
                        onRemove={removeSkill}
                        onTogglePlugin={togglePlugin}
                      />
                    ))}
                  </ul>
                </>
              )}
              {manualSkills.length > 0 && (
                <>
                  <p className="skill-group-title">
                    {t('skills.groupManual')}
                    <span className="skill-group-sub">{t('skills.groupManualSub')}</span>
                  </p>
                  <ul className="skill-list">
                    {manualSkills.map((s) => (
                      <SkillRow
                        key={s.dir}
                        skill={s}
                        sourceTag={sourceTag(s)}
                        toggling={togglingPluginId === s.pluginId}
                        onRemove={removeSkill}
                        onTogglePlugin={togglePlugin}
                      />
                    ))}
                  </ul>
                </>
              )}
              {inactiveSkills.length > 0 && (
                <>
                  <p className="skill-group-title">
                    {t('skills.groupInactive')}
                    <span className="skill-group-sub">{t('skills.groupInactiveSub')}</span>
                  </p>
                  <ul className="skill-list">
                    {inactiveSkills.map((s) => (
                      <SkillRow
                        key={s.dir}
                        skill={s}
                        sourceTag={sourceTag(s)}
                        toggling={togglingPluginId === s.pluginId}
                        onRemove={removeSkill}
                        onTogglePlugin={togglePlugin}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === 'market' && (
            <div className="skills-pane">
              <div className="market-search-row">
                <input
                  className="market-search-input"
                  type="text"
                  placeholder={t('skills.marketSearchPlaceholder')}
                  aria-label={t('skills.marketSearchAria')}
                  value={marketQuery}
                  onChange={(e) => setMarketQuery(e.target.value)}
                />
                <select
                  className="market-filter"
                  aria-label={t('skills.marketFilterAria')}
                  value={marketFilter}
                  onChange={(e) => setMarketFilter(e.target.value)}
                >
                  <option value="">{t('skills.marketAll')}</option>
                  {marketplaces.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} ({m.count})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={refreshing}
                  title={t('skills.marketRefresh')}
                  onClick={() => void refreshMarket()}
                >
                  {refreshing ? t('skills.marketRefreshing') : t('common.refresh')}
                </button>
              </div>
              <p className="hint-small">{t('skills.marketHint')}</p>
              {marketplaces.length === 0 && (
                <p className="muted">{t('skills.marketNoMarketplaces')}</p>
              )}
              {marketError !== '' && <p className="inline-error">{marketError}</p>}
              {entries !== null && entries.length === 0 && marketplaces.length > 0 && (
                <p className="muted">{t('skills.marketEmpty')}</p>
              )}
              {entries !== null && entries.length > 0 && (
                <>
                  <p className="skills-result-count">
                    {t('skills.marketCount', { count: entries.length })}
                  </p>
                  <ul className="skill-list">
                    {entries.map((e) => (
                      <li className="skill-row" key={e.installId} data-market-install-id={e.installId}>
                        <div className="skill-row-main">
                          <span className="skill-name" title={e.installId}>
                            {e.name}
                          </span>
                          <span className="skill-meta">
                            {[e.marketplace, e.category, e.author ?? '']
                              .filter((x) => x !== '')
                              .join(' · ')}
                            {e.installs > 0
                              ? ` · ${t('skills.marketInstalls', { count: e.installs })}`
                              : ''}
                          </span>
                          <button
                            type="button"
                            className="btn btn-mini primary"
                            disabled={installingId !== null || commandId !== null}
                            onClick={() => void installEntry(e)}
                          >
                            {installingId === e.installId
                              ? t('skills.marketInstalling')
                              : t('skills.marketInstall')}
                          </button>
                        </div>
                        {e.description !== '' && (
                          <div className="skill-desc" title={e.description}>
                            {e.description}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === 'import' && (
            <div className="skills-pane">
              <p className="hint-small">{t('skills.importHint')}</p>
              <div className="import-scope" role="radiogroup" aria-label={t('skills.importScopeAria')}>
                <label>
                  <input
                    type="radio"
                    name="skill-scope"
                    checked={scope === 'user'}
                    onChange={() => setScope('user')}
                  />
                  {t('skills.userScope')}
                </label>
                <label title={selectedProject ? undefined : t('skills.selectProjectFirst')}>
                  <input
                    type="radio"
                    name="skill-scope"
                    checked={scope === 'project'}
                    disabled={selectedProject === null}
                    onChange={() => setScope('project')}
                  />
                  {selectedProject
                    ? t('skills.projectScope', { name: selectedProject.name })
                    : t('skills.projectScopeNone')}
                </label>
              </div>
              <div className="dialog-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={importing}
                  onClick={() => void importFolder()}
                >
                  {t('skills.importFolder')}
                </button>
              </div>
              {importError !== '' && <p className="inline-error">{importError}</p>}
              <div className="cli-run-row">
                <input
                  type="text"
                  className="cli-command-input"
                  placeholder={t('skills.commandPlaceholder')}
                  aria-label={t('skills.commandAria')}
                  value={cliCommand}
                  onChange={(e) => setCliCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runCli()
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={cliCommand.trim() === ''}
                  onClick={() => void runCli()}
                >
                  {t('skills.run')}
                </button>
              </div>
              {cliError !== '' && <p className="inline-error">{cliError}</p>}
            </div>
          )}
        </div>

        {/* 命令输出区常驻页签下方（跨页签保留：在「在线搜索」点的安装，切到导入可看进度） */}
        <CliOutputView
          commandId={commandId}
          exitHint={t('skills.effectHint')}
          onExit={(code) => {
            void refresh()
            void loadMarketplaces()
            void searchMarket(marketQuery, marketFilter)
            if (code === 0) setToast(true)
          }}
        />

        {toast && (
          <div className="toast" role="status">
            {t('skills.effectHint')}
          </div>
        )}
      </div>
    </div>
  )
}

function SkillRow({
  skill,
  sourceTag,
  toggling,
  onRemove,
  onTogglePlugin
}: {
  skill: SkillInfo
  /** 来源标签（用户级 / 项目级 · 名称 / 插件 · id）——v1.2.1 不再按来源分组 */
  sourceTag?: string
  /** 该插件正在切换启用状态（按钮禁用 + 文案） */
  toggling?: boolean
  onRemove?: (s: SkillInfo) => void
  onTogglePlugin?: (s: SkillInfo, enabled: boolean) => void
}) {
  const t = useI18n()
  const meta = [
    skill.version !== undefined ? `v${skill.version}` : '',
    skill.author ?? '',
    sourceTag ?? ''
  ]
    .filter((x) => x !== '')
    .join(' · ')
  const isPlugin = skill.source === 'plugin'

  /** 生效方式徽标（默认生效不挂标签——列表默认项，标签只标「需要注意的」） */
  const activationBadge = ((): { cls: string; text: string; title: string } | null => {
    switch (skill.activation) {
      case 'manual':
        return { cls: 'skill-badge-activation', text: t('skills.badgeManual'), title: t('skills.groupManualSub') }
      case 'paths':
        return { cls: 'skill-badge-activation', text: t('skills.badgePaths'), title: t('skills.groupEffectiveSub') }
      case 'modelOnly':
        return { cls: 'skill-badge-activation', text: t('skills.badgeModelOnly'), title: t('skills.groupEffectiveSub') }
      default:
        return null
    }
  })()

  return (
    <li
      className="skill-row"
      data-skill-name={skill.name}
      data-activation={skill.activation ?? 'auto'}
      {...(isPlugin ? { 'data-plugin-id': skill.pluginId ?? '' } : {})}
      data-plugin-enabled={isPlugin ? String(skill.pluginEnabled === true) : undefined}
    >
      <div className="skill-row-main">
        <span className="skill-name" title={skill.dir}>
          {skill.name}
        </span>
        {meta !== '' && <span className="skill-meta">{meta}</span>}
        {activationBadge !== null && (
          <span className={activationBadge.cls} title={activationBadge.title}>
            {activationBadge.text}
          </span>
        )}
        {isPlugin && skill.pluginEnabled === false && (
          <span className="skill-badge-off" title={t('skills.pluginDisabled')}>
            {t('skills.pluginDisabledShort')}
          </span>
        )}
        {isPlugin ? (
          <button
            type="button"
            className={skill.pluginEnabled === true ? 'btn btn-mini' : 'btn btn-mini primary'}
            disabled={toggling === true}
            data-plugin-toggle={skill.pluginId ?? ''}
            onClick={() => onTogglePlugin?.(skill, skill.pluginEnabled !== true)}
          >
            {skill.pluginEnabled === true ? t('skills.pluginDisable') : t('skills.pluginEnable')}
          </button>
        ) : (
          <button type="button" className="btn btn-mini danger" onClick={() => void onRemove?.(skill)}>
            {t('common.remove')}
          </button>
        )}
      </div>
      {skill.description !== '' && (
        <div className="skill-desc" title={skill.description}>
          {skill.description}
        </div>
      )}
    </li>
  )
}