/**
 * S8 ABI 跨版本验证（O6；design §4-S8「模拟：改 vendor pty.node 后验证报错路径」）：
 * tgz 内 pty.node 换成假文件（echo garbage > pty.node）+ manifest sha256 同步重算
 * （保持上传校验自洽——模拟的是「远端 node 加载不了这份原生负载」，即真实 ABI
 * 不匹配/损坏二进制的等价故障面，而非传输损坏）→ ensureServer install：
 * 推送/解压照常成功（排除了上传层噪音）→ 启动即加载失败 → 健康探测必须报
 * healthFailed，且诊断含 node-gyp rebuild 修复指引（错误路径断言，非真跨版本）。
 *
 * 运行前提：本机 sshd(22)——不可达时整组跳过（S7 L3 同款守卫）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServerPackage, createTarball } from '../../../tools/build-server.mjs'
import {
  ensureServer,
  type LocalServerPackage
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

describe.skipIf(!sshPortOpen())('S8 ABI 假文件路径：损坏 pty.node → healthFailed + rebuild 指引', () => {
  let workDir: string
  let home: string
  let keyPath: string
  let authorizedKeysPath: string
  let manager: RealConnectionManager
  let connectionId: string
  let corruptPkg: LocalServerPackage

  /** 独立 ssh 进程执行远端命令（失败不抛——全量返回） */
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
    workDir = mkdtempSync(join(tmpdir(), 'cwb-s8-abi-'))
    home = join(workDir, 'cwb-home')

    // 1) 好包 → 解包换假 pty.node → 重打包 + manifest sha256 重算（校验自洽）
    const good = await buildServerPackage({ outDir: join(workDir, 'pkg-good'), quiet: true })
    const stage = join(workDir, 'stage')
    mkdirSync(stage, { recursive: true })
    execFileSync('tar', ['-xzf', join(workDir, 'pkg-good', good.file), '-C', stage])
    const ptyNode = join(stage, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    if (!existsSync(ptyNode)) throw new Error(`pty.node 不在预期路径: ${ptyNode}`)
    writeFileSync(ptyNode, 'garbage — not an ELF shared object (cwb-s8-abi fake payload)\n')
    const tgzBytes = createTarball(stage, ['dist', 'node_modules', 'package.json'])
    const outDir = join(workDir, 'pkg-corrupt')
    mkdirSync(outDir, { recursive: true })
    const file = `server-${good.version}.fake-abi.tgz`
    writeFileSync(join(outDir, file), tgzBytes)
    corruptPkg = {
      manifest: {
        ...good,
        file,
        sha256: createHash('sha256').update(tgzBytes).digest('hex'),
        sizeBytes: tgzBytes.length
      },
      tgzPath: join(outDir, file)
    }

    // 2) 临时密钥对 + authorized_keys marker 追加（surgical teardown；S5/S7 先例）
    keyPath = join(workDir, 'id_ed25519')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'cwb-s8-abi'], {
      stdio: 'ignore'
    })
    const pub = readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const marker = `# cwb-s8-abi ${join(workDir, '')}`
    authorizedKeysPath = join(process.env['HOME'] ?? tmpdir(), '.ssh', 'authorized_keys')
    appendFileSync(authorizedKeysPath, `${marker}\n${pub}\n`)

    // 3) 真实连接栈 + TOFU 两步锁定
    mkdirSync(join(workDir, 'store'), { recursive: true })
    const store = new ConnectionsStore(join(workDir, 'store'))
    manager = createSshConnectionStack({ baseDir: join(workDir, 'store') })
    let record = store.save(
      parseConnectionInput('zh', {
        name: 's8-abi',
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
        await manager.connect(connectionId)
      } else {
        throw err
      }
    }
    expect(manager.getState(connectionId)).toBe('connected')
  }, 120_000)

  afterAll(() => {
    try {
      if (home !== undefined && existsSync(home)) {
        sh(`kill $(cat ${home}/server.pid) 2>/dev/null`)
        sh(`rm -rf ${home}`)
      }
    } catch {
      /* ignore */
    }
    try {
      manager?.disconnect(connectionId)
    } catch {
      /* ignore */
    }
    manager?.disposeAll()
    // authorized_keys surgical 清理（marker+key 两行）+ wc 复核（checkpoint 纪律）
    try {
      const lines = readFileSync(authorizedKeysPath, 'utf8').split('\n')
      // v2.0.1 健壮化：循环删全部 marker 对（此前失败运行遗留孤儿/重复时，单次
      // splice 清不净 → 复核断言永红——环境级级联，本测试无法自愈）
      let idx = lines.findIndex((l) => l.startsWith('# cwb-s8-abi '))
      while (idx >= 0) {
        lines.splice(idx, 2)
        idx = lines.findIndex((l) => l.startsWith('# cwb-s8-abi '))
      }
      writeFileSync(authorizedKeysPath, lines.join('\n'))
      const after = readFileSync(authorizedKeysPath, 'utf8')
      expect(after.includes('# cwb-s8-abi ')).toBe(false)
      expect(after.trim().split('\n').filter((l) => l !== '').length).toBeGreaterThanOrEqual(1)
      console.log('[s8-abi] authorized_keys 清理后非空行数:', after.trim().split('\n').filter((l) => l !== '').length)
    } catch (err) {
      throw new Error(`authorized_keys 清理复核失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true })
  })

  it(
    'install：损坏负载上传/解压成功但启动加载失败 → healthFailed + 诊断含加载错误现场',
    async () => {
      const r = await ensureServer(manager, connectionId, {
        mode: 'install',
        serverHome: home,
        port: 17_720, // 专用口：不与真实安装/S3 L3 的 17717 互踩
        healthAttempts: 3,
        healthIntervalMs: 500,
        localPackage: corruptPkg
      })
      expect(r.ok).toBe(false)
      const fail = r as Extract<typeof r, { ok: false }>
      expect(fail.reason).toBe('healthFailed')
      // 诊断：node 路径 + pid 已死 + 日志尾部带真实加载错误现场（loadNativeModule 帧）
      expect(fail.diagnostics).toBeDefined()
      expect(fail.diagnostics).toContain('node=')
      expect(fail.diagnostics).toMatch(/pid=\d+\(dead\)/)
      expect(fail.diagnostics).toContain('log tail:')
      expect(fail.diagnostics).toContain('Failed to load native module: pty.node')
      expect(fail.diagnostics).toContain('npm rebuild') // 修复后补的 HINT 断言（S8 注释承诺）
      console.log('[s8-abi] healthFailed 诊断（脱敏）:', fail.diagnostics)
      // 远端取证：S7 缺陷（tail -n 15 截掉消息行）已由主控修复为 tail -n 40——
      // 上方诊断断言已含消息行与 npm rebuild HINT；此处保留原文 cat 取证交叉验证。
      const log = await manager.exec(connectionId, `cat ${home}/server.log`)
      console.log('[s8-abi] server.log 总行数:', log.stdout.split('\n').length)
      const msgLine = log.stdout
        .split('\n')
        .find((l) => l.includes('Failed to load native module: pty.node'))
      console.log('[s8-abi] 加载错误消息行:', JSON.stringify(msgLine?.slice(0, 200)))
      expect(msgLine).toBeDefined()
      expect(msgLine).toContain('pty.node')
      const tail40 = log.stdout.split('\n').slice(-40).join('\n')
      console.log('[s8-abi] tail -n 40 是否含消息行:', tail40.includes('pty.node'))
      expect(tail40.includes('pty.node')).toBe(true) // S7 缺陷已修（15→40）：诊断窗口覆盖加载错误行
      expect(tail40).toContain('Failed to load native module: pty.node')
    },
    120_000
  )

  it(
    'check：同一损坏安装 → notRunning + 诊断闭环（node/pid/日志尾部）',
    async () => {
      const r = await ensureServer(manager, connectionId, {
        mode: 'check',
        serverHome: home,
        port: 17_720,
        localPackage: corruptPkg
      })
      const fail = r as Extract<typeof r, { ok: false }>
      expect(fail.reason).toBe('notRunning')
      expect(fail.diagnostics).toContain('node=')
      expect(fail.diagnostics).toContain('log tail:')
    },
    60_000
  )
})
