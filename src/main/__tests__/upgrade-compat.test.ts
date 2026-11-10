/**
 * S8 升级兼容回归（design §9.1 / 决策点 9.1）：老版本（无 SSH 远程功能）升级到
 * 1.5.0 的首次启动——
 * - 全新 CWB_USER_DATA（无 connections.json）：应用照常起（store 层零依赖连接档案）；
 * - 存量本地任务目录：tasks.json 带 running 记录 → 本地任务归一 stopped（现行为
 *   逐字节不变，v1.4.x 用户无感）；
 * - 远程任务（connectionId 指向不存在档案——升级用户不可能有合法远程档案，孤儿即
 *   升级后的真实形态）→ 不归一（5.9=b server 保活语义），且 store 面可管理
 *   （removeProject/removeTask 等操作不因档案缺失而炸；UI 孤儿回根级兜底见
 *   remote-sidebar.test 的孤儿树用例）。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ tempDir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => h.tempDir,
    getVersion: () => '1.5.0-test',
    isPackaged: false,
    quit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  shell: { openExternal: vi.fn(async () => {}) },
  net: undefined,
  session: undefined,
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  }
}))

import { createSshConnectionStack } from '../ssh'
import { createAppContext, type AppContext } from '../ipc'

let dirs: string[] = []
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cwb-s8-upgrade-'))
  dirs.push(d)
  return d
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  h.tempDir = newDir()
  mkdirSync(h.tempDir, { recursive: true })
})

describe('S8 升级兼容（9.1）：无 connections.json 的全新数据目录 + 存量任务归一化分流', () => {
  it('本地 running 归一 stopped（v1.4.x 行为不变）+ 远程 running（档案不存在）不归一', async () => {
    // 老版本数据形态：只有 projects.json/tasks.json，绝无 connections.json
    const now = new Date().toISOString()
    writeFileSync(
      join(h.tempDir, 'projects.json'),
      JSON.stringify(
        [
          { id: 'p-local', name: 'LocalProj', dir: '/tmp/legacy-local', isGit: false, createdAt: now },
          { id: 'p-remote', name: 'RemoteProj', dir: '/home/dev/app', isGit: true, connectionId: 'ghost-conn', createdAt: now }
        ],
        null,
        2
      ),
      'utf8'
    )
    writeFileSync(
      join(h.tempDir, 'tasks.json'),
      JSON.stringify(
        [
          {
            id: 't-local', projectId: 'p-local', name: '本地存量', sessionId: 't-local',
            cwd: '/tmp/legacy-local', status: 'running', createdAt: now, lastActiveAt: now
          },
          {
            id: 't-remote', projectId: 'p-remote', name: '远程存量', sessionId: 't-remote',
            cwd: '/home/dev/app', status: 'running', createdAt: now, lastActiveAt: now
          }
        ],
        null,
        2
      ),
      'utf8'
    )
    expect(existsSync(join(h.tempDir, 'connections.json'))).toBe(false) // 前提钉死

    // 真实连接栈（空档案目录——生产组合根同款注入；Stub 会 NotImplementedError，
    // 而升级用户走的是真实栈）
    const ctx: AppContext = createAppContext({
      connection: createSshConnectionStack({ baseDir: h.tempDir })
    })

    // 本地任务：归一 stopped（升级用户无感——与 v1.4.x 完全一致）
    const local = ctx.tasks.get('t-local')
    expect(local?.status).toBe('stopped')
    // 远程任务：不归一（5.9=b server 保活语义；档案不存在不影响分流判定）
    const remote = ctx.tasks.get('t-remote')
    expect(remote?.status).toBe('running')
    // 落盘复核（normalizeOnStartup 已 save）
    const persisted = JSON.parse(readFileSync(join(h.tempDir, 'tasks.json'), 'utf8')) as Array<{
      id: string; status: string
    }>
    expect(persisted.find((t) => t.id === 't-local')?.status).toBe('stopped')
    expect(persisted.find((t) => t.id === 't-remote')?.status).toBe('running')
  })

  it('孤儿远程档案可管理：stopTask/removeProject 在档案缺失下不炸（store 层）', async () => {
    const now = new Date().toISOString()
    writeFileSync(
      join(h.tempDir, 'projects.json'),
      JSON.stringify(
        [
          { id: 'p-remote', name: 'RemoteProj', dir: '/home/dev/app', isGit: true, connectionId: 'ghost-conn', createdAt: now }
        ],
        null,
        2
      ),
      'utf8'
    )
    writeFileSync(
      join(h.tempDir, 'tasks.json'),
      JSON.stringify(
        [
          {
            id: 't-remote', projectId: 'p-remote', name: '远程存量', sessionId: 't-remote',
            cwd: '/home/dev/app', status: 'running', createdAt: now, lastActiveAt: now
          }
        ],
        null,
        2
      ),
      'utf8'
    )

    const ctx: AppContext = createAppContext({
      connection: createSshConnectionStack({ baseDir: h.tempDir })
    })
    // 显式停止（走 hub 定向远程后端——kill 帧发不出去也无害：档案缺失=从未连接）
    await expect(ctx.stopTask('t-remote')).resolves.toBeUndefined()
    expect(ctx.tasks.get('t-remote')?.status).toBe('stopped')
    // 删除项目级联（远程分支 managerFor 正常构造，不触网络）
    await expect(ctx.removeProject('p-remote')).resolves.toBeUndefined()
    expect(ctx.projects.get('p-remote')).toBeUndefined()
    expect(ctx.tasks.list().length).toBe(0)
  })
})
