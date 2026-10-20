import { app, BrowserWindow, Menu } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAppContext, registerIpcHandlers, type AppContext } from './ipc'
import { resolveClaudeCommand } from './pty-manager'
import { attachCloseToTray, setupTray, type TrayHandle } from './tray'

const execFileAsync = promisify(execFile)

/** S4 冒烟全程超时（app 内自守；驱动脚本另设更宽的外层超时兜底） */
const SMOKE_TIMEOUT_MS = 60_000
/** 等待 PTY 首字节/回执的窗口 */
const WAIT_DATA_MS = 50_000
/** renderer did-finish-load 后的缓冲（React mount + initListeners 订阅完成余量） */
const RENDERER_SETTLE_MS = 300

// ── 启动模式解析（须在 app ready 前） ─────────────────────────────────

const SMOKE_FLAG = process.argv.includes('--smoke')

/** v0.4.3 输入回显取证模式 --smoke-input：真实击键路径（DOM输入事件→xterm→PTY→回显→渲染行）逐层取证 */
const INPUT_PROBE_FLAG = process.argv.includes('--smoke-input')

/** --smoke-recovery[=phase-a|phase-b]：无值默认 phase-a */
function recoveryPhase(): 'a' | 'b' | null {
  const arg = process.argv.find((a) => a === '--smoke-recovery' || a.startsWith('--smoke-recovery='))
  if (!arg) return null
  return arg.endsWith('=phase-b') ? 'b' : 'a'
}

const RECOVERY = recoveryPhase()

/** 冒烟编排模式（--smoke 或 --smoke-recovery） */
const isSmokeRun = SMOKE_FLAG || RECOVERY !== null || INPUT_PROBE_FLAG

/** 测试注入 userData（防污染真实数据目录；须在 ready 前生效） */
const injectedUserData = process.env['CWB_USER_DATA']
if (injectedUserData) {
  app.setPath('userData', injectedUserData)
}

// ── 通用小工具 ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 打印失败原因并 exit(1)；throw 防止编排继续（app.exit 通常立即生效，此为兜底） */
function smokeFail(reason: string): never {
  console.error(`[smoke] FAIL: ${reason}`)
  app.exit(1)
  throw new Error(reason)
}

/** temp 目录建 git 仓库（init + 空提交；内联身份避免依赖全局 git config） */
async function makeGitRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await execFileAsync('git', ['-C', dir, 'init'])
  await execFileAsync('git', [
    '-C',
    dir,
    '-c',
    'user.name=CWB Smoke',
    '-c',
    'user.email=cwb-smoke@invalid',
    'commit',
    '--allow-empty',
    '-m',
    'init'
  ])
}

/** 按 taskId 聚合 PTY 字节的观察者（经 createAppContext 的 onPtyData 旁路接入） */
class PtyByteSink {
  private readonly chunks = new Map<string, string[]>()
  readonly onPtyData = (event: { taskId: string; data: string }): void => {
    const list = this.chunks.get(event.taskId)
    if (list) list.push(event.data)
    else this.chunks.set(event.taskId, [event.data])
  }
  bytes(taskId: string): string {
    return (this.chunks.get(taskId) ?? []).join('')
  }
  async waitForBytes(taskId: string, minBytes: number, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const data = this.bytes(taskId)
      if (Buffer.byteLength(data, 'utf8') >= minBytes) return data
      await sleep(200)
    }
    smokeFail(`task ${taskId} produced < ${minBytes} bytes within ${timeoutMs}ms`)
  }
}

/** 等 PTY 完全 teardown（onExit 已达、句柄已清）；kill 后立即 app.exit 有堆损坏前科（0xC0000374） */
async function waitPtyDead(ctx: AppContext, taskId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (ctx.pty.isRunning(taskId) && Date.now() < deadline) await sleep(100)
  if (ctx.pty.isRunning(taskId)) smokeFail(`PTY still running ${timeoutMs}ms after stopTask`)
  await sleep(500) // ConPTY 尾部清理缓冲（读线程收敛）
}

// ── ① --smoke：真 app/真窗口/真 PTY 的端到端回执 ─────────────────────

/**
 * 窗口加载后执行：CWB_USER_DATA 下建 temp 非 git 项目 → 真实 createTask(shared)
 * （真 spawn claude，空闲会话）→ 等 renderer（?smoke=1 的 SmokeBridge）经
 * reportSmoke 回执首段 PTY 数据 → 断言非空 → kill + 清记录 → exit(0)。
 */

// ── 输入回显取证（v0.4.3）：模拟"移动到 chat about this 后打字"全链路 ────

async function runInputProbe(ctx: AppContext, sink: PtyByteSink): Promise<void> {
  const projectDir = join(app.getPath('userData'), 'input-probe-project')
  mkdirSync(projectDir, { recursive: true })
  const project = await ctx.addProject(projectDir)
  const task = await ctx.createTask(project.id, 'input-probe', { isolation: 'shared' })
  console.log('[input-probe] task created, waiting first screen (trust dialog)...')

  const deadline = Date.now() + WAIT_DATA_MS
  while (Date.now() < deadline && ctx.smokeReports.length === 0) await sleep(200)
  if (ctx.smokeReports.length === 0) smokeFail('no renderer report (terminal not rendering)')
  await sleep(3000) // 信任对话框渲染稳定

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) smokeFail('no window for input probe')

  // 探针环境补全：smoke 模式经 main 侧建任务，renderer store 无该项目/tab——
  // 经 SmokeBridge 测试钩子驱动真实 openTaskAutoResume（开 tab+聚焦）
  const openClick = String(
    await win.webContents.executeJavaScript(
      "(function(){var t=window.__cwbTest;if(!t||!t.openTask)return 'NO-TEST-HOOK';t.openTask(" +
        JSON.stringify(task.id) +
        ");return 'OPENED'})()"
    )
  )
  console.log('[input-probe] open task tab via test hook:', openClick)
  await sleep(1500) // 自动恢复 spawn + 终端挂载渲染 + 50ms 聚焦
  const hasTextarea = String(
    await win.webContents.executeJavaScript(
      "Boolean(document.querySelector('.term-host-active textarea'))"
    )
  )
  console.log('[input-probe] xterm textarea present:', hasTextarea)

  /** 读 xterm 渲染行（用户实际所见） */
  const readRows = async (): Promise<string> =>
    String(
      await win.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('.xterm-rows > div')).map(function(r){return r.textContent}).join('\\n')"
      )
    )

  // 真实输入注入（Chromium 层 sendInputEvent——与用户物理键入同路径）
  const key = (keyCode: string, type: 'keyDown' | 'keyUp' | 'char' = 'keyDown'): void => {
    win.webContents.sendInputEvent({ type, keyCode } as Electron.KeyboardInputEvent)
  }

  // 相位等待（替代固定 sleep——打包/开发启动速度不同，打在错误相位会被对话框吞字）
  const waitForRows = async (marker: RegExp, timeoutMs: number, what: string): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (marker.test(await readRows())) {
        console.log(`[input-probe] phase reached: ${what}`)
        return true
      }
      await sleep(250)
    }
    console.error(`[input-probe] phase NOT reached: ${what} (${timeoutMs}ms)`)
    console.error('[input-probe] current rows:', JSON.stringify((await readRows()).slice(0, 600)))
    return false
  }

  // 诊断：当前焦点元素 + 单次方向键的 PTY 字节增量
  win.focus()
  await sleep(200)
  const focusInfo = String(
    await win.webContents.executeJavaScript(
      "document.activeElement ? String(document.activeElement.tagName)+'.'+String(document.activeElement.className) : 'none'"
    )
  )
  console.log('[input-probe] activeElement:', focusInfo)
  // 手动聚焦诊断：直接 focus xterm textarea 是否生效
  const manualFocus = String(
    await win.webContents.executeJavaScript(
      "(function(){var ta=document.querySelector('.term-host-active textarea');if(!ta)return 'NO-TEXTAREA';ta.focus();return document.activeElement===ta?'FOCUSED':'FOCUS-FAILED'})()"
    )
  )
  console.log('[input-probe] manual textarea focus:', manualFocus)

  // 对话框验证（v0.4.4 剥离子会话标记后，首启对话框在探针环境也可见）：
  // 两个特殊默认项——"type something"（行内直输+占位隐藏）与 "chat about this"（选中+回车）
  if (!/❯/.test(await readRows())) {
    const dialogReady = await waitForRows(/type something|chat about/i, 30_000, 'welcome dialog (type something / chat about)')
    if (!dialogReady) smokeFail('neither welcome dialog nor input line rendered within 30s')
    const dialogRows = await readRows()
    console.log('[input-probe] dialog options evidence:',
      'type-something=', /type something/i.test(dialogRows), 'chat-about=', /chat about/i.test(dialogRows))

    // 验证①：在对话框行内直接打字（不按 Enter）→ 回显、占位符隐藏
    for (const ch of 'hiprobe') {
      key(ch, 'char')
      await sleep(90)
    }
    await sleep(1500)
    const typedInDialog = await readRows()
    const norm = typedInDialog.replace(/\s+/g, '')
    console.log('[input-probe] ① inline typing in dialog: echo=', norm.includes('hiprobe'),
      'placeholder-hidden=', !/typesomething/i.test(norm))
    key('Return')
    const inputReady = await waitForRows(/❯/, 30_000, 'input line (❯) after dialog submit')
    if (!inputReady) smokeFail('input line ❯ not shown after Enter within 30s')
  } else {
    console.log('[input-probe] phase reached: input line already present (env skips dialog)')
    for (const ch of 'hiprobe') {
      key(ch, 'char')
      await sleep(90)
    }
    await sleep(1500)
  }
  await sleep(800)

  // 证据A：PTY 输出流（claude 是否收到并回显）
  const bytes = sink.bytes(task.id)
  console.log('[input-probe] A) PTY stream echo contains hiprobe:', bytes.includes('hiprobe'))
  console.log('[input-probe] A) PTY tail:', JSON.stringify(bytes.slice(-300)))

  // 证据B：xterm 渲染 DOM 行（用户实际所见）——逐行转储 1-12 行 + 归一化匹配
  const rows = await readRows()
  const lines = rows.split('\n')
  lines.slice(0, 12).forEach((ln, i) => {
    if (ln.trim().length > 0) console.log(`[input-probe] row ${i + 1}:`, JSON.stringify(ln.slice(0, 120)))
  })
  const normalized = rows.replace(/\s+/g, '')
  console.log('[input-probe] B) rendered contains hiprobe(raw):', rows.includes('hiprobe'))
  console.log('[input-probe] B) rendered contains iprobe(norm):', normalized.includes('iprobe'))

  await ctx.stopTask(task.id)
  await waitPtyDead(ctx, task.id)
  await ctx.removeTask(task.id, { deleteWorktree: false })
  console.log('[input-probe] OK')
  app.exit(normalized.includes('iprobe') ? 0 : 2) // exit 2 = 渲染层回显失败（复现；归一化匹配容忍光标样式空格）
}

async function runSmoke(ctx: AppContext): Promise<void> {
  // claude 解析证据（S5 ③：打包上下文的实际解析路径 + 版本；与 S4 e2e 同款记录）
  const claudeCmd = await resolveClaudeCommand()
  console.log(`[smoke] resolveClaudeCommand() -> ${claudeCmd}`)
  try {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', claudeCmd, '--version'], { timeout: 20_000 })
    console.log(`[smoke] claude --version -> ${stdout.trim()}`)
  } catch (err) {
    // 版本探测失败不让 smoke 失败——PTY 内真 spawn claude 才是功能断言
    console.warn(`[smoke] claude --version check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const projectDir = join(app.getPath('userData'), 'smoke-project')
  mkdirSync(projectDir, { recursive: true }) // 非 git 目录（不加 .git）
  // v0.4.4 探针：欢迎对话框（type something / chat about this）疑似仅对非空文件夹出现
  writeFileSync(join(projectDir, 'readme.md'), '# input probe project')
  const project = await ctx.addProject(projectDir)
  console.log(`[smoke] project registered: ${project.id} dir=${project.dir} isGit=${project.isGit}`)

  const task = await ctx.createTask(project.id, 'smoke-task', { isolation: 'shared' })
  console.log(`[smoke] task created via real createTask path: id=${task.id} status=${task.status} cwd=${task.cwd}`)

  const deadline = Date.now() + WAIT_DATA_MS
  while (Date.now() < deadline && ctx.smokeReports.length === 0) await sleep(200)
  const report = ctx.smokeReports[0]
  if (report === undefined) smokeFail('no smoke:report from renderer within 50s (renderer PTY data -> reportSmoke loop broken)')
  if (report.length === 0) smokeFail('smoke:report payload is empty')
  console.log(`[smoke] renderer reportSmoke received, ${Buffer.byteLength(report, 'utf8')} bytes: ${JSON.stringify(report.slice(0, 200))}`)

  await ctx.stopTask(task.id)
  await waitPtyDead(ctx, task.id)
  await ctx.removeTask(task.id, { deleteWorktree: false })
  const remaining = ctx.tasks.list()
  if (remaining.length !== 0) smokeFail(`task record not cleaned, remaining: ${JSON.stringify(remaining)}`)
  console.log('[smoke] task stopped & record removed')
  console.log('[smoke] OK')
  app.exit(0)
}

// ── ⑤ --smoke-recovery 两阶段 ────────────────────────────────────────

/** Phase A：建 temp git 项目 + createTask(shared)，待首字节证明 PTY 真跑后直接 exit(0)（不 kill——tasks.json 留 running，模拟应用退出前 PTY 在跑） */
async function runRecoveryPhaseA(ctx: AppContext, sink: PtyByteSink): Promise<void> {
  const projectDir = join(app.getPath('userData'), 'recovery-project')
  await makeGitRepo(projectDir)
  const project = await ctx.addProject(projectDir)
  console.log(`[recovery-a] project registered: dir=${project.dir} isGit=${project.isGit}`)

  const task = await ctx.createTask(project.id, 'recovery-task', { isolation: 'shared' })
  console.log(`[recovery-a] task created: id=${task.id} status=${task.status} cwd=${task.cwd}`)
  console.log(`[recovery-a] tasks.json persisted: ${JSON.stringify(ctx.tasks.get(task.id))}`)

  await sink.waitForBytes(task.id, 1, 10_000)
  console.log(`[recovery-a] PTY produced ${Buffer.byteLength(sink.bytes(task.id), 'utf8')} bytes (claude alive)`)

  const pid = ctx.pty.pid(task.id)
  console.log(`SMOKE-PTY-PID ${pid ?? 'unknown'}`)
  console.log('[recovery-a] OK — exiting with PTY left running (tasks.json keeps status=running)')
  app.exit(0)
}

/** Phase B：断言启动归一化（running→stopped）→ resumeTask → running + 10s 内 PTY 字节 → stopTask → exit(0) */
async function runRecoveryPhaseB(ctx: AppContext, sink: PtyByteSink): Promise<void> {
  const all = ctx.tasks.list()
  const task = all[0]
  if (!task) smokeFail(`no task found in tasks.json (expected the one persisted by phase A): ${JSON.stringify(all)}`)
  console.log(`[recovery-b] listTasks -> id=${task.id} status=${task.status} (normalizeOnStartup applied)`)
  if (task.status !== 'stopped') {
    smokeFail(`expected status==='stopped' after startup normalization, got '${task.status}'`)
  }

  const resumed = await ctx.resumeTask(task.id)
  if (resumed.status !== 'running') smokeFail(`resumeTask returned status='${resumed.status}', expected 'running'`)
  console.log(`[recovery-b] resumeTask -> status=${resumed.status} (claude --resume ${resumed.sessionId} spawned at cwd=${resumed.cwd})`)

  await sink.waitForBytes(task.id, 1, 10_000)
  const data = sink.bytes(task.id)
  const exitedEarly = !ctx.pty.isRunning(task.id)
  console.log(
    `[recovery-b] PTY produced ${Buffer.byteLength(data, 'utf8')} bytes after resume` +
      (exitedEarly ? ' (claude exited by itself after error/report output — behavior noted)' : '')
  )

  await ctx.stopTask(task.id)
  await waitPtyDead(ctx, task.id)
  const stopped = ctx.tasks.get(task.id)
  if (!stopped || stopped.status !== 'stopped') smokeFail(`task not stopped after stopTask: ${JSON.stringify(stopped)}`)
  console.log(`[recovery-b] stopTask -> tasks.json status=${stopped.status}`)
  console.log('[recovery-b] OK')
  app.exit(0)
}

// ── app 生命周期 ──────────────────────────────────────────────────────

// v0.5⑥ 防误关闭：关窗→托盘（isQuitting 区分真退出与隐藏）；托盘句柄供 before-quit 清理
let isQuitting = false
let trayHandle: TrayHandle | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    autoHideMenuBar: true,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // v0.5⑥：close 拦截（preventDefault + hide），任务 PTY 后台续跑；activate 重建的窗口同样接上
  attachCloseToTray(win, () => isQuitting)

  // v0.5⑥ 补丁：Electron 44 页面 window.close() 无条件销毁（最小实验实证，beforeunload 也拦不住，
  // exposeInMainWorld 不能覆盖内置属性）——主世界注入重定义 window.close → 走 __cwbClose 桥 →
  // 主进程 win.close()（X 按钮同路径，触发 close 拦截）。SPA 无导航，一次性注入即持久
  win.webContents.once('did-finish-load', () => {
    void win.webContents
      .executeJavaScript("window.close = function(){ if (window.__cwbClose) window.__cwbClose() }")
      .catch(() => {
        // 注入失败不阻断（JS-close 退化为直接销毁，X 按钮路径不受影响）
      })
  })

  // --smoke / --smoke-input：URL query ?smoke=1 通知 renderer 进入冒烟回执模式（零契约改动）
  const smokeQuery = SMOKE_FLAG || INPUT_PROBE_FLAG
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = process.env['ELECTRON_RENDERER_URL']
    void win.loadURL(smokeQuery ? `${url}?smoke=1` : url)
  } else if (smokeQuery) {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'smoke=1' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

const sink = new PtyByteSink()

/** 运行任务数（托盘 tooltip/退出确认的真值源——以 tasks.json 为准，TaskUpdate 旁路驱动刷新） */
const runningCountOf = (ctx: AppContext): number =>
  ctx.tasks.list().filter((t) => t.status === 'running').length

app.whenReady().then(async () => {
  // v0.5.2 用户指令：移除原生菜单栏（File/Edit/View/Window）——win 上 autoHideMenuBar 兜底
  Menu.setApplicationMenu(null)
  // v0.5⑥ 托盘 tooltip 刷新：任务记录每次变更（含状态迁移）旁路回调（同 onPtyData 注入缝先例）
  const refreshTrayCount = (): void => trayHandle?.setRunningCount(runningCountOf(currentCtx))
  let currentCtx: AppContext
  currentCtx = registerIpcHandlers(
    isSmokeRun
      ? createAppContext({ onPtyData: sink.onPtyData, onTaskUpdate: refreshTrayCount })
      : createAppContext({ onTaskUpdate: refreshTrayCount })
  )
  const win = createWindow()

  // v0.5.2 顺序修正：did-finish-load 编排注册前置（不再被托盘 await 阻塞——
  // dev getFileIcon 挂起曾导致 smoke 编排永不注册）；托盘后台初始化
  win.webContents.once('did-finish-load', () => {
    if (!isSmokeRun) return // 正常模式：窗口常驻，无冒烟编排
    // 冒烟全程超时守卫（仅冒烟模式启用；成功路径由编排方清算）
    const guard = setTimeout(() => {
      console.error('[smoke] FAIL: global 60s timeout exceeded')
      app.exit(1)
    }, SMOKE_TIMEOUT_MS)
    setTimeout(() => {
      const flow = INPUT_PROBE_FLAG
        ? runInputProbe(currentCtx, sink)
        : SMOKE_FLAG
        ? runSmoke(currentCtx)
        : RECOVERY === 'a'
          ? runRecoveryPhaseA(currentCtx, sink)
          : runRecoveryPhaseB(currentCtx, sink)
      flow.then(
        () => clearTimeout(guard),
        (err: unknown) => {
          // flow 内部失败路径均已 app.exit(1)；此处兜底未捕获异常
          console.error('[smoke] FAIL: unexpected orchestration error:', err)
          clearTimeout(guard)
          app.exit(1)
        }
      )
    }, RENDERER_SETTLE_MS)
  })

  void (async () => {
    trayHandle = await setupTray({ win, runningCount: () => runningCountOf(currentCtx) })
    trayHandle.setRunningCount(runningCountOf(currentCtx))
  })()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// v0.5⑥：真退出前置标志（close 拦截放行）+ 托盘清理
app.on('before-quit', () => {
  isQuitting = true
  trayHandle?.destroy()
  trayHandle = null
})
