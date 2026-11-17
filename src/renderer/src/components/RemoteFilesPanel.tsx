import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

/** v2.1.7 双击直接编辑（用户确认设计）：仅 <5MB；二进制由 main 读后嗅探拒绝 */
const EDIT_MAX_BYTES = 5 * 1024 * 1024

/** 编辑器单槽状态（null=关） */
interface EditorState {
  path: string
  name: string
  content: string
  original: string
  mtimeMs: number
  size: number
  loading: boolean
  loadError: string
  saving: boolean
  /** 状态栏：''=未修改语义由 dirty 派生；''=无、'saved'=已保存时间文案 */
  savedMsg: string
  saveError: string
  conflict: boolean
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
  /** v2.1.7 双击直接编辑（单槽）+ 轻提示（保存成功/二进制拒绝） */
  const [editor, setEditor] = useState<EditorState | null>(null)
  /** 脏态关闭二次确认（editor 置 null 即关——先过这里） */
  const [closeAsk, setCloseAsk] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (msg: string): void => {
    setToast(msg)
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3500)
  }
  const connName = connections.find((c) => c.id === connectionId)?.name ?? ''

  // v2.2.1 陈旧响应守卫：每次 load 自增序号，应答到达时已有更新请求发出即丢弃
  // ——挂载定位与 explicit 跟随两条 load 竞速时，慢的那份（通常主目录）不会盖掉新目录
  const loadSeqRef = useRef(0)
  const load = useCallback(
    (p?: string, pushHistory = true) => {
      const seq = ++loadSeqRef.current
      setSt((s) => ({ ...s, loading: true, error: '' }))
      window.cwb
        .listRemoteFiles(connectionId, p)
        .then((r) => {
          if (seq !== loadSeqRef.current) return // 陈旧应答——已有更新的导航在途
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
        .catch((err: unknown) => {
          if (seq !== loadSeqRef.current) return
          setSt((s) => ({ ...s, loading: false, error: errMsg(err) }))
        })
    },
    [connectionId] // st.path 故意不入依赖（读最新经函数式——压栈语义防重复 effect）
  )

  // v2.1.1 SSH 目录跟随（仅 SSH 控制台内嵌形态消费：seq 变化 → 导航）
  const follow = useAppStore((s) => s.sshFollowDir)
  const followEnabled = useAppStore((s) => s.sshFollowEnabled)
  useEffect(() => {
    if (follow === null || follow.connectionId !== connectionId) return
    // 显式定位（项目菜单/任务上下文）恒导航；OSC 7 跟随受开关门控。
    // v2.1.6 语义（用户需求）：面板手动切目录后终端没动（OSC 同路径，SshTermPane
    // 去重不产 seq）不拽回；终端真 cd 了（路径变）这里直接跟到新目录。
    if (follow.source === 'explicit' || followEnabled) load(follow.path, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 跟随按 seq 导航
  }, [follow?.seq, connectionId])
useEffect(() => {
    // per-connection 目录记忆（面板重开回上次位置；无记忆=home）。
    // v2.2.1 竞速修复：定向开台已有 explicit/OSC 跟随在途时跳过——记忆目录的
    // load 不再与项目目录的 load 竞速（慢响应盖掉新目录的实测根因）
    const s = useAppStore.getState()
    const f = s.sshFollowDir
    if (
      f !== null &&
      f.connectionId === connectionId &&
      (f.source === 'explicit' || s.sshFollowEnabled)
    ) {
      return // 跟随 effect 会导航——别再发一份竞速请求
    }
    const saved = s.uiSettings.filesPanelPath?.[connectionId]
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

  // ── v2.1.7 双击直接编辑：读（≤5MB；二进制/超限拒绝）→ 单槽编辑器 ──
  const openEditor = (f: RemoteFileEntry): void => {
    if (f.size > EDIT_MAX_BYTES) {
      // 超限维持现状：走下载（含传输记录）
      download(f)
      return
    }
    const path = `${st.path === '/' ? '' : st.path}/${f.name}`
    setEditor({
      path, name: f.name, content: '', original: '', mtimeMs: 0, size: f.size,
      loading: true, loadError: '', saving: false, savedMsg: '', saveError: '', conflict: false
    })
    void window.cwb
      .readRemoteTextFile(connectionId, path)
      .then((r) => {
        if (!r.ok) {
          if (r.binary) {
            setEditor(null)
            showToast(t('editor.binaryToast'))
            return
          }
          setEditor((e0) =>
            e0 !== null && e0.path === path
              ? { ...e0, loading: false, loadError: r.error }
              : e0
          )
          return
        }
        setEditor((e0) =>
          e0 !== null && e0.path === path
            ? {
                ...e0, content: r.content, original: r.content,
                mtimeMs: r.mtimeMs, size: r.size, loading: false, loadError: ''
              }
            : e0
        )
      })
      .catch((err: unknown) => {
        setEditor((e0) =>
          e0 !== null && e0.path === path
            ? { ...e0, loading: false, loadError: errMsg(err) }
            : e0
        )
      })
  }

  /** 保存：SFTP 直写（baseMtimeMs 冲突复核；overwrite=true 强制覆盖） */
  const saveEditor = (overwrite = false): void => {
    if (editor === null || editor.saving) return
    if (editor.content === editor.original && !overwrite) return
    setEditor({ ...editor, saving: true, saveError: '', conflict: false, savedMsg: '' })
    void window.cwb
      .writeRemoteTextFile(
        connectionId,
        editor.path,
        editor.content,
        overwrite ? undefined : (editor.mtimeMs > 0 ? editor.mtimeMs : undefined)
      )
      .then((r) => {
        if (!r.ok) {
          if (r.conflict) {
            setEditor((e0) => (e0 !== null ? { ...e0, saving: false, conflict: true } : e0))
            return
          }
          setEditor((e0) => (e0 !== null ? { ...e0, saving: false, saveError: r.error } : e0))
          return
        }
        setEditor((e0) =>
          e0 !== null
            ? {
                ...e0,
                saving: false,
                original: e0.content,
                mtimeMs: r.mtimeMs,
                size: e0.content.length,
                savedMsg: new Date().toLocaleTimeString(),
                saveError: '',
                conflict: false
              }
            : e0
        )
        showToast(t('editor.savedToast', { name: editor.name }))
        // 保存后刷新清单（大小/时间列对齐远端）
        load(st.path, false)
      })
      .catch((err: unknown) => {
        setEditor((e0) => (e0 !== null ? { ...e0, saving: false, saveError: errMsg(err) } : e0))
      })
  }

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
    <>
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
        {/* v2.1.7 传输记录（FinalShell 式）：右上角按钮 + 弹出面板（底部内嵌条移除） */}
        <TransfersButton connectionId={connectionId} connName={connName} />
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
              // v2.1.7（用户确认设计）：双击=弹窗直接编辑（仅下方文件面板此入口）；
              // ≥5MB 维持走下载（含传输记录）
              openEditor(f)
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
      </div>
      {/* v2.1.7 双击直接编辑弹窗（单槽）+ 脏态/冲突确认 + 轻提示 */}
      {editor !== null && (
        <RemoteTextEditor
          editor={editor}
          onChange={(content) => setEditor((e0) => (e0 !== null ? { ...e0, content } : e0))}
          onSave={() => saveEditor(false)}
          onOverwrite={() => saveEditor(true)}
          onReload={() => {
            const path = editor.path
            setEditor({ ...editor, loading: true, loadError: '', conflict: false })
            void window.cwb.readRemoteTextFile(connectionId, path).then((r) => {
              if (!r.ok) {
                setEditor((e0) => (e0 !== null && e0.path === path ? { ...e0, loading: false, loadError: r.error } : e0))
                return
              }
              setEditor((e0) =>
                e0 !== null && e0.path === path
                  ? { ...e0, content: r.content, original: r.content, mtimeMs: r.mtimeMs, size: r.size, loading: false, loadError: '' }
                  : e0
              )
            })
          }}
          onClose={() => {
            if (editor.content !== editor.original) setCloseAsk(true)
            else setEditor(null)
          }}
        />
      )}
      {closeAsk && editor !== null && (
        <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label={t('editor.dirtyTitle')}>
          <div className="dialog small-dialog">
            <p className="dialog-title">{t('editor.dirtyTitle')}</p>
            <p className="dialog-hint">{t('editor.dirtyHint', { name: editor.name })}</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setCloseAsk(false)
                  setEditor(null)
                }}
              >
                {t('editor.discard')}
              </button>
              <button type="button" className="btn primary" onClick={() => setCloseAsk(false)}>
                {t('editor.keepEditing')}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast !== '' && (
        <div className="save-toast" role="status" data-testid="save-toast">
          {toast}
        </div>
      )}
    </>
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

/**
 * v2.1.7 传输记录按钮 + 弹出面板（FinalShell 式，用户确认设计）：
 * - 自持数据装配（listTransfers / onTransfersProgress）——与旧底部传输条同源
 * - 角标=活动项计数（数字即信息）；有失败转红色数字；title 带聚合进度
 * - 弹层经 createPortal 挂 document.body + fixed 定位（v2.1.7 修复：此前 absolute
 *   挂工具栏，被 .files-panel/.ssh-files-host 的 overflow:hidden 裁切遮挡）；坐标
 *   随窗口 resize/滚动重算；非模态（Esc / 点击外部收起，不拦终端键盘）
 * - 发起新传输自动弹出一次（保留 v2.0.1 实测的「立即反馈」；手动收起后本轮
 *   不再自动弹，全部结束后下一轮重新适用）
 * - 「清空已完成」只修剪 done/error/canceled（活动项保留；main 侧 prune）
 * - 保存目录走 main 侧同源解析（getTransfersSaveDir）：自定义目录或 系统下载/
 *   SSH Workbench + 按连接子目录——默认目录也给「打开」按钮（v2.1.7 修复：
 *   此前仅自定义目录显示按钮）
 */
function TransfersButton({ connectionId, connName }: { connectionId: string; connName: string }) {
  const t = useI18n()
  const [items, setItems] = useState<TransferItem[]>([])
  const [open, setOpen] = useState(false)
  const [saveDir, setSaveDir] = useState('')
  const slotRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)

  const align = (): void => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r === undefined) return
    const w = Math.min(360, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
    const top = Math.min(r.bottom + 6, Math.max(8, window.innerHeight - 96))
    const maxHeight = Math.max(160, window.innerHeight - top - 12)
    setPos({ left, top, maxHeight })
  }

  useEffect(() => {
    void window.cwb.listTransfers().then(setItems).catch(() => {})
    void window.cwb
      .getTransfersSaveDir(connectionId)
      .then((dir) => {
        if (dir !== '') setSaveDir(dir)
      })
      .catch(() => {})
    return window.cwb.onTransfersProgress((fresh) => setItems(fresh))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 目录随连接取一次
  }, [connectionId, connName])

  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    align()
    window.addEventListener('resize', align)
    window.addEventListener('scroll', align, true)
    return () => {
      window.removeEventListener('resize', align)
      window.removeEventListener('scroll', align, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 开合时装/卸
  }, [open])

  // 点击外部收起（弹层在 portal 里不在 slot 子树——按两个 ref 判定）；Esc 同
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target as Node
      if (slotRef.current?.contains(target) !== true && popRef.current?.contains(target) !== true) {
        setOpen(false)
      }
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openSaveDir = async (): Promise<void> => {
    if (saveDir === '') return
    await window.cwb.openLocalPath(saveDir).catch(() => undefined)
  }

  const active = items.filter((i) => i.status === 'active' || i.status === 'queued')
  const failed = items.filter((i) => i.status === 'error')
  const finished = items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'canceled')
  const totalBytes = active.reduce((n, i) => n + i.totalBytes, 0)
  const doneBytes = active.reduce((n, i) => n + i.transferredBytes, 0)
  const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0
  const speed = (() => {
    let sum = 0
    for (const i of active) {
      if (i.status !== 'active') continue
      sum += i.transferredBytes
    }
    return sum > 0 ? fmtSize(Math.max(1, sum / 4)) + '/s≈' : ''
  })()

  // 新活动项 → 自动弹出一次（全部结束后重置）
  const hasActive = active.length > 0
  const seenActiveRef = useRef(false)
  useEffect(() => {
    if (hasActive && !seenActiveRef.current) {
      seenActiveRef.current = true
      setOpen(true)
    }
    if (!hasActive) seenActiveRef.current = false
  }, [hasActive])

  const badge = failed.length > 0 ? failed.length : active.length
  const title =
    active.length > 0
      ? `${t('files.xferBtn')} · ${t('files.xferBtnActive', { n: String(active.length), pct: String(pct) })}${speed !== '' ? ` · ${speed}` : ''}`
      : items.length > 0
        ? `${t('files.xferBtn')}（${items.length}）`
        : t('files.xferBtn')

  return (
    <div className="files-xfer-slot" ref={slotRef}>
      <button
        type="button"
        ref={btnRef}
        className="btn small files-xfer-btn"
        aria-label={t('files.xferBtn')}
        aria-expanded={open}
        title={title}
        data-testid="btn-xfer-pop"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6V3.5A1.5 1.5 0 0 1 5.5 2h5A1.5 1.5 0 0 1 12 3.5V6" />
          <path d="M4 10v2.5A1.5 1.5 0 0 0 5.5 14h5a1.5 1.5 0 0 0 1.5-1.5V10" />
          <path d="M8 3.5v9M8 3.5 6 5.5M8 3.5l2 2M8 12.5 6 10.5M8 12.5l2-2" />
        </svg>
        {badge > 0 && (
          <span className="xfer-badge" data-failed={failed.length > 0 ? 'true' : 'false'}>
            {badge}
          </span>
        )}
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={popRef}
            className="xfer-pop"
            style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
            role="dialog"
            aria-label={t('files.xferBtn')}
            data-testid="xfer-pop"
          >
            <div className="xfer-pop-head">
              <b>{t('files.xferBtn')}</b>
              <span className="xfer-pop-acts">
                {finished.length > 0 && (
                  <button
                    type="button"
                    className="btn small"
                    data-testid="btn-xfer-clear"
                    onClick={() => void window.cwb.clearFinishedTransfers()}
                  >
                    {t('files.xferClear')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn small"
                  aria-label={t('common.close')}
                  onClick={() => setOpen(false)}
                >
                  ×
                </button>
              </span>
            </div>
            {active.length > 0 && (
              <div className="xfer-pop-aggr">
                <div className="prog">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span className="xfer-meta">
                  {pct}%{speed !== '' ? ` · ${speed}` : ''} · {t('files.transfersActive', { n: String(active.length) })}
                </span>
              </div>
            )}
            <p
              className="xfer-savedir"
              data-testid="xfer-savedir"
              title={`${saveDir}（双击打开）`}
              onDoubleClick={() => void openSaveDir()}
            >
              {t('files.saveDirLabel')}:{' '}
              <span className="mono">{saveDir !== '' ? saveDir : t('files.defaultSaveDir')}</span>
              {saveDir !== '' && (
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
            <div className="xfer-pop-list" data-testid="xfer-table">
              {items.length === 0 ? (
                <p className="xfer-empty">{t('files.xferEmpty')}</p>
              ) : (
                <>
                  <div className="xfer-head">
                    <span> </span>
                    <span>{t('files.xferColFile')}</span>
                    <span>{t('files.xferColProgress')}</span>
                    <span>{t('files.xferColStatus')}</span>
                    <span> </span>
                  </div>
                  {items.map((i) => {
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
                                ↻
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * v2.1.7 远程文本编辑器（用户确认设计）：双击 <5MB 文件弹窗直接改，Ctrl+S
 * SFTP 直写远端（不经传输队列）。脏态关闭/冲突守卫由父层确认框兜底。
 * 键盘：Ctrl+S 保存（对话框级捕获）；Tab 插 2 空格；Esc 关（父层判脏态）。
 */
function RemoteTextEditor({
  editor,
  onChange,
  onSave,
  onOverwrite,
  onReload,
  onClose
}: {
  editor: EditorState
  onChange: (content: string) => void
  onSave: () => void
  onOverwrite: () => void
  onReload: () => void
  onClose: () => void
}) {
  const t = useI18n()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const dirty = editor.content !== editor.original
  const lines = editor.content.split('\n').length
  const chars = editor.content.length

  useEffect(() => {
    if (!editor.loading) taRef.current?.focus()
  }, [editor.loading])

  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('editor.title', { name: editor.name })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          onSave()
        }
      }}
    >
      <div className="dialog editor-dialog" data-testid="remote-editor">
        <div className="editor-head">
          <p className="dialog-title">
            ✎ {t('editor.title', { name: editor.name })}
            {dirty && (
              <span className="editor-dirty" title={t('editor.unsaved')}>
                ●
              </span>
            )}
          </p>
          <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="editor-path mono" title={editor.path}>
          {editor.path}
        </p>
        <div className="editor-body">
          {editor.loading ? (
            <p className="editor-loading">{t('editor.reading')}</p>
          ) : editor.loadError !== '' ? (
            <div className="editor-error">
              <p>{editor.loadError}</p>
              <button type="button" className="btn small" onClick={onReload}>
                {t('editor.readRetry')}
              </button>
            </div>
          ) : (
            <textarea
              ref={taRef}
              className="editor-ta"
              spellCheck={false}
              wrap="off"
              aria-label={t('editor.title', { name: editor.name })}
              value={editor.content}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                  e.preventDefault()
                  const ta = e.currentTarget
                  const at = ta.selectionStart
                  const next = `${editor.content.slice(0, at)}  ${editor.content.slice(ta.selectionEnd)}`
                  onChange(next)
                  requestAnimationFrame(() => {
                    ta.selectionStart = at + 2
                    ta.selectionEnd = at + 2
                  })
                }
              }}
            />
          )}
        </div>
        {editor.conflict && (
          <div className="editor-conflict" role="alert">
            <span>{t('editor.conflictHint')}</span>
            <span className="xfer-pop-acts">
              <button type="button" className="btn small danger" onClick={onOverwrite}>
                {t('editor.overwrite')}
              </button>
              <button type="button" className="btn small" onClick={onReload}>
                {t('editor.reload')}
              </button>
            </span>
          </div>
        )}
        <div className="editor-status" aria-live="polite">
          <span className="xfer-meta">
            {t('editor.stats', { n: String(lines), chars: String(chars) })} · {fmtSize(editor.size)} · UTF-8
          </span>
          <span className="editor-save-state">
            {editor.saving
              ? t('editor.saving')
              : editor.saveError !== ''
                ? `${t('editor.saveFailed')}: ${editor.saveError}`
                : editor.savedMsg !== ''
                  ? t('editor.savedAt', { time: editor.savedMsg })
                  : dirty
                    ? t('editor.unsaved')
                    : t('editor.clean')}
          </span>
          {editor.saveError !== '' && !editor.saving && (
            <button type="button" className="btn small" onClick={onSave}>
              {t('editor.saveRetry')}
            </button>
          )}
          <span className="editor-acts">
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={editor.saving || editor.loading || editor.loadError !== ''}
              aria-busy={editor.saving}
              data-testid="btn-editor-save"
              onClick={onSave}
            >
              {editor.saving ? t('editor.saving') : `${t('editor.save')} Ctrl+S`}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

