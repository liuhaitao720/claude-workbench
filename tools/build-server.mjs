#!/usr/bin/env node
/**
 * S7 cwb-server 交付打包（design-ssh-remote §4-S7 / O6 ABI 策略）。
 *
 * 产物（release/server-dist/，已 gitignore）：
 *   server-<version>.tgz —— 远端可运行全集：
 *     dist/main.cjs        esbuild bundle（ws/node-pty external——native 不进 bundle，
 *                          S3 L3 harness 同配方；远端经向上目录解析命中同包 node_modules）
 *     node_modules/        生产依赖（node-pty + node-addon-api + ws），
 *                          含本机编译的 Linux pty.node（O6：tgz 绑定构建机 ABI）
 *     src/                 server 源（体积可忽略；备远端侧排查/再打包）
 *     package.json         版本单一事实源（server.version 帧/升级比对共用）
 *   manifest.json —— {version,file,sha256,sizeBytes,fileCount,nodeVersion,nodeAbi,builtAt}
 *                     供 server-installer 运行时解析（不进 tgz——sha256 自指无解）。
 *
 * 确定性：tar 排序 + mtime/owner 归零 + node zlib gzip（mtime:0）→ 同输入两次构建
 * sha256 恒等（L2 断言）。
 *
 * 用法：node tools/build-server.mjs [--out <dir>]
 * 必须在 Linux 构建机跑（node-pty 原生产物随宿主平台——electron-builder.yml 注释同结论）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const scriptDir = dirname(import.meta.url) // …/tools/（fileURLToPath 归一带尾斜杠）
const repoRoot = resolve(scriptDir, '..')
const serverDir = join(repoRoot, 'server')
const defaultOutDir = join(repoRoot, 'release', 'server-dist')

/** 生产依赖（npm ci --omit=dev 的产物；离线回退按此清单拷贝） */
const PROD_DEPS = ['node-pty', 'node-addon-api', 'ws']

export function serverVersion(pkgJson) {
  const v = pkgJson.version
  if (typeof v !== 'string' || v.trim() === '') throw new Error('server/package.json 缺 version')
  return v.trim()
}

/**
 * 组装 staging 目录（package.json + dist/main.cjs + src + 生产 node_modules）。
 * npm ci 失败（离线等）回退：从 server/node_modules 拷贝生产清单（构建机必须装过）。
 */
export async function buildStaging(stageDir, { quiet = false } = {}) {
  const serverPkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'))
  const version = serverVersion(serverPkg)
  mkdirSync(stageDir, { recursive: true })
  cpSync(join(serverDir, 'package.json'), join(stageDir, 'package.json'))
  const lockPath = join(serverDir, 'package-lock.json')
  if (existsSync(lockPath)) cpSync(lockPath, join(stageDir, 'package-lock.json'))
  cpSync(join(serverDir, 'src'), join(stageDir, 'src'), { recursive: true })

  // 1) 生产 node_modules（含 Linux 编译 node-pty）
  const nmStage = join(stageDir, 'node_modules')
  const ciOk = tryNpmCi(stageDir, quiet)
  if (!ciOk) {
    if (!quiet) console.warn('[build-server] npm ci 失败，回退拷贝 server/node_modules 生产清单')
    const nmSrc = join(serverDir, 'node_modules')
    for (const dep of PROD_DEPS) {
      const src = join(nmSrc, dep)
      if (!existsSync(src)) {
        throw new Error(`离线回退失败：server/node_modules/${dep} 不存在（先 cd server && npm install）`)
      }
      cpSync(src, join(nmStage, dep), { recursive: true })
    }
  }
  pruneNativePayload(nmStage)
  assertLinuxPtyBinary(nmStage)

  // 2) bundle（S3 l3-harness 同配方：cjs/node、ws+node-pty external）
  await build({
    entryPoints: [join(serverDir, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(stageDir, 'dist', 'main.cjs'),
    external: ['node-pty', 'ws'],
    logLevel: 'silent'
  })
  return { version }
}

/** npm ci --omit=dev 到 staging（不自毁 server/node_modules 的 dev 依赖） */
function tryNpmCi(stageDir, quiet) {
  const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: stageDir,
    encoding: 'utf8',
    timeout: 180_000
  })
  if (r.status === 0 && existsSync(join(stageDir, 'node_modules', 'node-pty'))) return true
  if (!quiet) {
    const tail = (r.stderr ?? '').toString().split('\n').filter(Boolean).slice(-3).join(' | ')
    console.warn(`[build-server] npm ci 退出码 ${r.status}${tail !== '' ? `: ${tail}` : ''}`)
  }
  rmSync(join(stageDir, 'node_modules'), { recursive: true, force: true })
  return false
}

/**
 * 原生负载裁剪（O6）：node-pty prebuilds 只留 Linux 相关——本机安装形态为
 * build/Release/pty.node（Linux 编译产物）+ win32/darwin prebuild（~58MB 死重）。
 * 保留 binding.gyp/src/deps：ABI 不匹配时远端 node-gyp rebuild 需要（S7 文档指引）。
 * 排除 build/Makefile、build/config.gypi：node-gyp 生成物内嵌构建机绝对路径
 * （破坏确定性 tar），且任何 rebuild 都会重新生成。
 */
function pruneNativePayload(nmStage) {
  const prebuilds = join(nmStage, 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const name of readdirSync(prebuilds)) {
      if (name.startsWith('linux')) continue
      rmSync(join(prebuilds, name), { recursive: true, force: true })
    }
  }
  rmSync(join(nmStage, 'node-pty', 'build', 'Makefile'), { force: true })
  rmSync(join(nmStage, 'node-pty', 'build', 'config.gypi'), { force: true })
  rmSync(join(nmStage, '.bin'), { recursive: true, force: true })
}

/** 硬校验：tgz 必须带 Linux pty.node（没有=构建机没编过 → 装到 VM 必炸） */
function assertLinuxPtyBinary(nmStage) {
  const candidates = [
    join(nmStage, 'node-pty', 'build', 'Release', 'pty.node'),
    ...readdirOrEmpty(join(nmStage, 'node-pty', 'prebuilds'))
      .filter((n) => n.startsWith('linux'))
      .map((n) => join(nmStage, 'node-pty', 'prebuilds', n, 'pty.node'))
  ]
  if (!candidates.some((p) => existsSync(p))) {
    throw new Error(
      'node-pty 无 Linux 原生产物（build/Release/pty.node 或 prebuilds/linux-*）——' +
        '先在 server/ 下 npm install 触发编译后再打包（Linux 构建机）'
    )
  }
}

/** 确定性 tgz 字节流（tar 排序 + mtime/owner 归零 + node zlib gzip mtime:0）。
 * 返回值已含 gzip 层——调用方直接落盘为 .tgz，勿再压缩。 */
export function createTarball(stageDir, topEntries) {
  const tarArgs = [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--format=gnu',
    '-cf',
    '-',
    ...topEntries
  ]
  const r = spawnSync('tar', tarArgs, { cwd: stageDir, maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) {
    throw new Error(
      `tar 打包失败（code ${r.status}）：${(r.stderr ?? '').toString().slice(0, 300)}` +
        '——确定性参数需 GNU tar ≥1.28（Linux 构建机标配）'
    )
  }
  return gzipSync(r.stdout, { level: 9, mtime: 0 })
}

/** 完整构建：staging → tgz + manifest 写入 outDir；返回 manifest。
 * staging 用固定路径（node-gyp 生成物内嵌绝对路径 → 随机临时名会破坏
 * 同输入同 sha256 的确定性断言；路径固定后跨次构建字节恒等）。 */
export async function buildServerPackage({ outDir = defaultOutDir, quiet = false } = {}) {
  const stageRoot = join(outDir, '.staging')
  rmSync(stageRoot, { recursive: true, force: true })
  const stage = join(stageRoot, 'stage')
  try {
    const { version } = await buildStaging(stage, { quiet })
    const topEntries = readdirSync(stage).sort()
    const tgzBytes = createTarball(stage, topEntries)
    const file = `server-${version}.tgz`
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, file), tgzBytes)
    const manifest = {
      version,
      file,
      sha256: createHash('sha256').update(tgzBytes).digest('hex'),
      sizeBytes: tgzBytes.length,
      fileCount: countFiles(stage),
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      builtAt: new Date().toISOString()
    }
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}

// ── 内部小工具 ───────────────────────────────────────────────────────

function countFiles(root) {
  let n = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else n++
    }
  }
  walk(root)
  return n
}

function readdirOrEmpty(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function dirname(u) {
  return fileURLToPath(new URL('.', u))
}

/** CLI 入口（import 测试时不执行） */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let outDir = defaultOutDir
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1] !== undefined) outDir = resolve(args[i + 1])
  }
  buildServerPackage({ outDir })
    .then((m) => {
      console.log(
        `[build-server] ${m.file}（${(m.sizeBytes / 1024 / 1024).toFixed(2)} MB，` +
          `${m.fileCount} 文件，node ${m.nodeVersion} ABI ${m.nodeAbi}）`
      )
      console.log(`[build-server] sha256=${m.sha256}`)
      console.log(`[build-server] 输出目录 ${relative(repoRoot, outDir) || basename(outDir)}/`)
    })
    .catch((err) => {
      console.error(`[build-server] 打包失败：${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
