import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CloudflareTunnel,
  TUNNEL_RESTART_MAX_MS,
  resolveCloudflaredBin,
  type TunnelChild,
  type TunnelSpawnFn,
  type TunnelState
} from '../tunnel'

/**
 * v2.2.0 T4 隧道：cloudflared 定位 + 进程管理（URL 解析/退避重启/停止）。
 * 不真的拉 cloudflared——spawn 注入假子进程，定时器用 fake timers。
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'cwb-tunnel-'))
}

function fakeExecutable(dir: string, name = 'cloudflared'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\n', 'utf8')
  chmodSync(path, 0o755)
  return path
}

describe('resolveCloudflaredBin：CWB_CLOUDFLARED_BIN → PATH → ~/.cwb/bin', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('环境变量覆盖优先', () => {
    const dir = tmp()
    dirs.push(dir)
    const bin = fakeExecutable(dir)
    const other = fakeExecutable(tmp(), 'path-cloudflared')
    dirs.push(join(other, '..'))
    expect(
      resolveCloudflaredBin({ env: { CWB_CLOUDFLARED_BIN: bin, PATH: join(other, '..') }, home: '' })
    ).toBe(bin)
  })

  it('PATH 扫描 / ~/.cwb/bin 回退 / 缺失返回 undefined', () => {
    const dir = tmp()
    dirs.push(dir)
    expect(resolveCloudflaredBin({ env: { PATH: '' }, home: dir })).toBeUndefined()

    const homeBin = fakeExecutable(join(dir, '.cwb', 'bin'))
    expect(resolveCloudflaredBin({ env: { PATH: '' }, home: dir })).toBe(homeBin)

    const pathDir = tmp()
    dirs.push(pathDir)
    const pathBin = fakeExecutable(pathDir)
    expect(resolveCloudflaredBin({ env: { PATH: pathDir }, home: '' })).toBe(pathBin)
  })

  it('环境变量指向不存在/不可执行文件时回退 PATH', () => {
    const dir = tmp()
    dirs.push(dir)
    const pathBin = fakeExecutable(dir)
    expect(
      resolveCloudflaredBin({ env: { CWB_CLOUDFLARED_BIN: join(dir, 'nope'), PATH: dir }, home: '' })
    ).toBe(pathBin)

    const noExec = join(dir, 'plain')
    writeFileSync(noExec, 'x', 'utf8')
    chmodSync(noExec, 0o644)
    expect(
      resolveCloudflaredBin({ env: { CWB_CLOUDFLARED_BIN: noExec, PATH: '' }, home: '' })
    ).toBeUndefined()
  })

  it('win32 查找 cloudflared.exe', () => {
    const dir = tmp()
    dirs.push(dir)
    const bin = fakeExecutable(dir, 'cloudflared.exe')
    expect(resolveCloudflaredBin({ env: { PATH: dir }, home: '', platform: 'win32' })).toBe(bin)
  })
})

interface Harness {
  tunnel: CloudflareTunnel
  states: Array<[TunnelState, string | undefined]>
  children: FakeChild[]
  spawnCalls: string[][]
  setPort: (p: number | undefined) => void
}

class FakeChild extends EventEmitter implements TunnelChild {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): unknown {
    this.killed = true
    this.emit('exit', 0, 'SIGTERM')
    return true
  }
  emitExit(code = 1): void {
    this.emit('exit', code, null)
  }
}

function harness(opts: { bin?: string | undefined } = {}): Harness {
  const states: Array<[TunnelState, string | undefined]> = []
  const children: FakeChild[] = []
  const spawnCalls: string[][] = []
  let port: number | undefined = 18999
  const spawnImpl: TunnelSpawnFn = (_file, args) => {
    spawnCalls.push(args)
    const child = new FakeChild()
    children.push(child)
    return child
  }
  const tunnel = new CloudflareTunnel({
    targetPort: () => port,
    bin: 'bin' in opts ? opts.bin : '/usr/local/bin/cloudflared',
    onState: (state, url) => states.push([state, url]),
    spawnImpl,
    log: () => {}
  })
  return {
    tunnel,
    states,
    children,
    spawnCalls,
    setPort: (p) => {
      port = p
    }
  }
}

describe('CloudflareTunnel：启动/URL 解析/退避重启/停止', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('缺失二进制 → missing（不 spawn）', () => {
    const h = harness({ bin: undefined })
    h.tunnel.start()
    expect(h.states).toEqual([['missing', undefined]])
    expect(h.spawnCalls).toHaveLength(0)
    expect(h.tunnel.tunnelState).toBe('missing')
    h.tunnel.stop()
  })

  it('页面未就绪 → down，稍后重试；就绪后 starting', () => {
    vi.useFakeTimers()
    const h = harness()
    h.setPort(undefined)
    h.tunnel.start()
    expect(h.states.at(-1)?.[0]).toBe('down')
    expect(h.spawnCalls).toHaveLength(0)
    h.setPort(19001)
    vi.advanceTimersByTime(1)
    expect(h.spawnCalls).toHaveLength(1)
    expect(h.spawnCalls[0]).toEqual(['tunnel', '--url', 'http://127.0.0.1:19001', '--no-autoupdate'])
    expect(h.states.at(-1)?.[0]).toBe('starting')
    h.tunnel.stop()
  })

  it('从输出解析 trycloudflare URL → up；非该后缀忽略；URL 变化重新广播', () => {
    const h = harness()
    h.tunnel.start()
    expect(h.states.at(-1)?.[0]).toBe('starting')
    const child = h.children[0]!
    child.stderr.write('INF |  https://evil.example.com  |\n')
    expect(h.states.at(-1)?.[0]).toBe('starting')
    child.stderr.write('INF |  https://brave-fox-abc.trycloudflare.com  |\n')
    expect(h.states.at(-1)).toEqual(['up', 'https://brave-fox-abc.trycloudflare.com'])
    expect(h.tunnel.url).toBe('https://brave-fox-abc.trycloudflare.com')
    child.stdout.write('https://calm-owl-xyz.trycloudflare.com\n')
    expect(h.states.at(-1)).toEqual(['up', 'https://calm-owl-xyz.trycloudflare.com'])
    h.tunnel.stop()
    expect(h.states.at(-1)).toEqual(['off', undefined])
    expect(child.killed).toBe(true)
  })

  it('退出 → down + 指数退避重启（5s→10s→…上限 60s）', () => {
    vi.useFakeTimers()
    const h = harness()
    h.tunnel.start()
    expect(h.spawnCalls).toHaveLength(1)

    h.children[0]!.emitExit()
    expect(h.states.at(-1)?.[0]).toBe('down')
    vi.advanceTimersByTime(4_999)
    expect(h.spawnCalls).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(h.spawnCalls).toHaveLength(2)

    h.children[1]!.emitExit()
    vi.advanceTimersByTime(9_999)
    expect(h.spawnCalls).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(h.spawnCalls).toHaveLength(3)

    // 连续失败 → 20s → 40s → 上限 60s
    h.children[2]!.emitExit()
    vi.advanceTimersByTime(19_999)
    expect(h.spawnCalls).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(h.spawnCalls).toHaveLength(4)

    h.children[3]!.emitExit()
    vi.advanceTimersByTime(39_999)
    expect(h.spawnCalls).toHaveLength(4)
    vi.advanceTimersByTime(1)
    expect(h.spawnCalls).toHaveLength(5)

    h.children[4]!.emitExit()
    vi.advanceTimersByTime(TUNNEL_RESTART_MAX_MS - 1)
    expect(h.spawnCalls).toHaveLength(5)
    vi.advanceTimersByTime(1)
    expect(h.spawnCalls).toHaveLength(6)
    h.tunnel.stop()
  })

  it('成功拿到 URL 后退避计数归零（下次重启仍 5s）', () => {
    vi.useFakeTimers()
    const h = harness()
    h.tunnel.start()
    h.children[0]!.emitExit() // attempt=1 → 5s
    vi.advanceTimersByTime(5_000)
    expect(h.spawnCalls).toHaveLength(2)
    h.children[1]!.stderr.write('https://brave-fox-abc.trycloudflare.com\n')
    h.children[1]!.emitExit()
    vi.advanceTimersByTime(5_000)
    expect(h.spawnCalls).toHaveLength(3)
    h.tunnel.stop()
  })

  it('stop 后不再重启；重复 stop/start 幂等', () => {
    vi.useFakeTimers()
    const h = harness()
    h.tunnel.start()
    const child = h.children[0]!
    h.tunnel.stop()
    expect(child.killed).toBe(true)
    expect(h.tunnel.tunnelState).toBe('off')
    vi.advanceTimersByTime(120_000)
    expect(h.spawnCalls).toHaveLength(1)
    h.tunnel.stop()
    expect(h.tunnel.tunnelState).toBe('off')
    h.tunnel.start()
    expect(h.spawnCalls).toHaveLength(2)
    h.tunnel.stop()
  })

  it('子进程 error 事件只记日志（不改状态，等 exit）', () => {
    const h = harness()
    h.tunnel.start()
    h.children[0]!.emit('error', new Error('boom'))
    expect(h.tunnel.tunnelState).toBe('starting')
    h.tunnel.stop()
  })
})