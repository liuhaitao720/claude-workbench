#!/usr/bin/env node
/**
 * 协议同步脚本（SSH 远程模式 S1 批0 骨架；S3 归属后续增强）。
 *
 * 职责：把 src/shared/remote-protocol.ts 连同其相对 import 的传递依赖逐字节拷入
 * server/src/shared/，并对闭包内全部文件做内容一致性校验（sha256 比对）——
 * 源与目标任一不一致（含目标缺失/被手改）即非零退出。
 *
 * 用法：
 *   node tools/sync-protocol.mjs           # 同步写入 + 校验（幂等：已一致则零写入）
 *   node tools/sync-protocol.mjs --check   # 只校验不写入（CI/验收用；不一致非零退出）
 *
 * 边界：只处理 src/shared/ 内的相对依赖（./x、../x）；第三方依赖不属于同步范围。
 * 目标目录中的陈旧孤儿文件（源侧已删的依赖）不在校验闭包内——由人工/S3 清理。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

console.log(`[sync-protocol] 闭包 ${closure.length} 文件：${closure.join(', ')}`)
console.log(report.join('\n'))
console.log(
  `[sync-protocol] OK（${checkOnly ? '仅校验' : '同步写入'}；${changed} 个文件更新，全部 sha256 一致）`
)
