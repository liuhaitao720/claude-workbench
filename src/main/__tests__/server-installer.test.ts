/**
 * S7 L2 验收：打包（build-server）/ 版本比对 / 探活解析 / 本机包解析。
 *
 * 真实执行面：buildServerPackage 真跑 esbuild+npm ci（离线回退拷贝）产 tgz，
 * 断言产物存在、内容全集、跨次构建 sha256 恒等；probeServerVersion 对本机
 * 起的真实 HTTP 端点经真实 bash /dev/tcp 探测（S4 接线 self-check server 项
 * 的函数体直证——self-check.ts 的接线归 S4）。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { buildServerPackage } from '../../../tools/build-server.mjs'
import {
  NEED_SERVER_INSTALL_TOKEN,
  compareVersions,
  isSafeVersion,
  parseHealthResponse,
  posixQuote,
  probeServerVersion,
  resolveLocalServerPackage,
  type ServerInstallTransport
} from '../server-installer'
import type { SshExecResult } from '../ssh/connection-manager'

const tempDirs: string[] = []
function mkTemp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `cwb-s7-l2-${label}-`))
  tempDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

// ── 版本比对与应答解析（纯函数） ──────────────────────────────────────

describe('compareVersions（升级比对）', () => {
  it('数值段比较与相等', () => {
    expect(compareVersions('0.0.9', '0.1.0')).toBeLessThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.19.0', '0.2.0')).toBeGreaterThan(0)
  })
  it('段数不等按缺省 0 处理', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.1', '0.1')).toBeGreaterThan(0)
  })
})

describe('isSafeVersion / parseHealthResponse（防注入白名单）', () => {
  it('合法版本过白名单', () => {
    expect(isSafeVersion('0.1.0')).toBe(true)
    expect(isSafeVersion('1.2.3-beta.1')).toBe(true)
  })
  it('命令注入形态一律拒绝', () => {
    expect(isSafeVersion('0.1.0; rm -rf /')).toBe(false)
    expect(isSafeVersion("'; injected")).toBe(false)
    expect(isSafeVersion('')).toBe(false)
    expect(isSafeVersion('0.1.0\nx')).toBe(false)
  })
  it('HTTP 应答解析出 version；非法应答返回 null', () => {
    const ok = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"ok":true,"server":"cwb-server","version":"0.1.0"}\n'
    expect(parseHealthResponse(ok)).toBe('0.1.0')
    expect(parseHealthResponse('garbage')).toBeNull()
    // 应答中的恶意 version 不得透传（isSafeVersion 拦截 → null）
    const evil = 'HTTP/1.1 200 OK\r\n\r\n{"ok":true,"version":"0.1.0; rm -rf /"}'
    expect(parseHealthResponse(evil)).toBeNull()
  })
})

describe('posixQuote', () => {
  it('空格与单引号安全包裹', () => {
    expect(posixQuote('/tmp/a b')).toBe(`'/tmp/a b'`)
    expect(posixQuote("it's")).toBe(`'it'\\''s'`)
  })
})

// ── 本机交付包解析 ────────────────────────────────────────────────────

describe('resolveLocalServerPackage', () => {
  const prevTgz = process.env['CWB_SERVER_TGZ']
  afterEach(() => {
    if (prevTgz === undefined) delete process.env['CWB_SERVER_TGZ']
    else process.env['CWB_SERVER_TGZ'] = prevTgz
  })

  it('CWB_SERVER_TGZ 指定目录的 manifest+tgz；sha256 与实际文件一致', async () => {
    const outDir = mkTemp('pkg')
    const manifest = await buildServerPackage({ outDir, quiet: true })
    process.env['CWB_SERVER_TGZ'] = join(outDir, manifest.file)
    const pkg = resolveLocalServerPackage()
    expect(pkg.manifest.version).toBe(manifest.version)
    expect(pkg.tgzPath).toBe(join(outDir, manifest.file))
    const actual = createHash('sha256').update(readFileSync(pkg.tgzPath)).digest('hex')
    expect(actual).toBe(manifest.sha256)
  }, 240_000)

  it('缺失时抛错并含 build:server 指引 + needInstall token', () => {
    process.env['CWB_SERVER_TGZ'] = join(mkTemp('missing'), 'server-9.9.9.tgz')
    expect(() => resolveLocalServerPackage()).toThrow(NEED_SERVER_INSTALL_TOKEN)
  })
})

// ── 打包（真实执行） ──────────────────────────────────────────────────

describe('build-server 打包（tgz 组装 + 确定性）', () => {
  it(
    '产物存在、内容全集、清单字段',
    async () => {
      const outDir = mkTemp('build')
      const manifest = await buildServerPackage({ outDir, quiet: true })
      expect(manifest.version).toBe('0.1.3')
      expect(manifest.file).toBe('server-0.1.3.tgz')
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.sizeBytes).toBeGreaterThan(500 * 1024)
      expect(existsSync(join(outDir, manifest.file))).toBe(true)
      expect(existsSync(join(outDir, 'manifest.json'))).toBe(true)

      const listing = (await tarList(join(outDir, manifest.file))).split('\n').filter(Boolean)
      // 运行时全集：bundle 入口 + 生产 node_modules + 版本源
      expect(listing).toContain('dist/main.cjs')
      expect(listing).toContain('package.json')
      expect(listing.some((n) => n.startsWith('node_modules/node-pty/'))).toBe(true)
      expect(listing.some((n) => n.startsWith('node_modules/ws/'))).toBe(true)
      // Linux 原生负载在包内（O6）
      expect(listing.some((n) => /node-pty\/build\/Release\/pty\.node$/.test(n))).toBe(true)
      // 裁剪：非 Linux prebuild 与 node-gyp 路径生成物不进包
      expect(listing.some((n) => n.includes('prebuilds/win32'))).toBe(false)
      expect(listing.some((n) => n.includes('prebuilds/darwin'))).toBe(false)
      expect(listing).not.toContain('node_modules/node-pty/build/Makefile')
      expect(listing).not.toContain('node_modules/node-pty/build/config.gypi')
    },
    240_000
  )

  it(
    '同输入两次构建 sha256 恒等（确定性 tar）',
    async () => {
      const a = await buildServerPackage({ outDir: mkTemp('det-a'), quiet: true })
      const b = await buildServerPackage({ outDir: mkTemp('det-b'), quiet: true })
      expect(b.sha256).toBe(a.sha256)
    },
    240_000
  )
})

function tarList(tgz: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-tzf', tgz], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err != null) reject(err)
      else resolve(stdout)
    })
  })
}

// ── probeServerVersion（本机真实 HTTP + 真实 bash /dev/tcp） ─────────

describe('probeServerVersion（S4 self-check 接线的函数体直证）', () => {
  /** 本机 bash 执行替身：probe 命令与真实 SSH exec 完全同一形态 */
  const localTransport: ServerInstallTransport = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async exec(_id, command): Promise<SshExecResult> {
      return new Promise((resolve) => {
        execFile('bash', ['-c', command], { timeout: 10_000 }, (err, stdout, stderr) => {
          resolve({
            code: err !== null && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : (err === null ? 0 : 255),
            stdout: stdout?.toString() ?? '',
            stderr: stderr?.toString() ?? ''
          })
        })
      })
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async sftp() {
      throw new Error('probe 不经 sftp')
    }
  }

  let http: Server | null = null
  let port = 0
  afterEach(async () => {
    if (http !== null) await new Promise<void>((r) => http!.close(() => r()))
    http = null
  })

  it('活端点 → {ok:true,version}', async () => {
    http = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`{"ok":true,"server":"cwb-server","version":"0.1.0"}\n`)
    })
    port = await new Promise<number>((r) => http!.listen(0, '127.0.0.1', () => r((http!.address() as { port: number }).port)))
    const r = await probeServerVersion(localTransport, 'test-conn', { port })
    expect(r).toEqual({ ok: true, version: '0.1.0' })
  })

  it('死端口 → {ok:false}（语义=missing）', async () => {
    const dead = createServer()
    const deadPort = await new Promise<number>((r) => dead.listen(0, '127.0.0.1', () => r((dead.address() as { port: number }).port)))
    await new Promise<void>((r) => dead.close(() => r()))
    const r = await probeServerVersion(localTransport, 'test-conn', { port: deadPort })
    expect(r.ok).toBe(false)
  })
})
