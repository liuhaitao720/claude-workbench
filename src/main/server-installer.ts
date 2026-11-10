/**
 * S7 cwb-server 交付与升级（design-ssh-remote §4-S7 / 6.7=a 首连推送 / O6 ABI 兜底）。
 *
 * 职责（main 侧；确认弹窗 UI=S6，消费 installRemoteServer promise 形态）：
 * - probeServerVersion：经 SSH exec 的回环 HTTP 探测（bash /dev/tcp——零外部依赖、
 *   不依赖 AllowTcpForwarding、不泄漏 forwardOut 监听），供 S2 自检 server 项（S4 接线）
 *   与 ensureServer 复用；
 * - ensureServer：
 *     check 模式（默认）＝只读：版本一致=ok / 旧版=needUpgrade（不自动升级，UI 决策）
 *     / 探活不通且远端目录不存在=needInstall（[cwb:need-server-install] token 约定）
 *     / 探活不通但目录在=notRunning + 启动失败诊断（node 路径/日志尾部）；
 *     install 模式（ServerInstall 通道，用户确认后）＝推送安装/升级全流程：
 *     SFTP 上传 tgz → sha256 校验 → 解压 → nohup 启动（nvm PATH 墙：注入 bash -ic
 *     解析出的 node 绝对路径）→ 轮询探活 → current 指针 + 旧版本清理（保留 2）。
 *
 * 远端布局（home 默认 ~/.cwb-server；opts.serverHome 覆写——测试/多实例）：
 *   versions/<v>/{package.json,dist/main.cjs,node_modules}   版本目录
 *   current        指针文件（内容=版本串）
 *   server.pid     启动命令写入的 PID（优雅停机/诊断用）
 *   server.log     nohup stdout/stderr 追加（server 侧仅元数据日志，8.1=A）
 *
 * 安全口径（enterprise-secure-dev）：
 * - 远端命令的全部路径/参数逐个 POSIX 单引号包裹；远端 HTTP 响应的 version 字段
 *   白名单校验后才可进入命令行（防注入）；进度/诊断文本脱敏截断，不含凭据。
 * - tgz 上传后远端 sha256sum 与 manifest 比对（防传输损坏/篡改）再解压执行。
 * - O6：tgz 绑定构建机 node ABI；启动失败诊断含日志尾部——命中 NODE_MODULE_VERSION
 *   时给出 VM 内 node-gyp rebuild 指引。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SftpSession, SshExecResult } from './ssh/connection-manager'

/** S4 connect 流 needInstall 判定用的错误消息 token（契约 v2.2 约定，S4 接线消费） */
export const NEED_SERVER_INSTALL_TOKEN = '[cwb:need-server-install]'

/** 与客户端约定的 cwb-server 固定口（server/src/cwb-server.ts DEFAULT_PORT 同源） */
export const DEFAULT_SERVER_PORT = 17_717

/** 远端 home 下的固定子目录/文件名 */
const REMOTE_DIR = '.cwb-server'

/** npm ci 产物清单（tools/build-server.mjs 同源常量） */
export interface ServerPackageManifest {
  version: string
  file: string
  sha256: string
  sizeBytes: number
  fileCount: number
  nodeVersion?: string
  nodeAbi?: string
  builtAt?: string
}

export interface LocalServerPackage {
  manifest: ServerPackageManifest
  /** tgz 绝对路径（manifest.file 与其同目录） */
  tgzPath: string
}

/** ensureServer 所需的连接能力（ConnectionManager 结构子集——便于 S4/测试注入） */
export interface ServerInstallTransport {
  exec(connectionId: string, command: string, opts?: { cwd?: string }): Promise<SshExecResult>
  sftp(connectionId: string): Promise<SftpSession>
}

export type ServerInstallStage = 'probe' | 'upload' | 'extract' | 'start' | 'health' | 'done' | 'info' | 'error'

export interface ServerInstallProgressEvent {
  stage: ServerInstallStage
  /** 脱敏文本（路径/版本/字节数级元数据；绝不含凭据/终端内容） */
  message: string
}

export type EnsureServerResult =
  | { ok: true; action: 'none' | 'installed' | 'upgraded'; version: string }
  | {
      ok: false
      action: 'none'
      reason:
        | 'needInstall' // check：探活不通且远端无安装目录 → UI 弹安装确认
        | 'needUpgrade' // check：旧版运行中 → UI 决策（不自动升级）
        | 'notRunning' // check：目录在但探活不通 → 诊断信息（启动失败）
        | 'noLocalPackage' // 本机缺交付包 → 先 npm run build:server
        | 'uploadFailed'
        | 'startFailed'
        | 'healthFailed'
      message: string
      /** notRunning/healthFailed 附：node 路径/pid/日志尾部（脱敏） */
      diagnostics?: string
      currentVersion?: string
      expectedVersion?: string
    }

export interface EnsureServerOptions {
  /** check=只读探测（默认）；install=推送/升级全流程（ServerInstall 通道显式触发） */
  mode?: 'check' | 'install'
  onProgress?: (ev: ServerInstallProgressEvent) => void
  /** 远端安装根目录覆写（默认 <远端HOME>/.cwb-server；测试/多实例）。
   *  同时经 CWB_SERVER_HOME 传给 server 进程（config.json 同目录，不污染真实 HOME）。 */
  serverHome?: string
  port?: number
  /** 健康轮询：次数（默认 12）与间隔 ms（默认 10_000——慢 VM 冷启动余量；测试可注入短周期） */
  healthAttempts?: number
  healthIntervalMs?: number
  /** 测试注入：跳过本机包解析 */
  localPackage?: LocalServerPackage
}

// ── 本机交付包解析 ────────────────────────────────────────────────────

/**
 * 解析本机 cwb-server 交付包（manifest+tgz）。顺序：
 * 1. env CWB_SERVER_TGZ（显式指定 tgz——独占：manifest 取同目录，找不到即报错，
 *    不再回退其他候选——测试/注入的确定性语义）；
 * 2. 打包资源 process.resourcesPath/server/（electron-builder extraResources；
 *    纯 node 环境 process.resourcesPath 未定义 → 跳过）；
 * 3. 开发仓 release/server-dist/（tools/build-server.mjs 默认输出，从本模块位置上溯）。
 */
export function resolveLocalServerPackage(): LocalServerPackage {
  const envTgz = process.env['CWB_SERVER_TGZ']
  if (envTgz !== undefined && envTgz !== '') {
    try {
      return readManifestDir(dirname(envTgz), envTgz)
    } catch (err) {
      throw new Error(
        `CWB_SERVER_TGZ（${envTgz}）解析失败: ${err instanceof Error ? err.message : String(err)}` +
          `——先运行 npm run build:server${NEED_SERVER_INSTALL_TOKEN}`
      )
    }
  }
  const candidates: string[] = []
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (typeof resources === 'string' && resources !== '') candidates.push(join(resources, 'server'))
  candidates.push(join(repoRoot(), 'release', 'server-dist'))

  for (const dir of candidates) {
    try {
      return readManifestDir(dir)
    } catch (err) {
      if (dir === candidates[candidates.length - 1]) {
        throw new Error(
          'cwb-server 交付包缺失（manifest.json/server-*.tgz）——先运行 npm run build:server' +
            `${NEED_SERVER_INSTALL_TOKEN}`
        )
      }
      void err
    }
  }
  throw new Error('unreachable')
}

function readManifestDir(dir: string, explicitTgz?: string): LocalServerPackage {
  const manifestPath = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ServerPackageManifest
  if (typeof manifest.version !== 'string' || typeof manifest.file !== 'string') {
    throw new Error(`manifest.json 形状非法: ${manifestPath}`)
  }
  const tgzPath = explicitTgz ?? join(dir, manifest.file)
  if (!existsSync(tgzPath)) throw new Error(`tgz 不存在: ${tgzPath}`)
  return { manifest, tgzPath }
}

/** 本模块所在目录 → 上溯找仓库根（package.json name=claude-workbench） */
function repoRoot(): string {
  let dir = moduleDir()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
        if (pkg.name === 'claude-workbench') return dir
      } catch {
        /* continue */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return moduleDir()
}

function moduleDir(): string {
  // vitest（源码 TS，ESM）与 electron-vite 产物（out/main，CJS）双形态兼容：
  // CJS 优先 __dirname（rollup CJS 输出下 import.meta.url 经 shim 亦可用，双保险）
  if (typeof __dirname === 'string' && __dirname !== '') return __dirname
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

// ── 版本探测（S2 自检 server 项复用：S4 接线 self-check.ts 时消费）────────

export type ProbeOutcome = { ok: true; version: string } | { ok: false; detail: string }

export interface ProbeOptions {
  port?: number
  /** 单次探测客户端超时（默认 8s——远端挂起防御） */
  timeoutMs?: number
}

/**
 * 回环 HTTP 探测远端 cwb-server：GET http://127.0.0.1:<port>/ → {ok,version}。
 * 实现=bash /dev/tcp（bash 内建，Ubuntu 必有；不依赖远端 curl/AllowTcpForwarding）。
 * 连不上/超时/应答非法 → {ok:false}（调用方语义=missing）。
 */
export async function probeServerVersion(
  transport: ServerInstallTransport,
  connectionId: string,
  opts: ProbeOptions = {}
): Promise<ProbeOutcome> {
  const port = opts.port ?? DEFAULT_SERVER_PORT
  const timeoutMs = opts.timeoutMs ?? 8_000
  const script =
    `exec 3<>/dev/tcp/127.0.0.1/${port} && ` +
    `printf 'GET / HTTP/1.0\\r\\nHost: cwb\\r\\nConnection: close\\r\\n\\r\\n' >&3 && cat <&3`
  const command = `bash -c ${posixQuote(script)}`
  let r: SshExecResult
  try {
    r = await withTimeout(transport.exec(connectionId, command), timeoutMs, `probe timeout (${timeoutMs}ms)`)
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  if (r.code !== 0) return { ok: false, detail: `connect refused (exit ${r.code})` }
  const version = parseHealthResponse(r.stdout)
  if (version === null) return { ok: false, detail: `unexpected health response: ${truncate(r.stdout, 120)}` }
  return { ok: true, version }
}

/** HTTP 原始应答 → version（body 为 {"ok":true,"server":"cwb-server","version":...}） */
export function parseHealthResponse(raw: string): string | null {
  const body = raw.includes('\r\n\r\n') ? raw.slice(raw.indexOf('\r\n\r\n') + 4) : raw
  try {
    const v = (JSON.parse(body.trim()) as { ok?: unknown; version?: unknown }).version
    return typeof v === 'string' && isSafeVersion(v) ? v : null
  } catch {
    return null
  }
}

/** version 白名单（进入远端命令行/路径前必须过此校验——防注入） */
export function isSafeVersion(v: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.+-]+)?$/.test(v) && v.length <= 64
}

/** semver 数值段比较（a<b 负 / 相等 0 / a>b 正；缺段=0，非数值段退化字符串比较） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const xn = /^\d+$/.test(x) ? Number(x) : undefined
    const yn = /^\d+$/.test(y) ? Number(y) : undefined
    if (xn !== undefined && yn !== undefined) {
      if (xn !== yn) return xn - yn
    } else {
      const c = x.localeCompare(y)
      if (c !== 0) return c < 0 ? -1 : 1
    }
  }
  return 0
}

// ── ensureServer：check / install 全流程 ──────────────────────────────

/** 远端 POSIX 路径拼接（node:path.join 在 Windows 客户端产反斜杠——远端命令禁用；
 * 仅本机路径可用 join） */
function rp(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/')
}

interface RemoteLayout {
  home: string
  versionsDir: string
  versionDir(v: string): string
  currentFile: string
  pidFile: string
  logFile: string
  tgzFile(v: string): string
}

export async function ensureServer(
  transport: ServerInstallTransport,
  connectionId: string,
  opts: EnsureServerOptions = {}
): Promise<EnsureServerResult> {
  const mode = opts.mode ?? 'check'
  const port = opts.port ?? DEFAULT_SERVER_PORT
  const progress = opts.onProgress ?? (() => {})
  const home = await resolveRemoteHome(transport, connectionId, opts.serverHome)
  const L: RemoteLayout = {
    home,
    versionsDir: rp(home, 'versions'),
    versionDir: (v) => rp(home, 'versions', v),
    currentFile: rp(home, 'current'),
    pidFile: rp(home, 'server.pid'),
    logFile: rp(home, 'server.log'),
    tgzFile: (v) => rp(home, 'versions', v, `server-${v}.tgz`)
  }

  let local: LocalServerPackage
  try {
    local = opts.localPackage ?? resolveLocalServerPackage()
  } catch (err) {
    return fail('noLocalPackage', err instanceof Error ? err.message : String(err))
  }
  const expected = local.manifest.version
  if (!isSafeVersion(expected)) return fail('noLocalPackage', `manifest 版本非法: ${expected}`)

  progress({ stage: 'probe', message: `probing cwb-server on 127.0.0.1:${port} …` })
  const probe = await probeServerVersion(transport, connectionId, { port })
  const dirExists = await remoteTestDir(transport, connectionId, L.versionsDir)
  const currentPointer = dirExists ? await readRemoteFile(transport, connectionId, L.currentFile) : undefined
  const runningVersion = probe.ok ? probe.version : sanitizeVersion(currentPointer)

  if (probe.ok && probe.version === expected) {
    progress({ stage: 'done', message: `cwb-server ${expected} already healthy — nothing to do` })
    return { ok: true, action: 'none', version: expected }
  }

  if (mode === 'check') {
    if (probe.ok) {
      const rel = compareVersions(probe.version, expected)
      return {
        ok: false,
        action: 'none',
        reason: 'needUpgrade',
        message:
          `远端 cwb-server ${probe.version} ${rel < 0 ? '旧于' : '新于'} 本机交付 ${expected}` +
          `——需${rel < 0 ? '升级' : '降级重装'}（UI 确认后触发，不自动执行）`,
        currentVersion: probe.version,
        expectedVersion: expected
      }
    }
    if (!dirExists) {
      return {
        ok: false,
        action: 'none',
        reason: 'needInstall',
        message: `远端未安装 cwb-server（${home} 不存在）——需首连推送安装 ${NEED_SERVER_INSTALL_TOKEN}`,
        expectedVersion: expected
      }
    }
    const diagnostics = await collectDiagnostics(transport, connectionId, L, port)
    return {
      ok: false,
      action: 'none',
      reason: 'notRunning',
      message: `远端 ${home} 已安装但探活不通（${truncate(probe.detail ?? 'no response', 160)}）`,
      diagnostics,
      currentVersion: runningVersion,
      expectedVersion: expected
    }
  }

  // ── install 模式：推送/升级全流程 ──
  if (probe.ok) {
    progress({ stage: 'info', message: `upgrading: remote ${probe.version} → ${expected}` })
    await gracefulStop(transport, connectionId, L, progress)
  } else if (dirExists) {
    progress({ stage: 'info', message: 'server not responding; reinstalling (stale stop first)' })
    await gracefulStop(transport, connectionId, L, progress)
  } else {
    progress({ stage: 'info', message: `fresh install ${expected} → ${home}` })
  }

  const nodeBin = await resolveNodeBin(transport, connectionId)
  if (nodeBin === '') {
    const diagnostics = await collectDiagnostics(transport, connectionId, L, port)
    return fail('startFailed', '远端 node 不可解析（bash -ic/command -v 均失败）', diagnostics)
  }
  progress({ stage: 'info', message: `remote node: ${nodeBin}` })

  // 1) 上传（版本目录净空重建——含 dotfile，防陈旧残留混入）
  const vdir = L.versionDir(expected)
  progress({ stage: 'upload', message: `uploading ${local.manifest.file} (${fmtBytes(local.manifest.sizeBytes)})` })
  const mkdir = await transport.exec(
    connectionId,
    `mkdir -p ${q(L.versionsDir)} && rm -rf ${q(vdir)} && mkdir -p ${q(vdir)}`
  )
  if (mkdir.code !== 0) return fail('uploadFailed', `mkdir 远端目录失败: ${truncate(mkdir.stderr, 160)}`)
  try {
    const sftp = await transport.sftp(connectionId)
    await sftp.writeFile(L.tgzFile(expected), readFileSync(local.tgzPath))
  } catch (err) {
    return fail('uploadFailed', `SFTP 上传失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2) sha256 校验（防传输损坏/篡改）
  const sum = await transport.exec(connectionId, `sha256sum ${q(L.tgzFile(expected))}`)
  const remoteSum = sum.stdout.trim().split(/\s+/)[0] ?? ''
  if (remoteSum !== local.manifest.sha256) {
    return fail(
      'uploadFailed',
      `sha256 不一致（远端 ${remoteSum.slice(0, 16)}… ≠ 本机 ${local.manifest.sha256.slice(0, 16)}…）——重试或重新 build:server`
    )
  }
  progress({ stage: 'upload', message: `sha256 verified: ${remoteSum.slice(0, 16)}…` })

  // 3) 解压
  progress({ stage: 'extract', message: `extracting → ${vdir}` })
  const extract = await transport.exec(
    connectionId,
    `tar -xzf ${q(L.tgzFile(expected))} -C ${q(vdir)} && rm -f ${q(L.tgzFile(expected))} && test -s ${q(rp(vdir, 'dist', 'main.cjs'))}`
  )
  if (extract.code !== 0) {
    return fail('startFailed', `解压失败: ${truncate(extract.stderr, 200)}`)
  }

  // 4) 启动（nvm PATH 墙：node 绝对路径；nohup 全重定向——ssh 通道即刻返回）
  progress({ stage: 'start', message: `starting cwb-server ${expected} on port ${port}` })
  const startCmd =
    `nohup env CWB_SERVER_HOME=${q(home)} ${q(nodeBin)} ${q(rp(vdir, 'dist', 'main.cjs'))} --port ${port} ` +
    `>>${q(L.logFile)} 2>&1 < /dev/null & echo $! > ${q(L.pidFile)}`
  const start = await transport.exec(connectionId, startCmd)
  if (start.code !== 0) {
    const diagnostics = await collectDiagnostics(transport, connectionId, L, port)
    return fail('startFailed', `启动命令失败: ${truncate(start.stderr, 160)}`, diagnostics)
  }

  // 5) 健康轮询（探活=真实 HTTP；进程秒退/ABI 不匹配在此暴露）
  progress({ stage: 'health', message: 'waiting for health endpoint …' })
  const attempts = opts.healthAttempts ?? 12
  const intervalMs = opts.healthIntervalMs ?? 10_000
  let healthy = false
  for (let i = 1; i <= attempts; i++) {
    await sleep(i === 1 ? Math.min(intervalMs, 2_000) : intervalMs)
    const p = await probeServerVersion(transport, connectionId, { port, timeoutMs: Math.min(8_000, intervalMs + 2_000) })
    if (p.ok) {
      healthy = true
      progress({ stage: 'health', message: `healthy after ${i} attempt(s): version ${p.version}` })
      break
    }
    if (i < attempts) progress({ stage: 'health', message: `health attempt ${i}/${attempts} failed (${truncate(p.detail, 80)})` })
  }
  if (!healthy) {
    const diagnostics = await collectDiagnostics(transport, connectionId, L, port)
    return fail('healthFailed', `探活 ${attempts} 次失败——server 未就绪（见诊断）`, diagnostics)
  }

  // 6) current 指针 + 旧版本清理（保留最近 2 个）
  await writeRemoteFile(transport, connectionId, L.currentFile, `${expected}\n`)
  await cleanupOldVersions(transport, connectionId, L, expected, progress)

  const action = runningVersion !== undefined && runningVersion !== expected ? 'upgraded' : 'installed'
  progress({ stage: 'done', message: `cwb-server ${expected} ${action} at ${home} (port ${port})` })
  return { ok: true, action, version: expected }

  function fail(
    reason: Extract<EnsureServerResult, { ok: false }>['reason'],
    message: string,
    diagnostics?: string
  ): EnsureServerResult {
    progress({ stage: 'error', message: `${reason}: ${message}${diagnostics !== undefined ? ' | ' + diagnostics : ''}` })
    return { ok: false, action: 'none', reason, message, ...(diagnostics !== undefined ? { diagnostics } : {}) }
  }
}

// ── 远端原语（全部经 exec/SFTP；路径一律 posixQuote）──────────────────

async function resolveRemoteHome(
  transport: ServerInstallTransport,
  connectionId: string,
  override?: string
): Promise<string> {
  if (override !== undefined && override !== '') {
    if (!override.startsWith('/')) throw new Error(`serverHome 覆写必须为绝对路径: ${override}`)
    return override.replace(/\/+$/, '')
  }
  const r = await withTimeout(
    transport.exec(connectionId, 'printf %s "$HOME"'),
    8_000,
    'resolve $HOME timeout'
  )
  const home = r.stdout.trim()
  if (home === '' || !home.startsWith('/')) throw new Error(`远端 $HOME 解析失败: ${truncate(r.stdout, 80)}`)
  return rp(home, REMOTE_DIR)
}

async function remoteTestDir(
  transport: ServerInstallTransport,
  connectionId: string,
  dir: string
): Promise<boolean> {
  try {
    const r = await withTimeout(transport.exec(connectionId, `test -d ${q(dir)} && echo yes`), 8_000, 'test -d timeout')
    return r.stdout.trim() === 'yes'
  } catch {
    return false
  }
}

async function readRemoteFile(
  transport: ServerInstallTransport,
  connectionId: string,
  path: string
): Promise<string | undefined> {
  try {
    const r = await withTimeout(
      transport.exec(connectionId, `cat ${q(path)} 2>/dev/null`),
      8_000,
      'read timeout'
    )
    return r.code === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function writeRemoteFile(
  transport: ServerInstallTransport,
  connectionId: string,
  path: string,
  content: string
): Promise<void> {
  const sftp = await transport.sftp(connectionId)
  await sftp.writeFile(path, content)
}

/**
 * 解析远端 node 绝对路径（nvm PATH 墙：非交互 ssh 不 source ~/.bashrc 的 nvm 段）。
 * 顺序：bash -ic 'command -v node'（交互式加载 nvm）→ 直接 command -v node。
 * stdout 取最后一行（bash -ic 的作业控制告警走 stderr，不影响）。
 */
async function resolveNodeBin(transport: ServerInstallTransport, connectionId: string): Promise<string> {
  for (const cmd of [`bash -ic ${posixQuote('command -v node')}`, 'command -v node']) {
    try {
      const r = await withTimeout(transport.exec(connectionId, cmd), 10_000, 'node resolve timeout')
      const line = r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .pop()
      if (r.code === 0 && line !== undefined && line.startsWith('/') && !line.includes(' ')) return line
    } catch {
      /* 尝试下一策略 */
    }
  }
  return ''
}

/** 优雅停机（升级/重装前）：SIGTERM pid 文件进程 → 等退（≤5s）→ SIGKILL 兜底 */
async function gracefulStop(
  transport: ServerInstallTransport,
  connectionId: string,
  L: RemoteLayout,
  progress: (ev: ServerInstallProgressEvent) => void
): Promise<void> {
  const pid = sanitizeVersion(await readRemoteFile(transport, connectionId, L.pidFile))
  if (pid === undefined) {
    progress({ stage: 'info', message: 'no pid file — nothing to stop' })
    return
  }
  await transport.exec(connectionId, `kill ${pid} 2>/dev/null`)
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    const alive = await transport.exec(connectionId, `kill -0 ${pid} 2>/dev/null && echo yes`)
    if (alive.stdout.trim() !== 'yes') {
      progress({ stage: 'info', message: `old server (pid ${pid}) stopped` })
      return
    }
  }
  await transport.exec(connectionId, `kill -9 ${pid} 2>/dev/null`)
  progress({ stage: 'info', message: `old server (pid ${pid}) SIGKILLed after graceful timeout` })
}

/** 旧版本清理：按版本排序保留最近 2 个（含 current）；其余 rm -rf */
async function cleanupOldVersions(
  transport: ServerInstallTransport,
  connectionId: string,
  L: RemoteLayout,
  current: string,
  progress: (ev: ServerInstallProgressEvent) => void
): Promise<void> {
  let names: Array<{ name: string; isDir: boolean }>
  try {
    const sftp = await transport.sftp(connectionId)
    names = await sftp.list(L.versionsDir)
  } catch {
    return
  }
  const versions = names
    .filter((e) => e.isDir && isSafeVersion(e.name))
    .map((e) => e.name)
    .sort((a, b) => compareVersions(b, a))
  const keep = new Set([current, ...versions.slice(0, 2)])
  for (const v of versions) {
    if (keep.has(v)) continue
    await transport.exec(connectionId, `rm -rf ${q(L.versionDir(v))}`)
    progress({ stage: 'info', message: `removed old version dir ${v}` })
  }
}

/** 启动失败/探活失败诊断：current 版本/node 路径/pid 存活/server.log 尾部 + ABI 提示 */
async function collectDiagnostics(
  transport: ServerInstallTransport,
  connectionId: string,
  L: RemoteLayout,
  port: number
): Promise<string> {
  const parts: string[] = []
  const current = sanitizeVersion(await readRemoteFile(transport, connectionId, L.currentFile))
  if (current !== undefined) parts.push(`current=${current}`)
  const nodeBin = await resolveNodeBin(transport, connectionId)
  parts.push(`node=${nodeBin !== '' ? nodeBin : 'UNRESOLVED'}`)
  const pid = sanitizeVersion(await readRemoteFile(transport, connectionId, L.pidFile))
  if (pid !== undefined) {
    const alive = await transport.exec(connectionId, `kill -0 ${pid} 2>/dev/null && echo yes`)
    parts.push(`pid=${pid}(${alive.stdout.trim() === 'yes' ? 'alive' : 'dead'})`)
  }
  try {
    const log = await withTimeout(
      transport.exec(connectionId, `tail -n 40 ${q(L.logFile)} 2>/dev/null`),
      8_000,
      'tail timeout'
    )
    const logTail = truncate(log.stdout.replace(/\s+/g, ' ').trim(), 600)
    if (logTail !== '') parts.push(`log tail: ${logTail}`)
    if (/NODE_MODULE_VERSION|was compiled against a different Node|pty\.node/i.test(log.stdout)) {
      parts.push(
        'HINT: node-pty ABI 与远端 node 不匹配——在 VM 内执行 ' +
          (current !== undefined
            ? `'cd ${L.versionDir(current)}/node_modules/node-pty && npm rebuild'`
            : "'cd <cwb-server>/versions/<v>/node_modules/node-pty && npm rebuild'") +
          '（或安装与构建机一致的 node 大版本）后重试'
      )
    }
  } catch {
    /* 日志不可读不阻塞诊断 */
  }
  parts.push(`probe=127.0.0.1:${port}`)
  return truncate(parts.join(' | '), 2_000)
}

// ── 纯工具 ───────────────────────────────────────────────────────────

/** POSIX 单引号包裹（远端 Linux；防路径空格/元字符注入——manager.ts 同式） */
export function posixQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

function q(p: string): string {
  return posixQuote(p)
}

/** pid/版本等受控数字段：白名单外的值一律丢弃（不进命令行） */
function sanitizeVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const t = raw.trim()
  return /^\d+$/.test(t) || isSafeVersion(t) ? t : undefined
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeout)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
