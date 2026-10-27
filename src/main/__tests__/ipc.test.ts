import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HANDLE_CHANNELS, IpcChannels, SEND_CHANNELS } from '../../shared/ipc-channels'
import type { NotifyConfig, ProjectRecord, SkillInfo, TaskActivityEvent, TaskRecord } from '../../shared/types'

const execFileAsync = promisify(execFile)

/** vi.mock 工厂被提升到 import 之前，共享状态必须放 vi.hoisted */
const h = vi.hoisted(() => {
  return {
    tempDir: '',
    ctx: null as import('../ipc').AppContext | null,
    handleCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
    onCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    dialogResult: { canceled: false, filePaths: [] as string[] },
    openExternalCalls: [] as string[],
    ptyInstances: [] as Array<{
      spawnCalls: Array<{ taskId: string; args: string[]; cwd: string }>
      writes: Array<{ taskId: string; data: string }>
      resizes: Array<{ taskId: string; cols: number; rows: number }>
      callbacks: { onData: (e: { taskId: string; data: string }) => void; onExit: (taskId: string) => void }
      kill: (taskId: string) => void
      isRunning: (taskId: string) => boolean
    }>
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => h.tempDir,
    getVersion: () => '1.1.0-test',
    isPackaged: false,
    quit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(async () => h.dialogResult) },
  shell: {
    openExternal: vi.fn(async (url: string) => {
      h.openExternalCalls.push(url)
    })
  },
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } }
    ]
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

vi.mock('../pty-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pty-manager')>()
  class FakePtyManager {
    readonly spawnCalls: Array<{ taskId: string; args: string[]; cwd: string }> = []
    readonly writes: Array<{ taskId: string; data: string }> = []
    readonly resizes: Array<{ taskId: string; cols: number; rows: number }> = []
    readonly runningIds = new Set<string>()
    constructor(
      readonly callbacks: {
        onData: (e: { taskId: string; data: string }) => void
        onExit: (taskId: string) => void
      }
    ) {
      h.ptyInstances.push(this)
    }
    async spawnClaude(taskId: string, args: string[], cwd: string): Promise<void> {
      this.spawnCalls.push({ taskId, args, cwd })
      this.runningIds.add(taskId)
    }
    write(taskId: string, data: string): void {
      this.writes.push({ taskId, data })
    }
    resize(taskId: string, cols: number, rows: number): void {
      this.resizes.push({ taskId, cols, rows })
    }
    kill(taskId: string): void {
      if (this.runningIds.delete(taskId)) this.callbacks.onExit(taskId)
    }
    isRunning(taskId: string): boolean {
      return this.runningIds.has(taskId)
    }
    forget(_taskId: string): void {
      // v0.1.2 尺寸记忆清理（真实现见 pty-manager；替身无需状态）
    }
  }
  return { ...actual, PtyManager: FakePtyManager }
})

import { isSafeExternalUrl, registerIpcHandlers } from '../ipc'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const entry = h.handleCalls.find(([c]) => c === channel)
  if (!entry) throw new Error(`no handler registered for ${channel}`)
  return entry[1](undefined, ...args) as Promise<T>
}

function fire(channel: string, ...args: unknown[]): void {
  const entry = h.onCalls.find(([c]) => c === channel)
  if (!entry) throw new Error(`no listener registered for ${channel}`)
  entry[1](undefined, ...args)
}

function taskUpdates(): TaskRecord[] {
  return h.sent.filter((e) => e.channel === IpcChannels.TaskUpdate).map((e) => e.payload as TaskRecord)
}

/** v3.2 cwb:event:task-activity 广播流 */
function activityEvents(): TaskActivityEvent[] {
  return h.sent
    .filter((e) => e.channel === IpcChannels.TaskActivity)
    .map((e) => e.payload as TaskActivityEvent)
}

/** 测试注入缝：hooks settings 目录指向 temp（防污染真实 %LOCALAPPDATA%） */
function settingsDir(): string {
  return join(h.tempDir, 'cwb-settings')
}

function settingsPathOf(taskId: string): string {
  return join(settingsDir(), `${taskId}.json`)
}

function currentPty(): (typeof h.ptyInstances)[number] {
  const pty = h.ptyInstances[h.ptyInstances.length - 1]
  if (!pty) throw new Error('no PtyManager instance')
  return pty
}

async function initRepoWithCommit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init'])
  await execFileAsync('git', [
    '-C',
    dir,
    '-c',
    'user.name=CWB Test',
    '-c',
    'user.email=cwb-test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'init'
  ])
}

describe('registerIpcHandlers（electron mock：记录型 ipcMain + 广播窗口）', () => {
  beforeEach(() => {
    h.tempDir = mkdtempSync(join(tmpdir(), 'cwb-ipc-'))
    process.env['CWB_HOOK_SETTINGS_DIR'] = settingsDir()
    // v0.5③ skills 用户级根注入缝（防扫描真实 ~/.claude/skills）
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    h.handleCalls.length = 0
    h.onCalls.length = 0
    h.sent.length = 0
    h.ptyInstances.length = 0
    h.dialogResult = { canceled: false, filePaths: [] }
    h.ctx = registerIpcHandlers()
  })

  afterEach(() => {
    delete process.env['CWB_HOOK_SETTINGS_DIR']
    delete process.env['CWB_SKILLS_USER_ROOT']
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it('注册集恰为契约全集：handle === HANDLE_CHANNELS、on === SEND_CHANNELS（+CliKill 双注册）', () => {
    expect(h.handleCalls.map(([c]) => c)).toHaveLength(HANDLE_CHANNELS.length)
    expect(new Set(h.handleCalls.map(([c]) => c))).toEqual(new Set(HANDLE_CHANNELS))
    // v0.5③ 特例：CliKill 在 shared 契约里归 HANDLE 全集，但 preload 经 send 调用（照 ptyWrite 先例）
    // ——on 侧承载真实路径，handle 侧兜底注册集完整性断言；故 on 集恰为 SEND_CHANNELS ∪ {CliKill}
    expect(h.onCalls.map(([c]) => c)).toHaveLength(SEND_CHANNELS.length + 1)
    expect(new Set(h.onCalls.map(([c]) => c))).toEqual(new Set([...SEND_CHANNELS, IpcChannels.CliKill]))
  })

  it('addProject：isGit 检测落档、重复 dir 返回既有、listProjects 可读回', async () => {
    const projDir = join(h.tempDir, 'work', 'alpha')
    mkdirSync(join(projDir, '.git'), { recursive: true })

    const rec = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    expect(rec.isGit).toBe(true)
    expect(rec.name).toBe('alpha')
    expect(rec.dir).toBe(projDir)

    const dup = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    expect(dup.id).toBe(rec.id)
    expect(await invoke<ProjectRecord[]>(IpcChannels.ProjectsList)).toEqual([rec])
  })

  it('pickDirectory：选中返回路径；取消返回 null', async () => {
    h.dialogResult = { canceled: false, filePaths: ['D:\\mock\\dir'] }
    expect(await invoke<string | null>(IpcChannels.DialogPickDirectory)).toBe('D:\\mock\\dir')

    h.dialogResult = { canceled: true, filePaths: [] }
    expect(await invoke<string | null>(IpcChannels.DialogPickDirectory)).toBeNull()
  })

  // ── v1.0.8 外部链接出口（终端链接 → 系统浏览器）──────────────────────
  it('isSafeExternalUrl：仅 http/https 放行；javascript:/file:/盘符路径/空/超长拒绝', () => {
    expect(isSafeExternalUrl('https://claude.ai/docs')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:8080/x')).toBe(true)
    for (const bad of [
      'javascript:alert(1)', // 终端输出属不可信内容——OSC 8 可拼脚本协议
      'file:///C:/Windows/win.ini',
      'D:\\SourceCode\\agent', // 无协议的盘符路径（new URL 抛错）
      '',
      'ftp://example.com',
      'x'.repeat(3000)
    ]) {
      expect(isSafeExternalUrl(bad)).toBe(false)
    }
  })

  it('ShellOpenExternal：白名单 URL 交 shell.openExternal；拒绝的只返回 false 不抛错', async () => {
    h.openExternalCalls.length = 0
    expect(await invoke<boolean>(IpcChannels.ShellOpenExternal, 'https://example.com/docs')).toBe(true)
    expect(h.openExternalCalls).toEqual(['https://example.com/docs'])

    expect(await invoke<boolean>(IpcChannels.ShellOpenExternal, 'javascript:alert(1)')).toBe(false)
    expect(await invoke<boolean>(IpcChannels.ShellOpenExternal, 'not a url')).toBe(false)
    expect(h.openExternalCalls).toHaveLength(1) // 拒绝路径不触系统浏览器
  })

  it('createTask(shared)：新会话参数、cwd=项目根、running 落档并广播 TaskUpdate', async () => {
    const projDir = join(h.tempDir, 'work', 'beta')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)

    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '重构登录', {
      isolation: 'shared'
    })

    // v3.2：spawn args 附 --settings <per-task hooks 文件>（settingsPath 显式传入，路径可推导）
    expect(currentPty().spawnCalls).toEqual([
      {
        taskId: task.id,
        args: ['--session-id', task.id, '-n', '重构登录', '--settings', settingsPathOf(task.id)],
        cwd: projDir
      }
    ])
    expect(task.status).toBe('running')
    expect(task.sessionId).toBe(task.id)
    expect(task.cwd).toBe(projDir)
    expect('worktreePath' in task).toBe(false)
    expect(await invoke<TaskRecord[]>(IpcChannels.TasksList, proj.id)).toEqual([task])
    expect(taskUpdates()).toContainEqual(task)
  })

  it('createTask(worktree) 对非 git 项目抛错且不 spawn', async () => {
    const projDir = join(h.tempDir, 'work', 'plain')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)

    await expect(
      invoke(IpcChannels.TasksCreate, proj.id, 'x', { isolation: 'worktree' })
    ).rejects.toThrow(/worktree isolation requires a git project/)
    expect(currentPty().spawnCalls).toHaveLength(0)
    expect(await invoke<TaskRecord[]>(IpcChannels.TasksList)).toEqual([])
  })

  it('v0.3.1 单任务跳过权限确认：createTask 带 flag → spawn args+记录；切换元数据 → 下次 resume 生效', async () => {
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, h.tempDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '跳权限', {
      isolation: 'shared',
      skipPermissions: true
    })
    expect(task.skipPermissions).toBe(true)
    expect(currentPty().spawnCalls[0]?.args).toContain('--dangerously-skip-permissions')

    // 停止 → 关闭开关 → resume 不带 flag
    await invoke(IpcChannels.TasksStop, task.id)
    await invoke<TaskRecord>(IpcChannels.TasksSetSkipPermissions, task.id, false)
    const mid = await invoke<TaskRecord[]>(IpcChannels.TasksList)
    expect(mid[0]?.skipPermissions).toBeUndefined()
    await invoke<TaskRecord>(IpcChannels.TasksResume, task.id)
    expect(currentPty().spawnCalls[1]?.args).not.toContain('--dangerously-skip-permissions')

    // 再开启 → 下次 resume 带 flag（运行中切换不影响当前会话，仅下次 spawn 生效）
    await invoke(IpcChannels.TasksStop, task.id)
    await invoke<TaskRecord>(IpcChannels.TasksSetSkipPermissions, task.id, true)
    await invoke<TaskRecord>(IpcChannels.TasksResume, task.id)
    expect(currentPty().spawnCalls[2]?.args).toContain('--dangerously-skip-permissions')

    // 未知任务报错
    await expect(invoke(IpcChannels.TasksSetSkipPermissions, 'no-such', true)).rejects.toThrow(
      /task not found/
    )
  })

  it('v0.3.2 状态跟踪：会话自行退出 → exited；显式 stop → stopped（不被 onExit 抢标）；两者均可 resume', async () => {
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, h.tempDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '跟踪', {
      isolation: 'shared'
    })
    expect(task.status).toBe('running')

    // 模拟会话自行退出（不经 stopTask 直接 kill PTY）→ onExit 落 exited
    currentPty().kill(task.id)
    let list = await invoke<TaskRecord[]>(IpcChannels.TasksList)
    expect(list[0]?.status).toBe('exited')

    await invoke<TaskRecord>(IpcChannels.TasksResume, task.id)
    list = await invoke<TaskRecord[]>(IpcChannels.TasksList)
    expect(list[0]?.status).toBe('running')

    // 显式停止 → stopped
    await invoke(IpcChannels.TasksStop, task.id)
    list = await invoke<TaskRecord[]>(IpcChannels.TasksList)
    expect(list[0]?.status).toBe('stopped')

    await invoke<TaskRecord>(IpcChannels.TasksResume, task.id)
    list = await invoke<TaskRecord[]>(IpcChannels.TasksList)
    expect(list[0]?.status).toBe('running')
  })

  it('createTask(worktree)：真实 git 建树（cwd=worktree、分支 cwb/<id>）；removeTask(deleteWorktree) 清树删档', { timeout: 60_000 }, async () => {
    const repo = join(h.tempDir, 'repo')
    mkdirSync(repo)
    await initRepoWithCommit(repo)
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, repo)

    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '隔离任务', {
      isolation: 'worktree'
    })

    expect(task.worktreePath).toBe(join(repo, '.cwb-worktrees', task.id))
    expect(task.cwd).toBe(task.worktreePath)
    expect(existsSync(task.worktreePath as string)).toBe(true)
    const branch = await execFileAsync('git', ['-C', repo, 'branch', '--list', `cwb/${task.id}`])
    expect(branch.stdout).toContain(`cwb/${task.id}`)

    await invoke(IpcChannels.TasksRemove, task.id, { deleteWorktree: true })
    expect(existsSync(task.worktreePath as string)).toBe(false)
    expect(await invoke<TaskRecord[]>(IpcChannels.TasksList)).toEqual([])
  })

  it('stopTask：running→stopped 恰一次广播（onExit 与显式 stop 同路径防双写）；running 不可 resume；stopped 可 resume', async () => {
    const projDir = join(h.tempDir, 'work', 'gamma')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '任务A', {
      isolation: 'shared'
    })

    await expect(invoke(IpcChannels.TasksResume, task.id)).rejects.toThrow(/running/)

    await invoke(IpcChannels.TasksStop, task.id)
    const all = await invoke<TaskRecord[]>(IpcChannels.TasksList)
    expect(all[0]?.status).toBe('stopped')
    expect(taskUpdates()).toHaveLength(2) // create + stop；kill 触发的 onExit 不产生第三次

    const resumed = await invoke<TaskRecord>(IpcChannels.TasksResume, task.id)
    expect(resumed.status).toBe('running')
    expect(currentPty().spawnCalls[1]).toEqual({
      taskId: task.id,
      args: ['--resume', task.id, '-n', '任务A', '--settings', settingsPathOf(task.id)],
      cwd: task.cwd
    })
  })

  it('renameTask 改名并广播；renameProject 仅改 name；缺失 id 报错', async () => {
    const projDir = join(h.tempDir, 'work', 'delta')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '旧名', {
      isolation: 'shared'
    })

    const renamed = await invoke<TaskRecord>(IpcChannels.TasksRename, task.id, '新名')
    expect(renamed.name).toBe('新名')
    expect(taskUpdates().at(-1)).toEqual(renamed)
    await expect(invoke(IpcChannels.TasksRename, 'no-such', 'x')).rejects.toThrow(/task not found/)

    const renamedProj = await invoke<ProjectRecord>(IpcChannels.ProjectsRename, proj.id, '新项目名')
    expect(renamedProj.name).toBe('新项目名')
    expect(renamedProj.dir).toBe(projDir)
    await expect(invoke(IpcChannels.ProjectsRename, 'no-such', 'x')).rejects.toThrow(/project not found/)
  })

  it('ptyWrite/ptyResize 转发到 pty-manager；PTY onData 经 cwb:event:pty-data 广播；smoke:report 回执累积（S4 实装，原 NotImplemented 桩已替换）', async () => {
    fire(IpcChannels.PtyWrite, 't-9', 'hello\r')
    fire(IpcChannels.PtyResize, 't-9', 120, 40)
    expect(currentPty().writes).toEqual([{ taskId: 't-9', data: 'hello\r' }])
    expect(currentPty().resizes).toEqual([{ taskId: 't-9', cols: 120, rows: 40 }])

    currentPty().callbacks.onData({ taskId: 't-9', data: 'chunk' })
    expect(h.sent).toContainEqual({
      channel: IpcChannels.PtyData,
      payload: { taskId: 't-9', data: 'chunk' }
    })

    expect(h.ctx?.smokeReports).toEqual([])
    fire(IpcChannels.SmokeReport, 'payload')
    expect(h.ctx?.smokeReports).toEqual(['payload'])
  })

  it('removeProject：其任务被停止并删记录，项目记录删除', async () => {
    const projDir = join(h.tempDir, 'work', 'eps')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '任务B', {
      isolation: 'shared'
    })
    expect(currentPty().isRunning(task.id)).toBe(true)

    await invoke(IpcChannels.ProjectsRemove, proj.id)

    expect(await invoke<TaskRecord[]>(IpcChannels.TasksList)).toEqual([])
    expect(await invoke<ProjectRecord[]>(IpcChannels.ProjectsList)).toEqual([])
    expect(existsSync(settingsPathOf(task.id))).toBe(false) // v3.2 R8：settings 一并清理
  })

  it('v3.2 hooks 注入：createTask 落 per-task settings 文件（6 事件 http hook + epoch/taskId URL）并广播本地合成 idle', async () => {
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, h.tempDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, 'hook任务', {
      isolation: 'shared'
    })

    const path = settingsPathOf(task.id)
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; url: string; timeout: number }> }>>
    }
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['Elicitation', 'PermissionRequest', 'PreToolUse', 'Stop', 'StopFailure', 'UserPromptSubmit'].sort()
    )
    expect(parsed.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion|ExitPlanMode')
    const entry = parsed.hooks.UserPromptSubmit?.[0]?.hooks[0]
    expect(entry?.type).toBe('http')
    expect(entry?.timeout).toBe(3)
    expect(entry?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/UserPromptSubmit\?e=1&t=/)
    expect(entry?.url).toContain(`t=${task.id}`)

    // spawn 时刻本地合成 idle（绿）广播
    expect(activityEvents()).toContainEqual({ taskId: task.id, activity: 'idle' })
  })

  it('v3.2 真实 hook 回流：settings URL POST UserPromptSubmit → busy 广播；单字符 Esc → 合成 idle；方向键序列不误触', { timeout: 15_000 }, async () => {
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, h.tempDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '回流', {
      isolation: 'shared'
    })
    const parsed = JSON.parse(readFileSync(settingsPathOf(task.id), 'utf8')) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ url: string }> }> }
    }
    const url = parsed.hooks.UserPromptSubmit[0]?.hooks[0]?.url as string

    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ session_id: task.id }) })
    expect(res.status).toBe(200)
    await vi.waitFor(
      () => expect(activityEvents()).toContainEqual({ taskId: task.id, activity: 'busy' }),
      { timeout: 5_000, interval: 50 }
    )

    // 方向键等多字节序列：ptyWrite 照常转发，但不触发 Esc 合成（仍 busy）
    fire(IpcChannels.PtyWrite, task.id, '\x1b[A')
    expect(activityEvents().at(-1)).toEqual({ taskId: task.id, activity: 'busy' })

    // 恰为单字符 \x1b：busy → 本地合成 idle
    fire(IpcChannels.PtyWrite, task.id, '\x1b')
    await vi.waitFor(
      () => expect(activityEvents().at(-1)).toEqual({ taskId: task.id, activity: 'idle' }),
      { timeout: 5_000, interval: 50 }
    )
    expect(currentPty().writes).toEqual([
      { taskId: task.id, data: '\x1b[A' },
      { taskId: task.id, data: '\x1b' }
    ])
  })

  it('v3.2 生命周期：resume 重写 settings（epoch 递增作废旧 PTY hook）；removeTask 删 settings 文件', async () => {
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, h.tempDir)
    const task = await invoke<TaskRecord>(IpcChannels.TasksCreate, proj.id, '生命周期', {
      isolation: 'shared'
    })
    const stopUrlEpoch = (): string => {
      const parsed = JSON.parse(readFileSync(settingsPathOf(task.id), 'utf8')) as {
        hooks: { Stop: Array<{ hooks: Array<{ url: string }> }> }
      }
      return parsed.hooks.Stop[0]?.hooks[0]?.url as string
    }
    expect(stopUrlEpoch()).toContain('e=1')

    await invoke<TaskRecord>(IpcChannels.TasksStop, task.id)
    await invoke<TaskRecord>(IpcChannels.TasksResume, task.id)
    expect(stopUrlEpoch()).toContain('e=2') // resume 重写捕获新 epoch
    expect(existsSync(settingsPathOf(task.id))).toBe(true)

    await invoke(IpcChannels.TasksRemove, task.id, { deleteWorktree: false })
    expect(existsSync(settingsPathOf(task.id))).toBe(false)
  })

  it('v0.5③ CliRun：非法命令拒绝（带原因）且不 spawn；CliKill（on+handle 双注册）未知 id no-op', async () => {
    await expect(invoke(IpcChannels.CliRun, 'claude x & calc')).rejects.toThrow(/白名单/)
    await expect(invoke(IpcChannels.CliRun, 'notepad foo')).rejects.toThrow(/必须以 claude 开头/)
    // 无 spawn 侧效果（CliRunner 自有表，不经 PtyManager）
    expect(currentPty().spawnCalls).toHaveLength(0)
    expect(() => fire(IpcChannels.CliKill, 'no-such-command')).not.toThrow()
    const killHandle = h.handleCalls.find(([c]) => c === IpcChannels.CliKill)
    expect(killHandle).toBeDefined() // 契约把 CliKill 归 HANDLE 全集（preload 经 send 调用）——双注册兜底
  })

  it('v0.5④N NotifyGet/NotifySet：默认配置、保存读回（channel 按 URL 推断）', async () => {
    expect(await invoke(IpcChannels.NotifyGet)).toEqual({ url: '', enabled: false, channel: 'wecom' })
    const saved = await invoke<NotifyConfig>(
      IpcChannels.NotifySet,
      'https://qyapi.weixin.qq.com/send?key=k',
      true
    )
    expect(saved).toEqual({ url: 'https://qyapi.weixin.qq.com/send?key=k', enabled: true, channel: 'wecom' })
    expect(await invoke<NotifyConfig>(IpcChannels.NotifyGet)).toEqual(saved)
  })

  it('v0.5③ SkillsList：用户级+项目级合并（用户级根经注入缝指向 temp）', async () => {
    expect(await invoke<SkillInfo[]>(IpcChannels.SkillsList)).toEqual([])
    const userSkillDir = join(h.tempDir, 'skills-user', 'demo-skill')
    mkdirSync(userSkillDir, { recursive: true })
    writeFileSync(
      join(userSkillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 演示\n---\n'
    )
    const projDir = join(h.tempDir, 'work', 'omega')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    const projSkillDir = join(projDir, '.claude', 'skills', 'proj-only')
    mkdirSync(projSkillDir, { recursive: true })
    writeFileSync(join(projSkillDir, 'SKILL.md'), '---\nname: proj-only\ndescription: 仅项目\n---\n')

    const list = await invoke<SkillInfo[]>(IpcChannels.SkillsList)
    expect(list).toHaveLength(2)
    expect(list.find((s) => s.source === 'user')).toMatchObject({ name: 'demo-skill' })
    expect(list.find((s) => s.source === 'project')).toMatchObject({
      name: 'proj-only',
      projectId: proj.id
    })
  })
})
