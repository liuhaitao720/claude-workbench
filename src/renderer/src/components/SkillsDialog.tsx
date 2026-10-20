import { useEffect, useRef, useState } from 'react'
import type { SkillInfo } from '../../../shared/types'
import { useAppStore } from '../store'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { CliOutputView } from './CliOutputView'

/** 导入成功的一次性 toast 文案（v0.5③：成功时提示，非常驻小字） */
const SKILL_EFFECT_HINT = '新 skill 对已运行会话不生效——新任务自动生效，旧任务恢复后生效'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Skills 管理弹窗（v0.5③）：
 * - 列表：listSkills 按 source 分组（用户级·全局生效 / 项目级·仅该项目）；
 *   行=名称+描述截断+版本/作者+移除（confirm→removeSkill，失败行内提示）
 * - 导入双通道：①「导入文件夹」（pickDirectory→scope 单选→importSkillFolder，
 *   同名冲突错误行内显示）②「CLI 命令」（runCliCommand，校验错误行内显示）
 *   + 内嵌输出区（CliOutputView 共享组件）
 * - 导入成功：列表刷新 + 一次性 toast；CLI 命令退出即刷新列表
 * - 安全提示常驻一行小字；关闭弹窗 killCliCommand 防孤儿
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
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

  useEffect(() => {
    void refresh()
  }, [])

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
        setImportError('未选中项目——请先在侧栏选择项目')
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

  const removeSkill = async (skill: SkillInfo) => {
    if (!window.confirm(`移除 skill “${skill.name}”？（移入回收站，可从回收站恢复）`)) return
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
      <div className="dialog dialog-scroll dialog-wide" role="dialog" aria-label="Skills 管理">
        <p className="dialog-title">Skills 管理</p>

        <div className="dialog-section">
          {skills === null && listError === '' && <p className="muted">加载中…</p>}
          {listError !== '' && <p className="inline-error">{listError}</p>}
          {skills !== null && skills.length === 0 && (
            <p className="muted">暂无已安装 skill——可通过下方导入</p>
          )}
          {userSkills.length > 0 && (
            <>
              <p className="skill-group-title">
                用户级 · 全局生效
                <span className="skill-group-sub">（~/.claude/skills，本机所有 claude 会话可用）</span>
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
                项目级 · 仅该项目
                <span className="skill-group-sub">（&lt;项目&gt;/.claude/skills）</span>
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

        <div className="dialog-section">
          <p className="section-title">导入</p>
          {/* 安全提示常驻（enterprise-secure-dev 红线 6 精神） */}
          <p className="hint-small">仅安装可信来源——skill 可携带可执行脚本</p>
          <div className="import-scope" role="radiogroup" aria-label="导入目标">
            <label>
              <input
                type="radio"
                name="skill-scope"
                checked={scope === 'user'}
                onChange={() => setScope('user')}
              />
              用户级（全局生效）
            </label>
            <label title={selectedProject ? undefined : '先在侧栏选中项目'}>
              <input
                type="radio"
                name="skill-scope"
                checked={scope === 'project'}
                disabled={selectedProject === null}
                onChange={() => setScope('project')}
              />
              {selectedProject ? `项目级（${selectedProject.name}）` : '项目级（未选中项目）'}
            </label>
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={importing}
              onClick={() => void importFolder()}
            >
              导入文件夹…
            </button>
          </div>
          {importError !== '' && <p className="inline-error">{importError}</p>}
          <div className="cli-run-row">
            <input
              type="text"
              className="cli-command-input"
              placeholder="如：claude plugin install xxx@marketplace"
              aria-label="claude CLI 命令"
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
              执行
            </button>
          </div>
          {cliError !== '' && <p className="inline-error">{cliError}</p>}
          <CliOutputView
            commandId={commandId}
            exitHint={SKILL_EFFECT_HINT}
            onExit={(code) => {
              // 执行完自动刷新列表（spec ③）；成功退出视为可能装了新 skill → toast
              void refresh()
              if (code === 0) setToast(true)
            }}
          />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>

        {toast && (
          <div className="toast" role="status">
            {SKILL_EFFECT_HINT}
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
          移除
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
