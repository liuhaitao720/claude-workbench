import { describe, expect, it } from 'vitest'
import type { ConnectionManager } from '../ssh/connection-manager'
import type { ProviderConfig } from '../../shared/types'
import {
  probeRemoteModels,
  readRemoteProviders,
  removeRemoteProvider,
  saveRemoteProvider,
  setRemoteDefault
} from '../remote-providers'

/**
 * v1.6.0 远程模型配置（用户指令：远程连接的模型配置存 VM——读取/修改源同在远程）：
 * fake ConnectionManager（exec+SFTP 内存文件系统）验证 read-modify-write 全链与
 * VM 侧 curl 探测。语义断言点：注册表与本地 providers-store 零分叉（纯函数共用）、
 * 缺失/损坏容错、apiKey 的 shell 单引号硬化。
 */

interface FakeEnv {
  mgr: ConnectionManager
  files: Map<string, string>
  execLog: string[]
}

function makeFake(): FakeEnv {
  const files = new Map<string, string>()
  const execLog: string[] = []
  const mgr = {
    exec: async (_cid: string, cmd: string) => {
      execLog.push(cmd)
      if (cmd.includes('mkdir -p "$HOME/.cwb"')) return { code: 0, stdout: 'ok', stderr: '' }
      if (cmd === 'h=$(printf %s "$HOME"); printf %s "$h"') return { code: 0, stdout: '/home/vm', stderr: '' }
      if (cmd.startsWith('curl')) {
        return { code: 0, stdout: '{"data":[{"id":"m-1"},{"id":"m-2"}]}\n200', stderr: '' }
      }
      return { code: 127, stdout: '', stderr: `unexpected command: ${cmd}` }
    },
    sftp: async () => ({
      readFile: async (p: string) => {
        const c = files.get(p)
        if (c === undefined) throw new Error('no such file')
        return Buffer.from(c, 'utf8')
      },
      writeFile: async (p: string, d: string | Buffer) => {
        files.set(p, String(d))
      },
      list: async () => []
    })
  } as unknown as ConnectionManager
  return { mgr, files, execLog }
}

const REGISTRY_PATH = '/home/vm/.cwb/providers.json'

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: '',
    name: '测试服务',
    format: 'anthropic',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-abc',
    models: ['m-1'],
    ...over
  }
}

describe('v1.6.0 远程模型配置（~/.cwb/providers.json 经 SSH read-modify-write）', () => {
  it('文件缺失 → 空注册表；损坏 JSON → 空注册表（与本地 load 容错同语义）', async () => {
    const { mgr } = makeFake()
    expect(await readRemoteProviders(mgr, 'c1')).toEqual({ providers: [] })
    // @ts-expect-error 直接注入损坏内容
    mgr.sftp = async () => ({
      readFile: async () => Buffer.from('{corrupt', 'utf8'),
      writeFile: async () => undefined
    })
    expect(await readRemoteProviders(mgr, 'c1')).toEqual({ providers: [] })
  })

  it('save（新增分配 uuid）→ list 读回 → setDefault → remove；变更与本地语义一致', async () => {
    const { mgr, files } = makeFake()
    const saved = await saveRemoteProvider(mgr, 'c1', provider())
    expect(saved.id).not.toBe('')
    expect(files.has(REGISTRY_PATH)).toBe(true)

    const state = await readRemoteProviders(mgr, 'c1')
    expect(state.providers).toHaveLength(1)
    expect(state.providers[0]!.name).toBe('测试服务')
    expect(state.defaultProviderId).toBeUndefined()

    await setRemoteDefault(mgr, 'c1', saved.id)
    expect((await readRemoteProviders(mgr, 'c1')).defaultProviderId).toBe(saved.id)

    await removeRemoteProvider(mgr, 'c1', saved.id)
    expect(await readRemoteProviders(mgr, 'c1')).toEqual({ providers: [] })
    // 删除不存在的 → 报错；设默认指向不存在条目 → 报错
    await expect(removeRemoteProvider(mgr, 'c1', 'nope')).rejects.toThrow(/not found/)
    await expect(setRemoteDefault(mgr, 'c1', 'nope')).rejects.toThrow(/not found/)
    // id 空串=取消默认（不报错）
    await setRemoteDefault(mgr, 'c1', '')
  })

  it('写前 mkdir ~/.cwb（chmod 700）经 exec；写盘内容为注册表 JSON', async () => {
    const { mgr, execLog, files } = makeFake()
    await saveRemoteProvider(mgr, 'c1', provider({ id: 'p1' }))
    expect(execLog.some((c) => c.includes('mkdir -p "$HOME/.cwb"') && c.includes('chmod 700'))).toBe(
      true
    )
    const written = JSON.parse(files.get(REGISTRY_PATH)!) as { providers: unknown[] }
    expect(written.providers).toHaveLength(1)
  })

  it('探测：VM 侧 curl（headers 单引号硬化——apiKey 含引号/空格不破命令）；响应解析同本地', async () => {
    const { mgr, execLog } = makeFake()
    const r = await probeRemoteModels(mgr, 'c1', provider({ apiKey: "sk'x y" }))
    expect(r.ok).toBe(true)
    expect(r.models).toEqual(['m-1', 'm-2'])
    const curl = execLog.find((c) => c.startsWith('curl'))
    expect(curl).toBeDefined()
    // url 与 header 均被单引号包裹；apiKey 中的单引号经 '"'"' 转义后 shell 语义仍为原值
    // （anthropic 格式 apiKeyType 缺省=auth_token → Authorization 头，与本地探测同源）
    expect(curl).toContain(`'https://api.example.com/v1/models'`)
    expect(curl).toContain(`-H 'Authorization: Bearer sk'"'"'x y'`)
    // 非 200 / curl 失败的错误面
    ;(mgr as { exec: unknown }).exec = async () => ({ code: 28, stdout: '', stderr: 'curl: timeout' })
    const bad = await probeRemoteModels(mgr, 'c1', provider())
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('timeout')
  })
})
