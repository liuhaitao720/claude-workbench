import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CwbServer } from '../cwb-server'

/**
 * v2.2.0 T4：手机答复通道装配（startAnswerChannel）。
 * 验收：answer.enabled 打开 → 应答页监听 + 缺失 cloudflared 时 tunnel='missing'；
 * 关闭 → 释放全部挂起（claude 立即回落 TUI）+ 页面停止。配置轮询用 20ms 测试值。
 */
describe('v2.2.0 手机答复通道：配置轮询启停', () => {
  let home: string
  let server: CwbServer
  let port: number
  const savedPath = process.env['PATH']

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  async function waitFor(pred: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const started = Date.now()
    while (!pred()) {
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
      await sleep(20)
    }
  }

  function writeAnswer(enabled: boolean): void {
    writeFileSync(
      join(home, '.cwb', 'notify.json'),
      JSON.stringify({
        url: '',
        enabled: false,
        answer: { enabled, ttlSec: 900, presenceMin: 5, pagePort: 0 }
      }),
      'utf8'
    )
  }

  beforeAll(async () => {
    // 确定性：让 cloudflared 解析必然失败（PATH 清空 → 缺失）
    process.env['PATH'] = ''
    home = mkdtempSync(join(tmpdir(), 'cwb-answer-channel-'))
    mkdirSync(join(home, '.cwb'), { recursive: true })
    writeAnswer(false)
    server = new CwbServer({
      port: 0,
      notifyHome: home,
      log: () => {}
    })
    ;({ port } = await server.start())
    server.startAnswerChannel(20)
  })

  afterAll(async () => {
    process.env['PATH'] = savedPath
    await server?.shutdown?.()
    rmSync(home, { recursive: true, force: true })
  })

  it('disabled → 不建页面；enabled → 页面监听 + tunnel=missing（不挂起）', async () => {
    await sleep(80)
    expect(server['answerPage']).toBeUndefined()

    writeAnswer(true)
    await waitFor(() => server['answerPage']?.port !== undefined, 'answer page start')
    await waitFor(() => server['answerTunnelState'] === 'missing', 'tunnel missing')
    expect(server['answerTunnelState']).toBe('missing')
    expect(server.answer.baseUrl).toBeUndefined()
  })

  it('关闭 enabled → 全部挂起空响应释放 + 页面停止', async () => {
    // 模拟隧道就绪（生产由 cloudflared 输出置位）
    server.answer.setSurface('https://test.trycloudflare.com')
    const resP = fetch(`http://127.0.0.1:${port}/hook/PermissionRequest?t=t-ch&e=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash' })
    })
    await waitFor(() => server.answer.count() === 1, 'hook 挂起')

    writeAnswer(false)
    await waitFor(() => server.answer.count() === 0, 'pending 释放')
    const res = await resP
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    await waitFor(() => server['answerPage'] === undefined, 'page stopped')
    expect(server['answerTunnelState']).toBe('off')
    expect(server.answer.baseUrl).toBeUndefined()
  })
})