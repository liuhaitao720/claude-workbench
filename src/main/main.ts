import { app, BrowserWindow, Menu } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  broadcastConnectionState,
  broadcastRemoteServerLog,
  createAppContext,
  registerIpcHandlers,
  type AppContext
} from './ipc'
import { CrashLogger } from './crash-log'
import { countLiveRunningTasks } from './running-count'
import { mainLanguage } from './language'
import { resolveClaudeCommand } from './pty-manager'
import { versionProbeCommand } from './platform'
import { initSingleInstance } from './single-instance'
import { createSshConnectionStack } from './ssh'
import { ConnectionError } from './ssh/errors'
import { ConnectionsStore, parseConnectionInput } from './connections-store'
import {
  DEFAULT_SERVER_PORT,
  ensureServer,
  resolveLocalServerPackage
} from './server-installer'
import { attachCloseToTray, setupTray, type TrayHandle } from './tray'
import { migrateLegacyUserData } from './userdata-migrate'

const execFileAsync = promisify(execFile)

/**
 * v1.4.x Linux 等待加成：真实 Linux/VM 下 claude TUI 首字节与渲染回执比 Win 慢
 * （nvm shim + node 冷启动 + Wayland 终端挂载），实测偶发逼近原窗口上限。
 * 回显等待窗口 x1.5（仅放宽等待，不改变判定）；waitForBytes 轮询 200→100ms
 * （同等窗口内多等几次，缩短首字节落地的感知延迟）。Win 保持原值。
 */
const SMOKE_WAIT_SCALE = process.platform === 'win32' ? 1 : 1.5
const smokeWait = (ms: number): number => Math.round(ms * SMOKE_WAIT_SCALE)

/** S4 冒烟全程超时（app 内自守；驱动脚本另设更宽的外层超时兜底） */
const SMOKE_TIMEOUT_MS = smokeWait(60_000)
/** 等待 PTY 首字节/回执的窗口 */
const WAIT_DATA_MS = smokeWait(50_000)
/** renderer did-finish-load 后的缓冲（React mount + initListeners 订阅完成余量） */
const RENDERER_SETTLE_MS = 300
/** 自动升级开始检查的延迟（等窗口/托盘稳定；避免与首屏渲染抢网络与 CPU） */
const AUTO_UPDATE_START_DELAY_MS = 5_000

// ── 启动模式解析（须在 app ready 前） ─────────────────────────────────

const SMOKE_FLAG = process.argv.includes('--smoke')

/** v0.4.3 输入回显取证模式 --smoke-input：真实击键路径（DOM输入事件→xterm→PTY→回显→渲染行）逐层取证 */
const INPUT_PROBE_FLAG = process.argv.includes('--smoke-input')

/** v1.0.8 渲染器探针 --probe-webgl：开真实任务终端后断言 WebGL 渲染器已激活
 *  （.xterm-screen 出现 canvas；DOM 渲染器无 canvas）。中文栅格对齐修复的前置验收。 */
const WEBGL_PROBE_FLAG = process.argv.includes('--probe-webgl')

/** --smoke-recovery[=phase-a|phase-b]：无值默认 phase-a */
function recoveryPhase(): 'a' | 'b' | null {
  const arg = process.argv.find((a) => a === '--smoke-recovery' || a.startsWith('--smoke-recovery='))
  if (!arg) return null
  return arg.endsWith('=phase-b') ? 'b' : 'a'
}

const RECOVERY = recoveryPhase()

/**
 * S8 --smoke-remote[=phase-a|phase-b]：SSH 远程模式端到端冒烟（localhost sshd 全链）。
 * phase-a：连接→server 推送安装→远程项目注册（注册即导入）→createTask 真实 claude
 * →hooks 反向转发 awaiting→击键回显延迟采样→断连冻结→重连 re-attach→app.quit 留
 * 远端 PTY 存活（驱动脚本经独立 ssh 断言）；phase-b：二次启动（normalizeOnStartup
 * 不归一远程 running）→server 侧存活取证→显式 stopTask→远端进程退出→环境清理。
 * 无值默认 phase-a（两相位分属两个进程——app.quit 是相位边界）。
 */
function remoteSmokePhase(): 'a' | 'b' | null {
  const arg = process.argv.find((a) => a === '--smoke-remote' || a.startsWith('--smoke-remote='))
  if (!arg) return null
  return arg.endsWith('=phase-b') ? 'b' : 'a'
}

const REMOTE_SMOKE = remoteSmokePhase()

/** 冒烟编排模式（--smoke 或 --smoke-recovery） */
const isSmokeRun =
  SMOKE_FLAG || RECOVERY !== null || INPUT_PROBE_FLAG || WEBGL_PROBE_FLAG || REMOTE_SMOKE !== null

/** --no-auto-update：显式关闭启动自动升级（打包产物验收探针用——探针进程不该下载/替换自身） */
const NO_AUTO_UPDATE_FLAG = process.argv.includes('--no-auto-update')

/** 测试注入 userData（防污染真实数据目录；须在 ready 前生效） */
const injectedUserData = process.env['CWB_USER_DATA']
if (injectedUserData) {
  app.setPath('userData', injectedUserData)
}

// ── S9 更名 userData 一次性迁移（Claude Workbench → SSH Workbench）─────
// productName 变更改变 userData 目录名；在单实例锁（会在 userData 落锁文件）
// 与任何 store/日志读盘之前执行整目录拷贝，幂等且失败不阻断启动（见
// src/main/userdata-migrate.ts 头注释）。注入态（冒烟/测试）跳过。
migrateLegacyUserData({
  newDir: app.getPath('userData'),
  appDataDir: app.getPath('appData'),
  injected: Boolean(injectedUserData)
})

/**
 * v1.4.2 Linux 渲染节流禁用：VM/GNOME Wayland 下 Chromium 帧回调偶发停滞时，
 * 遮挡/后台节流会把重绘挂起到下一个输入事件（表现为「切换页面不刷新，再点一次
 * 才正常」）。三个开关让 Chromium 在任何可见性判定下都保持主动重绘。
 * CWB_NO_THROTTLE_FIX=1 可关闭本修正（排查用）。
 */
if (process.platform === 'linux' && process.env['CWB_NO_THROTTLE_FIX'] !== '1') {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

/**
 * v1.4.2 CWB_OZONE=x11 可选 XWayland 实验：GNOME Wayland 下 Chromium 帧回调在
 * 突发输入后可能卡死（显示永久慢一拍），X11 路径仅瞬态且自恢复（实测对比）。
 * 但 VM 环境强制 X11 时窗口无法映射（GPU 禁用也救不回），故不设默认——默认仍
 * Wayland 原生；设 CWB_OZONE=x11 时附加 X11 平台并禁用硬件加速。
 */
if (process.platform === 'linux' && process.env['CWB_OZONE'] === 'x11') {
  app.commandLine.appendSwitch('ozone-platform', 'x11')
  app.disableHardwareAcceleration()
}

// ── 单实例锁（v1.0.7；锁键=userData，故在 userData 注入之后） ──────────

/** 主窗口引用（second-instance 唤起用；whenReady/activate 两处创建均回填） */
let mainWindow: BrowserWindow | null = null

const gotSingleLock = initSingleInstance(app, () => mainWindow)

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
      await sleep(100) // v1.4.x 200→100ms：同等窗口内多等几次回显
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

// ── v1.0.8 渲染器探针：断言 WebGL 渲染器在真机激活（中文栅格对齐的前置验收）──

/** WebglAddon 把渲染 canvas 挂在 .xterm-screen 内；DOM 渲染器只用 div 行，无 canvas */
async function runWebglProbe(ctx: AppContext): Promise<void> {
  const projectDir = join(app.getPath('userData'), 'webgl-probe-project')
  mkdirSync(projectDir, { recursive: true })
  const project = await ctx.addProject(projectDir)
  const task = await ctx.createTask(project.id, 'webgl-probe', { isolation: 'shared' })
  console.log('[probe] task created:', task.id)

  const deadline = Date.now() + WAIT_DATA_MS
  while (Date.now() < deadline && ctx.smokeReports.length === 0) await sleep(200)
  if (ctx.smokeReports.length === 0) smokeFail('no renderer report (terminal not rendering)')

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) smokeFail('no window for webgl probe')
  // 探针环境补全：同 input-probe 先例——main 侧建任务，renderer store 无 tab，经测试钩子开
  const opened = String(
    await win.webContents.executeJavaScript(
      "(function(){var t=window.__cwbTest;if(!t||!t.openTask)return 'NO-TEST-HOOK';t.openTask(" +
        JSON.stringify(task.id) +
        ");return 'OPENED'})()"
    )
  )
  if (opened !== 'OPENED') smokeFail(`open task hook: ${opened}`)
  await sleep(3000) // 终端挂载 + WebglAddon 激活 + 首帧绘制

  const webglActive = String(
    await win.webContents.executeJavaScript(
      "Boolean(document.querySelector('.term-host-active .xterm-screen canvas'))"
    )
  )
  console.log(`[probe] webgl canvas present: ${webglActive}`)
  if (webglActive !== 'true') {
    console.error('[probe] WEBGL-DOM-FALLBACK（渲染回落 DOM——中文对齐/性能修复受限，查 console.info 降级原因）')
    app.exit(2)
    return
  }
  console.log('[probe] WEBGL-OK')
  app.exit(0)
}

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
    const dialogReady = await waitForRows(/type something|chat about/i, smokeWait(30_000), 'welcome dialog (type something / chat about)')
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
    const inputReady = await waitForRows(/❯/, smokeWait(30_000), 'input line (❯) after dialog submit')
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
    // v1.3：探测命令形态按平台分流（win cmd.exe /c 包装、linux 直跑）——失败不致命
    const probe = versionProbeCommand(claudeCmd)
    const { stdout } = await execFileAsync(probe.file, probe.args, { timeout: 20_000 })
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

// ── ⑥ --smoke-remote：SSH 远程模式端到端（S8）───────────────────────

/** 远端（=本机 localhost）项目目录与种子会话（phase-a 预置、phase-b 清理） */
const RS_PROJECT_DIR = '/tmp/cwb-smoke-remote-proj'
const RS_SESSION_DIR = join(homedir(), '.claude', 'projects', '-tmp-cwb-smoke-remote-proj')
const RS_SESSION_FILE = 'smoke8a1-0000-4000-8000-000000000001.jsonl'
const RS_KEY_COMMENT = 'cwb-smoke-remote'

/** 冒烟工作目录（密钥/连接档案标记/seed-created 旗标——userData 隔离区内） */
const rsWorkDir = (): string => join(app.getPath('userData'), 'smoke-remote')

/** authorized_keys 的 marker 行（phase 追加/清理均以本行定位——并发测试纪律） */
const rsMarkerLine = (): string => `# ${RS_KEY_COMMENT} ${rsWorkDir()}/`

/** 临时密钥对 + authorized_keys 追加（marker+key 两行）；返回私钥路径 */
function rsMakeKeyPair(): string {
  const dir = rsWorkDir()
  mkdirSync(dir, { recursive: true })
  const keyPath = join(dir, 'id_ed25519')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', RS_KEY_COMMENT], {
    stdio: 'ignore'
  })
  const akPath = join(homedir(), '.ssh', 'authorized_keys')
  const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim()
  appendFileSync(akPath, `${rsMarkerLine()}\n${pub}\n`)
  return keyPath
}

/** authorized_keys surgical 删除（marker+key 两行，可能多次运行累积——循环全清）+ 行数复核日志 */
function rsRemoveAuthorizedKey(): void {
  const akPath = join(homedir(), '.ssh', 'authorized_keys')
  const lines = readFileSync(akPath, 'utf8').split('\n')
  let removed = 0
  for (let idx = lines.findIndex((l) => l === rsMarkerLine()); idx >= 0; idx = lines.findIndex((l) => l === rsMarkerLine())) {
    lines.splice(idx, 2)
    removed++
  }
  if (removed === 0) {
    console.log('[smoke-remote] authorized_keys marker 不在（可能已清理）')
    return
  }
  writeFileSync(akPath, lines.join('\n'))
  const remaining = readFileSync(akPath, 'utf8').split('\n').filter((l) => l !== '').length
  console.log(`[smoke-remote] authorized_keys 已 surgical 清理 ${removed} 组，剩余非空行 ${remaining}`)
  if (remaining < 1) console.error('[smoke-remote] WARN: authorized_keys 清空（异常——复核用户自身公钥）')
}

/** 远端项目目录 + 种子会话（注册即导入的断言依据）；返回是否新建了种子目录 */
function rsSeedRemoteProject(): boolean {
  if (!existsSync(join(RS_PROJECT_DIR, '.git'))) {
    mkdirSync(RS_PROJECT_DIR, { recursive: true })
    execFileSync('git', ['-C', RS_PROJECT_DIR, 'init'], { stdio: 'ignore' })
  }
  if (existsSync(RS_SESSION_DIR)) return false
  mkdirSync(RS_SESSION_DIR, { recursive: true })
  writeFileSync(
    join(RS_SESSION_DIR, RS_SESSION_FILE),
    [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"S8 远程冒烟种子会话"}]},"timestamp":"2026-11-10T08:00:00.000Z"}',
      '{"type":"ai-title","aiTitle":"S8 冒烟种子"}',
      '{"type":"assistant","message":{"role":"assistant","content":[]},"timestamp":"2026-11-10T08:00:01.000Z"}'
    ].join('\n') + '\n'
  )
  return true
}

/** 连接档案落盘（与 ctx.connection 同源的 userData/connections.json——store 逐次读盘） */
function rsSaveProfile(keyPath: string): { id: string; fingerprintLock: (fp: string) => void } {
  const store = new ConnectionsStore(app.getPath('userData'))
  const parsed = parseConnectionInput('zh', {
    name: 'smoke-remote',
    host: '127.0.0.1',
    port: 22,
    user: process.env['USER'] ?? 'nobody',
    authMethod: 'key',
    keyPath
  })
  const record = store.save(parsed.record)
  return { id: record.id, fingerprintLock: (fp) => store.save({ ...record, lastHostKeyFingerprint: fp }) }
}

/** 连接 + TOFU 两步锁定（首连 hostKeyConfirm → 档案锁指纹 → 二连通过） */
async function rsConnect(ctx: AppContext, connectionId: string, lockFingerprint: (fp: string) => void): Promise<void> {
  try {
    await ctx.connection.connect(connectionId)
  } catch (err) {
    if (
      err instanceof ConnectionError &&
      err.kind === 'hostKeyConfirm' &&
      err.hostKeyFingerprint !== undefined
    ) {
      console.log(`[smoke-remote] TOFU 首连待确认（${err.hostKeyFingerprint}）→ 锁定后二连`)
      lockFingerprint(err.hostKeyFingerprint)
      await ctx.connection.connect(connectionId)
    } else {
      throw err
    }
  }
  if (ctx.connection.getState(connectionId) !== 'connected') {
    smokeFail(`connect 后状态非 connected: ${ctx.connection.getState(connectionId)}`)
  }
}

/** 轮询直到条件满足（超时 smokeFail） */
async function rsWaitFor(what: string, timeoutMs: number, pred: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(100)
  }
  smokeFail(`等待超时: ${what} (${timeoutMs}ms)`)
}

/** ANSI 剥离（终端原始字节 → 可读文本；信任对话框选中态判定用） */
const rsAnsiStrip = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

/**
 * 信任对话框处置：claude 首次打开 git 目录显示 folder trust 对话框且默认选中
 * 「No, exit」——直接采样击键无回显、误按 Enter 会退出。Down 切到「Yes, I trust
 * this folder」（校验选中标记 ❯ 落在 Yes——防默认序变化误选）→ Enter 进入工作区
 * → 等待输入框就绪后再采样。
 */
async function rsDismissTrustDialog(ctx: AppContext, sink: PtyByteSink, taskId: string): Promise<void> {
  const byteLen = (): number => Buffer.byteLength(sink.bytes(taskId), 'utf8')
  // Ink 渲染用光标移动序列代替空格分词——剥离 ANSI 后再折叠全部空白再匹配
  const tailText = (): string => rsAnsiStrip(sink.bytes(taskId)).replace(/\s+/g, '').slice(-500)
  // 信任态按项目目录记忆（~/.claude.json）：已信任过的目录跳过对话框直达输入框
  // ——首跑与复跑两种形态都接受（等首屏字节，3s 内无 trust 字样即视为已信任）
  const deadline = Date.now() + smokeWait(10_000)
  while (Date.now() < deadline && !/trustthisfolder/i.test(tailText())) await sleep(200)
  if (!/trustthisfolder/i.test(tailText())) {
    console.log('[smoke-remote] 目录已信任（复跑形态）——无信任对话框')
    await rsWaitScreenSettled(sink, taskId)
    return
  }
  for (let i = 0; i < 2; i++) {
    if (/❯Yes/i.test(tailText())) break
    const before = byteLen()
    ctx.pty.write(taskId, '\x1b[B') // Down：选中下移一项
    const waitRedraw = Date.now() + smokeWait(3_000)
    while (Date.now() < waitRedraw && byteLen() <= before) await sleep(50)
  }
  if (!/❯Yes/i.test(tailText())) {
    smokeFail(`信任对话框选中态未到 Yes（tail=${JSON.stringify(tailText().slice(-200))}）`)
  }
  ctx.pty.write(taskId, '\r') // Enter：信任并进入工作区
  await rsWaitScreenSettled(sink, taskId)
  console.log('[smoke-remote] 信任对话框已确认（Down→Yes→Enter），工作区就绪')
}

/** 等首屏动画/工作区准备收敛（1.5s 无新字节即认为静息；下限 2s 上限 15s） */
async function rsWaitScreenSettled(sink: PtyByteSink, taskId: string): Promise<void> {
  const byteLen = (): number => Buffer.byteLength(sink.bytes(taskId), 'utf8')
  await sleep(2_000)
  const deadline = Date.now() + smokeWait(13_000)
  let last = byteLen()
  let lastAt = Date.now()
  while (Date.now() < deadline) {
    await sleep(250)
    const now = byteLen()
    if (now > last) {
      last = now
      lastAt = Date.now()
    } else if (Date.now() - lastAt >= 1_500) {
      return // 静息 1.5s——输入框就绪
    }
  }
  console.log('[smoke-remote] WARN: 首屏 15s 未完全静息（继续采样——按实际回显计数）')
}

/** 击键→回显延迟采样（O7 显式边界：localhost 上限基线） */
async function rsLatencySamples(
  ctx: AppContext,
  sink: PtyByteSink,
  taskId: string,
  attempts: number
): Promise<void> {
  const byteLen = (): number => Buffer.byteLength(sink.bytes(taskId), 'utf8')
  const samples: number[] = []
  let misses = 0
  for (let i = 0; i < attempts; i++) {
    const before = byteLen()
    const t0 = Date.now()
    // 纯可见字符（不回删）：每键必然扩展输入框文本 → TUI 重绘字节（实测 \x7f 退格
    // 在 claude TUI 的 Ink diff 下常零输出——只采必然回显的键；绝不发 Enter）
    ctx.pty.write(taskId, 'x')
    const deadline = Date.now() + smokeWait(5_000)
    while (Date.now() < deadline && byteLen() <= before) await sleep(30)
    if (byteLen() > before) samples.push(Date.now() - t0)
    else misses++
    await sleep(250)
  }
  const pct = (q: number): number => {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? -1
  }
  console.log(
    `[smoke-remote] 延迟采样（击键→首字节回显，localhost）：n=${samples.length}/${attempts} ` +
      `miss=${misses} P50=${pct(0.5)}ms P95=${pct(0.95)}ms P99=${pct(0.99)}ms ` +
      `max=${Math.max(...samples, -1)}ms`
  )
  console.log(
    '[smoke-remote] O7 边界：以上为 localhost 环回上限基线（本机回显微秒~毫秒级）；' +
      '真实 Windows 客户端↔VM 链路指标含 SSH 隧道与物理网络往返，须 Windows 侧实测，本环境不伪造结论。'
  )
  if (samples.length < 20) smokeFail(`延迟采样成功数 ${samples.length} < 20（miss=${misses}）`)
}

/** phase-a：全链主相位（以 app.quit 结束——PTY 留远端保活，退出码 0） */
async function runSmokeRemoteA(ctx: AppContext, sink: PtyByteSink): Promise<void> {
  console.log('[smoke-remote] phase-a start（CWB_USER_DATA 隔离 + 本机 sshd 真链）')
  // 1) 环境预置：密钥对/authorized_keys marker、远端项目+种子会话、连接档案
  const keyPath = rsMakeKeyPair()
  const seedCreated = rsSeedRemoteProject()
  if (seedCreated) writeFileSync(join(rsWorkDir(), 'seed-created'), '1')
  const profile = rsSaveProfile(keyPath)
  const cid = profile.id
  console.log(`[smoke-remote] profile=${cid} key=${keyPath} seedSession=${seedCreated}`)

  // 2) 连接（TOFU 两步）+ server 推送安装（check=needInstall → install=installed）
  await rsConnect(ctx, cid, profile.fingerprintLock)
  console.log('[smoke-remote] SSH connected（真实 sshd + key 认证 + 自检通过）')
  const pkg = resolveLocalServerPackage()
  const serverHome = join(rsWorkDir(), 'server-home')
  const installOpts = {
    serverHome,
    port: DEFAULT_SERVER_PORT,
    healthAttempts: 8,
    healthIntervalMs: 3_000,
    localPackage: pkg,
    onProgress: (p: { stage: string; message: string }): void => {
      console.log(`[smoke-remote] install[${p.stage}] ${p.message}`)
    }
  }
  const check1 = await ensureServer(ctx.connection, cid, { ...installOpts, mode: 'check' })
  console.log(`[smoke-remote] ensureServer check → ${JSON.stringify(check1)}`)
  if (!(check1.ok === false && check1.reason === 'needInstall')) {
    smokeFail(`全新环境 check 应为 needInstall，实得 ${JSON.stringify(check1)}`)
  }
  const install = await ensureServer(ctx.connection, cid, { ...installOpts, mode: 'install' })
  if (!install.ok) smokeFail(`server 安装失败: ${JSON.stringify(install)}`)
  console.log(`[smoke-remote] ensureServer install → ${JSON.stringify(install)}（tgz=release/server-dist 现产物）`)
  await ctx.remotePty.ensureConnected(cid)
  console.log('[smoke-remote] server WS 隧道 + 协议 ping 通过（ensureConnected）')

  // 3) 远程项目注册：注册即导入（种子会话 ≥1）
  const project = await ctx.addProject(RS_PROJECT_DIR, cid)
  if (project.connectionId !== cid || !project.isGit) {
    smokeFail(`注册形态异常: ${JSON.stringify(project)}`)
  }
  const imported = ctx.tasks.list(project.id)
  console.log(`[smoke-remote] 注册即导入：${imported.length} 条（isGit=${project.isGit}）`)
  if (imported.length < 1) smokeFail('注册即导入断言失败（任务数 < 1）')

  // 4) createTask：真实 claude 经 SSH spawn，--settings hooks 生效（SFTP 落 VM）
  const task = await ctx.createTask(project.id, 'smoke-remote-task', { isolation: 'shared' })
  console.log(`[smoke-remote] task created: ${task.id}（真实 claude @ ${task.cwd}）`)
  await sink.waitForBytes(task.id, 1, WAIT_DATA_MS)
  console.log(`[smoke-remote] PTY 首字节已回流（累计 ${Buffer.byteLength(sink.bytes(task.id), 'utf8')}B）`)
  const hookPort = await ctx.remotePty.hookPortFor(cid)
  const settingsCat = await ctx.connection.exec(
    cid,
    `cat "$HOME/.cwb-server/task-settings/${task.id}.json"`
  )
  const expectedUrl = `http://127.0.0.1:${hookPort}/hook/PermissionRequest?e=1&t=${task.id}`
  if (!settingsCat.stdout.includes(expectedUrl)) {
    smokeFail(`远端 settings 缺 hooks URL（期望含 ${expectedUrl}）: ${settingsCat.stdout.slice(0, 300)}`)
  }
  console.log(`[smoke-remote] --settings hooks 已落 VM（URL base=forwardIn:${hookPort}）`)

  // 5) PermissionRequest 事件回流断言 awaiting（VM 侧→forwardIn 隧道→接收端→裁决）
  const post = await fetch(
    `http://127.0.0.1:${hookPort}/hook/PermissionRequest?e=1&t=${task.id}`,
    { method: 'POST', body: '{}' }
  )
  console.log(`[smoke-remote] VM 侧 PermissionRequest POST → HTTP ${post.status}`)
  if (post.status !== 200) smokeFail(`PermissionRequest POST 状态 ${post.status}`)
  await rsWaitFor('PermissionRequest → awaiting', smokeWait(10_000), () => ctx.activity.current(task.id) === 'awaiting')
  console.log(`[smoke-remote] 事件回流裁决 awaiting（activity=${ctx.activity.current(task.id)}）`)

  // 6) 信任对话框处置 + 击键→回显延迟采样（≥20 有效样本）
  await rsDismissTrustDialog(ctx, sink, task.id)
  await rsLatencySamples(ctx, sink, task.id, 24)

  // 7) 断开 → 冻结态（记录/注册表保持 running 语义）
  await ctx.connection.disconnect(cid)
  await rsWaitFor('disconnect → offline', smokeWait(5_000), () => ctx.connection.getState(cid) === 'offline')
  const frozenTask = ctx.tasks.get(task.id)
  if (frozenTask?.status !== 'running' || !ctx.pty.isRunning(task.id)) {
    smokeFail(`冻结态异常: status=${frozenTask?.status} isRunning=${ctx.pty.isRunning(task.id)}`)
  }
  console.log('[smoke-remote] 断连冻结：state=offline task=running(isRunning=true)')

  // 8) 重连 → re-attach → 收到数据（attach 的 resize toggle 逼重绘；无输出则显式 toggle）
  await ctx.connection.connect(cid)
  await rsWaitFor('重连 → connected', smokeWait(30_000), () => ctx.connection.getState(cid) === 'connected')
  const bytesBeforeReattach = Buffer.byteLength(sink.bytes(task.id), 'utf8')
  let via = ''
  try {
    await rsWaitFor('re-attach 自动重绘字节', smokeWait(15_000), () =>
      Buffer.byteLength(sink.bytes(task.id), 'utf8') > bytesBeforeReattach
    )
    via = 'attach 自动重绘'
  } catch {
    // toggle 兜底（S3 语义：同尺寸 resize 是 no-op，±1 强制 SIGWINCH）
    const size = ctx.pty.currentSize(task.id) ?? { cols: 80, rows: 24 }
    ctx.pty.resize(task.id, size.cols + 1, size.rows)
    ctx.pty.resize(task.id, size.cols, size.rows)
    await rsWaitFor('toggle 重绘字节', smokeWait(15_000), () =>
      Buffer.byteLength(sink.bytes(task.id), 'utf8') > bytesBeforeReattach
    )
    via = '显式 toggle'
  }
  console.log(
    `[smoke-remote] 重连 re-attach（${via}）：新增 ` +
      `${Buffer.byteLength(sink.bytes(task.id), 'utf8') - bytesBeforeReattach}B`
  )

  // 9) 客户端仍在线时远端 PTY 存活取证（pid 打点——驱动脚本在 app.quit 后独立复核）
  const pid = ctx.pty.pid(task.id)
  console.log(`SMOKE-REMOTE-PTY-PID ${pid ?? 'unknown'}`)
  if (pid !== undefined) {
    const ps = await ctx.connection.exec(cid, `ps -o args= -p ${pid}`)
    if (!ps.stdout.includes('claude')) smokeFail(`远端 PTY 进程形态异常: ${JSON.stringify(ps.stdout)}`)
    console.log(`[smoke-remote] 远端 PTY 存活（ps: ${ps.stdout.trim().slice(0, 120)}）`)
  }
  console.log('[smoke-remote] phase-a OK — app.quit()（远端 PTY 由 cwb-server 保活，请驱动脚本独立复核后跑 phase-b）')
  app.quit()
}

/** phase-b：重启相位（normalizeOnStartup 不归一远程 running）+ 显式停止 + 环境清理 */
async function runSmokeRemoteB(ctx: AppContext): Promise<void> {
  console.log('[smoke-remote] phase-b start（二次启动——重启相位模拟）')
  // 1) 重启归一分流断言：远程 running 保留（5.9=b），不归一为 stopped
  const all = ctx.tasks.list()
  const projects = ctx.projects.list()
  const remoteRunning = all.filter((t) => {
    const cid = projects.find((p) => p.id === t.projectId)?.connectionId
    return cid !== undefined && cid !== '' && t.status === 'running'
  })
  if (remoteRunning.length !== 1) {
    smokeFail(`重启后远程 running 任务数异常（期望 1，实得 ${remoteRunning.length}）: ${JSON.stringify(all.map((t) => [t.id, t.status]))}`)
  }
  const task = remoteRunning[0]
  const cid = projects.find((p) => p.id === task.projectId)?.connectionId ?? ''
  console.log(`[smoke-remote] normalizeOnStartup 分流生效：${task.id} 保持 running（其余 ${all.length - remoteRunning.length} 条保持原状，其中 stopped=${all.filter((t) => t.status === 'stopped').length}——导入的种子会话任务）`)

  // 2) 重连（档案/指纹/密钥均持久化——无 TOFU）+ 协议 ping
  await ctx.connection.connect(cid)
  await rsWaitFor('重连 → connected', smokeWait(30_000), () => ctx.connection.getState(cid) === 'connected')
  await ctx.remotePty.ensureConnected(cid)
  console.log('[smoke-remote] 二次连接 + ensureConnected 通过（持久化档案免 TOFU）')

  // 3) server 侧存活取证：task.list 对账 + ps（客户端已退出过一次——5.9=b 跨退出保活）
  const list = (await ctx.remotePty.managerFor(cid).request<Array<{ taskId?: unknown; pid?: unknown }>>({
    type: 'task.list'
  })) ?? []
  const alive = list.find((s) => typeof s === 'object' && s?.['taskId'] === task.id)
  if (alive === undefined) smokeFail(`server 侧无该任务（保活失败）: ${JSON.stringify(list)}`)
  const pid = typeof alive?.['pid'] === 'number' ? alive['pid'] : undefined
  console.log(`[smoke-remote] server 保活对账：task.list 含 ${task.id}（pid=${pid}）`)
  if (pid !== undefined) {
    const ps = await ctx.connection.exec(cid, `ps -o args= -p ${pid}`)
    if (!ps.stdout.includes('claude')) smokeFail(`跨客户端退出的远端 PTY 不存活: ${JSON.stringify(ps)}`)
    console.log('[smoke-remote] 客户端退出后远端 PTY 仍存活（ssh exec ps 取证）')
  }

  // 4) 显式 stopTask → 远端进程退出
  await ctx.stopTask(task.id)
  await rsWaitFor('stopTask → tasks.json stopped', smokeWait(10_000), () => ctx.tasks.get(task.id)?.status === 'stopped')
  if (ctx.pty.isRunning(task.id)) {
    await rsWaitFor('远端 PTY 退出（注册表清空）', smokeWait(15_000), () => !ctx.pty.isRunning(task.id))
  }
  console.log('[smoke-remote] stopTask 生效：任务记录 stopped + 远端注册表已清')
  if (pid !== undefined) {
    const deadline = Date.now() + smokeWait(15_000)
    let psOut = ''
    while (Date.now() < deadline) {
      const ps = await ctx.connection.exec(cid, `ps -o args= -p ${pid}`)
      psOut = ps.stdout
      if (!ps.stdout.includes('claude')) break
      await sleep(300)
    }
    if (psOut.includes('claude')) smokeFail(`远端进程 ${pid} 未随 task.kill 退出: ${psOut}`)
    console.log(`[smoke-remote] 远端进程 ${pid} 已随显式 stopTask 退出（ps 空）`)
  }

  // 5) 环境清理：远端 server 停止/目录、种子会话、task-settings 文件、authorized_keys
  //    （路径全部受控——serverHome=固定 userData 子目录、RS_SESSION_DIR=常量、
  //    task.id=uuid；仍按远端命令惯例单引号包裹）
  const serverHome = join(rsWorkDir(), 'server-home')
  const rq = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`
  await ctx.connection.exec(cid, `kill $(cat ${rq(serverHome)}/server.pid) 2>/dev/null; rm -rf ${rq(serverHome)}`)
  await ctx.connection.exec(cid, `rm -f "$HOME"/.cwb-server/task-settings/${rq(task.id)}.json`)
  if (existsSync(join(rsWorkDir(), 'seed-created'))) {
    await ctx.connection.exec(cid, `rm -rf ${rq(RS_SESSION_DIR)}`)
    console.log('[smoke-remote] 种子会话目录已清（phase-a 创建）')
  }
  await ctx.connection.disconnect(cid)
  rsRemoveAuthorizedKey()
  console.log('[smoke-remote] phase-b OK')
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

  await sink.waitForBytes(task.id, 1, smokeWait(10_000))
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

  await sink.waitForBytes(task.id, 1, smokeWait(10_000))
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
/** v0.9⑧：组合根引用（createWindow 时尚未创建——close 分流惰性读取；类型 AppContext 见下方 import） */
let currentCtx: AppContext | null = null

/**
 * v1.1.0 退出/崩溃取证：用户报告「点更新后突然退出」而事件日志无记录——只记
 * 元数据（事件/来源/退出码），不记终端内容；文件 userData/cwb-crash.log。
 */
const crashLog = new CrashLogger(join(app.getPath('userData'), 'cwb-crash.log'))

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
  // v0.9⑧：关闭按钮行为按设置分流（托盘常驻/直接退出）
  attachCloseToTray(win, () => isQuitting, () => currentCtx?.appSettings.get().closeToTray !== false)

  // v1.1.0 渲染进程崩溃取证：主进程默认不断言（实测崩溃后仍存活），但用户视角
  // 是"窗口消失=应用没了"。记录事件供诊断；托盘常驻下应用仍可从托盘恢复。
  win.webContents.on('render-process-gone', (_e, details) => {
    crashLog.log({
      event: 'render-process-gone',
      detail: `reason=${details.reason} exitCode=${details.exitCode}`
    })
  })
  win.webContents.on('unresponsive', () => {
    crashLog.log({ event: 'renderer-unresponsive' })
  })

  // v1.0.8 链接安全兜底：终端输出里的链接（WebLinksAddon 默认 handler 走 window.open）不得
  // 在应用内开新窗口/导航——deny 全部 window.open（合法链接走 openExternal→系统浏览器），
  // will-navigate 一并拦截（SPA 无导航，任何导航都是异常注入）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

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
  const smokeQuery = SMOKE_FLAG || INPUT_PROBE_FLAG || WEBGL_PROBE_FLAG
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

/**
 * 运行任务数（托盘 tooltip/退出确认的真值源）。
 * v1.1.0 加固：不只信 tasks.json 的 status==='running'，还要求 PTY 句柄确实存活——
 * 异常退出/崩溃残留的「幽灵 running」记录不该让用户看到「仍有任务在运行」。
 */
const runningCountOf = (ctx: AppContext | null): number =>
  ctx === null ? 0 : countLiveRunningTasks(ctx.tasks.list(), (id) => ctx.pty.isRunning(id))

app.whenReady().then(async () => {
  if (!gotSingleLock) return // v1.0.7 第二实例：不建窗口/托盘，等 initSingleInstance 的 exit(0) 生效
  crashLog.log({ event: 'app-ready', detail: `version=${app.getVersion()} pid=${process.pid}` })
  // v1.1.0 未捕获异常取证（异常导致进程退出时留下最后一笔）
  process.on('uncaughtException', (err) => {
    crashLog.log({ event: 'uncaughtException', detail: err?.stack ?? String(err) })
  })
  process.on('unhandledRejection', (reason) => {
    crashLog.log({ event: 'unhandledRejection', detail: String(reason) })
  })
  // v0.5.2 用户指令：移除原生菜单栏（File/Edit/View/Window）——win 上 autoHideMenuBar 兜底
  Menu.setApplicationMenu(null)
  // v0.5⑥ 托盘 tooltip 刷新：任务记录每次变更（含状态迁移）旁路回调（同 onPtyData 注入缝先例）
  const refreshTrayCount = (): void => trayHandle?.setRunningCount(runningCountOf(currentCtx))
  // v1.2.0 语言变更：托盘菜单/退出确认文案随 AppSettings.language 刷新
  // （appSettings 变更已写入 language.ts 的进程级语言，这里只需令托盘重建菜单）
  const syncTrayLanguage = (): void => trayHandle?.setLanguage(mainLanguage())
  currentCtx = registerIpcHandlers(
    isSmokeRun
      ? createAppContext({
          // SSH 远程连接（S2 实装）：RealConnectionManager（ssh2）+ 事件挂钩——
          // ConnectionStateChanged/RemoteServerLog 经 ipc broadcast 外送（A2 权属）
          connection: createSshConnectionStack({
            baseDir: app.getPath('userData'),
            onStateChange: broadcastConnectionState,
            onLog: broadcastRemoteServerLog
          }),
          onPtyData: sink.onPtyData,
          onTaskUpdate: refreshTrayCount,
          onSettingsChange: syncTrayLanguage
        })
      : createAppContext({
          connection: createSshConnectionStack({
            baseDir: app.getPath('userData'),
            onStateChange: broadcastConnectionState,
            onLog: broadcastRemoteServerLog
          }),
          onTaskUpdate: refreshTrayCount,
          onSettingsChange: syncTrayLanguage
        })
  )
  const win = createWindow()
  mainWindow = win // v1.0.7 second-instance 唤起锚点

  // v0.5.2 顺序修正：did-finish-load 编排注册前置（不再被托盘 await 阻塞——
  // dev getFileIcon 挂起曾导致 smoke 编排永不注册）；托盘后台初始化
  win.webContents.once('did-finish-load', () => {
    if (!isSmokeRun) return // 正常模式：窗口常驻，无冒烟编排
    // 冒烟全程超时守卫（仅冒烟模式启用；成功路径由编排方清算）。
    // --smoke-remote 全链含 server 推送安装/真实 claude/断连重连，窗口按相位放宽
    const guardMs = REMOTE_SMOKE === null ? SMOKE_TIMEOUT_MS : REMOTE_SMOKE === 'a' ? smokeWait(300_000) : smokeWait(180_000)
    const guard = setTimeout(() => {
      console.error(`[smoke] FAIL: global ${guardMs}ms timeout exceeded`)
      app.exit(1)
    }, guardMs)
    setTimeout(() => {
      const flow = REMOTE_SMOKE !== null
        ? REMOTE_SMOKE === 'a'
          ? runSmokeRemoteA(currentCtx!, sink)
          : runSmokeRemoteB(currentCtx!)
        : WEBGL_PROBE_FLAG
        ? runWebglProbe(currentCtx!)
        : INPUT_PROBE_FLAG
        ? runInputProbe(currentCtx!, sink)
        : SMOKE_FLAG
        ? runSmoke(currentCtx!)
        : RECOVERY === 'a'
          ? runRecoveryPhaseA(currentCtx!, sink)
          : runRecoveryPhaseB(currentCtx!, sink)
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
    trayHandle = await setupTray({
      win,
      runningCount: () => runningCountOf(currentCtx),
      language: mainLanguage,
      markQuitOrigin: () => crashLog.markOrigin('tray-quit')
    })
    trayHandle.setRunningCount(runningCountOf(currentCtx))
  })()

  // v1.2.1 自动升级：正常模式启动即检查 → 有新版本后台下载 → 无运行任务（且过启动宽限期）
  // 自动退出替换重启，全程无需点按钮；冒烟/探针模式不触网
  if (!isSmokeRun) {
    win.webContents.once('did-finish-load', () => {
      if (NO_AUTO_UPDATE_FLAG) return
      setTimeout(() => void currentCtx?.appUpdate.runAutoUpdate(), AUTO_UPDATE_START_DELAY_MS)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  // v1.1.0 托盘驻留修正：closeToTray=true 时窗口消失不得退出应用（用户看不到任何
  // 提示就"突然退出"）——用户在托盘/设置里明确选过"最小化到托盘"，语义是应用常驻。
  // 只有 ①真退出流程中（isQuitting）或 ②设置=直接退出 时才 quit。
  if (process.platform === 'darwin') return
  if (isQuitting) return
  if (currentCtx?.appSettings.get().closeToTray !== false) {
    crashLog.log({ event: 'window-all-closed', detail: '托盘驻留：保持进程存活，等待用户从托盘恢复' })
    return
  }
  crashLog.markOrigin('window-all-closed')
  app.quit()
})

// v0.5⑥：真退出前置标志（close 拦截放行）+ 托盘清理
/** v1.0.3：真退出前已清理标记（before-quit 二段式——先杀树再放行） */
let quitCleanupDone = false

app.on('before-quit', (event) => {
  isQuitting = true
  trayHandle?.destroy()
  trayHandle = null
  crashLog.log({ event: 'before-quit', origin: crashLog.origin() || 'unknown' })
  // v1.0.3 退出目录锁修复：PTY 子进程树（cmd.exe→claude→node、ConPTY OpenConsole.exe）
  // 不随主进程退出而亡，残留句柄锁死 exe 所在目录与项目/worktree 目录（实测 win-unpacked
  // 无法删除的根因）。二段式退出：先 taskkill /T /F 定点杀树（记录的 pid，非枚举），
  // 再放行真退出。
  if (quitCleanupDone) return
  event.preventDefault()
  quitCleanupDone = true
  try {
    currentCtx?.pty.killAllTrees()
    currentCtx?.cli.killAllTrees()
  } catch {
    // 杀进程失败不阻断退出（残留风险低于无法退出）
  }
  setImmediate(() => app.quit())
})
