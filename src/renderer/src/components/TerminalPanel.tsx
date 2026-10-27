import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import type { TaskRecord } from '../../../shared/types'
import { clampFontSize, loadFontSize, persistFontSize } from '../font-size'
import { isFontFamily, isFontInstalled, loadFontFamily, persistFontFamily } from '../font-family'
import { terminalThemeFor } from '../theme'
import { SidebarMenu } from './SidebarMenu'
import type { EffectiveTheme } from '../theme'
import { subscribeTaskData, useAppStore } from '../store'

/**
 * 终端面板：每任务一个 xterm Terminal 实例（模块级缓存）。
 * - tab 切换不销毁实例：非 active 用 style.display='none' 隐藏，回切 buffer 保留
 * - close tab → 退订 PTY 数据 + dispose Terminal + 清缓存
 * - terminal.unicode.activeVersion='11'（CJK/emoji 宽度修正）
 * - v0.5②：默认字号 15（font-size.ts）+ Ctrl+=/-（attachCustomKeyEventHandler，
 *   防隐藏 textarea 先消费）+ Ctrl+滚轮（host 捕获 preventDefault）+ 持久化
 * - v0.9④：字体族白名单（font-family.ts）——新实例取持久化值，运行时经
 *   changeFontFamily 换装（字号/字体族同属字模几何，共用 dirty 补偿）
 * - v1.0.8：WebGL 渲染器（中文栅格对齐根治）+ IME 组合期输出缓冲（候选框消闪）
 *   + term.paste 粘贴通道（括号粘贴/换行归一化）+ Shift+Enter 换行 + 面板内搜索
 */
export const terminalCache = new Map<string, Terminal>()
const fitAddonCache = new Map<string, FitAddon>()
const searchAddonCache = new Map<string, SearchAddon>()

/**
 * v1.0.8 应用终端主题：options.theme 之外同步注入 composition-view 主题化 CSS 变量
 * （xterm 自带样式是 background:#000/color:#FFF，浅色主题下 IME 组合文字闪黑框——
 * styles.css 用 .composition-view { background: var(--cwb-term-bg) } 消费）。
 */
export function applyTermTheme(term: Terminal, theme: EffectiveTheme): void {
  const t = terminalThemeFor(theme)
  term.options.theme = t
  if (term.element && t.background !== undefined && t.foreground !== undefined) {
    term.element.style.setProperty('--cwb-term-bg', t.background)
    term.element.style.setProperty('--cwb-term-fg', t.foreground)
  }
}

/**
 * v1.0.8 IME 组合期 PTY 输出缓冲上限（字符数）：xterm 每渲染帧都会把 composition-view
 * 和隐藏 textarea 重锚到光标格——claude 流式输出下锚点随 TUI 重绘来回搬，输入法候选框
 * 跟着闪。组合期间冻结回放、compositionend 后一次 flush 即可稳住锚点；上限防长组合
 * + 大流量输出撑爆内存（超限宁可闪一下也不丢数据）。
 */
const IME_BUFFER_LIMIT = 1_000_000

/**
 * 字模几何（v0.5② 字号 / v0.9④ 字体族）变更时处于隐藏态的实例——激活时补
 * fit+ptyResize（隐藏时 fit 按 0 尺寸算错）
 */
const fontDirty = new Set<string>()

/**
 * v0.5② 字号调整单一入口（Ctrl+=/-、Ctrl+滚轮、设置弹窗 stepper 共用）：
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
      fontDirty.add(taskId)
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

/**
 * v0.9④ 字体族调整单一入口（设置弹窗 select）：白名单校验 → 持久化 →
 * 遍历 terminalCache 逐实例 set options.fontFamily（字体变更字模尺寸必变，
 * 与字号同路：活动实例 fit+ptyResize，隐藏实例标 dirty 激活补偿）。
 * 返回实际落地字体族（非白名单/同值时短路，不动缓存不发 ptyResize）。
 */
export function changeFontFamily(family: string): string {
  const current = loadFontFamily()
  if (family === current) return current
  // v0.9.4：白名单成员 或 本机已安装字体（fonts.check）均放行
  if (!isFontFamily(family) && isFontInstalled(family) !== true) return current
  persistFontFamily(family)
  const activeId = useAppStore.getState().activeTaskId
  for (const [taskId, term] of terminalCache) {
    term.options.fontFamily = family
    if (taskId !== activeId) {
      fontDirty.add(taskId)
      continue
    }
    try {
      fitAddonCache.get(taskId)?.fit()
    } catch {
      // 隐藏态 propose 失败不阻断——用 term 现值同步即可
    }
    window.cwb.ptyResize(taskId, term.cols, term.rows)
  }
  return family
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
  searchAddonCache.delete(taskId)
}

function TerminalView({ task, active }: { task: TaskRecord; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  // v1.0.4 右键菜单：光标锚点 + 打开时刻的选中快照；nullBtnRef 永空（占位满足
  // SidebarMenu 的 triggerRef 契约——outside-click 对任何点击都关闭，含终端区）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sel: string } | null>(null)
  const nullBtnRef = useRef<HTMLButtonElement>(null)
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
        // 默认字体，Win11 自带；制表符/块元素/盲文渲染显著优于 Consolas）；
        // v0.9④ 改白名单可选项（font-family.ts，持久化值优先），xterm 自动落 CSS font-family
        fontFamily: loadFontFamily(),
        fontSize: loadFontSize(), // v0.5② 默认 15（持久化值优先）
        lineHeight: 1.2, // 接近真实终端默认行距，长输出更透气
        letterSpacing: 0,
        cursorBlink: true,
        convertEol: false,
        // ── v1.0.8 终端保真三项 ──────────────────────────────────────────
        scrollback: 8000, // xterm 默认 1000 行太小——长会话回滚被截（WT 默认 9001 量级）
        rescaleOverlappingGlyphs: true, // GB18030：歧义宽度字形溢出相邻格时横向缩放
        windowsPty: { backend: 'conpty' }, // 后端是 ConPTY——行数增加时 scrollback 补行启发式（防内容丢失）
        // OSC 8 超链接出口：xterm 默认无 handler 时弹原生 confirm 警告框——统一走
        // openExternal（main 侧 http/https 白名单 → 系统浏览器）
        linkHandler: {
          activate: (_e, uri) => {
            void window.cwb.openExternal(uri)
          }
        },
        // v0.5.3：主题不再硬编码——按当前生效取（跟随开关 + UI 主题解耦，见 theme.ts）
        theme: terminalThemeFor(currentTerminalTheme())
      })
      // v0.5②：Ctrl+= / Ctrl+- 调字号——attachCustomKeyEventHandler 拦在 xterm
      // 键盘处理之前（窗口级监听会被 xterm 隐藏 textarea 先消费）；返回 false
      // 阻止 xterm 继续处理该键。
      // v1.0.2：粘贴/复制——Electron 移除应用菜单后原生 paste 加速键不可靠（实测
      // Ctrl+V 发送 ^V 到 PTY 而非粘贴），显式读剪贴板经 term.paste() 走 xterm 正规
      // 粘贴通道（括号粘贴包装 + \r?\n→\r 归一化——直接 ptyWrite 丢这两层保护，多行
      // 粘贴会被 claude 逐行提交）；复制对齐 Windows Terminal 习惯（Ctrl+C 有选中=
      // 复制、无选中=发 ^C 中断；Ctrl+Shift+C/Ctrl+Insert 恒复制）
      t.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true
        // v1.0.8 Shift+Enter 换行：发 ESC+CR（claude /terminal-setup 给 VS Code 写的
        // 同款序列）。xterm 6 无 kitty/modifyOtherKeys/win32-input 协议，修饰键无法
        // 原生透传——必须在此显式翻译。IME 组合中的 Enter 是选字确认，放行。
        if (
          ev.key === 'Enter' &&
          ev.shiftKey &&
          !ev.ctrlKey &&
          !ev.altKey &&
          !ev.metaKey &&
          !ev.isComposing
        ) {
          window.cwb.ptyWrite(task.id, '\x1b\r')
          return false
        }
        // v1.0.8 面板内搜索（VS Code/Windows Terminal 惯例 Ctrl+Shift+F）
        if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'f') {
          useAppStore.getState().openSearch()
          return false
        }
        // 粘贴三键：Ctrl+V / Ctrl+Shift+V / Shift+Insert
        if (
          (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'v') ||
          (ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === 'Insert')
        ) {
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text !== '') t.paste(text)
            })
            .catch(() => {
              // 剪贴板权限被拒/不可用——退回原生 paste 事件路径（xterm textarea 或可触发）
            })
          return false
        }
        // 复制：Ctrl+Shift+C / Ctrl+Insert / Ctrl+C（有选中时）
        const isCopyKey =
          (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') ||
          (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c' && t.hasSelection()) ||
          (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key === 'Insert')
        if (isCopyKey) {
          const sel = t.getSelection()
          if (sel !== '') {
            void navigator.clipboard.writeText(sel).catch(() => {})
            return false
          }
          return true // 无选中（Ctrl+Insert 空选）放行
        }
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
      // v1.0.8 链接出口收敛：正则链接点击 → openExternal（协议白名单见 ipc.ts）；
      // WebLinksAddon 默认 handler 走 window.open——主进程已 deny，必须显式给 handler
      t.loadAddon(
        new WebLinksAddon((_e, uri) => {
          void window.cwb.openExternal(uri)
        })
      )
      // v1.0.8 面板内搜索（addon 与终端同生命周期；SearchBar 只持引用不重复创建）
      const search = new SearchAddon()
      t.loadAddon(search)
      searchAddonCache.set(task.id, search)
      terminalCache.set(task.id, t)
      fitAddonCache.set(task.id, fit)
      t.open(host)
      // v1.0.8 WebGL 渲染器：逐格纹理绘制替代 DOM 渲染器的 letter-spacing 补偿——
      // 中文/emoji 字形与选择高亮的栅格对齐由此根治（rescaleOverlappingGlyphs 也仅在
      // WebGL 下生效）。加载失败（无 GPU/jsdom）或上下文丢失静默回落 DOM 渲染器，
      // 不加配置项——渲染器是实现细节，降级信息进 console 供诊断。
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          console.info('[cwb] WebGL context lost，终端回落 DOM 渲染器')
        })
        t.loadAddon(webgl)
      } catch (err) {
        console.info(
          '[cwb] WebGL 渲染器不可用，使用 DOM 渲染器：',
          err instanceof Error ? err.message : err
        )
      }
      applyTermTheme(t, currentTerminalTheme())
      fitAndSync(task.id, host)
      term = t
    } else {
      term.open(host) // 防御：缓存仍在但宿主重建（如 StrictMode 重挂载）
    }

    const terminal = term

    // v1.0.8 IME 组合期输出缓冲（见模块头 IME_BUFFER_LIMIT 注释）：组合期间 PTY 数据
    // 进队列不渲染——渲染帧不动，composition-view/textarea 锚点稳定，候选框不闪。
    // compositionend 正常 flush；blur 兜底（焦点丢失时部分 IME 不补发 compositionend）。
    let composing = false
    let pending = ''
    const flushPending = (): void => {
      if (pending !== '') {
        terminal.write(pending)
        pending = ''
      }
    }
    const ta = terminal.textarea
    const onCompositionStart = (): void => {
      composing = true
    }
    const onCompositionEnd = (): void => {
      composing = false
      flushPending()
    }
    const onTextareaBlur = (): void => {
      if (composing) {
        composing = false
        flushPending()
      }
    }
    ta?.addEventListener('compositionstart', onCompositionStart)
    ta?.addEventListener('compositionend', onCompositionEnd)
    ta?.addEventListener('blur', onTextareaBlur)

    const onDataDisposer = terminal.onData((d) => window.cwb.ptyWrite(task.id, d))
    const unsubscribePty = subscribeTaskData(task.id, (d) => {
      if (composing) {
        pending += d
        if (pending.length > IME_BUFFER_LIMIT) flushPending() // 上限保护：宁可闪不卡死
        return
      }
      terminal.write(d)
    })
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
      ta?.removeEventListener('compositionstart', onCompositionStart)
      ta?.removeEventListener('compositionend', onCompositionEnd)
      ta?.removeEventListener('blur', onTextareaBlur)
      disposeTaskTerminal(task.id, host)
      fontDirty.delete(task.id)
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
  // v0.5②：隐藏期间字号/字体族变更的补偿——激活即 fit+ptyResize（dirty 标记见 changeFontSize）
  useEffect(() => {
    if (!active) return
    if (fontDirty.delete(task.id)) {
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
      // v1.0.4 右键菜单：claude TUI 开启鼠标上报后拖拽被透传给 PTY（本地选择需按住
      // Shift 拖拽——Windows Terminal 同款约定），键盘/菜单复制是主要复制路径。
      // v1.0.9：菜单降级为 Shift+右键（全选/清屏等低频项）；普通右键改智能动作
      // （无选中=粘贴/有选中=复制，Windows Terminal 默认语义——高频路径一键直达）。
      // 菜单打开前快照选中内容（菜单点击会清 xterm 选中）
      onContextMenu={(e) => {
        e.preventDefault()
        const term = terminalCache.get(task.id)
        // v1.0.9 右键智能动作（Windows Terminal 默认语义）：无选中=直接粘贴，有选中=
        // 复制并清选中（下一次右键即粘贴——"选中→右键复制→右键粘贴"自然衔接）。
        // 两条路径都即时 focus 终端：粘贴后 claude TUI 回显，光标自动落在粘贴内容之后
        // （用户需求：粘贴完光标自动定位）。Shift+右键保留完整菜单（全选/清屏等低频项）。
        if (!e.shiftKey) {
          if (term && term.hasSelection()) {
            const sel = term.getSelection()
            if (sel !== '') void navigator.clipboard.writeText(sel).catch(() => {})
            term.clearSelection()
            term.focus()
            return
          }
          term?.focus()
          void navigator.clipboard
            .readText()
            .then((text) => {
              // 双重防护：tab 已关（缓存无此实例）不粘贴，防 disposed terminal 抛错
              if (text !== '' && terminalCache.get(task.id) === term) term?.paste(text)
            })
            .catch(() => {
              // 剪贴板权限被拒——仅聚焦（原生 paste 事件路径或可触发）
            })
          return
        }
        setCtxMenu({ x: e.clientX, y: e.clientY, sel: term?.getSelection() ?? '' })
      }}
    >
      {ctxMenu !== null && (
        <SidebarMenu
          triggerRef={nullBtnRef}
          anchor={{ x: ctxMenu.x, y: ctxMenu.y }}
          items={[
            ...(ctxMenu.sel !== ''
              ? [
                  {
                    label: '复制',
                    onClick: () =>
                      void navigator.clipboard
                        .writeText(ctxMenu.sel)
                        .catch(() => {})
                  }
                ]
              : []),
            {
              label: '粘贴',
              // v1.0.8：与 Ctrl+V 同路——term.paste() 走 xterm 粘贴通道（括号粘贴/换行归一化）；
              // v1.0.9：粘贴后焦点还终端（菜单点击会 steal focus，光标需回位）
              onClick: () =>
                void navigator.clipboard
                  .readText()
                  .then((text) => {
                    if (text !== '') terminalCache.get(task.id)?.paste(text)
                  })
                  .catch(() => {})
                  .finally(() => terminalCache.get(task.id)?.focus())
            },
            {
              label: '全选',
              onClick: () => terminalCache.get(task.id)?.selectAll()
            },
            {
              label: '清屏',
              onClick: () => terminalCache.get(task.id)?.clear()
            }
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

/** v0.4.3 焦点管理③：对话框/菜单关闭后把键盘焦点还给当前活跃终端 */
export function focusActiveTerminal(): void {
  const id = useAppStore.getState().activeTaskId
  if (id) terminalCache.get(id)?.focus()
}

/**
 * v1.0.8 面板内搜索浮层（VS Code/Windows Terminal 惯例：Ctrl+Shift+F 开、Esc 关）：
 * - 增量搜索（边输边跳）+ 全量匹配高亮（decorations，主题中性色——深浅底都可见）
 * - Enter 下一个 / Shift+Enter 上一个 / ↑↓ 按钮同义；计数 n/m（onDidChangeResults）
 * - 目标=打开时的活跃终端；切换 tab 自动关（对齐 VS Code），关闭清装饰并把焦点还终端
 */
function TerminalSearchBar() {
  const closeSearch = useAppStore((s) => s.closeSearch)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const [term, setTerm] = useState('')
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const addonRef = useRef<SearchAddon | null>(
    searchAddonCache.get(useAppStore.getState().activeTaskId ?? '') ?? null
  )

  useEffect(() => {
    inputRef.current?.focus()
    const addon = addonRef.current
    if (!addon) return
    const d = addon.onDidChangeResults((e) => setResult({ index: e.resultIndex, count: e.resultCount }))
    return () => {
      d.dispose()
      addon.clearDecorations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时取目标终端与订阅
  }, [])

  // 切换 tab → 关闭（搜索目标是打开时的终端；不跨终端续搜，避免装饰残留）
  const activeRef = useRef(activeTaskId)
  useEffect(() => {
    if (activeRef.current !== activeTaskId) {
      activeRef.current = activeTaskId
      closeSearch()
    }
  }, [activeTaskId, closeSearch])

  const decorations = () => ({
    matchBackground: '#e8c26a',
    matchOverviewRuler: '#e8c26a',
    activeMatchBackground: '#f28c3a',
    activeMatchColorOverviewRuler: '#f28c3a'
  })

  const run = (dir: 'next' | 'prev', incremental: boolean, value: string): void => {
    const addon = addonRef.current
    if (!addon) return
    if (value === '') {
      addon.clearDecorations()
      setResult(null)
      return
    }
    // onChange 里 state 尚未更新——必须传实时值（闭包读 state 会拿到上一帧的空串）
    const opts = { incremental, decorations: decorations() }
    if (dir === 'next') addon.findNext(value, opts)
    else addon.findPrevious(value, opts)
  }

  const label =
    result !== null && term !== ''
      ? result.index >= 0
        ? `${result.index + 1}/${result.count}`
        : `>${result.count}`
      : ''

  return (
    <div className="term-search" role="search">
      <input
        ref={inputRef}
        className="term-search-input"
        type="text"
        placeholder="在终端中查找…"
        value={term}
        aria-label="终端搜索"
        onChange={(e) => {
          const v = e.target.value
          setTerm(v)
          run('next', true, v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            closeSearch()
            focusActiveTerminal()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            run(e.shiftKey ? 'prev' : 'next', false, term)
          }
        }}
      />
      <span className="term-search-count">{label}</span>
      <button type="button" className="btn btn-mini" aria-label="上一个匹配" onClick={() => run('prev', false, term)}>
        ↑
      </button>
      <button type="button" className="btn btn-mini" aria-label="下一个匹配" onClick={() => run('next', false, term)}>
        ↓
      </button>
      <button
        type="button"
        className="btn btn-mini"
        aria-label="关闭搜索"
        onClick={() => {
          closeSearch()
          focusActiveTerminal()
        }}
      >
        ×
      </button>
    </div>
  )
}

export function TerminalPanel() {
  const openTaskIds = useAppStore((s) => s.openTaskIds)
  const tasks = useAppStore((s) => s.tasks)
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const projects = useAppStore((s) => s.projects)
  const searchOpen = useAppStore((s) => s.searchOpen)
  /** v0.5.3 终端主题联动：effectiveTheme/termFollowsTheme 任一变化 → 遍历缓存
   *  逐实例换 theme（v1.0.8 起 applyTermTheme 同步 composition-view 主题变量；
   *  xterm 自动重绘，无需 fit；新建实例在创建路径取当前值） */
  const terminalTheme = useAppStore((s) => (s.termFollowsTheme ? s.effectiveTheme : 'dark'))

  useEffect(() => {
    for (const term of terminalCache.values()) {
      applyTermTheme(term, terminalTheme)
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
        <>
          {openTasks.map((t) => (
            <TerminalView key={t.id} task={t} active={t.id === activeTaskId} />
          ))}
          {searchOpen && <TerminalSearchBar />}
        </>
      )}
    </div>
  )
}
