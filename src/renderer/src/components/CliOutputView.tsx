import { useEffect, useRef, useState } from 'react'
import { normalizeCliOutput } from '../cli-output-clean'

/**
 * CLI 命令内嵌只读输出区（v0.5③/⑤）：非完整 xterm——<pre> 滚动区按 commandId
 * 订阅 onCliOutput 追加文本；exit 事件显示退出码 + 生效提示（新任务生效/旧任务
 * 恢复后生效）；commandId 变更（换命令）时重置缓冲。About/Skills 弹窗共用。
 * 弹窗关闭的 killCliCommand 由持有命令的弹窗自身负责（本组件只读）。
 *
 * v1.1.0：输出先经 normalizeCliOutput 清洗——`claude update`/安装器带大量终端控制
 * 序列（清行/光标定位/进度条 \r 覆盖），原样塞进 <pre> 会渲染成成片空行，用户看到
 * 「点了更新没反应」。清洗后进度/结果立即可读。
 */
export function CliOutputView({
  commandId,
  onExit,
  exitHint = '新任务生效，旧任务恢复（resume）后生效'
}: {
  /** 运行中命令 id（null=无命令，不渲染） */
  commandId: string | null
  /** exit 事件回调（安装完成刷新版本信息/导入完成刷新列表等） */
  onExit?: (exitCode: number) => void
  /** 完成态提示文案（默认 claude update/install 语义） */
  exitHint?: string
}) {
  /** 原始累积输出（清洗在渲染时做——流式分片可能截断控制序列，攒够再清洗） */
  const [raw, setRaw] = useState('')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  // onExit 由调用方内联闭包（含刷新逻辑）——ref 转发避免其身份变化触发重订阅/重置缓冲
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    if (commandId === null) return
    setRaw('')
    setExitCode(null)
    const off = window.cwb.onCliOutput((e) => {
      if (e.commandId !== commandId) return
      if (e.type === 'exit') {
        setExitCode(e.exitCode ?? 0)
        onExitRef.current?.(e.exitCode ?? 0)
      } else if (e.data !== undefined) {
        setRaw((prev) => prev + e.data)
      }
    })
    return off
  }, [commandId])

  const chunks = normalizeCliOutput(raw)

  // 输出追加后滚到底部（jsdom scrollHeight=0 无副作用）
  useEffect(() => {
    const pre = preRef.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [chunks])

  if (commandId === null) return null

  return (
    <div className="cli-output-wrap">
      <pre className="cli-output" ref={preRef} role="log" aria-label="命令输出">
        {chunks === '' ? '（等待输出…）' : chunks}
      </pre>
      {exitCode !== null && (
        <p className="cli-output-exit">
          已完成（退出码 {exitCode}）——{exitHint}
        </p>
      )}
    </div>
  )
}
