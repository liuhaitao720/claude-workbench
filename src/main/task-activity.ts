import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { TaskActivityEvent } from '../shared/types'

/**
 * 任务活动状态裁决器 + claude hooks HTTP 接收端（S7 v3.2 事件驱动改造）。
 *
 * 数据流：spawn/resume 时 per-task settings 注入 claude（--settings，见 buildSettings），
 * 其中 6 类 hook 事件以 type:http POST 回本模块的 127.0.0.1 随机端口；URL 携带
 * `e=<epoch>&t=<taskId>`——resume 会 epoch+1，旧 PTY 的迟到 hook 因 epoch 不匹配被丢弃。
 * PTY 字节流（onData 已流经 main）作兜底信号（noteBytes）。
 *
 * 裁决优先级（resolveInternal）：
 *   1. awaiting 粘滞——红了之后只有新字节流（宽限后）或新 hook 事件能改变；
 *   2. hook 事件新鲜（< HOOK_FRESH_MS）；
 *   3. 本地合成新鲜（< LOCAL_FRESH_MS——spawn/resume/Esc 的 idle 就绪窗）；
 *   4. 字节兜底（BYTE_ACTIVE_MS 活跃窗→busy，静默→idle；永不产生红）。
 *
 * activity 变化经 onActivity 外送（同值不播）；1s 定时器把时间驱动的变迁
 * （字节静默→idle 等）也送上广播（tick）。epoch 只存内存（重启重置，可接受——
 * 重启后旧 PTY 已死，不存在迟到 hook）。
 */

/** 任务活动状态（与契约 TaskActivityEvent.activity 同集，禁改 shared 故在此派生） */
export type TaskActivity = TaskActivityEvent['activity']

type ActivitySource = 'hook' | 'local' | 'bytes'

interface TaskState {
  /** settings URL 捕获的世代号；noteSpawn 自增作废旧 PTY 迟到 hook */
  epoch: number
  activity: TaskActivity
  source: ActivitySource
  /** source 态落定时刻（新鲜度窗起算） */
  updatedAt: number
  /** 最近一次 PTY 字节时刻（0=未知） */
  lastByteAt: number
  /** 用户最近一次键入时刻（v0.4.2：输入回显抑制——键入后 2s 内的 PTY 字节视为 TUI 重绘回显） */
  lastUserInputAt: number
  /** 最近一次裁决确认为 busy 的时刻（v0.4.5 滞回：busy→idle 需保持窗，防切换 tab 等瞬态翻转闪绿） */
  busyAffirmedAt: number
  /** Stop hook 上报 background_tasks/session_crons 非空（记录不展示，见 S7 concerns） */
  backgroundWork: boolean
}

export interface TaskActivityOptions {
  /** per-task settings 目录（ipc 组合根注入：CWB_HOOK_SETTINGS_DIR 测试覆盖 / %LOCALAPPDATA% 回退） */
  settingsDir: string
  /** activity 变化外送（同值不播；ipc 侧接 broadcast cwb:event:task-activity） */
  onActivity?: (e: TaskActivityEvent) => void
  /** 时间源（测试注入；缺省 Date.now） */
  now?: () => number
}

export interface TaskActivityHandle {
  /** 实际监听端口（ready 前为 0） */
  readonly port: number
  /** 监听就绪（端口确定）；失败也 resolve（降级：hook 不通，字节兜底仍可用） */
  ready(): Promise<void>
  /** 写 per-task settings（原子写 tmp+rename）并返回路径；URL 捕获当前 epoch */
  buildSettings(taskId: string): Promise<string>
  /** spawn/resume 时刻：epoch+1 + 本地合成 idle（绿）+ 重置字节钟 */
  noteSpawn(taskId: string): void
  /** PTY onData 字节记录；awaiting 粘滞解除（宽限后的新字节→busy） */
  noteBytes(taskId: string): void
  /** 用户键入（v0.4.2 输入回显抑制信号；ipc ptyWrite 全量调用） */
  noteUserInput(taskId: string): void
  /** 本地 Esc（ptyWrite 恰为单字符 \x1b）：当前裁决为 busy → 合成 idle */
  onEsc(taskId: string): void
  /** 当前裁决结果（未知任务 undefined） */
  current(taskId: string): TaskActivity | undefined
  /** Stop hook 是否上报过后台工作（background_tasks/session_crons 非空） */
  backgroundWork(taskId: string): boolean
  /** 时间驱动重裁决并广播（内部 1s 定时调用；测试可手动驱动） */
  tick(): void
  /** 删 settings 文件 + 内存态（removeTask/removeProject 生命周期清理） */
  forget(taskId: string): void
  /** 启动孤儿清扫：settings 目录下不在 keep 集内的 *.json / *.json.tmp 删除 */
  cleanupOrphans(keepTaskIds: readonly string[]): void
  /** 停 server 与定时器（测试用；生产随 app 生命周期不调） */
  dispose(): void
}

/** hook 事件 → 目标 activity（未列出的事件名忽略） */
const HOOK_EVENT_ACTIVITIES: Readonly<Record<string, TaskActivity>> = {
  UserPromptSubmit: 'busy',
  Stop: 'idle',
  StopFailure: 'idle',
  PermissionRequest: 'awaiting',
  Elicitation: 'awaiting',
  PreToolUse: 'awaiting' // settings 侧 matcher 已限定 AskUserQuestion|ExitPlanMode
}

/** hook 事件新鲜窗：窗内 hook 裁决不被字节兜底翻案（Stop 后尾部输出不误判回 busy） */
const HOOK_FRESH_MS = 15_000
/** 本地合成新鲜窗（spawn/resume/Esc 的 idle 就绪窗；窗内字节不翻案） */
const LOCAL_FRESH_MS = 8_000
/** 字节活跃窗：窗内有字节→busy */
const BYTE_ACTIVE_MS = 4_000
/** awaiting 粘滞解除宽限：进红后该窗内的字节视为对话框重绘噪音，不解除粘滞 */
/** awaiting 粘滞宽限（评审 #2：对话框对每次按键都重绘产生字节——1s 会被用户击键误解除；
 *  5s 内的重绘噪音不解粘，仅持续 >5s 的新字节流（claude 真正恢复输出）才解除转 busy） */
const AWAIT_UNSTICK_GRACE_MS = 5_000
/** 输入回显抑制窗（v0.4.2）：最后按键后该窗内到达的 PTY 字节视为 TUI 重绘回显 */
const INPUT_ECHO_MS = 2_000
/** busy 滞回保持窗（v0.4.5）：最后一次 busy 确认后该窗内不降级 idle */
const BUSY_HOLD_MS = 1_500
/** 广播重裁决周期 */
const TICK_MS = 1_000
/** hook body 上限（防御任意本地进程的垃圾输入） */
const MAX_BODY_BYTES = 1_000_000

export function startTaskActivityServer(opts: TaskActivityOptions): TaskActivityHandle {
  const now = opts.now ?? Date.now
  const states = new Map<string, TaskState>()
  /** 最近一次外送的 activity（同值不播） */
  const published = new Map<string, TaskActivity>()
  let port = 0
  let disposed = false

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res)
  })
  // 任一本地进程都可 POST——hooks 不是安全边界（同机信任域）；错误不崩主进程
  server.on('error', (err) => {
    console.error('[cwb] task-activity http server error:', err instanceof Error ? err.message : err)
  })

  let readyPromise: Promise<void> | null = null
  function ready(): Promise<void> {
    if (readyPromise) return readyPromise
    readyPromise = new Promise((resolve) => {
      if (port !== 0 || disposed) {
        resolve()
        return
      }
      server.once('error', () => resolve()) // 监听失败：降级（端口 0 的 URL 不可达，字节兜底仍可用）
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        port = typeof addr === 'object' && addr !== null ? addr.port : 0
        resolve()
      })
    })
    return readyPromise
  }

  /** 解析裁决：粘滞 awaiting > 新鲜 hook > 新鲜本地合成 > 字节兜底（永不红） */
  function resolveInternal(st: TaskState, at: number): TaskActivity {
    if (st.activity === 'awaiting') return 'awaiting'
    const age = at - st.updatedAt
    if (st.source === 'hook' && age < HOOK_FRESH_MS) return st.activity
    if (st.source === 'local' && age < LOCAL_FRESH_MS) return st.activity
    // v0.4.2 输入回显抑制：最后按键后 2s 内到达的字节=TUI 逐键重绘（用户在输入，非 LLM 执行）
    // ——不点亮 busy（用户未提交时保持绿；hooks 正常时提交后由 UserPromptSubmit 驱动 busy）
    if (at - st.lastByteAt < BYTE_ACTIVE_MS && st.lastByteAt - st.lastUserInputAt >= INPUT_ECHO_MS) {
      st.busyAffirmedAt = at
      return 'busy'
    }
    // v0.4.5 busy 滞回：字节窗刚过期但 1.5s 内仍确认过 busy → 保持（防瞬态闪绿）。
    // 锚 busyAffirmedAt 而非 st.activity——字节驱动的 busy 仅经 resolve 瞬态计算不落 activity
    if (at - st.busyAffirmedAt < BUSY_HOLD_MS) return 'busy'
    return 'idle'
  }

  /** 裁决并按需外送（同值不播） */
  function publish(taskId: string): void {
    const st = states.get(taskId)
    if (!st) return
    const effective = resolveInternal(st, now())
    if (published.get(taskId) === effective) return
    published.set(taskId, effective)
    opts.onActivity?.({ taskId, activity: effective })
  }

  function ensureState(taskId: string): TaskState {
    let st = states.get(taskId)
    if (!st) {
      st = {
        epoch: 0,
        activity: 'idle',
        source: 'bytes',
        updatedAt: 0,
        lastByteAt: 0,
        lastUserInputAt: 0,
        busyAffirmedAt: 0,
        backgroundWork: false
      }
      states.set(taskId, st)
    }
    return st
  }

  function setActivity(st: TaskState, taskId: string, activity: TaskActivity, source: ActivitySource): void {
    st.activity = activity
    st.source = source
    st.updatedAt = now()
    // v0.4.5：显式迁移同步滞回锚——busy 刷新确认时刻；非 busy 清零（显式 idle 优先于滞回）
    st.busyAffirmedAt = activity === 'busy' ? now() : 0
    publish(taskId)
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      try {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        const url = req.url ?? ''
        const match = /^\/hook\/([A-Za-z]+)$/.exec(url.split('?')[0])
        if (!match) {
          res.statusCode = 404
          res.end()
          return
        }
        const body = await readBody(req)
        // 无论是否采纳，一律 200 空体——不干扰 claude 授权流、不触发重试
        res.statusCode = 200
        res.end()
        applyHook(match[1] ?? '', url, body)
      } catch {
        try {
          res.statusCode = 400
          res.end()
        } catch {
          /* 响应已发出等，忽略 */
        }
      }
    })()
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const parts: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          parts.length = 0
          req.destroy()
          resolve('')
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function applyHook(event: string, rawUrl: string, body: string): void {
    const target = HOOK_EVENT_ACTIVITIES[event]
    if (target === undefined) return
    // URL 不含 e/t 或 epoch 不匹配 → 忽略（旧 PTY 迟到 hook）
    let query: URLSearchParams
    try {
      query = new URL(rawUrl, `http://127.0.0.1:${port}`).searchParams
    } catch {
      return
    }
    const taskId = query.get('t')
    const epochRaw = query.get('e')
    if (!taskId || epochRaw === null) return
    const epoch = Number(epochRaw)
    const st = states.get(taskId)
    if (!st || !Number.isInteger(epoch) || epoch !== st.epoch) return
    if (event === 'Stop') {
      // payload 含 background_tasks/session_crons 非空 → 记录标志（仍 idle；展示取舍见 concerns）
      const parsed = parseJsonRecord(body)
      st.backgroundWork = nonEmptyArray(parsed?.['background_tasks']) || nonEmptyArray(parsed?.['session_crons'])
    }
    setActivity(st, taskId, target, 'hook')
  }

  const tickTimer = setInterval(() => {
    for (const taskId of states.keys()) publish(taskId)
  }, TICK_MS)
  tickTimer.unref?.()

  // 构造即监听（急启动）：消费方（ipc 组合根）无需先 await ready() 才有真实端口；
  // ready() 仅供需要确定端口的场景（buildSettings）等待
  void ready()

  return {
    get port() {
      return port
    },
    ready,
    async buildSettings(taskId) {
      await ready()
      const st = ensureState(taskId)
      const epoch = st.epoch
      const hook = (event: string, matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: 'http',
            url: `http://127.0.0.1:${port}/hook/${event}?e=${epoch}&t=${encodeURIComponent(taskId)}`,
            timeout: 3
          }
        ]
      })
      const settings = {
        hooks: {
          UserPromptSubmit: [hook('UserPromptSubmit')],
          Stop: [hook('Stop')],
          StopFailure: [hook('StopFailure')],
          PermissionRequest: [hook('PermissionRequest')],
          Elicitation: [hook('Elicitation')],
          PreToolUse: [hook('PreToolUse', 'AskUserQuestion|ExitPlanMode')]
        }
      }
      mkdirSync(opts.settingsDir, { recursive: true })
      const file = join(opts.settingsDir, `${taskId}.json`)
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
      renameSync(tmp, file)
      return file
    },
    noteSpawn(taskId) {
      const st = ensureState(taskId)
      st.epoch += 1 // 作废旧 PTY 迟到 hook
      st.activity = 'idle'
      st.source = 'local'
      st.updatedAt = now()
      st.lastByteAt = 0 // 重置字节钟：旧会话尾部字节不得立刻翻回 busy
      st.backgroundWork = false
      publish(taskId)
    },
    noteBytes(taskId) {
      const at = now()
      const st = ensureState(taskId)
      st.lastByteAt = at
      // v0.4.2：键入后 2s 内的字节=回显（用户在答复对话框/打字），不解除 awaiting 粘滞
      const echoLike = at - st.lastUserInputAt < INPUT_ECHO_MS
      if (!echoLike && st.activity === 'awaiting' && at - st.updatedAt >= AWAIT_UNSTICK_GRACE_MS) {
        setActivity(st, taskId, 'busy', 'bytes')
      }
    },
    noteUserInput(taskId) {
      ensureState(taskId).lastUserInputAt = now()
    },
    onEsc(taskId) {
      const st = states.get(taskId)
      if (!st) return
      if (resolveInternal(st, now()) === 'busy') {
        setActivity(st, taskId, 'idle', 'local')
      }
    },
    current(taskId) {
      const st = states.get(taskId)
      return st ? resolveInternal(st, now()) : undefined
    },
    backgroundWork(taskId) {
      return states.get(taskId)?.backgroundWork === true
    },
    tick() {
      for (const taskId of states.keys()) publish(taskId)
    },
    forget(taskId) {
      states.delete(taskId)
      published.delete(taskId)
      try {
        unlinkSync(join(opts.settingsDir, `${taskId}.json`))
      } catch {
        // 不存在/已删，幂等
      }
    },
    cleanupOrphans(keepTaskIds) {
      let files: string[]
      try {
        files = readdirSync(opts.settingsDir)
      } catch {
        return // 目录不存在：无孤儿可扫
      }
      const keep = new Set(keepTaskIds)
      for (const f of files) {
        if (!f.endsWith('.json') && !f.endsWith('.json.tmp')) continue
        const stem = f.replace(/\.json(\.tmp)?$/, '')
        if (!keep.has(stem)) {
          try {
            unlinkSync(join(opts.settingsDir, f))
          } catch {
            // 并发删除/权限等，尽力而为
          }
        }
      }
    },
    dispose() {
      disposed = true
      clearInterval(tickTimer)
      server.close(() => {})
    }
  }
}

function parseJsonRecord(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}
