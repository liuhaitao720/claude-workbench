#!/usr/bin/env node
/**
 * v2.2.3 发布清单生成：portable zip → dist-release/latest.json。
 *
 * 形状=src/main/app-updater.ts AppUpdateManifest（应用内自动更新读
 * https://github.com/liuhaitao720/ssh-workbench/releases/latest/download/latest.json）：
 *   { version, url, sha256, size, date }
 * url 指向本 tag 的 Release 资产（SSH-Workbench-<v>-portable.zip）。
 *
 * 用法：node tools/gen-release-manifest.mjs --tag v2.2.3 --zip dist-release/SSH-Workbench-2.2.3-portable.zip [--out dist-release/latest.json]
 * （CI release.yml 与本机发布链共用——此前由 Windows 侧私有 scripts/release.mjs 承担）
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const tag = arg('tag')
const zip = arg('zip')
if (tag === undefined || zip === undefined) {
  console.error('用法: gen-release-manifest.mjs --tag v2.2.3 --zip <portable.zip> [--out <latest.json>]')
  process.exit(1)
}
const version = tag.replace(/^v/, '')
const buf = readFileSync(resolve(zip))
const manifest = {
  version,
  url: `https://github.com/liuhaitao720/ssh-workbench/releases/download/${tag}/${basename(zip)}`,
  sha256: createHash('sha256').update(buf).digest('hex'),
  size: buf.length,
  date: new Date().toISOString()
}
const out = arg('out', 'dist-release/latest.json')
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`[gen-release-manifest] ${out} → v${version} sha256=${manifest.sha256.slice(0, 16)}… size=${manifest.size}`)
