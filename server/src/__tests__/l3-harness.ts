/**
 * L3 测试公共设施：esbuild 打包 → 真实子进程 server → 真实 WS 客户端工具。
 * 仅测试域使用（vitest include 只认 *.test.ts——本文件不进测试清单）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'
import { expect } from 'vitest'
import type { ClientFrame, ServerFrame } from '../shared/remote-protocol'

export const serverRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

let bundleFile: string | null = null

/**
 * 打包 server 入口（幂等缓存；ws/node-pty external——native 模块不进 bundle）。
 * 产物必须落在 server/dist/（.gitignore 已覆盖）：external 的 ws/node-pty 经
 * Node 向上目录解析命中 server/node_modules——放 /tmp 会解析失败。
 * 文件名带 pid（并发测试运行互不冲突）；worker 退出时清理（防累积）。
 */
export async function bundleServer(): Promise<string> {
  if (bundleFile !== null) return bundleFile
  const { mkdirSync } = await import('node:fs')
  const outDir = join(serverRoot, 'dist')
  mkdirSync(outDir, { recursive: true })
  sweepStaleBundles(outDir)
  bundleFile = join(outDir, `main.test-${process.pid}.cjs`)
  await build({
    entryPoints: [join(serverRoot, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundleFile,
    external: ['node-pty', 'ws'],
    logLevel: 'silent'
  })
  process.on('exit', () => {
    try {
      rmSync(bundleFile!, { force: true })
    } catch {
      /* best effort */
    }
  })
  return bundleFile
}

/** 清掉陈旧测试 bundle（>30 分钟未动——vitest 硬杀 worker 时 exit 钩子不跑的兜底；
 * 30min 阈值保证并发运行中的活跃 bundle（秒级刷新）绝不被误删） */
function sweepStaleBundles(outDir: string): void {
  const cutoff = Date.now() - 30 * 60 * 1000
  try {
    for (const name of readdirSync(outDir)) {
      if (!name.startsWith('main.test-') || !name.endsWith('.cjs')) continue
      const f = join(outDir, name)
      try {
        if (statSync(f).mtimeMs < cutoff) rmSync(f, { force: true })
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

export interface ServerProc {
  proc: ChildProcess
  port: number
  workDir: string
  /** 结束（SIGTERM→超时 SIGKILL；临时目录清理） */
  stop: () => Promise<void>
}

/** 起真实 server 子进程（--port 0 动态口），等 listening 行 */
export async function bootServer(): Promise<ServerProc> {
  const bundle = await bundleServer()
  const workDir = mkdtempSync(join(tmpdir(), 'cwb-srv-l3-'))
  const proc = spawn(process.execPath, [bundle, '--port', '0'], {
    cwd: workDir,
    env: { ...process.env, CWB_SERVER_HOME: join(workDir, 'cwb-home') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stderr!.on('data', () => {}) // 元数据日志不进测试输出
  const line = await new Promise<string>((resolve_, reject) => {
    const timer = setTimeout(() => reject(new Error('server boot timeout')), 15_000)
    let buf = ''
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        clearTimeout(timer)
        resolve_(buf.slice(0, idx))
      }
    })
    proc.once('exit', (code) => reject(new Error(`server exited early: ${code}`)))
  })
  const port = (JSON.parse(line) as { port: number }).port
  expect(port).toBeGreaterThan(0)
  return {
    proc,
    port,
    workDir,
    stop: async () => {
      const { rmSync } = await import('node:fs')
      const { once } = await import('node:events')
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        await Promise.race([once(proc, 'exit'), sleep(3000)])
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

/** 等待满足谓词的帧（超时抛错；默认 15s——本机并行负载下真实进程链路余量） */
export function waitFor(
  ws: WebSocket,
  pred: (frame: ServerFrame) => boolean,
  timeoutMs = 15_000
): Promise<ServerFrame> {
  return new Promise((resolve_, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      const seen = frameTrace.get(ws) ?? []
      reject(new Error(`waitFor timeout; frames=${JSON.stringify(seen)}`))
    }, timeoutMs)
    const onMessage = (data: unknown): void => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(data)) as ServerFrame
      } catch {
        return
      }
      if (!pred(frame)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve_(frame)
    }
    ws.on('message', onMessage)
  })
}

export function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve_, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('open', () => resolve_(ws))
    ws.once('error', reject)
    // 帧类型轨迹（flake 自诊断：超时错误里带最近帧序列，免猜测）
    const trace: string[] = []
    frameTrace.set(ws, trace)
    ws.on('message', (data) => {
      try {
        const f = JSON.parse(String(data)) as ServerFrame
        trace.push(f.type + (f.type === 'result' ? `(${f.ok ? 'ok' : 'ERR'})` : ''))
        if (trace.length > 40) trace.shift()
      } catch {
        /* ignore */
      }
    })
  })
}

const frameTrace = new WeakMap<WebSocket, string[]>()

let seq = 0

/** 发带 rid 帧 → 等 result 回执（inReplyTo=rid 关联） */
export async function request(
  ws: WebSocket,
  frame: ClientFrame,
  timeoutMs = 15_000
): Promise<{ ok: boolean; error?: string; payload?: unknown }> {
  const rid = (frame as { rid?: string }).rid ?? `r${++seq}`
  const pending = waitFor(ws, (f) => f.type === 'result' && f.inReplyTo === rid, timeoutMs)
  ws.send(JSON.stringify({ ...frame, rid }))
  const result = await pending
  if (result.type !== 'result') throw new Error('unreachable')
  return { ok: result.ok, error: result.error, payload: result.payload }
}

/** 收集连接上的 task.data chunk（按 taskId） */
export function collector(ws: WebSocket, taskId: string): { text(): string } {
  const chunks: string[] = []
  ws.on('message', (data) => {
    try {
      const f = JSON.parse(String(data)) as ServerFrame
      if (f.type === 'task.data' && f.taskId === taskId) chunks.push(f.chunk)
    } catch {
      /* ignore */
    }
  })
  return { text: () => chunks.join('') }
}

/**
 * 等待某任务的累计输出包含子串（PTY 输出可任意分帧——单帧谓词会漏跨帧短语，
 * 曾致 'Claude Code' 偶发超时；按累计文本断言）。resolve 值=命中时的累计文本。
 */
export function waitForText(
  ws: WebSocket,
  taskId: string,
  substr: string,
  timeoutMs = 15_000,
  /** 已累计文本（连接即建的 collector 的 text()——目标子串可能在本等待注册
   *  前已到达：attach 回执与数据帧的到达竞态，无 seed 会漏检已到内容） */
  seed = ''
): Promise<string> {
  return new Promise((resolve_, reject) => {
    let acc = seed
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`waitForText timeout (${taskId}): tail=${JSON.stringify(acc.slice(-120))}`))
    }, timeoutMs)
    const onMessage = (data: unknown): void => {
      try {
        const f = JSON.parse(String(data)) as ServerFrame
        if (f.type !== 'task.data' || f.taskId !== taskId) return
        acc += f.chunk
        if (acc.includes(substr)) {
          clearTimeout(timer)
          ws.off('message', onMessage)
          resolve_(acc)
        }
      } catch {
        /* ignore */
      }
    }
    ws.on('message', onMessage)
    // seed 已含目标（帧在注册前已到）：立即命中
    if (acc.includes(substr)) {
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve_(acc)
    }
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** ps 语义进程存活探测（signal 0） */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
