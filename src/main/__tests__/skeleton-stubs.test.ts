import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDLE_CHANNELS, IpcChannels } from '../../shared/ipc-channels'
import { registerIpcHandlers, type AppContext } from '../ipc'
import { StubConnectionManager } from '../ssh/connection-manager'
import type { PtyBackend } from '../pty-backend'
import { PtyManager } from '../pty-manager'

/**
 * S1 契约骨架接线桩断言（L2.5 批0）：
 * ① AppContext.connection 非 null 且为 StubConnectionManager（A0=S1 桩+S2 实）；
 * ② 新 HANDLE 通道全部注册且 invoke 抛明确 NotImplemented（实现归属 S2/S4/S7）；
 * ③ PtyManager 实例满足 PtyBackend（编译期可赋值 + 运行时 instanceof）。
 * 基建照 ipc.test.ts 先例（记录型 ipcMain mock + temp userData 注入缝）。
 */

const h = vi.hoisted(() => ({
  tempDir: '',
  handleCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
  onCalls: [] as Array<[string, (...args: unknown[]) => unknown]>
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  app: {
    getPath: (_name: string) => h.tempDir,
    getVersion: () => '1.1.0-test',
    isPackaged: false,
    quit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  shell: { openExternal: vi.fn(async () => {}) },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (_channel: string, _payload: unknown) => {} } }]
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handleCalls.push([channel, fn])
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.onCalls.push([channel, fn])
    }
  }
}))

/**
 * S1 新增的 SSH 远程模式 HANDLE 通道全集（与 ipc-channels.ts 契约同步维护）。
 * S2 落地后连接族 8 通道已实装（见 connection-manager.test.ts L2.5）——此处仅
 * 断言仍属桩的 S4/S7 通道。
 */
const REMOTE_STUB_HANDLE_CHANNELS = [
  IpcChannels.ServerInstall,
  IpcChannels.RemoteProxyStatus,
  IpcChannels.RemoteProxyConfigGet,
  IpcChannels.RemoteProxyConfigSet
] as const

/** S2 已实装的连接族通道（注册完整性 + 默认 Stub 注入下的行为边界） */
const S2_HANDLE_CHANNELS = [
  IpcChannels.ConnectionsList,
  IpcChannels.ConnectionsSave,
  IpcChannels.ConnectionsDelete,
  IpcChannels.ConnectionsTest,
  IpcChannels.ConnectionsConnect,
  IpcChannels.ConnectionsDisconnect,
  IpcChannels.SftpBrowse
] as const

/** invoke：async 包一层——同步 throw 也转 rejection（与 renderer invoke 语义一致） */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const entry = h.handleCalls.find(([c]) => c === channel)
  if (!entry) throw new Error(`no handler registered for ${channel}`)
  return entry[1](undefined, ...args)
}

describe('S1 契约骨架接线桩（AppContext.connection / NotImplemented / PtyBackend）', () => {
  let ctx: AppContext

  beforeEach(() => {
    h.tempDir = mkdtempSync(join(tmpdir(), 'cwb-skeleton-'))
    // 测试注入缝（照 ipc.test.ts 先例：防污染真实 settings/skills/market 目录）
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(h.tempDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(h.tempDir, 'market-home')
    h.handleCalls.length = 0
    h.onCalls.length = 0
    ctx = registerIpcHandlers()
  })

  afterEach(() => {
    delete process.env['CWB_HOOK_SETTINGS_DIR']
    delete process.env['CWB_SKILLS_USER_ROOT']
    delete process.env['CWB_SKILL_MARKET_HOME']
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it('① AppContext.connection 非 null 且为 StubConnectionManager（A0 桩，S2 替换）', () => {
    expect(ctx.connection).not.toBeNull()
    expect(ctx.connection).toBeInstanceOf(StubConnectionManager)
    // 桩方法不可被误用为可用实现（消费即抛 S2 未实现）
    expect(() => ctx.connection.getState('any-id')).toThrow(/S2 未实现/)
  })

  it('② S4/S7 通道仍为 NotImplemented 桩；S2 连接族 8 通道已实装（CRUD 直接可用）', async () => {
    // 通道已入 HANDLE_CHANNELS 契约（ipc.test.ts 的注册集完整性断言据此覆盖注册数）
    expect(HANDLE_CHANNELS).toEqual(
      expect.arrayContaining([...REMOTE_STUB_HANDLE_CHANNELS, ...S2_HANDLE_CHANNELS])
    )
    for (const channel of REMOTE_STUB_HANDLE_CHANNELS) {
      const entry = h.handleCalls.find(([c]) => c === channel)
      expect(entry, `handler 未注册：${channel}`).toBeDefined()
      await expect(invoke(channel, 'test-connection-id')).rejects.toThrow(/^NotImplemented:/)
    }
    // S2 实装面：默认注入（StubConnectionManager）下 CRUD 走 connections-store
    // 可用（temp userData 空清单）；连接操作类委托 ctx.connection=Stub → 明确报错
    for (const channel of S2_HANDLE_CHANNELS) {
      const entry = h.handleCalls.find(([c]) => c === channel)
      expect(entry, `handler 未注册：${channel}`).toBeDefined()
    }
    expect(await invoke(IpcChannels.ConnectionsList)).toEqual([])
    await expect(invoke(IpcChannels.ConnectionsTest, 'no-such-id')).resolves.toMatchObject({
      ok: false
    })
    await expect(invoke(IpcChannels.ConnectionsConnect, 'no-such-id')).rejects.toThrow()
    await expect(invoke(IpcChannels.SftpBrowse, 'no-such-id')).resolves.toMatchObject({
      ok: false
    })
  })

  it('③ PtyManager 实例满足 PtyBackend（编译期赋值断言 + 运行时 instanceof）', () => {
    const mgr = new PtyManager({ onData: () => {}, onExit: () => {} })
    // 编译期断言：PtyManager 可赋值给 PtyBackend（公共面逐一对齐；违反=tsc 编译红）
    const backend: PtyBackend = mgr
    expect(backend).toBeInstanceOf(PtyManager)
    // 运行时面校验：契约方法全部存在（防接口与实现漂移到运行期才暴露）
    for (const method of [
      'spawn',
      'spawnClaude',
      'write',
      'resize',
      'kill',
      'isRunning',
      'pid',
      'killAllTrees',
      'currentSize',
      'forget'
    ] as const) {
      expect(typeof backend[method], `PtyBackend.${method}`).toBe('function')
    }
  })
})
