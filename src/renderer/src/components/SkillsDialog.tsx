import { useEffect, useRef, useState } from 'react'
import type { SkillInfo, SkillMarketEntry, SkillMarketplaceInfo } from '../../../shared/types'
import { useAppStore } from '../store'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { useI18n } from '../i18n'
import { CliOutputView } from './CliOutputView'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Skills 管理弹窗（v0.5③；v1.2.0 增加在线搜索安装）：
 * - 列表：listSkills 按 source 分组（用户级·全局生效 / 项目级·仅该项目）；
 *   行=名称+描述截断+版本/作者+移除（confirm→removeSkill，失败行内提示）
 * - 在线搜索（v1.2.0）：搜索本机已配置 marketplace 目录（main 侧只读解析），
 *   marketplace 过滤 + 安装量排序；「安装」走 CLI 受控模板
 *   `claude plugin install <id>@<marketplace> -y`，输出进内嵌输出区；
 *   「刷新目录」= `claude plugin marketplace update`（联网由 CLI 完成）
 * - 导入双通道：①「导入文件夹」（pickDirectory→scope 单选→importSkillFolder，
 *   同名冲突错误行内显示）②「CLI 命令」（runCliCommand，校验错误行内显示）
 *   + 内嵌输出区（CliOutputView 共享组件）
 * - 导入成功：列表刷新 + 一次性 toast；CLI 命令退出即刷新列表
 * - 安全提示常驻一行小字；关闭弹窗 killCliCommand 防孤儿
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n()
  const projects = useAppStore((s) => s.projects)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

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
      const list = await window.cwb.searchSkillMarket(
        query,
        filter === '' ? undefined : filter,
        100
      )
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

  /** 安装市场条目：CLI 受控模板执行，输出复用同一输出区 */
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

  const projectNameOf = (projectId?: string): string =>
    projects.find((p) => p.id === projectId)?.name ?? ''

  const userSkills = (skills ?? []).filter((s) => s.source === 'user')
  const projectSkills = (skills ?? []).filter((s) => s.source === 'project')

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog dialog-scroll dialog-wide" role="dialog" aria-label={t('skills.aria')}>
        <p className="dialog-title">{t('skills.title')}</p>

        <div className="dialog-section">
          {skills === null && listError === '' && <p className="muted">{t('common.loading')}</p>}
          {listError !== '' && <p className="inline-error">{listError}</p>}
          {skills !== null && skills.length === 0 && <p className="muted">{t('skills.empty')}</p>}
          {userSkills.length > 0 && (
            <>
              <p className="skill-group-title">
                {t('skills.userLevel')}
                <span className="skill-group-sub">{t('skills.userLevelSub')}</span>
              </p>
              <ul className="skill-list">
                {userSkills.map((s) => (
                  <SkillRow key={s.dir} skill={s} onRemove={removeSkill} />
                ))}
              </ul>
            </>
          )}
          {projectSkills.length > 0 && (
            <>
              <p className="skill-group-title">
                {t('skills.projectLevel')}
                <span className="skill-group-sub">{t('skills.projectLevelSub')}</span>
              </p>
              <ul className="skill-list">
                {projectSkills.map((s) => (
                  <SkillRow
                    key={s.dir}
                    skill={s}
                    projectName={projectNameOf(s.projectId)}
                    onRemove={removeSkill}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* v1.2.0 在线搜索安装：本机 marketplace 目录 → 安装走 CLI 受控模板 */}
        <div className="dialog-section">
          <p className="section-title">{t('skills.marketTitle')}</p>
          <p className="hint-small">{t('skills.marketHint')}</p>
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
          {marketplaces.length === 0 && <p className="muted">{t('skills.marketNoMarketplaces')}</p>}
          {marketError !== '' && <p className="inline-error">{marketError}</p>}
          {entries !== null && entries.length === 0 && marketplaces.length > 0 && (
            <p className="muted">{t('skills.marketEmpty')}</p>
          )}
          {entries !== null && entries.length > 0 && (
            <>
              <p className="hint-small">{t('skills.marketCount', { count: entries.length })}</p>
              <ul className="skill-list market-list">
                {entries.map((e) => (
                  <li className="skill-row" key={e.installId} data-market-install-id={e.installId}>
                    <div className="skill-row-main">
                      <span className="skill-name" title={e.installId}>
                        {e.name}
                      </span>
                      <span className="skill-meta">
                        {[e.marketplace, e.category, e.author ?? ''].filter((x) => x !== '').join(' · ')}
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

        <div className="dialog-section">
          <p className="section-title">{t('skills.importTitle')}</p>
          {/* 安全提示常驻（enterprise-secure-dev 红线 6 精神） */}
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
          <CliOutputView
            commandId={commandId}
            exitHint={t('skills.effectHint')}
            onExit={(code) => {
              // 执行完自动刷新列表（spec ③）；成功退出视为可能装了新 skill → toast。
              // v1.2.0：marketplace 刷新命令退出后同样重查市场条目（目录已更新）
              void refresh()
              void loadMarketplaces()
              void searchMarket(marketQuery, marketFilter)
              if (code === 0) setToast(true)
            }}
          />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

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
  projectName,
  onRemove
}: {
  skill: SkillInfo
  projectName?: string
  onRemove: (s: SkillInfo) => void
}) {
  const t = useI18n()
  const meta = [
    skill.version !== undefined ? `v${skill.version}` : '',
    skill.author ?? '',
    projectName ?? ''
  ]
    .filter((x) => x !== '')
    .join(' · ')
  return (
    <li className="skill-row" data-skill-name={skill.name}>
      <div className="skill-row-main">
        <span className="skill-name" title={skill.dir}>
          {skill.name}
        </span>
        {meta !== '' && <span className="skill-meta">{meta}</span>}
        <button type="button" className="btn btn-mini danger" onClick={() => void onRemove(skill)}>
          {t('common.remove')}
        </button>
      </div>
      {skill.description !== '' && (
        <div className="skill-desc" title={skill.description}>
          {skill.description}
        </div>
      )}
    </li>
  )
}