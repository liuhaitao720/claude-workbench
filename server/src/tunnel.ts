/**
 * 公网隧道（v2.2.0 B 链，设计 §3.5）：Cloudflare Quick Tunnel。
 *
 * 手机在外网、server 在内网（用户约束）——应答页只监听 127.0.0.1，由 cloudflared
 * 反向代理出公网。免账号/免域名（2.3f=A），无 Cloudflare 插入页。
 *
 * - 仅当 answer.enabled 时启动（调用方决定）；
 * - URL 从子进程输出解析，校验 *.trycloudflare.com 后缀；
 * - 退出/断线指数退避 5s→60s 重启，URL 变化经 onState 广播；
 * - 二进制定位 CWB_CLOUDFLARED_BIN → PATH → ~/.cwb/bin/cloudflared；缺失=tunnel
 *   'missing'（不挂起、推送不带链接）。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type TunnelState = 'off' | 'starting' | 'up' | 'down' | 'missing'

/** 重启退避下限/上限（设计 §3.5：5s→60s） */
export const TUNNEL_RESTART_MIN_MS = 5_000
export const TUNNEL_RESTART_MAX_MS = 60_000

/** 仅接受 Cloudflare 快速隧道 URL（防子进程输出被伪造指向任意主机） */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g

/** 子进程最小契约（测试注入假实现） */
export interface TunnelChild {
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}

export type TunnelSpawnFn = (
  file: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] }
) => TunnelChild

export interface CloudflareTunnelOptions {
  /** 应答页本端口（隧道目标；未就绪时暂不启动） */
  targetPort: () => number | undefined
  /** 状态变化回调（UI/广播；url 只在 up 时给出） */
  onState: (state: TunnelState, url?: string) => void
  /** 已解析的 cloudflared 路径；undefined=缺失 */
  bin?: string | undefined
  /** 测试注入 */
  spawnImpl?: TunnelSpawnFn
  log?: (level: 'info' | 'warn', message: string) => void
}

export class CloudflareTunnel {
  private proc: TunnelChild | undefined
  private state: TunnelState = 'off'
  private currentUrl: string | undefined
  /** 上次回调广播的 URL（去重；URL 变化须重新广播） */
  private emittedUrl: string | undefined
  private stopped = true
  private attempt = 0
  private restartTimer: NodeJS.Timeout | undefined

  constructor(private readonly opts: CloudflareTunnelOptions) {}

  get tunnelState(): TunnelState {
    return this.state
  }

  get url(): string | undefined {
    return this.currentUrl
  }

  /** 启动（幂等）：先报 starting，再拉起子进程 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.spawnOnce()
  }

  /** 停止：杀子进程、清退避定时器、状态归 off（幂等） */
  stop(): void {
    this.stopped = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const proc = this.proc
    this.proc = undefined
    this.currentUrl = undefined
    if (proc !== undefined) {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
    }
    this.setState('off')
  }

  private spawnOnce(): void {
    if (this.stopped) return
    if (this.opts.bin === undefined) {
      this.setState('missing')
      return
    }
    const port = this.opts.targetPort()
    if (port === undefined) {
      // 页面尚未监听：稍后重试（沿用退避，不消耗 attempt）
      this.setState('down')
      this.scheduleRestart(0)
      return
    }
    this.setState('starting')
    const spawnImpl: TunnelSpawnFn = this.opts.spawnImpl ?? (spawn as unknown as TunnelSpawnFn)
    let proc: TunnelChild
    try {
      proc = spawnImpl(
        this.opts.bin,
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      this.opts.log?.('warn', `cloudflared spawn failed: ${errText(err)}`)
      this.setState('down')
      this.scheduleRestart()
      return
    }
    this.proc = proc
    let buffer = ''
    const scan = (chunk: unknown): void => {
      buffer = (buffer + String(chunk)).slice(-8192)
      // 取 buffer 里最后一个 URL（重启后新 URL 会追加；旧 URL 仍在窗口内）
      const found = [...buffer.matchAll(URL_RE)].at(-1)?.[0]
      if (found !== undefined && found !== this.currentUrl) {
        this.currentUrl = found
        this.attempt = 0
        this.setState('up', found)
        this.opts.log?.('info', 'tunnel up')
      }
    }
    proc.stdout?.on('data', scan)
    proc.stderr?.on('data', scan)
    proc.on('error', (err) => {
      this.opts.log?.('warn', `cloudflared error: ${errText(err)}`)
    })
    proc.on('exit', () => {
      if (this.proc !== proc) return
      this.proc = undefined
      this.currentUrl = undefined
      if (this.stopped) return
      this.setState('down')
      this.scheduleRestart()
    })
  }

  private scheduleRestart(delayOverride?: number): void {
    if (this.stopped) return
    if (this.restartTimer !== undefined) return
    const delay =
      delayOverride ?? Math.min(TUNNEL_RESTART_MAX_MS, TUNNEL_RESTART_MIN_MS * 2 ** this.attempt)
    if (delayOverride === undefined) this.attempt += 1
    const timer = setTimeout(() => {
      this.restartTimer = undefined
      this.spawnOnce()
    }, delay)
    timer.unref?.()
    this.restartTimer = timer
  }

  private setState(state: TunnelState, url?: string): void {
    const emitted = state === 'up' ? (url ?? this.currentUrl) : undefined
    const changed = state !== this.state || emitted !== this.emittedUrl
    this.state = state
    this.emittedUrl = emitted
    if (changed) this.opts.onState(state, emitted)
  }
}

/**
 * cloudflared 定位（设计 §3.5）：CWB_CLOUDFLARED_BIN → PATH → ~/.cwb/bin/cloudflared。
 * 返回 undefined=缺失。
 */
export function resolveCloudflaredBin(
  opts: { env?: NodeJS.ProcessEnv; home?: string; platform?: NodeJS.Platform } = {}
): string | undefined {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? env['HOME'] ?? ''
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'

  const override = env['CWB_CLOUDFLARED_BIN']
  if (override !== undefined && override !== '' && isExecutable(override)) return override

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, exe)
    if (isExecutable(candidate)) return candidate
  }

  if (home !== '') {
    const candidate = join(home, '.cwb', 'bin', exe)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n', 1)[0]!.slice(0, 120) : String(err)
}