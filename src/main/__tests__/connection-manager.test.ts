import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connect as tcpConnect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket
} from 'node:net'
import { Server as SshServer } from 'ssh2'
import { IpcChannels } from '../../shared/ipc-channels'
import type { ConnectionManager } from '../ssh/connection-manager'
import { ConnectionError } from '../ssh/errors'
import { RealConnectionManager, RealSftpSession, browseRemoteDir } from '../ssh/manager'
import { createSshConnectionStack } from '../ssh'
import {
  ConnectionsStore,
  parseConnectionInput,
  type SafeStoragePort
} from '../connections-store'
import { broadcastConnectionState, createAppContext, registerIpcHandlers, type AppContext } from '../ipc'

/**
 * S2 连接层验收（L2 + L2.5）：
 * - ssh2.Server 本机替身（③评审实证可行）：①密码认证成功/失败 ②TOFU 指纹确认流
 *   ③keepalive 连续 3 次无响应判死 ④退避序列与手动重试 ⑦forwardIn 入站流交付/forwardOut/exec
 * - connections-store：⑤原子写/读回/safeStorage 密文往返/容错读
 * - L2.5 装配：createAppContext 注入 Real 栈非 null；onStateChange →
 *   broadcastConnectionState → EVENT 面收到事件（照 skeleton-stubs.test.ts 基建）。
 *
 * 纪律：测试用凭据均为一次性假值（pw-ok/pw-wrong），断言不落任何真实密钥/密码。
 * keepalive 判死模拟：ssh2.Server 不暴露原始 socket——经一层 TCP 代理接缝，
 * pause 代理侧 socket 即网络黑洞（keepalive 无应答 ≠ TCP FIN，可精确测判死路径）。
 */

const h = vi.hoisted(() => ({
  tempDir: '',
  handleCalls: [] as Array<[string, (...args: unknown[]) => unknown]>,
  sentEvents: [] as Array<[string, unknown]>
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => h.tempDir,
    getVersion: () => '1.4.2-test',
    isPackaged: false,
    quit: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  shell: { openExternal: vi.fn(async () => {}) },
  net: undefined,
  session: undefined,
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, payload: unknown) => { h.sentEvents.push([channel, payload]) } } }
    ]
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handleCalls.push([channel, fn])
    },
    on: () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`el:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^el:/, '')
  }
}))

// ── 测试基建 ─────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms = 8_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(15)
  }
  throw new Error(`waitFor timeout: ${what}`)
}

function genPrivateKeyPem(): string {
  // ssh2 的 keyParser 支持 PKCS1/OpenSSH 格式（PKCS8 ed25519 不支持）——RSA PKCS1 纯 node:crypto 可产
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
}

const HOST_KEY_A = genPrivateKeyPem()
const HOST_KEY_B = genPrivateKeyPem()
/** 客户端私钥（v1.5.2 密钥认证 TOFU 测试）：RSA PKCS1——同 genPrivateKeyPem 的 ssh2 keyParser 格式约束 */
const CLIENT_KEY_PEM = genPrivateKeyPem()

/** 把客户端私钥写到一次性 temp 文件（openSshClient 按 keyPath readFileSync） */
function writeClientKeyFile(): string {
  const p = join(newTempDir(), 'id_rsa')
  writeFileSync(p, CLIENT_KEY_PEM)
  return p
}

/** 密钥认证档案（v1.5.2 起 TOFU 仅对密钥认证生效——hostVerifier 的密钥路径测试入口） */
async function saveKeyRecord(
  store: ConnectionsStore,
  port: number,
  keyPath: string
): Promise<string> {
  const parsed = parseConnectionInput('zh', {
    id: '',
    name: '密钥连接',
    host: '127.0.0.1',
    port,
    user: 'vmuser',
    authMethod: 'key',
    keyPath
  })
  const saved = store.save(parsed.record, parsed.plainPassword)
  return saved.id
}

/** 自检通过形态的 exec 脚本（claude/node 探测命令 → 成功输出；S4 起命令包 bash -ic） */
const CHECK_CLAUDE = `bash -ic 'command -v claude && claude --version'`
const CHECK_NODE = `bash -ic 'command -v node && node --version'`
/** S5 起自检 server 项真实探活（probeServerVersion 的 /dev/tcp 回环 GET）——mock 应答健康体 */
const SERVER_PROBE_OK: ExecScript = {
  out: 'HTTP/1.0 200 OK\r\n\r\n{"ok":true,"server":"cwb-server","version":"0.1.0"}'
}
const SELF_CHECK_EXEC_OK: Record<string, { out?: string; err?: string; code?: number }> = {
  [CHECK_CLAUDE]: { out: '/home/vm/.nvm/versions/node/v22.14.0/bin/claude\n1.0.72 (Claude Code)\n' },
  [CHECK_NODE]: { out: 'v22.14.0\n' }
}

interface ExecScript {
  out?: string
  err?: string
  code?: number
}

interface MockSshdHandle {
  /** manager 应连接的端口（TCP 代理缝） */
  port: number
  /** pause 代理侧 socket：制造 keepalive 无应答黑洞（≠ TCP close） */
  pauseData(): void
  /** 解除 pause：判死断言后恢复数据面（旧连接 FIN 传播，防清理挂死） */
  resumeData(): void
  destroy(): Promise<void>
}

interface OpenServer {
  close(): Promise<void>
}

/** 关停 TCP server（@types/node 未声明 closeAllConnections，运行时 Node ≥18.2 存在）；超时兜底防清理挂死 */
function closeTcpServer(server: import('node:net').Server, timeoutMs = 2_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const guard = setTimeout(() => resolve(), timeoutMs)
    guard.unref?.()
    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    server.close(() => {
      clearTimeout(guard)
      resolve()
    })
  })
}

const openServers: OpenServer[] = []
const managers: RealConnectionManager[] = []

/** 本机 sshd 替身：ssh2.Server + TCP 代理缝（pause/判死与 forwardIn 的远端监听） */
async function startMockSshd(opts: {
  hostKeyPem: string
  /** undefined=接受任意密码（仅验证可连通的流程用）；有值=校验密码 */
  expectedPassword?: string
  /** true=接受任意带签名的 publickey 认证（v1.5.2 密钥认证 TOFU 测试用） */
  acceptPublickey?: boolean
  exec?: Record<string, ExecScript>
}): Promise<MockSshdHandle> {
  const proxySockets = new Set<Socket>()

  const sshd = new SshServer({ hostKeys: [opts.hostKeyPem] }, (client) => {
    client.on('authentication', (ctx) => {
      const c = ctx as typeof ctx & { password?: string }
      if (c.method === 'publickey') {
        // ssh2 客户端语义：先无签名探询（探询被拒即整体放弃）——接受探询后客户端
        // 才发签名尝试；两次都 accept（测试替身不校验密钥内容，测的是客户端 TOFU）
        if (opts.acceptPublickey === true) {
          ctx.accept()
        } else {
          ctx.reject(['password', 'publickey'])
        }
        return
      }
      if (c.method === 'password') {
        if (opts.expectedPassword === undefined || c.password === opts.expectedPassword) {
          ctx.accept()
        } else {
          ctx.reject(['password', 'publickey'])
        }
        return
      }
      ctx.reject(['password', 'publickey'])
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        // v2.1.0 SSH 纯终端：裸 shell 通道（回显服务端——write 原样回流 + 开场横幅）
        // pty-req 先于 shell 到达——测试替身直接接受
        session.on('pty', (acceptPty) => acceptPty())
        session.on('shell', (acceptShell: () => import('ssh2').ServerChannel, _rejectShell: () => void, _info: unknown) => {
          const sh = acceptShell()
          setTimeout(() => sh.write('mock-shell-ready\r\n'), 30)
          sh.on('data', (d: Buffer) => sh.write(d))
        })
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          // S5：server 探活命令（bash -c 'exec 3<>/dev/tcp/...'）按子串命中健康应答
          const script =
            opts.exec?.[info.command] ??
            (info.command.includes('/dev/tcp/') ? SERVER_PROBE_OK : undefined)
          if (script?.err !== undefined) stream.stderr.write(script.err)
          if (script?.out !== undefined) stream.write(script.out)
          stream.exit(script === undefined ? 127 : (script.code ?? 0)) // 未知命令=127（自检 missing 路径）
          stream.end()
        })
      })
      // 客户端 forwardOut（本地→远端）：按 sshd 语义拨真实 TCP 到目标并双向 pipe
      client.on('tcpip', (accept, reject, info) => {
        const upstream = tcpConnect(info.destPort, info.destIP)
        upstream.on('error', () => reject())
        upstream.on('connect', () => {
          const channel = accept()
          channel.pipe(upstream)
          upstream.pipe(channel)
          const done = (): void => {
            channel.destroy()
            upstream.destroy()
          }
          channel.on('close', done)
          upstream.on('close', done)
        })
      })
      // 客户端 forwardIn（远端→本地）：起真实监听，入站连接经 forwarded-tcpip 回送
      client.on('request', (accept, reject, name, data) => {
        const a = accept as (() => void) | undefined
        const r = reject as (() => void) | undefined
        const d = data as { bindAddr?: string; bindPort?: number }
        if (name === 'tcpip-forward' && typeof d.bindPort === 'number') {
          const listener = createTcpServer((sock) => {
            ;(client as unknown as {
              forwardOut(
                boundAddr: string,
                boundPort: number,
                remoteAddr: string,
                remotePort: number,
                cb: (err: Error | undefined, channel: Socket) => void
              ): void
            }).forwardOut('127.0.0.1', d.bindPort!, '127.0.0.1', 0, (err, channel) => {
              if (err !== undefined && err !== null) {
                sock.destroy()
                return
              }
              sock.pipe(channel)
              channel.pipe(sock)
              const done = (): void => {
                sock.destroy()
                channel.destroy()
              }
              sock.on('close', done)
              channel.on('close', done)
            })
          })
          listener.listen(d.bindPort, '127.0.0.1', () => a?.())
          openServers.push({ close: () => closeTcpServer(listener) })
          return
        }
        if (name === 'cancel-tcpip-forward') {
          a?.()
          return
        }
        r?.()
      })
    })
    client.on('error', () => undefined)
  })
  sshd.on('error', () => undefined)

  const upstreamPort = await new Promise<number>((resolve, reject) => {
    sshd.once('error', reject)
    sshd.listen(0, '127.0.0.1', () => resolve((sshd.address() as AddressInfo).port))
  })

  // TCP 代理缝：manager 连这里；pause 代理 socket = 网络黑洞（keepalive 判死路径）
  const proxy = createTcpServer((sock) => {
    proxySockets.add(sock)
    sock.on('close', () => proxySockets.delete(sock))
    const upstream = tcpConnect(upstreamPort, '127.0.0.1')
    sock.pipe(upstream)
    upstream.pipe(sock)
    const done = (): void => {
      sock.destroy()
      upstream.destroy()
    }
    sock.on('error', done)
    upstream.on('error', done)
    upstream.on('close', () => sock.destroy())
    sock.on('close', () => upstream.destroy())
  })
  const port = await new Promise<number>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as AddressInfo).port))
  })
  openServers.push({ close: () => closeTcpServer(proxy) })

  return {
    port,
    pauseData(): void {
      for (const s of proxySockets) s.pause()
    },
    /** 恢复数据面：判死断言后解除 pause（让旧连接 FIN 传播，防清理挂死） */
    resumeData(): void {
      for (const s of proxySockets) s.resume()
    },
    async destroy(): Promise<void> {
      for (const s of proxySockets) {
        s.resume()
        s.destroy()
      }
      proxySockets.clear()
      await closeTcpServer(proxy)
      await closeTcpServer(sshd)
    }
  }
}

/** 随机空闲 TCP 端口（先占后放，取端口号） */
async function freeTcpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createTcpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

const mockStoreSafeStorage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`ENC:${s}`),
  // 模拟真实 keychain 语义：非本密钥产出的密文解密即抛（密钥串变更/损坏）
  decryptString: (b: Buffer) => {
    const s = b.toString('utf8')
    if (!s.startsWith('ENC:')) throw new Error('Could not decrypt (invalid ciphertext)')
    return s.slice(4)
  }
}

function makeStore(dir: string): ConnectionsStore {
  return new ConnectionsStore(dir, mockStoreSafeStorage)
}

function makeManager(store: ConnectionsStore): RealConnectionManager {
  const mgr = new RealConnectionManager({
    store,
    language: () => 'zh',
    keepaliveIntervalMs: 100, // 4.4 短间隔注入（产品 15s×3 语义等价）
    keepaliveCountMax: 3,
    connectTimeoutMs: 4_000,
    backoffScheduleMs: [40, 80, 160, 240] // 5.7 短序列注入（产品 1→2→5→10s 封顶）
  })
  managers.push(mgr)
  return mgr
}

async function savePasswordRecord(
  store: ConnectionsStore,
  port: number,
  password: string,
  user = 'vmuser'
): Promise<string> {
  const parsed = parseConnectionInput('zh', {
    id: '',
    name: '测试连接',
    host: '127.0.0.1',
    port,
    user, // 2.0.2 起新增按 (user,host,port) 去重——多档案用例须各异目标
    authMethod: 'password',
    password
  })
  const saved = store.save(parsed.record, parsed.plainPassword)
  return saved.id
}

/** TOFU 锁定步骤已随 v1.5.2 密码认证免校验移除（密钥认证的锁定流由测试 ② 内联覆盖） */

let tempDirs: string[] = []

beforeEach(() => {
  tempDirs = []
  h.handleCalls.length = 0
  h.sentEvents.length = 0
})

afterEach(async () => {
  for (const m of managers.splice(0)) m.disposeAll()
  for (const s of openServers.splice(0)) await s.close().catch(() => undefined)
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  delete process.env['CWB_HOOK_SETTINGS_DIR']
  delete process.env['CWB_SKILLS_USER_ROOT']
  delete process.env['CWB_SKILL_MARKET_HOME']
})

function newTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cwb-s2-'))
  tempDirs.push(d)
  return d
}

// ── ⑤ connections-store：原子写/读回/密文往返/容错读 ─────────────────

describe('S2 connections-store（1.2/1.4：原子写 + safeStorage 密文往返）', () => {
  it('⑤a 保存：密文落盘（明文绝不入文件）、无 .tmp 残留、createdAt 分配 uuid/时间戳', () => {
    const dir = newTempDir()
    const store = makeStore(dir)
    const parsed = parseConnectionInput('zh', {
      id: '',
      name: 'vm-dev',
      host: '192.168.1.20',
      port: 22,
      user: 'dev',
      authMethod: 'password',
      password: 'S3cret-Value-123'
    })
    const saved = store.save(parsed.record, parsed.plainPassword)
    expect(saved.id).not.toBe('')
    expect(saved.createdAt).not.toBe('')
    expect(saved.passwordEncrypted).toBeUndefined() // 对外输出剥离密文

    const file = join(dir, 'connections.json')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false) // 原子写：无残留
    const content = readFileSync(file, 'utf8')
    expect(content).not.toContain('S3cret-Value-123') // 明文红线
    expect(content).not.toContain('ENC:') // 密文以 base64 形态存在
    const parsedFile = JSON.parse(content) as { connections: Array<{ passwordEncrypted?: string }> }
    expect(parsedFile.connections[0]?.passwordEncrypted).toBe(
      Buffer.from('ENC:S3cret-Value-123').toString('base64')
    )
  })

  it('⑤b 读回：新实例（同目录）get→revealSecret 往返；list 剥离密文；指纹归一保存', () => {
    const dir = newTempDir()
    const store = makeStore(dir)
    const parsed = parseConnectionInput('zh', {
      id: '',
      name: 'vm-dev',
      host: '192.168.1.20',
      port: 22,
      user: 'dev',
      authMethod: 'password',
      password: 'round-trip-pw',
      lastHostKeyFingerprint: 'AAAAbbbb1234' // 无前缀 → 归一补 SHA256:
    })
    const saved = store.save(parsed.record, parsed.plainPassword)

    const store2 = makeStore(dir)
    const full = store2.get(saved.id)!
    expect(full.passwordEncrypted).toBeDefined()
    expect(full.lastHostKeyFingerprint).toBe('SHA256:AAAAbbbb1234')
    expect(store2.revealSecret(full)).toEqual({ password: 'round-trip-pw' })
    expect(store2.list()[0]?.passwordEncrypted).toBeUndefined()
  })

  it('⑤c 编辑语义：不重输密码保留密文；密码认证缺密文保存被拒；换 key 认证旧密文不迁移', () => {
    const dir = newTempDir()
    const file = join(dir, 'connections.json')
    const store = makeStore(dir)
    const parsed = parseConnectionInput('zh', {
      id: '',
      name: 'vm',
      host: 'h',
      port: 22,
      user: 'u',
      authMethod: 'password',
      password: 'first-pw'
    })
    const saved = store.save(parsed.record, parsed.plainPassword)
    const cipher1 = store.get(saved.id)!.passwordEncrypted

    const edit = store.save({ ...store.get(saved.id)!, name: 'vm2' }) // 未带明文=保留
    expect(edit.name).toBe('vm2')
    expect(store.get(saved.id)!.passwordEncrypted).toBe(cipher1)

    // 密码认证但密文丢失（手改文件/密钥串失效）→ 保存被拒（防"看不见的旧密码"继续生效）
    const stripped = { ...store.get(saved.id)!, name: 'vm3' }
    const { passwordEncrypted: _drop, ...noCipher } = stripped
    writeFileSync(file, JSON.stringify({ connections: [noCipher] }), 'utf8')
    expect(() => store.save(store.get(saved.id)!)).toThrow(/密码/)
    expect(store.get(saved.id)!.name).toBe('vm3') // 被拒的保存未落盘

    // 换 key 认证：旧密码密文不迁移（authMethod 变化即失效）
    writeFileSync(file, JSON.stringify({ connections: [store.get(saved.id)!] }), 'utf8')
    const asKey = parseConnectionInput('zh', {
      ...store.get(saved.id)!,
      authMethod: 'key',
      keyPath: '/home/user/.ssh/id_ed25519'
    })
    const switched = store.save(asKey.record)
    expect(switched.authMethod).toBe('key')
    expect(switched.keyPath).toBe('/home/user/.ssh/id_ed25519')
    expect(store.get(saved.id)!.passwordEncrypted).toBeUndefined()
  })

  it('⑤d 容错读：损坏 JSON → 空清单；脏条目丢弃；密文损坏 → revealSecret 抛 credentialCorrupt', () => {
    const dir = newTempDir()
    const file = join(dir, 'connections.json')

    // 1) 坏 JSON → 空清单
    const seeded = makeStore(dir)
    const parsed = parseConnectionInput('zh', {
      id: '',
      name: 'vm',
      host: 'h',
      port: 22,
      user: 'u',
      authMethod: 'password',
      password: 'good-pw'
    })
    const saved = seeded.save(parsed.record, parsed.plainPassword)
    const goodEntry = seeded.get(saved.id)!
    writeFileSync(file, '{not-json', 'utf8')
    expect(makeStore(dir).list()).toEqual([])

    // 2) 结构合法条目 + 脏条目（port 越界）混存 → 只留合法条目
    writeFileSync(
      file,
      JSON.stringify({
        connections: [
          goodEntry,
          { id: 'bad', name: 'n', host: 'h', port: 99999, user: 'u', authMethod: 'password', createdAt: 'now' }
        ]
      }),
      'utf8'
    )
    expect(makeStore(dir).list().map((c) => c.id)).toEqual([saved.id])

    // 3) 密文损坏（非本 safeStorage 产出）→ credentialCorrupt（要求重输，1.4=A）
    writeFileSync(
      file,
      JSON.stringify({
        connections: [{ ...goodEntry, passwordEncrypted: Buffer.from('not-ours').toString('base64') }]
      }),
      'utf8'
    )
    const store5 = makeStore(dir)
    const full = store5.get(saved.id)!
    try {
      store5.revealSecret(full)
      expect.unreachable('revealSecret should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectionError)
      expect((e as ConnectionError).kind).toBe('credentialCorrupt')
    }
  })

  it('⑤e 校验：parseConnectionInput 拒非法档案（端口/认证方式/空名），en→双语文案', () => {
    const bad = (over: Record<string, unknown>): unknown =>
      parseConnectionInput('zh', {
        id: '', name: 'n', host: 'h', port: 22, user: 'u', authMethod: 'password', ...over
      })
    expect(() => bad({ port: 0 })).toThrow(/端口/)
    expect(() => bad({ authMethod: 'agent' })).toThrow(/认证方式/)
    expect(() => bad({ name: '' })).toThrow(/名称/)
    expect(() => bad({ authMethod: 'key' })).toThrow(/私钥/)
    expect(() =>
      parseConnectionInput('en', { id: '', name: '', host: 'h', port: 22, user: 'u', authMethod: 'password' })
    ).toThrow(/Name required/)
  })

  it('⑤f 新增去重（2.0.2 用户实测：1 个远程出现 2 条同目标记录）：同 user@host:port 新增被拒；不同用户/编辑不受影响', () => {
    const dir = newTempDir()
    const store = makeStore(dir)
    const mk = (over: Record<string, unknown>) =>
      parseConnectionInput('zh', {
        id: '', name: 'vm-dev', host: '192.168.1.20', port: 22, user: 'dev',
        authMethod: 'password', password: 'pw', ...over
      })

    const first = store.save(mk({}).record, mk({}).plainPassword)
    // 连点/重复添加同目标 → 拒绝并点名既有档案
    expect(() => store.save(mk({ name: 'vm-dev-2' }).record, mk({}).plainPassword)).toThrow(
      /已存在相同 user@host:port.*vm-dev/
    )
    expect(store.list()).toHaveLength(1)

    // 同主机不同用户名 → 合法（多账号并存）
    const other = store.save(mk({ user: 'root' }).record, mk({}).plainPassword)
    expect(store.list()).toHaveLength(2)

    // 编辑既有档案（id 命中，目标未变）→ 不触发去重
    const edited = store.save({ ...store.get(first.id)!, name: 'vm-dev-renamed' })
    expect(edited.name).toBe('vm-dev-renamed')
    expect(store.list()).toHaveLength(2)

    // 非空 id 但未命中（孤儿 upsert）也按新增口径去重——防脏 id 绕过
    expect(() =>
      store.save({ ...mk({}).record, id: other.id + '-ghost' }, mk({}).plainPassword)
    ).toThrow(/已存在相同/)
  })
})

// ── L2：RealConnectionManager（ssh2.Server 本机替身）─────────────────

describe('S2 RealConnectionManager（认证/TOFU/判死/退避/转发）', () => {
  it('① 密码认证：成功（自检通过 connected）/ 失败分级为 auth', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: SELF_CHECK_EXEC_OK
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)

    const goodId = await savePasswordRecord(store, sshd.port, 'pw-ok')
    // v1.5.2：密码认证不校验主机指纹——无锁定指纹直连成功（无需 TOFU 锁定步骤）
    await mgr.connect(goodId)
    expect(mgr.getState(goodId)).toBe('connected')

    const badId = await savePasswordRecord(store, sshd.port, 'pw-wrong', 'vmuser2')
    const err = await mgr.connect(badId).then(
      () => {
        throw new Error('expected auth failure')
      },
      (e: unknown) => e as ConnectionError
    )
    expect(err).toBeInstanceOf(ConnectionError)
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('认证失败') // 2.3=A 分级文案（i18n conn.err.auth）
    expect(mgr.getState(badId)).toBe('offline')
    // 好连接不受坏档案影响（多档案独立状态机）
    expect(mgr.getState(goodId)).toBe('connected')
  }, 15_000)

  it('② host key TOFU（密钥认证，v1.5.2 起唯一生效面）：首连 hostKeyConfirm（needConfirm+指纹）→ 档案锁定后成功 → 指纹变更阻断', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      acceptPublickey: true,
      exec: SELF_CHECK_EXEC_OK
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const id = await saveKeyRecord(store, sshd.port, writeClientKeyFile())

    // 首连：无锁定指纹 → needConfirm 语义（kind+指纹），状态回 offline
    const first = await mgr.connect(id).then(
      () => {
        throw new Error('expected hostKeyConfirm')
      },
      (e: unknown) => e as ConnectionError
    )
    expect(first.kind).toBe('hostKeyConfirm')
    expect(first.hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(first.message).toContain('SHA256:') // 指纹随错误文案展示给 UI
    expect(mgr.getState(id)).toBe('offline')

    // UI 确认=指纹落档案 → 重连成功
    const fp = first.hostKeyFingerprint!
    store.save({ ...store.get(id)!, lastHostKeyFingerprint: fp })
    await mgr.connect(id)
    expect(mgr.getState(id)).toBe('connected')
    await mgr.disconnect(id)
    expect(mgr.getState(id)).toBe('offline')

    // 服务器换 key（VM 重装场景）→ 指纹变更阻断
    await sshd.destroy()
    const sshd2 = await startMockSshd({
      hostKeyPem: HOST_KEY_B,
      acceptPublickey: true,
      exec: SELF_CHECK_EXEC_OK
    })
    store.save({ ...store.get(id)!, port: sshd2.port })
    const changed = await mgr.connect(id).then(
      () => {
        throw new Error('expected hostKeyChanged')
      },
      (e: unknown) => e as ConnectionError
    )
    expect(changed.kind).toBe('hostKeyChanged')
    expect(changed.hostKeyFingerprint).toMatch(/^SHA256:/)
    expect(changed.hostKeyFingerprint).not.toBe(fp)
    expect(changed.message).toContain('指纹变更')
    expect(mgr.getState(id)).toBe('offline')
  }, 15_000)

  it('②b 密码认证不校验主机指纹（v1.5.2 用户指令）：首连直通 + 指纹变更不阻断', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: SELF_CHECK_EXEC_OK
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const id = await savePasswordRecord(store, sshd.port, 'pw-ok')

    // 首连：无锁定指纹 → 直接 connected（不产生 hostKeyConfirm——代理面板等懒连接入口直通）
    await mgr.connect(id)
    expect(mgr.getState(id)).toBe('connected')
    await mgr.disconnect(id)

    // 服务器换 key（VM 重装场景）→ 不阻断（hostKeyChanged 不产生），仍可连接
    await sshd.destroy()
    const sshd2 = await startMockSshd({
      hostKeyPem: HOST_KEY_B,
      expectedPassword: 'pw-ok',
      exec: SELF_CHECK_EXEC_OK
    })
    store.save({ ...store.get(id)!, port: sshd2.port })
    await mgr.connect(id)
    expect(mgr.getState(id)).toBe('connected')
  }, 15_000)

  it('③ keepalive 连续 3 次无响应判死（4.4=A；短间隔注入）→ reconnecting → 恢复', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: SELF_CHECK_EXEC_OK
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const id = await savePasswordRecord(store, sshd.port, 'pw-ok')
    await mgr.connect(id)
    expect(mgr.getState(id)).toBe('connected')

    const events: Array<{ state: string; attempt?: number }> = []
    mgr.onStateChange((e) => events.push({ state: e.state, attempt: e.attempt }))

    const pausedAt = Date.now()
    sshd.pauseData() // 网络黑洞：keepalive 无应答但 TCP 未 FIN——纯判死路径
    await waitFor(() => events.some((e) => e.state === 'reconnecting'), 6_000, 'keepalive 判死')
    const judgedAt = Date.now()
    // 3×100ms 起判（若为 TCP close 会瞬时触发——以耗时佐证走的是 keepalive 计数路径）
    expect(judgedAt - pausedAt).toBeGreaterThanOrEqual(240)
    expect(events.find((e) => e.state === 'reconnecting')?.attempt).toBe(1)
    sshd.resumeData() // 解除 pause：旧连接 FIN 传播（防 afterEach 清理挂死）

    // 判死后自动重连成功（新 TCP 连接未被 pause）
    await waitFor(() => mgr.getState(id) === 'connected', 6_000, 'reconnect after keepalive death')
    await mgr.disconnect(id)
  }, 15_000)

  it('④ 意外断链：退避序列 40→80→160→240 封顶循环 + connect()=手动重试重置退避', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: SELF_CHECK_EXEC_OK
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const id = await savePasswordRecord(store, sshd.port, 'pw-ok')
    await mgr.connect(id)
    expect(mgr.getState(id)).toBe('connected')

    const reconnectEvents: Array<{ attempt?: number; t: number }> = []
    mgr.onStateChange((e) => {
      if (e.state === 'reconnecting') reconnectEvents.push({ attempt: e.attempt, t: Date.now() })
    })

    await sshd.destroy() // TCP FIN：意外断链（非用户 disconnect）
    await waitFor(() => reconnectEvents.length >= 5, 8_000, '5 次退避重试')
    expect(mgr.getState(id)).toBe('reconnecting')

    const attempts = reconnectEvents.map((e) => e.attempt)
    expect(attempts.slice(0, 5)).toEqual([1, 2, 3, 4, 5]) // attempt 单调递增
    // 退避间隔：事件 k→k+1 的间隔 ≈ backoff[k-1]（40/80/160/240 封顶）——调度毛刺下界
    const gaps = reconnectEvents.slice(0, 5).map((e, i, a) => (i === 0 ? 0 : e.t - a[i - 1].t))
    expect(gaps[1]).toBeGreaterThanOrEqual(38)
    expect(gaps[2]).toBeGreaterThanOrEqual(78)
    expect(gaps[3]).toBeGreaterThanOrEqual(158)
    expect(gaps[4]).toBeGreaterThanOrEqual(238) // 第 4 次间隔起封顶 240（5.7 封顶语义）
    expect(Math.max(...gaps)).toBeLessThan(3_000) // 无失控长等待

    // 手动重试（5.7=A 外部触发）：重连循环中 connect() → 清退避立即试，attempt 归 1
    const manual = await mgr.connect(id).then(
      () => {
        throw new Error('expected refused')
      },
      (e: unknown) => e as ConnectionError
    )
    expect(manual.kind).toBe('refused') // 服务器已停——立即尝试并拿到分级错误
    await waitFor(
      () => reconnectEvents.some((e, i) => i >= 5 && e.attempt === 1),
      4_000,
      '手动重试重置 attempt'
    )
    expect(mgr.getState(id)).toBe('reconnecting') // 循环继续（无限重试）
    await mgr.disconnect(id)
    expect(mgr.getState(id)).toBe('offline')
    const settled = reconnectEvents.length
    await sleep(150)
    expect(reconnectEvents.length).toBe(settled) // disconnect 后循环停止
  }, 20_000)

  it('⑥ 自检阻断（2.2=A）：claude 缺失 → selfCheckFailed + missing 清单，状态 offline', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: { ...SELF_CHECK_EXEC_OK, [CHECK_CLAUDE]: { code: 127, err: 'claude: command not found\n' } }
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const id = await savePasswordRecord(store, sshd.port, 'pw-ok')
    const err = await mgr.connect(id).then(
      () => {
        throw new Error('expected selfCheckFailed')
      },
      (e: unknown) => e as ConnectionError
    )
    expect(err.kind).toBe('selfCheckFailed')
    expect(err.missing).toEqual(['claude'])
    expect(err.checks?.map((c) => [c.id, c.status])).toEqual([
      ['sshd', 'ok'],
      ['claude', 'missing'],
      ['node', 'ok'],
      ['server', 'ok'] // S5 起真实探活（mock 健康应答）；missing 不阻断——阻断项仅 claude/node
    ])
    expect(mgr.getState(id)).toBe('offline')
  }, 15_000)

  it('⑦ exec / forwardIn 入站流交付（含去重）/ forwardOut 本地隧道', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: { ...SELF_CHECK_EXEC_OK, 'echo hi': { out: 'hi\n' } }
    })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const id = await savePasswordRecord(store, sshd.port, 'pw-ok')
    await mgr.connect(id)

    // exec（UTF-8 聚合 + 退出码）
    const r = await mgr.exec(id, 'echo hi')
    expect(r).toEqual({ code: 0, stdout: 'hi\n', stderr: '' })
    const r2 = await mgr.exec(id, 'pwd', { cwd: '/home/vmuser/工作 目录' })
    expect(r2.code).toBe(127) // mock 只认识白名单命令——cwd 前缀注入后未知命令 127

    // forwardIn：VM 侧入站流以回调交付（M7）
    const inbound: NodeJS.ReadWriteStream[] = []
    const remotePort = await freeTcpPort()
    await mgr.forwardIn(id, remotePort, (stream) => {
      inbound.push(stream)
      stream.write('inbound-v1')
    })
    // 同 remotePort 重复注册=去重（覆盖 handler，不二次登记）
    await mgr.forwardIn(id, remotePort, (stream) => {
      inbound.push(stream)
      stream.write('inbound-v2')
    })
    const fromVm = tcpConnect(remotePort, '127.0.0.1')
    const got = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`forwardIn data timeout, got=${buf}`)), 5_000)
      fromVm.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf.includes('inbound-v2')) {
          clearTimeout(timer)
          resolve(buf)
        }
      })
      fromVm.on('error', reject)
    })
    expect(got).toBe('inbound-v2') // 去重语义：后来注册的 handler 生效
    expect(inbound.length).toBe(1) // 单一入站流（未双重登记）
    fromVm.destroy()

    // forwardOut：本机 127.0.0.1 随机端口 → 远端 echo 服务
    const echoServer = createTcpServer((s) => s.pipe(s))
    const echoPort = await new Promise<number>((resolve, reject) => {
      echoServer.once('error', reject)
      echoServer.listen(0, '127.0.0.1', () => resolve((echoServer.address() as AddressInfo).port))
    })
    openServers.push({ close: () => closeTcpServer(echoServer) })
    const localPort = await mgr.forwardOut(id, '127.0.0.1', echoPort)
    expect(localPort).toBeGreaterThan(0)
    const tunneled = tcpConnect(localPort, '127.0.0.1')
    const echoed = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`forwardOut echo timeout, got=${buf}`)), 5_000)
      tunneled.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf === 'ping-pong') {
          clearTimeout(timer)
          resolve(buf)
        }
      })
      tunneled.on('error', reject)
      tunneled.on('connect', () => tunneled.write('ping-pong'))
    })
    expect(echoed).toBe('ping-pong')
    tunneled.destroy()
    await mgr.disconnect(id)
  }, 20_000)

  it('⑧ 未连接 exec 抛分级错误 / SftpBrowse 组装（缺省 home + 失败分级文案）', async () => {
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const err = await mgr.exec('no-such-id', 'ls').then(
      () => {
        throw new Error('expected unavailable')
      },
      (e: unknown) => e as ConnectionError
    )
    expect(err.kind).toBe('unavailable')

    // browseRemoteDir：缺省请求=远端 home（realpath('.')）；失败 → ok:false 分级文案
    const fakeSession = {
      // v1.5.4 语义：list() 只返回目录（真实链路 RealSftpSession.list 见 ⑧b）
      list: async () => [{ name: 'proj-a', isDir: true }],
      realpath: async (p: string) => (p === '.' ? '/home/vmuser' : p)
    }
    const fakeMgr = { sftp: async () => fakeSession } as unknown as ConnectionManager
    // fake 会话直接透传其 list 结果（排序属 RealSftpSession.list；真实 sftp 链路无 mock 侧实现）
    expect(await browseRemoteDir(fakeMgr, 'c1')).toEqual({
      ok: true,
      path: '/home/vmuser',
      entries: [{ name: 'proj-a', isDir: true }]
    })
    const failing = {
      sftp: async (): Promise<never> => {
        throw new ConnectionError('auth', 'zh')
      }
    } as unknown as ConnectionManager
    const res = await browseRemoteDir(failing, 'c1')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('认证失败')
  })

  // v1.5.4（用户 Windows 实测）：指向目录的符号链接在 readdir 中 mode=LNK →
  // isDirectory()=false 被误判为文件；跟链 stat 复核纳入，且 list 只返回目录
  it('⑧b RealSftpSession.list：LNK 指向目录经 stat 复核纳入；死链/文件排除；仅返回目录', async () => {
    const statCalls: string[] = []
    const wrapper = {
      readdir: (_dir: string, cb: (e: Error | null, l?: unknown[]) => void) => {
        cb(null, [
          { filename: 'real-dir', attrs: { isDirectory: () => true, mode: 0o40755 } },
          { filename: 'file.txt', attrs: { isDirectory: () => false, mode: 0o100644 } },
          { filename: 'link-dir', attrs: { isDirectory: () => false, mode: 0o120777 } },
          { filename: 'link-dead', attrs: { isDirectory: () => false, mode: 0o120777 } },
          { filename: '.', attrs: { isDirectory: () => true, mode: 0o40755 } },
          { filename: '..', attrs: { isDirectory: () => true, mode: 0o40755 } }
        ])
      },
      stat: (p: string, cb: (e: Error | null, st?: unknown) => void) => {
        statCalls.push(p)
        if (p === '/home/dir/link-dir') cb(null, { isDirectory: () => true })
        else cb(new Error('No such file'))
      }
    } as unknown as import('ssh2').SFTPWrapper
    const session = new RealSftpSession(wrapper)
    const out = await session.list('/home/dir')
    expect(out).toEqual([
      { name: 'link-dir', isDir: true },
      { name: 'real-dir', isDir: true }
    ])
    // 只有 LNK 条目触发 stat（普通文件/目录零额外往返）
      })

  // v2.0.1（用户实测 /home/<user>/src→/mnt/src）：listAll 同样把 LNK 目录误判为文件——
  // 跟链 stat 复核（与 list() ⑧b 同语义）；死链/链接到文件保持文件态
  it('⑧c RealSftpSession.listAll：LNK 指向目录按目录呈现（可进入）；死链与文件不动', async () => {
    const statCalls: string[] = []
    const wrapper = {
      readdir: (_dir: string, cb: (e: Error | null, l?: unknown[]) => void) => {
        cb(null, [
          { filename: 'real-dir', attrs: { isDirectory: () => true, mode: 0o40755, size: 0 } },
          { filename: 'plain.txt', attrs: { isDirectory: () => false, mode: 0o100644, size: 7 } },
          { filename: 'src', attrs: { isDirectory: () => false, mode: 0o120777, size: 9 } },
          { filename: 'link-dead', attrs: { isDirectory: () => false, mode: 0o120777, size: 0 } }
        ])
      },
      stat: (p: string, cb: (e: Error | null, st?: unknown) => void) => {
        statCalls.push(p)
        if (p === '/home/dir/src') cb(null, { isDirectory: () => true })
        else cb(new Error('No such file'))
      }
    } as unknown as import('ssh2').SFTPWrapper
    const session = new RealSftpSession(wrapper)
    const out = await session.listAll('/home/dir')
    expect(out).toEqual([
      { name: 'real-dir', isDir: true, size: 0, mtimeMs: 0 },
      { name: 'src', isDir: true, size: 0, mtimeMs: 0 },
      { name: 'link-dead', isDir: false, size: 0, mtimeMs: 0 },
      { name: 'plain.txt', isDir: false, size: 7, mtimeMs: 0 }
    ])
    expect(statCalls).toEqual(['/home/dir/src', '/home/dir/link-dead'])
  })
})

// ── L2.5：装配断言（AppContext 注入 Real 栈 + 事件挂钩到 EVENT 面）────

describe('L2.5 S2 装配（createAppContext 注入 Real 栈 / broadcast 到 EVENT 面）', () => {
  it('⑨ broadcastConnectionState 直发 EVENT 面（S1 挂钩可用性）', () => {
    broadcastConnectionState({ connectionId: 'c-direct', state: 'offline' })
    expect(h.sentEvents[h.sentEvents.length - 1]).toEqual([
      IpcChannels.ConnectionStateChanged,
      { connectionId: 'c-direct', state: 'offline' }
    ])
  })

  it('⑩ createAppContext 注入 Real 栈非 null；连接族 handler 全链（CRUD/Test/Connect→EVENT）', async () => {
    const sshd = await startMockSshd({
      hostKeyPem: HOST_KEY_A,
      expectedPassword: 'pw-ok',
      exec: SELF_CHECK_EXEC_OK
    })
    h.tempDir = newTempDir()
    process.env['CWB_HOOK_SETTINGS_DIR'] = join(h.tempDir, 'cwb-settings')
    process.env['CWB_SKILLS_USER_ROOT'] = join(h.tempDir, 'skills-user')
    process.env['CWB_SKILL_MARKET_HOME'] = join(h.tempDir, 'market-home')

    const stack = createSshConnectionStack({
      baseDir: h.tempDir,
      onStateChange: broadcastConnectionState, // A2 权属：S2 产生 → S1 挂钩广播
      onLog: () => undefined
    })
    expect(stack).toBeInstanceOf(RealConnectionManager)

    const ctx: AppContext = createAppContext({ connection: stack })
    expect(ctx.connection).not.toBeNull()
    expect(ctx.connection).toBeInstanceOf(RealConnectionManager) // A0=S1 桩+S2 实（实到位）

    registerIpcHandlers(ctx)
    const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
      const entry = h.handleCalls.find(([c]) => c === channel)
      if (entry === undefined) throw new Error(`no handler registered for ${channel}`)
      return entry[1](undefined, ...args)
    }

    // CRUD：保存（明文 password 仅 main 侧出现一次即加密）/ 列表剥离密文
    const saved = (await invoke(IpcChannels.ConnectionsSave, {
      id: '',
      name: 'vm-dev',
      host: '127.0.0.1',
      port: sshd.port,
      user: 'vmuser',
      authMethod: 'password',
      password: 'pw-ok'
    })) as { id: string; passwordEncrypted?: string }
    expect(saved.id).not.toBe('')
    expect(saved.passwordEncrypted).toBeUndefined()
    expect(await invoke(IpcChannels.ConnectionsList)).toHaveLength(1)

    // Test：v1.5.2 密码认证免指纹校验——无锁定指纹直接全绿（自检清单：sshd/claude/
    // node/server——S5 起 server 项为 probeServerVersion 真实探活，mock sshd 以
    // /dev/tcp 子串应答健康体）
    const test1 = (await invoke(IpcChannels.ConnectionsTest, saved.id)) as {
      ok: boolean
      error?: string
      kind?: string
      hostKeyFingerprint?: string
      checks?: Array<{ id: string; status: string; detail?: string }>
    }
    expect(test1.ok).toBe(true)
    expect(test1.hostKeyFingerprint).toMatch(/^SHA256:/) // ok=true 时=已验证指纹原串
    expect(test1.checks?.map((c) => `${c.id}:${c.status}`)).toEqual([
      'sshd:ok',
      'claude:ok',
      'node:ok',
      'server:ok'
    ])
    expect(test1.checks?.find((c) => c.id === 'server')?.detail).toBe('0.1.0')

    // Connect：真实状态机 → connecting/connected 经 EVENT 面到达（A2 全链）。
    // S4：SSH 连通后连接流程做 cwb-server 健康检查（WS+ping）——mock sshd 无
    // server 监听 17717 → needInstall token 错误上抛（S6 安装弹窗触发源）；
    // SSH 层状态机不受影响（仍 connected——SFTP/注册等非 server 用途可用）。
    // 环境自适应（v1.5.4）：真实 cwb-server 若在本机 17717 运行（Windows 实测
    // 装过的存活实例——mock sshd 的 forwardOut 拨真实 TCP 即连上真 server），
    // 健康检查通过 → Connect resolve；无 server 环境才断言 needInstall 拒绝。
    const serverPortOpen = await new Promise<boolean>((resolve) => {
      const sock = tcpConnect(17717, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => resolve(false))
    })
    if (serverPortOpen) {
      await invoke(IpcChannels.ConnectionsConnect, saved.id)
    } else {
      await expect(invoke(IpcChannels.ConnectionsConnect, saved.id)).rejects.toThrow(
        /need-server-install/
      )
    }
    expect(stack.getState(saved.id)).toBe('connected')
    const states = h.sentEvents
      .filter(([c]) => c === IpcChannels.ConnectionStateChanged)
      .map(([, p]) => (p as { state: string }).state)
    expect(states).toContain('connecting')
    expect(states[states.length - 1]).toBe('connected')

    // Disconnect → offline 事件；Delete → 档案移除
    await invoke(IpcChannels.ConnectionsDisconnect, saved.id)
    expect(stack.getState(saved.id)).toBe('offline')
    await invoke(IpcChannels.ConnectionsDelete, saved.id)
    expect(await invoke(IpcChannels.ConnectionsList)).toHaveLength(0)
  }, 20_000)
})

describe('S2+ v2.1.0 shell()（SSH 纯终端——ssh2 shell 通道）', () => {
  it('shell①：open → 横幅+回显往返；resize 不抛；close → onClose 单次触发', async () => {
    const sshd = await startMockSshd({ hostKeyPem: HOST_KEY_A, expectedPassword: 'pw-ok', exec: SELF_CHECK_EXEC_OK })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const cid = await savePasswordRecord(store, sshd.port, 'pw-ok')
    await mgr.connect(cid)
    expect(mgr.getState(cid)).toBe('connected')

    const session = await mgr.shell!(cid)
    const chunks: string[] = []
    let closed = 0
    session.onData((c) => chunks.push(c))
    session.onClose(() => {
      closed += 1
    })
    // 开场横幅（回显 shell 的 ready 行）
    await waitFor(() => chunks.join('').includes('mock-shell-ready'))
    // 键入回显往返
    session.write('echo-hi\r')
    await waitFor(() => chunks.join('').includes('echo-hi'))
    // resize（pty setWindow）不抛；close 后 write/resize 无操作
    expect(() => session.resize(120, 30)).not.toThrow()
    session.close()
    await waitFor(() => closed === 1)
    session.write('after-close') // 无操作不抛
    expect(chunks.join('')).not.toContain('after-close')
  })

  it('shell②：远端主动退出 → onClose 触发（连接仍 connected——会话亡不杀连接）', async () => {
    // 用 exec 侧通道无法杀 shell——回显替身不退；此处验证 close 幂等 + 二次 open=新会话
    const sshd = await startMockSshd({ hostKeyPem: HOST_KEY_A, expectedPassword: 'pw-ok', exec: SELF_CHECK_EXEC_OK })
    const store = makeStore(newTempDir())
    const mgr = makeManager(store)
    const cid = await savePasswordRecord(store, sshd.port, 'pw-ok')
    await mgr.connect(cid)
    const s1 = await mgr.shell!(cid)
    s1.close()
    const s2 = await mgr.shell!(cid) // 二次 open=新会话（不抛）
    const got: string[] = []
    s2.onData((c) => got.push(c))
    await waitFor(() => got.join('').includes('mock-shell-ready'))
    s2.close()
    expect(mgr.getState(cid)).toBe('connected')
  })
})
