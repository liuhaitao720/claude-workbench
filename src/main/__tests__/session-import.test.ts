import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcChannels } from '../../shared/ipc-channels'
import type { ProjectRecord, TaskRecord } from '../../shared/types'
import { ProjectStore } from '../project-store'
import {
  importTasksFromSessionsImpl,
  listSessions,
  mungePath,
  type SessionMeta
} from '../session-import'
import { TaskStore } from '../task-store'

// ── 单元域（session-import 纯 node，无 electron 依赖）─────────────────

const T1 = '2026-10-01T10:00:00.000Z'
const T2 = '2026-10-02T10:00:00.000Z'
const MTIME = new Date('2026-10-03T12:00:00.000Z')

/** fixture 根（会话存储根 = root/<munged-dir>/<sessionId>.jsonl） */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cwb-session-import-'))
}

function userLine(
  content: string | unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content },
    timestamp: T1,
    ...extra
  }
}

/** 写一个会话 jsonl；返回文件路径（mtime 固定为 MTIME 便于断言 lastActiveAt） */
function writeSession(
  root: string,
  projDir: string,
  sessionId: string,
  lines: ReadonlyArray<Record<string, unknown>>
): string {
  const dir = join(root, mungePath(projDir))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf8')
  utimesSync(file, MTIME, MTIME)
  return file
}

/** 首个会话元信息——单会话 fixture 的便捷断言入口 */
async function firstSession(root: string, projDir = 'D:\\fake\\demo'): Promise<SessionMeta> {
  const list = await listSessions(projDir, { projectsRoot: () => root })
  const meta = list[0]
  if (!meta) throw new Error('no session found in fixture')
  return meta
}

describe('mungePath（实测目录对照：~/.claude/projects 命名规则）', () => {
  it('盘符冒号与反斜杠 → `-`（D:\\SourceCode\\agent → D--SourceCode-agent）', () => {
    expect(mungePath('D:\\SourceCode\\agent')).toBe('D--SourceCode-agent')
  })

  it('深层路径实测对照（Temp 下 cwb-review-session 目录）', () => {
    expect(mungePath('C:\\Users\\liuhait1\\AppData\\Local\\Temp\\cwb-review-session')).toBe(
      'C--Users-liuhait1-AppData-Local-Temp-cwb-review-session'
    )
  })

  it('正斜杠/点/空格/下划线等非字母数字一律 `-`；大小写保留', () => {
    expect(mungePath('/home/user/proj')).toBe('-home-user-proj')
    expect(mungePath('D:\\work\\my.v2 sub')).toBe('D--work-my-v2-sub')
    expect(mungePath('\\\\server\\share')).toBe('--server-share')
    expect(mungePath('D:\\SourceCode\\agent')).toBe('D--SourceCode-agent') // 大写 D/S 保留
  })

  it('本机活体校验：~/.claude/projects 下存在 mungePath(D:\\SourceCode\\agent) 目录（无则静默跳过——CI 无该目录）', () => {
    const live = join(homedir(), '.claude', 'projects', mungePath('D:\\SourceCode\\agent'))
    if (!existsSync(join(homedir(), '.claude', 'projects'))) return
    expect(existsSync(live)).toBe(true)
  })
})

describe('listSessions 命名优先级（fixture jsonl）', () => {
  it('customTitle > aiTitle > summary > 首条真实用户消息 > 兜底', async () => {
    const root = makeRoot()
    try {
      // 四分支独立 fixture
      const sidCustom = '11111111-1111-4111-8111-111111111111'
      const sidAi = '22222222-2222-4222-8222-222222222222'
      const sidSummary = '33333333-3333-4333-8333-333333333333'
      const sidUser = '44444444-4444-4444-8444-444444444444'
      const sidFallback = '55555555-5555-4555-8555-555555555555'
      const realUser = userLine('这是真实的第一条用户消息')

      writeSession(root, 'D:\\fake\\demo', sidCustom, [
        realUser,
        { type: 'ai-title', aiTitle: 'AI标题', timestamp: T1 },
        { type: 'summary', summary: '会话摘要', timestamp: T1 },
        { type: 'user', customTitle: '用户命名', message: { role: 'user', content: 'x' }, timestamp: T1 }
      ])
      writeSession(root, 'D:\\fake\\demo', sidAi, [
        realUser,
        { type: 'summary', summary: '会话摘要', timestamp: T1 },
        { type: 'ai-title', aiTitle: 'AI标题', timestamp: T1 }
      ])
      writeSession(root, 'D:\\fake\\demo', sidSummary, [
        realUser,
        { type: 'summary', summary: '会话摘要', timestamp: T1 }
      ])
      writeSession(root, 'D:\\fake\\demo', sidUser, [realUser])
      writeSession(root, 'D:\\fake\\demo', sidFallback, [
        { type: 'assistant', message: { role: 'assistant', content: [] }, timestamp: T1 },
        { type: 'queue-operation', operation: 'enqueue', timestamp: T1 },
        { parentUuid: null, isSidechain: false, timestamp: T1 } // 无 type 字段的行（实测存在）
      ])

      const byId = new Map(
        (await listSessions('D:\\fake\\demo', { projectsRoot: () => root })).map((s) => [s.sessionId, s])
      )
      expect(byId.get(sidCustom)?.name).toBe('用户命名')
      expect(byId.get(sidAi)?.name).toBe('AI标题')
      expect(byId.get(sidSummary)?.name).toBe('会话摘要')
      expect(byId.get(sidUser)?.name).toBe('这是真实的第一条用户消息')
      expect(byId.get(sidFallback)?.name).toBe(`会话 ${sidFallback.slice(0, 8)}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非真实输入全过滤：local-command-caveat/isMeta、command-name（无 isMeta）、system-reminder、isSidechain、tool_result 数组', async () => {
    const root = makeRoot()
    try {
      const sid = '66666666-6666-4666-8666-666666666666'
      writeSession(root, 'D:\\fake\\demo', sid, [
        userLine('<local-command-caveat>The command below was run directly...</local-command-caveat>', { isMeta: true }),
        userLine('<command-name>/model</command-name>\n<command-message>model</command-message>'), // 实测无 isMeta——前缀过滤必须独立生效
        userLine('<system-reminder>系统提醒注入内容</system-reminder>'),
        userLine('子代理链里的消息不该成为任务名', { isSidechain: true }),
        userLine([{ type: 'tool_result', tool_use_id: 't1', content: '工具输出不是用户输入' }]),
        userLine('真实   用户\n消息') // 空白归一
      ])
      const meta = await firstSession(root)
      expect(meta.name).toBe('真实 用户 消息')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('user message.content 为 text 数组时取 text 项拼名', async () => {
    const root = makeRoot()
    try {
      const sid = '77777777-7777-4777-8777-777777777777'
      writeSession(root, 'D:\\fake\\demo', sid, [
        userLine([
          { type: 'text', text: '数组形态的用户消息' },
          { type: 'tool_result', content: '忽略' }
        ])
      ])
      expect((await firstSession(root)).name).toBe('数组形态的用户消息')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('超长名称截 40 字（Unicode 码点——emoji 不劈代理对）+ 控制字符剔除', async () => {
    const root = makeRoot()
    try {
      const sid = '88888888-8888-4888-8888-888888888888'
      // 3+30+8=41 码点：截 40 后恰丢最后一个字符，且尾部标记（完整串）不可见
      const tail = '尾部超长内容截断'
      const raw = `首部分${'🎉'.repeat(30)}${tail}`
      writeSession(root, 'D:\\fake\\demo', sid, [userLine(`\u0007${raw}\n`)])
      const name = (await firstSession(root)).name
      expect(name).toBe(Array.from(raw).slice(0, 40).join(''))
      expect(Array.from(name)).toHaveLength(40)
      expect(name.startsWith('首部分🎉')).toBe(true)
      expect(name).not.toContain(tail) // 第 41 码点起被截
      expect(name.includes('\uFFFD')).toBe(false) // 未劈开 emoji 代理对
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('listSessions 流式头部读取（大文件只读头部）', () => {
  it('行数上限 200：第 250 行的 customTitle 不被读到（若全文载入则会命中）', async () => {
    const root = makeRoot()
    try {
      const sid = '99999999-9999-4999-8999-999999999999'
      const lines: Array<Record<string, unknown>> = [
        userLine('流式命名测试', { timestamp: T1 }),
        { type: 'assistant', message: { role: 'assistant', content: [] }, timestamp: T1 }
      ]
      for (let i = lines.length; i < 249; i++) {
        lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `第${i}轮` }] }, timestamp: T1 })
      }
      lines.push({ type: 'user', customTitle: '两百行外的命名不该生效', message: { role: 'user', content: 'x' }, timestamp: T1 })
      for (let i = 0; i < 50; i++) lines.push({ type: 'assistant', message: { role: 'assistant', content: [] }, timestamp: T1 })
      writeSession(root, 'D:\\fake\\demo', sid, lines)

      expect((await firstSession(root)).name).toBe('流式命名测试')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('字节上限 2MB：不足 200 行即截断，第 160 行的 customTitle 不被读到', async () => {
    const root = makeRoot()
    try {
      const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const filler = 'x'.repeat(16 * 1024) // 每行 16KB：~128 行即超 2MB
      const lines: Array<Record<string, unknown>> = [
        { type: 'queue-operation', operation: 'enqueue', timestamp: T1 },
        userLine('字节上限内的用户消息', { timestamp: T2 })
      ]
      for (let i = 0; i < 158; i++) {
        lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] }, timestamp: T2 })
      }
      lines.push({ type: 'user', customTitle: '字节封顶外的命名不该生效', message: { role: 'user', content: 'x' }, timestamp: T2 })
      writeSession(root, 'D:\\fake\\demo', sid, lines)

      expect((await firstSession(root)).name).toBe('字节上限内的用户消息')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('时间戳：createdAt=头部首条 timestamp、lastActiveAt=文件 mtime；缺 timestamp 时 createdAt 回退 mtime', async () => {
    const root = makeRoot()
    try {
      const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      writeSession(root, 'D:\\fake\\demo', sid, [
        { type: 'queue-operation', operation: 'enqueue', timestamp: T1 },
        userLine('有时间戳', { timestamp: T2 })
      ])
      expect(await firstSession(root)).toMatchObject({
        createdAt: T1,
        lastActiveAt: MTIME.toISOString()
      })

      const sidNoTs = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      writeSession(root, 'D:\\fake\\demo', sidNoTs, [
        { type: 'user', isSidechain: false, message: { role: 'user', content: '无时间戳行' } } // 无 timestamp 字段
      ])
      const list = await listSessions('D:\\fake\\demo', { projectsRoot: () => root })
      const noTs = list.find((s) => s.sessionId === sidNoTs)
      expect(noTs).toMatchObject({
        createdAt: MTIME.toISOString(),
        lastActiveAt: MTIME.toISOString()
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('目录缺失/空目录 → 空列表；非 jsonl 条目（memory/ 目录、.tmp 文件）跳过', async () => {
    const root = makeRoot()
    try {
      expect(await listSessions('D:\\never\\registered', { projectsRoot: () => root })).toEqual([])
      const dir = join(root, mungePath('D:\\fake\\demo'))
      mkdirSync(join(dir, 'memory'), { recursive: true })
      writeFileSync(join(dir, 'stray.tmp'), 'x', 'utf8')
      writeSession(root, 'D:\\fake\\demo', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [userLine('唯一会话')])
      const list = await listSessions('D:\\fake\\demo', { projectsRoot: () => root })
      expect(list).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('importTasksFromSessionsImpl（真实 ProjectStore/TaskStore）', () => {
  it('过滤已存在 sessionId → 创建 stopped 任务（id===sessionId、cwd=项目根）→ 逐个落盘并按 createdAt 升序返回', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cwb-import-impl-'))
    const root = makeRoot()
    try {
      const projects = new ProjectStore(base)
      const tasks = new TaskStore(base)
      const projDir = 'D:\\fake\\demo'
      const project = projects.add(projDir, false)
      writeSession(root, projDir, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', [
        userLine('第二个会话', { timestamp: T2 })
      ])
      writeSession(root, projDir, 'ffffffff-ffff-4fff-8fff-ffffffffffff', [
        userLine('第一个会话', { timestamp: T1 })
      ])

      const added = await importTasksFromSessionsImpl(project.id, projects, tasks, {
        projectsRoot: () => root
      })
      expect(added.map((t) => t.name)).toEqual(['第一个会话', '第二个会话']) // createdAt 升序
      for (const t of added) {
        expect(t).toMatchObject({
          id: t.sessionId,
          projectId: project.id,
          cwd: projDir,
          status: 'stopped'
        })
        expect('worktreePath' in t).toBe(false) // 导入任务工作目录=项目根，非 worktree
        expect('skipPermissions' in t).toBe(false) // 安全默认：未勾选跳过权限
      }
      // 落盘核对
      const onDisk = JSON.parse(readFileSync(join(base, 'tasks.json'), 'utf8')) as TaskRecord[]
      expect(onDisk).toHaveLength(2)
      expect(onDisk.map((t) => t.id).sort()).toEqual(added.map((t) => t.id).sort())

      // 幂等：二次导入零新增
      expect(
        await importTasksFromSessionsImpl(project.id, projects, tasks, { projectsRoot: () => root })
      ).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('全局 sessionId 查重：已归属其他项目的会话不再导入；无会话项目得空数组；未知项目抛错', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cwb-import-impl-'))
    const root = makeRoot()
    try {
      const projects = new ProjectStore(base)
      const tasks = new TaskStore(base)
      const projA = projects.add('D:\\fake\\a', false)
      const projB = projects.add('D:\\fake\\b', false)
      const sid = 'abababab-abab-4bab-8bab-abababababab'
      writeSession(root, 'D:\\fake\\a', sid, [userLine('会话在项目A')])
      // 项目 A 导入后，把同一会话目录"挂"到项目 B 名下（模拟 munge 碰撞：D:\fake\a-b 同名）
      const first = await importTasksFromSessionsImpl(projA.id, projects, tasks, { projectsRoot: () => root })
      expect(first).toHaveLength(1)
      mkdirSync(join(root, mungePath('D:\\fake\\b')), { recursive: true })
      const src = join(root, mungePath('D:\\fake\\a'), `${sid}.jsonl`)
      writeFileSync(join(root, mungePath('D:\\fake\\b'), `${sid}.jsonl`), readFileSync(src, 'utf8'), 'utf8')

      const second = await importTasksFromSessionsImpl(projB.id, projects, tasks, { projectsRoot: () => root })
      expect(second).toEqual([]) // sessionId 全局查重——不重复建任务

      // 无会话目录的项目 → 空数组；未知项目 → 报错（与其他 handler 语义一致）
      const projEmpty = projects.add('D:\\fake\\empty', false)
      expect(
        await importTasksFromSessionsImpl(projEmpty.id, projects, tasks, { projectsRoot: () => root })
      ).toEqual([])
      await expect(
        importTasksFromSessionsImpl('no-such-project', projects, tasks, { projectsRoot: () => root })
      ).rejects.toThrow(/project not found/)
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── ipc 集成域（electron mock + CWB_CLAUDE_PROJECTS_ROOT 注入缝）──────

/** vi.mock 工厂被提升到 import 之前，共享状态必须放 vi.hoisted */
const h = vi.hoisted(() => {
  return {
    tempDir: '',
    handleCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
    onCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    ptyInstances: [] as Array<{
      spawnCalls: Array<{ taskId: string; args: string[]; cwd: string }>
      callbacks: { onData: (e: { taskId: string; data: string }) => void; onExit: (taskId: string) => void }
      kill: (taskId: string) => void
      isRunning: (taskId: string) => boolean
    }>
  }
})

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => h.tempDir, getVersion: () => '1.1.0-test', isPackaged: false, quit: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
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
    readonly runningIds = new Set<string>()
    constructor(
      readonly callbacks: {
        onData: (e: { taskId: string; data: string }) => void
        onExit: (taskId: string) => void
      }
    ) {
      h.ptyInstances.push(this)
    }
    async spawnClaude(taskId: string, _args: string[], _cwd: string): Promise<void> {
      this.spawnCalls.push({ taskId, args: _args, cwd: _cwd })
      this.runningIds.add(taskId)
    }
    write(_taskId: string, _data: string): void {}
    resize(_taskId: string, _cols: number, _rows: number): void {}
    kill(taskId: string): void {
      if (this.runningIds.delete(taskId)) this.callbacks.onExit(taskId)
    }
    isRunning(taskId: string): boolean {
      return this.runningIds.has(taskId)
    }
    forget(_taskId: string): void {}
  }
  return { ...actual, PtyManager: FakePtyManager }
})

import { registerIpcHandlers } from '../ipc'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const entry = h.handleCalls.find(([c]) => c === channel)
  if (!entry) throw new Error(`no handler registered for ${channel}`)
  return entry[1](undefined, ...args) as Promise<T>
}

function taskUpdates(): TaskRecord[] {
  return h.sent.filter((e) => e.channel === IpcChannels.TaskUpdate).map((e) => e.payload as TaskRecord)
}

describe('ipc 集成：addProject 自动导入 + importTasksFromSessions 手动触发', () => {
  beforeEach(() => {
    h.tempDir = mkdtempSync(join(tmpdir(), 'cwb-session-ipc-'))
    // 注入缝同 ipc.test.ts 先例（hooks settings/skills 根）+ 本模块会话存储根
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(h.tempDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    process.env['CWB_CLAUDE_PROJECTS_ROOT'] = join(h.tempDir, 'claude', 'projects')
    h.handleCalls.length = 0
    h.onCalls.length = 0
    h.sent.length = 0
    h.ptyInstances.length = 0
  })

  afterEach(() => {
    delete process.env['CWB_HOOK_SETTINGS_DIR']
    delete process.env['CWB_SKILLS_USER_ROOT']
    delete process.env['CWB_CLAUDE_PROJECTS_ROOT']
    rmSync(h.tempDir, { recursive: true, force: true })
  })

  it('addProject 后 tasks.json 含导入任务；响应契约不变（纯 ProjectRecord）；TaskUpdate 广播推送', async () => {
    registerIpcHandlers()
    const projDir = join(h.tempDir, 'proj')
    mkdirSync(projDir, { recursive: true })
    const sid = '8eda4f41-5f65-453d-9acd-e8f88d740957'
    writeSession(join(h.tempDir, 'claude', 'projects'), projDir, sid, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: T1, sessionId: sid },
      userLine('<local-command-caveat>...</local-command-caveat>', { isMeta: true }),
      userLine('现在生效的skill有哪些', { timestamp: T2 }),
      { type: 'ai-title', aiTitle: '当前生效的 skill 列表', sessionId: sid }
    ])

    const rec = await invoke<ProjectRecord>(IpcChannels.ProjectsAdd, projDir)
    // addProject 契约返回不变：恰为 ProjectRecord 五字段（无 importedCount 等附加）
    expect(Object.keys(rec).sort()).toEqual(['createdAt', 'dir', 'id', 'isGit', 'name'])

    // tasks.json 落盘核对（真实 TaskStore 写入）
    const onDisk = JSON.parse(readFileSync(join(h.tempDir, 'tasks.json'), 'utf8')) as TaskRecord[]
    expect(onDisk).toEqual([
      expect.objectContaining({
        id: sid,
        sessionId: sid,
        projectId: rec.id,
        name: '当前生效的 skill 列表', // aiTitle 优先于首条用户消息
        cwd: projDir,
        status: 'stopped'
      })
    ])
    // 导入经 TaskUpdate 广播（renderer 列表自动出现）
    expect(taskUpdates()).toContainEqual(expect.objectContaining({ id: sid, status: 'stopped' }))
  })

  it('importTasksFromSessions：手动触发导入新会话；二次幂等零新增；未知项目报错；不 spawn', async () => {
    registerIpcHandlers()
    const projDir = join(h.tempDir, 'proj2')
    mkdirSync(projDir, { recursive: true })
    const proj = await invoke<{ id: string }>(IpcChannels.ProjectsAdd, projDir) // 无会话目录——自动导入空转
    const sid = '0289f574-86d0-46f6-b980-9d58b16911d5'
    writeSession(join(h.tempDir, 'claude', 'projects'), projDir, sid, [userLine('补扫的会话', { timestamp: T2 })])

    const added = await invoke<TaskRecord[]>(IpcChannels.TasksImportFromSessions, proj.id)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ id: sid, sessionId: sid, cwd: projDir, status: 'stopped' })
    expect(await invoke<TaskRecord[]>(IpcChannels.TasksImportFromSessions, proj.id)).toEqual([])
    expect(taskUpdates()).toContainEqual(expect.objectContaining({ id: sid }))

    await expect(invoke(IpcChannels.TasksImportFromSessions, 'no-such')).rejects.toThrow(
      /project not found/
    )
    expect(h.ptyInstances[0]?.spawnCalls ?? []).toEqual([]) // 导入只建记录不 spawn
  })
})
