/**
 * S7 L3 验收（真实执行·本机 localhost 全链）：build-server 产 tgz → 测试密钥对
 * 连本机 sshd（照 S2 L3 先例：authorized_keys 临时追加，测试后清理）→
 * ensureServer 推送安装/升级/幂等/诊断全流程。
 *
 * 链路：真 sshd + 真 bash + 真 SFTP + 真 node 进程 + 真 HTTP 探活。
 * 远端=本机（HOME 污染防护：serverHome 覆写 + CWB_SERVER_HOME 注入测试目录）。
 * 升级路径用「真·旧版本 server」：改 version 重打包 0.0.9 → 安装为运行版 →
 * check=needUpgrade → 升级回 0.1.0（比伪造 version 文件更强的证据）。
 *
 * 运行前提：本机 sshd(22) + claude/node 可解析（自检阻断项）——不可达时整组跳过。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { build as esbuild } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServerPackage, createTarball } from '../../../tools/build-server.mjs'
import {
  ensureServer,
  probeServerVersion,
  type EnsureServerResult,
  type LocalServerPackage,
  type ServerInstallProgressEvent
} from '../server-installer'
import { createSshConnectionStack } from '../ssh'
import { RealConnectionManager } from '../ssh/manager'
import { ConnectionsStore, parseConnectionInput } from '../connections-store'
import { ConnectionError } from '../ssh/errors'

const sshPortOpen = (): boolean => {
  try {
    execFileSync('bash', ['-c', 'exec 3<>/dev/tcp/127.0.0.1/22'], { timeout: 3_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const repoRoot = join(__dirname, '..', '..', '..')
const serverSrc = join(repoRoot, 'server', 'src')

describe.skipIf(!sshPortOpen())('S7 L3：localhost sshd 全链（推送→启动→探活→幂等→升级→诊断）', () => {
  let workDir: string
  let home: string // 远端（=本机）安装目录覆写
  let keyPath: string
  let authorizedKeysPath: string
  let manager: RealConnectionManager
  let connectionId: string
  let newPkg: LocalServerPackage
  let oldPkg: LocalServerPackage
  let serverPort: number
  const progressLog: ServerInstallProgressEvent[] = []

  /** 真实远端命令（独立 ssh 进程；失败不抛——stdout/stderr/exit code 全量返回） */
  const sh = (cmd: string): { code: number; stdout: string; stderr: string } => {
    const r = spawnSync(
      'ssh',
      [
        '-i', keyPath,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-p', '22',
        '127.0.0.1',
        cmd
      ],
      { encoding: 'utf8', timeout: 30_000 }
    )
    return { code: r.status ?? 255, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'cwb-s7-l3-'))
    home = join(workDir, 'cwb-home')

    // 1) 本机包（0.1.0）与真·旧版本包（0.0.9——改 version 重 bundle）
    const outDir = join(workDir, 'pkg')
    const m = await buildServerPackage({ outDir: join(outDir, 'new'), quiet: true })
    newPkg = { manifest: m, tgzPath: join(outDir, 'new', m.file) }
    oldPkg = await buildFakeVersionPackage('0.0.9', join(outDir, 'old'), newPkg)

    // 2) 临时密钥对 + authorized_keys 追加（marker 定位，teardown 精确清理）。
    //    ssh-keygen ed25519/OpenSSH 格式：真 sshd 拒 RSA-SHA1 签名、ssh2 keyParser
    //    不吃 node:crypto 的 PKCS8——OpenSSH 私钥两全（S2 mock 测试的 RSA 仅适 ssh2.Server）
    keyPath = join(workDir, 'id_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'cwb-s7-l3'], {
      stdio: 'ignore'
    })
    const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const marker = `# cwb-s7-l3 ${join(workDir, '')}`
    authorizedKeysPath = join(process.env['HOME'] ?? tmpdir(), '.ssh', 'authorized_keys')
    appendFileSync(authorizedKeysPath, `${marker}\n${pub}\n`)

    // 3) 真实连接栈 + TOFU 两步锁定
    mkdirSync(join(workDir, 'store'), { recursive: true })
    const store = new ConnectionsStore(join(workDir, 'store'))
    manager = createSshConnectionStack({ baseDir: join(workDir, 'store') })
    let record = store.save(
      parseConnectionInput('zh', {
        name: 's7-l3',
        host: '127.0.0.1',
        port: 22,
        user: process.env['USER'] ?? 'nobody',
        authMethod: 'key',
        keyPath
      }).record
    )
    connectionId = record.id
    try {
      await manager.connect(connectionId)
    } catch (err) {
      if (err instanceof ConnectionError && err.kind === 'hostKeyConfirm' && err.hostKeyFingerprint !== undefined) {
        record = store.save({ ...record, lastHostKeyFingerprint: err.hostKeyFingerprint })
        expect(record.lastHostKeyFingerprint).toMatch(/^SHA256:/)
        await manager.connect(connectionId)
      } else {
        throw err
      }
    }
    expect(manager.getState(connectionId)).toBe('connected')

    // 4) 动态空闲口（避开 17717 固定口残留——生产默认不变，此处注入测试口）
    serverPort = await new Promise<number>((resolve) => {
      const srv = createNetServer()
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port
        srv.close(() => resolve(p))
      })
    })
  }, 120_000)

  afterAll(() => {
    // 先停 server（防删目录后进程带 deleted fd 残留），再清目录/密钥——全程 best effort
    try {
      if (home !== undefined && existsSync(home)) {
        sh(`kill $(cat ${home}/server.pid) 2>/dev/null`)
      }
    } catch {
      /* ignore */
    }
    try {
      if (home !== undefined && existsSync(home)) sh(`rm -rf ${home}`)
    } catch {
      /* ignore */
    }
    try {
      manager?.disconnect(connectionId)
    } catch {
      /* ignore */
    }
    manager?.disposeAll()
    // authorized_keys 精确移除 marker+key 两行
    try {
      const lines = readFileSync(authorizedKeysPath, 'utf8').split('\n')
      const idx = lines.findIndex((l) => l.startsWith('# cwb-s7-l3 '))
      if (idx >= 0) {
        lines.splice(idx, 2)
        writeFileSync(authorizedKeysPath, lines.join('\n'))
      }
    } catch {
      /* best effort */
    }
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true })
  })

  const opts = (): Parameters<typeof ensureServer>[2] => ({
    mode: 'install',
    serverHome: home,
    port: serverPort,
    healthAttempts: 25,
    healthIntervalMs: 800,
    localPackage: newPkg,
    onProgress: (p) => {
      progressLog.push(p)
    }
  })

  it(
    'check：全新环境 → needInstall（探活不通且无远端目录）',
    async () => {
      const r = await ensureServer(manager, connectionId, { ...opts(), mode: 'check' })
      expect(r).toMatchObject({ ok: false, reason: 'needInstall' })
      expect((r as { message: string }).message).toContain('[cwb:need-server-install]')
    },
    30_000
  )

  it(
    'install：推送→启动→探活 {ok,version}（远端目录/tgz 解包/进程/current 指针全断言）',
    async () => {
      const r = await ensureServer(manager, connectionId, opts())
      expect(r).toEqual({ ok: true, action: 'installed', version: '0.1.0' })

      // 远端目录与产物
      const vdir = `${home}/versions/0.1.0`
      expect(sh(`test -s ${vdir}/dist/main.cjs && test -d ${vdir}/node_modules/node-pty && echo yes`).stdout).toContain('yes')
      // current 指针
      expect(sh(`cat ${home}/current`).stdout.trim()).toBe('0.1.0')
      // pid 文件 + 真实进程（ps 断言 node + server 入口）
      const pid = sh(`cat ${home}/server.pid`).stdout.trim()
      expect(pid).toMatch(/^\d+$/)
      const ps = sh(`ps -o args= -p ${pid}`).stdout
      expect(ps).toContain('node')
      expect(ps).toContain('dist/main.cjs')
      // HTTP 探活（直连与经 SSH 通道双证）
      const probe = await probeServerVersion(manager, connectionId, { port: serverPort })
      expect(probe).toEqual({ ok: true, version: '0.1.0' })
      // 结构化阶段（S6 弹窗消费形态）
      const stages = progressLog.map((p) => p.stage)
      for (const s of ['upload', 'extract', 'start', 'health', 'done']) expect(stages).toContain(s)
    },
    180_000
  )

  it(
    '幂等：版本一致 → action=none 且零动作（无 upload/extract）',
    async () => {
      progressLog.length = 0
      const r = await ensureServer(manager, connectionId, opts())
      expect(r).toEqual({ ok: true, action: 'none', version: '0.1.0' })
      const stages = progressLog.map((p) => p.stage)
      expect(stages).not.toContain('upload')
      expect(stages).not.toContain('extract')
      expect(stages).not.toContain('start')
    },
    60_000
  )

  it(
    '升级路径：真·旧版 0.0.9 运行 → check=needUpgrade → 升级到 0.1.0（旧进程停/新探活/旧版本清理）',
    async () => {
      // 装 0.0.9（旧包）——真旧 server 起来
      const downgrade = await ensureServer(manager, connectionId, { ...opts(), localPackage: oldPkg })
      expect(downgrade).toEqual({ ok: true, action: 'upgraded', version: '0.0.9' })
      expect(await probeServerVersion(manager, connectionId, { port: serverPort })).toEqual({ ok: true, version: '0.0.9' })

      // check：旧版在跑 → needUpgrade（不自动升级）
      const check = await ensureServer(manager, connectionId, { ...opts(), mode: 'check' })
      expect(check).toMatchObject({ ok: false, reason: 'needUpgrade', currentVersion: '0.0.9', expectedVersion: '0.1.0' })

      // 伪造更旧版本目录（清理断言用：保留最近 2 个 → 0.0.5 应被清）
      sh(`mkdir -p ${home}/versions/0.0.5 && touch ${home}/versions/0.0.5/marker`)

      // 显式升级（ServerInstall 通道语义）
      progressLog.length = 0
      const oldPid = sh(`cat ${home}/server.pid`).stdout.trim()
      const up = await ensureServer(manager, connectionId, opts())
      expect(up).toEqual({ ok: true, action: 'upgraded', version: '0.1.0' })
      // 新版本探活 + 旧进程已停
      expect(await probeServerVersion(manager, connectionId, { port: serverPort })).toEqual({ ok: true, version: '0.1.0' })
      expect(sh(`kill -0 ${oldPid} 2>/dev/null && echo alive`).stdout).not.toContain('alive')
      // 版本目录：保留最近 2（0.1.0/0.0.9），0.0.5 清除
      expect(sh(`ls ${home}/versions`).stdout.trim().split(/\s+/)).toEqual(['0.0.9', '0.1.0'])
    },
    240_000
  )

  it(
    '诊断闭环：server 被杀 → check=notRunning + 诊断（node 路径/日志尾部）',
    async () => {
      const pid = sh(`cat ${home}/server.pid`).stdout.trim()
      sh(`kill ${pid}`)
      await new Promise((r) => setTimeout(r, 1_500))
      const r = (await ensureServer(manager, connectionId, { ...opts(), mode: 'check' })) as Extract<
        EnsureServerResult,
        { ok: false }
      >
      expect(r.reason).toBe('notRunning')
      expect(r.diagnostics).toBeDefined()
      expect(r.diagnostics).toContain('node=')
      expect(r.diagnostics).toContain('log tail:')
      expect(r.diagnostics).toContain('pid=')
    },
    60_000
  )
})

/** 真·旧版本包：server/src + version 改写 → 重 bundle → 复用新版 node_modules → tgz */
async function buildFakeVersionPackage(
  version: string,
  outDir: string,
  basePkg: LocalServerPackage
): Promise<LocalServerPackage> {
  const tree = mkdtempSync(join(tmpdir(), `cwb-s7-old-${version}-`))
  try {
    cpSync(serverSrc, join(tree, 'src'), { recursive: true })
    cpSync(join(repoRoot, 'server', 'package.json'), join(tree, 'package.json'))
    const pkg = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as { version: string }
    pkg.version = version
    writeFileSync(join(tree, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    const stage = join(tree, 'stage')
    mkdirSync(join(stage, 'dist'), { recursive: true })
    await esbuild({
      entryPoints: [join(tree, 'src', 'main.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: join(stage, 'dist', 'main.cjs'),
      external: ['node-pty', 'ws'],
      logLevel: 'silent'
    })
    // node_modules：解新版 tgz 取（同一份原生负载）；package.json 用改写版（版本一致）
    mkdirSync(join(tree, 'extract'))
    execFileSync('tar', ['-xzf', basePkg.tgzPath, '-C', join(tree, 'extract')])
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    cpSync(join(tree, 'extract', 'node_modules'), join(stage, 'node_modules'), { recursive: true })
    // 确定性 tgz（createTarball 已含 gzip 层——勿再包一层）+ manifest（sha256 供上传校验）
    const { createHash } = await import('node:crypto')
    const tgzBytes = createTarball(stage, ['dist', 'node_modules', 'package.json'])
    mkdirSync(outDir, { recursive: true })
    const file = `server-${version}.tgz`
    writeFileSync(join(outDir, file), tgzBytes)
    return {
      manifest: {
        version,
        file,
        sha256: createHash('sha256').update(tgzBytes).digest('hex'),
        sizeBytes: tgzBytes.length,
        fileCount: 0
      },
      tgzPath: join(outDir, file)
    }
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
}
