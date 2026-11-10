#!/usr/bin/env node
/**
 * 协议同步脚本（SSH 远程模式 S1 骨架；S3 增强：孤儿文件清理）。
 *
 * 职责：把 src/shared/remote-protocol.ts 连同其相对 import 的传递依赖逐字节拷入
 * server/src/shared/，并对闭包内全部文件做内容一致性校验（sha256 比对）——
 * 源与目标任一不一致（含目标缺失/被手改）即非零退出；同时清理目标侧孤儿文件
 * （源侧已删的依赖残留在 server/src/shared/ 的副本），两侧目录内容集完全对齐。
 *
 * 用法：
 *   node tools/sync-protocol.mjs           # 同步写入 + 孤儿清理 + 校验（幂等）
 *   node tools/sync-protocol.mjs --check   # 只校验不写入（CI/验收用；不一致或存在孤儿非零退出）
 *
 * 边界：只处理 src/shared/ 内的相对依赖（./x、../x）；第三方依赖不属于同步范围。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src', 'shared')
const destDir = join(root, 'server', 'src', 'shared')
const ENTRY = 'remote-protocol.ts'
const checkOnly = process.argv.includes('--check')

const fail = (msg) => {
  console.error(`[sync-protocol] FAIL: ${msg}`)
  process.exit(1)
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 解析一个 TS 文件的相对 import 依赖（import/export ... from './x' 与副作用 import './x'） */
function relativeImportsOf(absFile) {
  const text = readFileSync(absFile, 'utf8')
  const specs = new Set()
  // from '...' 子句（import/export 声明；type/value 均算——同步的是文件字节）
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]/g)) {
    specs.add(m[1])
  }
  // 副作用导入 import './x'
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)) {
    specs.add(m[1])
  }
  return [...specs]
}

/** 从入口出发 BFS 收集相对依赖闭包（返回相对 srcDir 的文件名集合） */
function collectClosure() {
  const closure = new Set([ENTRY])
  const queue = [ENTRY]
  while (queue.length > 0) {
    const name = queue.shift()
    const absFile = join(srcDir, name)
    let text
    try {
      text = readFileSync(absFile, 'utf8')
    } catch {
      fail(`源文件缺失或不可读：src/shared/${name}`)
    }
    for (const spec of relativeImportsOf(absFile)) {
      const resolved = resolve(dirname(absFile), spec)
      const rel = relative(srcDir, resolved)
      if (rel.startsWith('..')) {
        fail(`依赖越出 src/shared/ 范围（不同步）：src/shared/${name} -> ${spec}`)
      }
      // 补全省略的 .ts 扩展名（bundler resolution）
      const candidates = rel.endsWith('.ts') ? [rel] : [`${rel}.ts`, `${rel}/index.ts`]
      const hit = candidates.find((c) => {
        try {
          readFileSync(join(srcDir, c))
          return true
        } catch {
          return false
        }
      })
      if (hit === undefined) fail(`解析不到依赖文件：src/shared/${name} -> ${spec}`)
      if (!closure.has(hit)) {
        closure.add(hit)
        queue.push(hit)
      }
    }
  }
  return [...closure].sort()
}

const closure = collectClosure()
let changed = 0
const report = []
for (const name of closure) {
  const srcFile = join(srcDir, name)
  const destFile = join(destDir, name)
  const srcBuf = readFileSync(srcFile)
  const srcHash = sha256(srcBuf)
  let destHash = null
  try {
    destHash = sha256(readFileSync(destFile))
  } catch {
    destHash = null // 缺失视为不一致
  }
  if (destHash === srcHash) {
    report.push(`  = ${name} (${srcHash.slice(0, 12)})`)
    continue
  }
  if (checkOnly) {
    fail(`--check 不一致：server/src/shared/${name} 缺失或与源漂移（期望 ${srcHash.slice(0, 12)}）`)
  }
  mkdirSync(dirname(destFile), { recursive: true })
  writeFileSync(destFile, srcBuf)
  changed += 1
  // 写后复验（写入即校验——盘上字节必须与源一致）
  if (sha256(readFileSync(destFile)) !== srcHash) {
    fail(`写入后复验失败：server/src/shared/${name}`)
  }
  report.push(`  + ${name} (${srcHash.slice(0, 12)}) 已同步`)
}

// ── 孤儿清理：目标侧存在而源闭包没有的文件=源侧已删依赖的残留 ──────────────
const orphans = listDestFiles().filter((f) => !closure.includes(f))
for (const name of orphans) {
  if (checkOnly) {
    fail(`--check 发现孤儿文件：server/src/shared/${name}（源侧已删——运行同步模式清理）`)
  }
  rmSync(join(destDir, name))
  changed += 1
  report.push(`  - ${name} 孤儿清理（源侧已删）`)
}
if (!checkOnly && orphans.length > 0) pruneEmptyDirs(destDir)

console.log(`[sync-protocol] 闭包 ${closure.length} 文件：${closure.join(', ')}`)
console.log(report.join('\n'))
console.log(
  `[sync-protocol] OK（${checkOnly ? '仅校验' : '同步写入+孤儿清理'}；${changed} 个文件变更，全部 sha256 一致，无孤儿）`
)

/** 递归列出 destDir 下全部文件（相对路径统一 / 分隔，与 closure 同口径） */
function listDestFiles() {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(join(destDir, rel), { withFileTypes: true })
    } catch {
      return // 目录不存在=无孤儿
    }
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.isFile()) out.push(child)
    }
  }
  walk('')
  return out
}

/** 自底向上剪空目录（孤儿删除后遗留；destDir 本身保留） */
function pruneEmptyDirs(base) {
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    pruneEmptyDirs(join(base, e.name))
  }
  try {
    // rmSync 对目录需 recursive（此处已验证为空目录，安全）
    if (readdirSync(base).length === 0 && base !== destDir) rmSync(base, { recursive: true })
  } catch {
    // 非空/并发变更——保留
  }
}
