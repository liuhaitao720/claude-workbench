import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * v1.1.0 崩溃/退出取证（用户报告「点更新后突然退出」——无日志则无法定位）。
 *
 * 只记元数据（事件名、时间、原因码、窗口/进程 id、退出触发来源），**绝不记录**
 * 终端内容、命令输出、路径里的用户数据（安全策略：日志不留敏感值）。
 * 文件 userData/cwb-crash.log，单文件上限 256KB（超限截断重写，防无限增长）。
 */

export interface CrashLogEntry {
  event: string
  detail?: string
  /** 触发退出的来源标记（before-quit 面包屑：谁调用了 quit/close） */
  origin?: string
}

const MAX_LOG_BYTES = 256 * 1024

/** 纯函数：一行日志（ISO 时间 + 事件 + 细节）；无换行/无控制字符（防日志注入） */
export function formatCrashLine(e: CrashLogEntry): string {
  const clean = (s: string): string => s.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 400)
  const parts = [new Date().toISOString(), e.event]
  if (e.origin !== undefined) parts.push(`origin=${clean(e.origin)}`)
  if (e.detail !== undefined) parts.push(clean(e.detail))
  return parts.join(' | ') + '\n'
}

export class CrashLogger {
  /** v1.1.0 退出面包屑（最近一次 quit/close 来源） */
  private lastOrigin = ''

  constructor(private readonly file: string) {}

  /** 记录事件（写盘失败静默——日志不能反噬主流程） */
  log(e: CrashLogEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      let size = 0
      try {
        size = statSync(this.file).size
      } catch {
        size = 0
      }
      const line = formatCrashLine(e)
      if (size + line.length > MAX_LOG_BYTES) {
        writeFileSync(this.file, `--- log rotated (${new Date().toISOString()}) ---\n`)
      }
      appendFileSync(this.file, line)
    } catch {
      // 静默
    }
    if (e.origin !== undefined) this.lastOrigin = e.origin
  }

  /** 触发退出的来源（before-quit 与 window-all-closed 记录用） */
  markOrigin(origin: string): void {
    this.lastOrigin = origin
    this.log({ event: 'quit-origin', origin })
  }

  origin(): string {
    return this.lastOrigin
  }
}