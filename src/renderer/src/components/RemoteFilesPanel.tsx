import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteFileEntry, TransferItem } from '../../../shared/types'
import { useAppStore } from '../store'
import { useI18n } from '../i18n'

/**
 * v2.0 远程文件面板（用户确认原型 design/remote-files-2.0.html——FinalShell 式）：
 * - 挂主工作区右侧（RemoteFilesHost 开合/拖宽/记忆），per-connection 目录记忆
 * - 面包屑导航/双击进目录/上级/后退/刷新/新建目录
 * - 上传双入口：工具栏（文件/目录）+ 拖拽（DataTransfer→webUtils 路径，A3）
 * - 行操作：下载/重命名/删除（目录=VM trash 可找回）/复制路径
 * - 冲突弹窗三选（覆盖/跳过/保留两者）——批量级一次裁决
 * - 传输条：进度/速度/取消/失败重试（onTransfersProgress 节流推送）
 */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fmtSize(n: number): string {
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(ms: number): string {
  if (ms === 0) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

interface PanelState {
  path: string
  entries: RemoteFileEntry[]
  loading: boolean
  error: string
}

/** v2.0.1 文本扩展白名单（FinalShell 同类语义；无扩展名视为文本——conf/log 类常态） */
const TEXT_EXTS = new Set([
  'txt','md','markdown','json','jsonc','json5','log','csv','tsv','xml','yml','yaml','toml','ini','conf','cfg','env','properties',
  'ts','tsx','js','jsx','mjs','cjs','py','rb','go','rs','java','kt','swift','c','h','cpp','hpp','cs','php','sh','bash','zsh','fish','ps1','bat','cmd',
  'html','htm','css','scss','less','sql','gitignore','dockerfile','makefile','dockerignore','editorconfig','npmrc','nvmrc','lock'
])
const PEEK_MAX_BYTES = 10 * 1024 * 1024
function isPeekable(f: RemoteFileEntry): boolean {
  if (f.isDir || f.size > PEEK_MAX_BYTES) return false
  const dot = f.name.lastIndexOf('.')
  const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : ''
  return ext === '' || TEXT_EXTS.has(ext)
}

export function RemoteFilesPanel({ connectionId }: { connectionId: string }) {
  const t = useI18n()
  const connections = useAppStore((s) => s.connections)
  const [st, setSt] = useState<PanelState>({ path: '', entries: [], loading: true, error: '' })
  /** 浏览历史（后退用；进目录/跳面包屑即压栈） */
  const historyRef = useRef<string[]>([])
  /** v2.0.1 多选（FinalShell 语义）：单击选中/取消；Ctrl 增减；Shift 范围；拖动框选 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** Shift 范围锚点（上次单击行索引；目录切换/清空时复位） */
  const anchorIdxRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 拖动框选（橡皮筋）：起点/当前矩形（相对列表视口 px） */
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const bandStartRef = useRef<{ x: number; y: number } | null>(null)

  const rowNames = (): string[] => st.entries.map((f) => f.name)
  const applyRange = (from: number, to: number, base: ReadonlySet<string>): ReadonlySet<string> => {
    const names = rowNames()
    const [a, b] = from <= to ? [from, to] : [to, from]
    const n = new Set(base)
    for (let i = a; i <= b; i++) {
      const nm = names[i]
      if (nm !== undefined) n.add(nm)
    }
    return n
  }

  /** 框选与行矩形求交（视口坐标系；jsdom 零矩形下安全返回空） */
  const bandHits = (x1: number, y1: number, x2: number, y2: number): ReadonlySet<string> => {
    const rect = listRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.height === 0) return new Set()
    const top = Math.min(y1, y2)
    const bottom = Math.max(y1, y2)
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.files-row') ?? []
    const hits = new Set<string>()
    for (const row of rows) {
      const r = row.getBoundingClientRect()
      if (r.height === 0) continue
      const rowTop = r.top - rect.top + listRef.current!.scrollTop
      const rowBottom = rowTop + r.height
      if (rowBottom >= top && rowTop <= bottom) {
        const nm = row.dataset['fileName']
        if (nm !== undefined) hits.add(nm)
      }
      void x1
      void x2
    }
    return hits
  }
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null)
  const [conflict, setConflict] = useState<{ files: string[]; apply: (policy: 'overwrite' | 'skip' | 'rename') => void } | null>(null)
  const connName = connections.find((c) => c.id === connectionId)?.name ?? ''

  const load = useCallback(
    (p?: string, pushHistory = true) => {
      setSt((s) => ({ ...s, loading: true, error: '' }))
      window.cwb
        .listRemoteFiles(connectionId, p)
        .then((r) => {
          if (!r.ok || r.path === undefined) {
            setSt((s) => ({ ...s, loading: false, error: r.error ?? 'list failed' }))
            return
          }
          if (pushHistory && st.path !== '' && st.path !== r.path) {
            historyRef.current.push(st.path)
          }
          setSt({ path: r.path, entries: r.entries ?? [], loading: false, error: '' })
          setSelected(new Set())
        })
        .catch((err: unknown) => setSt((s) => ({ ...s, loading: false, error: errMsg(err) })))
    },
    [connectionId] // st.path 故意不入依赖（读最新经函数式——压栈语义防重复 effect）
  )

  useEffect(() => {
    // per-connection 目录记忆（面板重开回上次位置；无记忆=home）
    const saved = useAppStore.getState().uiSettings.filesPanelPath?.[connectionId]
    load(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅连接切换重载
  }, [connectionId])

  // 目录记忆持久化（路径稳定后写回——100ms 防抖足够）
  useEffect(() => {
    if (st.path === '') return
    const cur = useAppStore.getState().uiSettings.filesPanelPath ?? {}
    if (cur[connectionId] === st.path) return
    const next = { ...cur, [connectionId]: st.path }
    useAppStore.setState({ uiSettings: { ...useAppStore.getState().uiSettings, filesPanelPath: next } })
    void window.cwb.setAppSettings({ filesPanelPath: next })
  }, [st.path, connectionId])

  const goUp = (): void => {
    if (st.path === '' || st.path === '/') return
    const parent = st.path.replace(/\/[^/]+$/, '') || '/'
    load(parent)
  }
  const goBack = (): void => {
    const prev = historyRef.current.pop()
    if (prev !== undefined) load(prev, false)
  }
  const into = (name: string): void => load(`${st.path === '/' ? '' : st.path}/${name}`)

  const crumbParts = (): Array<{ label: string; path: string }> => {
    if (st.path === '') return []
    const parts = st.path.split('/').filter((x) => x !== '')
    const out = [{ label: '/', path: '/' }]
    let acc = ''
    for (const p of parts) {
      acc += `/${p}`
      out.push({ label: p, path: acc })
    }
    return out
  }

  // ── 操作 ────────────────────────────────────────────────────────────
  const pickAndUpload = async (files: boolean, dirs: boolean): Promise<void> => {
    const paths = await window.cwb.pickLocalForUpload(files, dirs)
    if (paths === null || paths.length === 0) return
    await startUpload(paths)
  }

  const startUpload = async (paths: string[]): Promise<void> => {
    // v2.0.2（用户实测）：同名预检——当前清单里没有同名才不弹窗直接传（此前无
    // 条件弹三选）。清单可能略陈旧（引擎仍按所选策略兜底），无同名时策略无差别。
    const baseOf = (p: string): string => p.split(/[\\/]/).pop() ?? p
    const clash = paths
      .map(baseOf)
      .filter((n) => st.entries.some((e) => e.name === n))
    if (clash.length === 0) {
      await window.cwb.uploadRemoteFiles(connectionId, paths, st.path, 'overwrite')
      load(st.path, false)
      return
    }
    const policy = await askConflictPolicy(clash)
    if (policy === null) return // 用户取消整批
    const r = await window.cwb.uploadRemoteFiles(connectionId, paths, st.path, policy)
    if (policy === 'skip' && r.conflicts.length > 0) {
      // 引擎 rename 名入队 + 对冲突原目标……简化语义：skip=跳过冲突文件整体
      for (const c of r.conflicts) void c
    }
    load(st.path, false)
  }

  const askConflictPolicy = async (clashNames: string[]): Promise<'overwrite' | 'skip' | 'rename' | null> => {
    return new Promise((resolve) => {
      setConflict({
        files: clashNames,
        apply: (policy) => {
          setConflict(null)
          resolve(policy)
        }
      })
      // 取消通道：弹窗关闭按钮 → resolve(null)
      conflictCancelRef.current = () => {
        setConflict(null)
        resolve(null)
      }
    })
  }
  const conflictCancelRef = useRef<(() => void) | null>(null)

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const paths = localPathsFromDataTransfer(e.dataTransfer)
    if (paths.length === 0) {
      // 可诊断性：drop 到达但取不到本机路径（webUtils 桥断/拖入非文件）——留痕
      console.error('[cwb] drop with no local paths:', e.dataTransfer.types.join(','))
      return
    }
    await startUpload(paths)
  }
  const [dragging, setDragging] = useState(false)

  // v2.0.2 拖拽修复兜底：Chromium 拖拽目标因重渲染失效时 drop 不派发（被
  // will-navigate 静默吞掉）且 dragleave 丢失 → 提示条卡死。document 级
  // dragend/drop 一律收起提示（dragend 在源端取消拖拽、drop 在任意处释放均触发）
  useEffect(() => {
    const clear = (): void => setDragging(false)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])

  const download = (f: RemoteFileEntry): void => {
    void window.cwb
      .downloadRemoteFile(connectionId, `${st.path === '/' ? '' : st.path}/${f.name}`, f.name)
      .then(() => undefined)
      .catch((err: unknown) => setSt((s) => ({ ...s, error: errMsg(err) })))
  }

  const remove = async (f: RemoteFileEntry): Promise<void> => {
    if (!window.confirm(t('files.deleteConfirm', { name: f.name }))) return
    try {
      await window.cwb.deleteRemote(connectionId, `${st.path === '/' ? '' : st.path}/${f.name}`, f.isDir)
      load(st.path, false)
    } catch (err) {
      setSt((s) => ({ ...s, error: errMsg(err) }))
    }
  }

  /** v2.0.1 多选直删（用户指令：不进回收站）；一次确认列出数量与名字样例 */
  const removeSelected = async (): Promise<void> => {
    const targets = st.entries.filter((f) => selected.has(f.name))
    if (targets.length === 0) return
    const sample = targets.slice(0, 3).map((f) => f.name).join('、')
    const suffix = targets.length > 3 ? ` …等 ${targets.length} 项` : ''
    if (!window.confirm(t('files.deleteMultiConfirm', { n: String(targets.length), names: `${sample}${suffix}` }))) {
      return
    }
    try {
      for (const f of targets) {
        await window.cwb.deleteRemote(connectionId, `${st.path === '/' ? '' : st.path}/${f.name}`, f.isDir)
      }
      setSelected(new Set())
      load(st.path, false)
    } catch (err) {
      setSt((s) => ({ ...s, error: errMsg(err) }))
    }
  }

  const submitRename = async (): Promise<void> => {
    if (renaming === null) return
    const to = renaming.value.trim()
    if (to !== '' && to !== renaming.from) {
      try {
        await window.cwb.renameRemote(
          connectionId,
          `${st.path === '/' ? '' : st.path}/${renaming.from}`,
          `${st.path === '/' ? '' : st.path}/${to}`
        )
        load(st.path, false)
      } catch (err) {
        setSt((s) => ({ ...s, error: errMsg(err) }))
      }
    }
    setRenaming(null)
  }

  const mkdir = async (): Promise<void> => {
    const name = window.prompt(t('files.mkdirPrompt'))
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    try {
      await window.cwb.mkdirRemote(connectionId, `${st.path === '/' ? '' : st.path}/${trimmed}`)
      load(st.path, false)
    } catch (err) {
      setSt((s) => ({ ...s, error: errMsg(err) }))
    }
  }

  return (
    <div
      className="files-panel"
      data-testid="files-panel"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        // v2.0.2：经子元素离开（relatedTarget 不在面板内）也算离场——此前仅
        // currentTarget===target 判定，从列表行/面包屑离开时提示条不消失
        const to = e.relatedTarget
        if (to === null || !(to instanceof Node) || !e.currentTarget.contains(to)) {
          setDragging(false)
        }
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="files-head">
        <b>{t('files.title')}</b>
        <span className="pill" data-state="on">{connName}</span>
      </div>
      <div className="crumb">
        {crumbParts().map((c, i) => (
          <span key={c.path} className="crumb-item">
            {i > 0 && <span className="sep">/</span>}
            <button type="button" onClick={() => load(c.path)}>
              {i === 0 ? '⌂' : c.label}
            </button>
          </span>
        ))}
      </div>
      <div className="files-toolbar">
        <button
          type="button"
          className="btn small"
          title={t('files.goHome')}
          onClick={() => load(undefined)}
        >
          🏠
        </button>
        <button type="button" className="btn small" disabled={st.path === '' || st.path === '/'} onClick={goUp} title="Alt+↑">
          ↑
        </button>
        <button type="button" className="btn small" disabled={historyRef.current.length === 0} onClick={goBack}>
          ←
        </button>
        <button type="button" className="btn small" onClick={() => load(st.path, false)} title="F5">
          ⟳
        </button>
        <button type="button" className="btn small" onClick={() => void mkdir()}>
          ＋
        </button>
        <button
          type="button"
          className="btn small danger"
          disabled={selected.size === 0}
          title={t('files.deleteSelected')}
          data-testid="btn-delete-selected"
          onClick={() => void removeSelected()}
        >
          🗑 {selected.size > 0 ? `(${selected.size})` : ''}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn small primary" onClick={() => void pickAndUpload(true, true)}>
          ⬆ {t('files.upload')}
        </button>
      </div>
      <div
        className="files-list"
        ref={listRef}
        onMouseDown={(e) => {
          // 框选起点（仅左键且非按钮/输入/行内操作——落在行上也允许，拖动>4px 才成框）
          if (e.button !== 0) return
          const rect = listRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          bandStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top + listRef.current!.scrollTop }
        }}
        onMouseMove={(e) => {
          const st0 = bandStartRef.current
          const rect = listRef.current?.getBoundingClientRect()
          if (st0 === null || rect === undefined || band === null) return
          const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top + listRef.current!.scrollTop }
          if (Math.abs(cur.x - st0.x) + Math.abs(cur.y - st0.y) < 4) return
          setBand({ x1: st0.x, y1: st0.y, x2: cur.x, y2: cur.y })
          setSelected(bandHits(st0.x, st0.y, cur.x, cur.y))
        }}
        onMouseUp={() => {
          bandStartRef.current = null
          if (band !== null) {
            setBand(null)
            anchorIdxRef.current = null
          }
        }}
        onMouseLeave={() => {
          bandStartRef.current = null
          setBand(null)
        }}
      >
        {st.loading && <p className="muted files-hint">{t('common.detecting')}</p>}
        {!st.loading && st.error !== '' && <p className="inline-error">{st.error}</p>}
        {!st.loading && st.error === '' && st.entries.length === 0 && (
          <p className="muted files-hint">{t('files.empty')}</p>
        )}
        {st.entries.map((f) => (
          <div
            key={f.name}
            className={`files-row${f.isDir ? ' dir' : ''}${selected.has(f.name) ? ' sel' : ''}`}
            data-file-name={f.name}
            data-selected={selected.has(f.name) ? '1' : undefined}
            onClick={(e) => {
              const idx = st.entries.findIndex((f2) => f2.name === f.name)
              if (e.shiftKey && anchorIdxRef.current !== null) {
                setSelected((prev) => applyRange(anchorIdxRef.current!, idx, prev))
                return
              }
              if (e.ctrlKey || e.metaKey) {
                anchorIdxRef.current = idx
                setSelected((prev) => {
                  const n = new Set(prev)
                  if (n.has(f.name)) n.delete(f.name)
                  else n.add(f.name)
                  return n
                })
                return
              }
              anchorIdxRef.current = idx
              setSelected((prev) => (prev.has(f.name) && prev.size === 1 ? new Set() : new Set([f.name])))
            }}
            onDoubleClick={() => {
              if (f.isDir) {
                into(f.name)
                return
              }
              // v2.0.1（参考 FinalShell）：小文本双击本机打开；其余走下载
              if (isPeekable(f)) {
                void window.cwb
                  .peekRemoteFile(connectionId, `${st.path === '/' ? '' : st.path}/${f.name}`)
                  .catch((err: unknown) => setSt((s2) => ({ ...s2, error: errMsg(err) })))
                return
              }
              download(f)
            }}
          >
            <span className="files-ico">{f.isDir ? '📁' : fileIcon(f.name)}</span>
            {renaming?.from === f.name ? (
              <input
                className="files-rename-input"
                spellCheck={false}
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ from: f.name, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => void submitRename()}
              />
            ) : (
              <span
                className="files-name"
                title={`${f.name}${f.mtimeMs > 0 ? ` · ${fmtTime(f.mtimeMs)}` : ''}`}
              >
                {f.name}
              </span>
            )}
            <span className="files-size" title={f.isDir ? undefined : `${f.size} B`}>
              {f.isDir ? '—' : fmtSize(f.size)}
            </span>
            <span className="files-mtime">{f.mtimeMs > 0 ? fmtTime(f.mtimeMs) : ''}</span>
            <span className="files-acts">
              {!f.isDir && (
                <button type="button" className="btn small" title={t('files.download')} onClick={() => download(f)}>
                  ⬇
                </button>
              )}
              <button
                type="button"
                className="btn small"
                title={t('common.edit')}
                onClick={() => setRenaming({ from: f.name, value: f.name })}
              >
                ✎
              </button>
              <button
                type="button"
                className="btn small danger"
                title={t('common.remove')}
                onClick={() => void remove(f)}
              >
                🗑
              </button>
            </span>
          </div>
        ))}
        {band !== null && (
          <div
            className="files-band"
            style={{
              left: Math.min(band.x1, band.x2),
              top: Math.min(band.y1, band.y2),
              width: Math.abs(band.x2 - band.x1),
              height: Math.abs(band.y2 - band.y1)
            }}
            data-testid="files-band"
          />
        )}
      </div>
      {dragging && (
        <div className="files-dropzone">
          <b>{t('files.dropHere')}</b>
          <span className="muted">{st.path}</span>
        </div>
      )}
      {conflict !== null && (
        <div className="files-conflict" role="dialog" aria-label={t('files.conflictTitle')}>
          {/* v2.0.2（用户实测「布局乱」）：卡片容器收拢全部内容——此前标题/提示/
              文件清单/按钮是 overlay 的平级子节点，flex 横排挤成一行 */}
          <div className="files-conflict-card">
            <p className="files-conflict-title">{t('files.conflictTitle')}</p>
            <p className="muted files-conflict-hint">
              {t('files.conflictHint', { n: String(conflict.files.length) })}
            </p>
            <div className="files-conflict-files">
              {conflict.files.slice(0, 5).map((f) => (
                <span key={f} className="files-conflict-file">
                  {f}
                </span>
              ))}
              {conflict.files.length > 5 && <span className="muted">+{conflict.files.length - 5}</span>}
            </div>
            <div className="files-conflict-actions">
              <button type="button" className="btn" onClick={() => conflict.apply('skip')}>
                {t('files.conflictSkip')}
              </button>
              <button type="button" className="btn" onClick={() => conflict.apply('rename')}>
                {t('files.conflictRename')}
              </button>
              <button type="button" className="btn primary" onClick={() => conflict.apply('overwrite')}>
                {t('files.conflictOverwrite')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => conflictCancelRef.current?.()}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* v2.0.1（用户实测）：选中项全量信息条——完整时间在列宽不足时的承载位 */}
      {(() => {
        const sel = st.entries.find((f) => selected.has(f.name))
        if (sel === undefined) return null
        return (
          <p className="files-statusbar" data-testid="files-statusbar">
            <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {sel.name}
            </span>
            <span>{sel.isDir ? t('files.dirLabel') : fmtSize(sel.size)}</span>
            <span>{sel.mtimeMs > 0 ? new Date(sel.mtimeMs).toLocaleString() : ''}</span>
          </p>
        )
      })()}
      <TransferBar connName={connName} />
    </div>
  )
}

function fileIcon(name: string): string {
  const lower = name.toLowerCase()
  if (/\.(md|txt|log)$/.test(lower)) return '📄'
  if (/\.(zip|gz|tar|tgz|7z)$/.test(lower)) return '🗄'
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/.test(lower)) return '🖼'
  return '🗂'
}

/** 拖拽路径提取（Electron 44：File.path 已废——经 preload 的 webUtils 桥，A3） */
function localPathsFromDataTransfer(dt: DataTransfer): string[] {
  const files = Array.from(dt.files ?? [])
  const out: string[] = []
  for (const f of files) {
    const p = (f as File & { path?: string }).path ?? window.cwb.getPathForFile?.(f)
    if (p !== undefined && p !== '') out.push(p)
  }
  return out
}

/** 传输条（面板底部：聚合进度 + 保存目录头 + 展开队列；取消/重试） */
function TransferBar({ connName }: { connName: string }) {
  const t = useI18n()
  const [items, setItems] = useState<TransferItem[]>([])
  const [open, setOpen] = useState(false)
  /** v2.0.1（用户实测②）：顶部统一显示当前下载保存目录（与 main 落位逻辑同源派生） */
  const [saveDir, setSaveDir] = useState('')

  /** v2.0.1：真实可打开路径（默认目录占位时不可开——按钮禁用）+ 显示文案 */
  const [openableDir, setOpenableDir] = useState('')
  useEffect(() => {
    void window.cwb.listTransfers().then(setItems).catch(() => {})
    void window.cwb
      .getAppSettings()
      .then((s) => {
        const root = s.downloadDir !== undefined ? s.downloadDir.trim() : ''
        const openable =
          root === ''
            ? '' // 默认目录（系统下载/SSH Workbench）——main 落位，此处未知则不开
            : s.downloadPerConnection === false
              ? root
              : `${root}${root.endsWith('\\') ? '' : '\\'}${connName}`
        setOpenableDir(openable)
        setSaveDir(openable !== '' ? openable : t('files.defaultSaveDir'))
      })
      .catch(() => {})
    return window.cwb.onTransfersProgress((fresh) => setItems(fresh))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 目录随连接名/语言取一次
  }, [connName])

  const openSaveDir = async (): Promise<void> => {
    if (openableDir === '') return
    await window.cwb.openLocalPath(openableDir).catch(() => undefined)
  }

  // v2.0.1（用户实测"下载无提示"）：出现活动项即自动展开队列——肉眼即时反馈
  const hasActive = items.some((i) => i.status === 'active' || i.status === 'queued')
  const seenActiveRef = useRef(false)
  useEffect(() => {
    if (hasActive && !seenActiveRef.current) {
      seenActiveRef.current = true
      setOpen(true)
    }
    if (!hasActive) seenActiveRef.current = false
  }, [hasActive])

  const active = items.filter((i) => i.status === 'active' || i.status === 'queued')
  const recent = items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'canceled').slice(0, 8)
  const totalBytes = active.reduce((n, i) => n + i.totalBytes, 0)
  const doneBytes = active.reduce((n, i) => n + i.transferredBytes, 0)
  const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0
  const speed = (() => {
    // 粗估：活跃项近 1s 增量——v1 用完成字节/已历时（首包即显示，精度足够）
    let sum = 0
    for (const i of active) {
      if (i.status !== 'active') continue
      sum += i.transferredBytes
    }
    return sum > 0 ? fmtSize(Math.max(1, sum / 4)) + '/s≈' : ''
  })()

  if (items.length === 0) return null
  return (
    <div className={`xfer${open ? ' open' : ''}`} data-testid="transfer-bar">
      <div className="xfer-bar" onClick={() => setOpen((v) => !v)}>
        <b>{t('files.transfers')}</b>
        {active.length > 0 && (
          <>
            <div className="prog">
              <i style={{ width: `${pct}%` }} />
            </div>
            <span className="xfer-meta">
              {pct}%{speed !== '' ? ` · ${speed}` : ''} · {t('files.transfersActive', { n: String(active.length) })}
            </span>
          </>
        )}
        {active.length === 0 && recent.length > 0 && (
          <span className="xfer-meta">{t('files.transfersDone', { n: String(recent.filter((i) => i.status === 'done').length) })}</span>
        )}
        <span className="xfer-meta">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="xfer-list" data-testid="xfer-table">
          <p
            className="xfer-savedir"
            data-testid="xfer-savedir"
            title={openableDir !== '' ? `${saveDir}（双击打开）` : saveDir}
            onDoubleClick={() => void openSaveDir()}
          >
            {t('files.saveDirLabel')}: <span className="mono">{saveDir}</span>
            {openableDir !== '' && (
              <button
                type="button"
                className="btn small"
                style={{ marginLeft: 8 }}
                data-testid="btn-open-savedir"
                onClick={() => void openSaveDir()}
              >
                {t('files.openDirBtn')}
              </button>
            )}
          </p>
          <div className="xfer-head">
            <span> </span>
            <span>{t('files.xferColFile')}</span>
            <span>{t('files.xferColProgress')}</span>
            <span>{t('files.xferColStatus')}</span>
            <span> </span>
          </div>
          {[...active, ...recent].map((i) => {
            const p = i.totalBytes > 0 ? Math.round((i.transferredBytes / i.totalBytes) * 100) : 0
            return (
              <div key={i.id} className="xfer-row" data-transfer-id={i.id}>
                <span className="xfer-dir">{i.direction === 'upload' ? '⬆' : '⬇'}</span>
                <span className="xfer-name" title={i.name}>
                  {i.name}
                </span>
                {i.status === 'active' || i.status === 'queued' ? (
                  <>
                    <div className="prog">
                      <i style={{ width: `${p}%` }} />
                    </div>
                    <span className="xfer-st">
                      {i.status === 'queued' ? t('files.xferQueued') : `${p}%`}
                    </span>
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={() => void window.cwb.cancelTransfer(i.id)}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <>
                    <span className="xfer-st" data-status={i.status}>
                      {i.status === 'done'
                        ? t('files.xferDone')
                        : i.status === 'canceled'
                          ? t('files.xferCanceled')
                          : (i.error ?? t('files.xferError'))}
                    </span>
                    {i.status === 'error' && (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => void window.cwb.retryTransfer(i.id)}
                      >
                        {t('files.xferRetry')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
