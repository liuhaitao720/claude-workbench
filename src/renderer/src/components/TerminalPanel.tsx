import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TaskRecord } from '../../../shared/types'
import { clampFontSize, loadFontSize, persistFontSize } from '../font-size'
import { terminalThemeFor } from '../theme'
import type { EffectiveTheme } from '../theme'
import { subscribeTaskData, useAppStore } from '../store'

/**
 * 终端面板：每任务一个 xterm Terminal 实例（模块级缓存）。
 * - tab 切换不销毁实例：非 active 用 style.display='none' 隐藏，回切 buffer 保留
 * - close tab → 退订 PTY 数据 + dispose Terminal + 清缓存
 * - terminal.unicode.activeVersion='11'（CJK/emoji 宽度修正）
 * - v0.5②：默认字号 15（font-size.ts）+ Ctrl+=/-（attachCustomKeyEventHandler，
 *   防隐藏 textarea 先消费）+ Ctrl+滚轮（host 捕获 preventDefault）+ 持久化
 */
export const terminalCache = new Map<string, Terminal>()
const fitAddonCache = new Map<string, FitAddon>()

/** v0.5②：字号变更时处于隐藏态的实例——激活时补 fit+ptyResize（隐藏时 fit 按 0 尺寸算错） */
const fontSizeDirty = new Set<string>()

/**
 * v0.5② 字号调整单一入口（Ctrl+=/-、Ctrl+滚轮共用）：
 * clamp → 持久化 → 遍历 terminalCache 逐实例 set options.fontSize；
 * 活动实例 fit+ptyResize（对齐 resume 先例：fit 失败不阻断、ptyResize 无条件发，
 * jsdom 可测）；隐藏实例标 dirty 由激活 effect 补偿。返回实际落地字号。
 */
export function changeFontSize(delta: number): number {
  const current = loadFontSize()
  const next = clampFontSize(current + delta)
  if (next === current) return next // 已在边界——短路，避免无谓的 ptyResize 风暴
  persistFontSize(next)
  const activeId = useAppStore.getState().activeTaskId
  for (const [taskId, term] of terminalCache) {
    term.options.fontSize = next
    if (taskId !== activeId) {
      fontSizeDirty.add(taskId)
      continue
    }
    try {
      fitAddonCache.get(taskId)?.fit()
    } catch {
      // 隐藏态 propose 失败不阻断——用 term 现值同步即可
    }
    window.cwb.ptyResize(taskId, term.cols, term.rows)
  }
  return next
}

/** 终端生效主题（v0.5.3 解耦设计）：跟随开关关 → 恒 dark（浅 UI 下终端仍深底） */
function currentTerminalTheme(): EffectiveTheme {
  const { termFollowsTheme, effectiveTheme } = useAppStore.getState()
  return termFollowsTheme ? effectiveTheme : 'dark'
}

/** 容器可见时 fit + 同步 pty 尺寸；尺寸为 0（隐藏/jsdom）时跳过 */
function fitAndSync(taskId: string, host: HTMLElement): void {
  if (host.offsetWidth <= 0 || host.offsetHeight <= 0) return
  const fit = fitAddonCache.get(taskId)
  const term = terminalCache.get(taskId)
  if (!fit || !term) return
  // 抖动根因防护（v0.1.1）：ResizeObserver↔fit 反馈回路——fit 改变栅格会再触发 observer，
  // Windows 滚动条占宽/DPI 亚像素行高会让建议尺寸在相邻两值间振荡，claude TUI 随 resize
  // 全量重绘 → 输入时上下剧烈抖动。仅在 cols/rows 真实变化时才 fit+同步，斩断回路。
  const dims = fit.proposeDimensions()
  if (!dims || dims.cols <= 0 || dims.rows <= 0) return
  if (dims.cols === term.cols && dims.rows === term.rows) return
  fit.fit()
  window.cwb.ptyResize(taskId, term.cols, term.rows)
}

function disposeTaskTerminal(taskId: string, host: HTMLElement): void {
  const term = terminalCache.get(taskId)
  if (term) {
    if (term.element && term.element.parentNode === host) host.removeChild(term.element)
    term.dispose()
    terminalCache.delete(taskId)
  }
  fitAddonCache.delete(taskId)
}

function TerminalView({ task, active }: { task: TaskRecord; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  // v0.1.2 光标错位修复：任务恢复（stopped→running）时终端不重新挂载、host 不变，
  // v0.1.1 的尺寸去重使 observer 不再兜底——PTY 以记忆尺寸重开后必须在此强制重同步
  // 并清掉旧会话残留缓冲，否则 claude 按旧栅格/旧缓冲计算光标 → 错位错行
  const prevStatusRef = useRef<TaskRecord['status']>(task.status)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let term = terminalCache.get(task.id)
    if (!term) {
      const t = new Terminal({
        allowProposedApi: true, // unicode 版本切换属 proposed API（CJK 宽度修正必需）
        // v0.4.5 字体对齐 claude CLI 真实终端观感：Cascadia Mono（Windows Terminal
        // 默认字体，Win11 自带；制表符/块元素/盲文渲染显著优于 Consolas），逐级回退
        fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
        fontSize: loadFontSize(), // v0.5② 默认 15（持久化值优先）
        lineHeight: 1.2, // 接近真实终端默认行距，长输出更透气
        letterSpacing: 0,
        cursorBlink: true,
        convertEol: false,
        // v0.5.3：主题不再硬编码——按当前生效取（跟随开关 + UI 主题解耦，见 theme.ts）
        theme: terminalThemeFor(currentTerminalTheme())
      })
      // v0.5②：Ctrl+= / Ctrl+- 调字号——attachCustomKeyEventHandler 拦在 xterm
      // 键盘处理之前（窗口级监听会被 xterm 隐藏 textarea 先消费）；返回 false
      // 阻止 xterm 继续处理该键
      t.attachCustomKeyEventHandler((ev) => {
        if (!ev.ctrlKey || ev.metaKey || ev.altKey) return true
        if (ev.key === '=' || ev.key === '+') {
          changeFontSize(1)
          return false
        }
        if (ev.key === '-' || ev.key === '_') {
          changeFontSize(-1)
          return false
        }
        return true
      })
      const fit = new FitAddon()
      t.loadAddon(fit)
      t.loadAddon(new Unicode11Addon())
      t.unicode.activeVersion = '11'
      t.loadAddon(new WebLinksAddon())
      terminalCache.set(task.id, t)
      fitAddonCache.set(task.id, fit)
      t.open(host)
      fitAndSync(task.id, host)
      term = t
    } else {
      term.open(host) // 防御：缓存仍在但宿主重建（如 StrictMode 重挂载）
    }

    const terminal = term
    const onDataDisposer = terminal.onData((d) => window.cwb.ptyWrite(task.id, d))
    const unsubscribePty = subscribeTaskData(task.id, (d) => terminal.write(d))
    // v0.5②：Ctrl+滚轮缩放——host 捕获阶段 preventDefault（xterm 的 wheel 处理器
    // 遵循 defaultPrevented 早退，捕获先于其目标阶段触发），同时阻断终端滚动与
    // 浏览器缩放默认行为；非 Ctrl 滚轮原样放行
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      changeFontSize(e.deltaY < 0 ? 1 : -1)
    }
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })
    // rAF 合并 resize 回调（v0.1.1）：observer 短时间连发只落地最后一帧，
    // 配合 fitAndSync 的尺寸去重，杜绝 resize 风暴
    let resizeRaf = 0
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => fitAndSync(task.id, host))
    })
    resizeObserver.observe(host)

    return () => {
      cancelAnimationFrame(resizeRaf)
      host.removeEventListener('wheel', onWheel, { capture: true })
      resizeObserver.disconnect()
      onDataDisposer.dispose()
      unsubscribePty()
      disposeTaskTerminal(task.id, host)
      fontSizeDirty.delete(task.id)
    }
  }, [task.id])

  // 恢复任务（stopped→running）：清缓冲 + 强制重同步尺寸（ptyResize 无条件发，
  // 绕过 fitAndSync 去重——term 尺寸可能未变，但 PTY 是新实例必须被告知）。
  // 顺序设计（评审 F2 注明）：先 reset 后 ptyResize——若 PTY 首段输出先于本 effect
  // 到达会被 reset 清掉，随后的 ptyResize 触发 claude 全量重绘自愈；反过来
  // （先 resize 后 reset）会把正确栅格的首帧也清掉且无重绘驱动，不可调换。
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = task.status
    if (prev !== 'stopped' || task.status !== 'running') return
    const term = terminalCache.get(task.id)
    if (!term) return
    term.reset()
    try {
      fitAddonCache.get(task.id)?.fit()
    } catch {
      // propose 失败（如隐藏态）不阻断——用 term 现值同步即可
    }
    window.cwb.ptyResize(task.id, term.cols, term.rows)
  }, [task.id, task.status])

  // v0.4.3 焦点管理①：tab 激活（打开/切换）即聚焦终端——否则键入落在侧栏/按钮上，
  // 表现为"选完对话框选项后无法输入"（键盘焦点从未进入终端）。
  // v0.5②：隐藏期间字号变更的补偿——激活即 fit+ptyResize（dirty 标记见 changeFontSize）
  useEffect(() => {
    if (!active) return
    if (fontSizeDirty.delete(task.id)) {
      const term = terminalCache.get(task.id)
      if (term) {
        try {
          fitAddonCache.get(task.id)?.fit()
        } catch {
          // propose 失败不阻断——term 现值同步
        }
        window.cwb.ptyResize(task.id, term.cols, term.rows)
      }
    }
    const timer = window.setTimeout(() => terminalCache.get(task.id)?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [active, task.id])

  return (
    <div
      ref={hostRef}
      className={active ? 'term-host term-host-active' : 'term-host'}
      style={active ? undefined : { display: 'none' }}
      // v0.4.3 焦点管理②：终端区域任意 mousedown 必把键盘焦点收回终端
      //（TUI 鼠标上报模式下点击选项，焦点可能未落在 xterm 隐藏文本域）
      onMouseDown={() => terminalCache.get(task.id)?.focus()}
    />
  )
}

/** v0.4.3 焦点管理③：对话框/菜单关闭后把键盘焦点还给当前活跃终端 */
export function focusActiveTerminal(): void {
  const id = useAppStore.getState().activeTaskId
  if (id) terminalCache.get(id)?.focus()
}

export function TerminalPanel() {
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const tasks = useAppStore((s) => s.tasks)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const projects = useAppStore((s) => s.projects)
  /** v0.5.3 终端主题联动：effectiveTheme/termFollowsTheme 任一变化 → 遍历缓存
   *  逐实例换 theme（xterm 自动重绘，无需 fit；新建实例在创建路径取当前值） */
  const terminalTheme = useAppStore((s) => (s.termFollowsTheme ? s.effectiveTheme : 'dark'))

  useEffect(() => {
    for (const term of terminalCache.values()) {
      term.options.theme = terminalThemeFor(terminalTheme)
    }
  }, [terminalTheme])

  const openTasks = useMemo(() => {
    const list: TaskRecord[] = []
    for (const id of openTaskIds) {
      const t = tasks.find((x) => x.id === id)
      if (t) list.push(t)
    }
    return list
  }, [openTaskIds, tasks])

  return (
    <div className="terminal-panel">
      {openTasks.length === 0 ? (
        /* 零项目时提示由主区 empty-hint 承担（A3），此处不再叠加一句误导文案 */
        projects.length > 0 && (
          <div className="terminal-empty">暂无打开的终端——点击任务行打开终端 tab</div>
        )
      ) : (
        openTasks.map((t) => <TerminalView key={t.id} task={t} active={t.id === activeTaskId} />)
      )}
    </div>
  )
}
