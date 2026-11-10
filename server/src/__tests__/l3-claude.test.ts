import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { bootServer, collector, connect, request, waitFor, waitForText, type ServerProc } from './l3-harness'

/**
 * L3 真实 claude（本机 claude 2.1.321）：经协议 spawn 真实 claude CLI。
 * 用 `claude --version`（非交互、确定性退出 0）验证全链：spawn 解析（PATH 增强
 * 语义下裸名 `claude` 可执行）→ task.data 字节回流 → task.exit code 0。
 * cwd=已信任目录 /tmp/cwb-pty-run（防 trust 对话框干扰交互态用例——交互态留 S8）。
 */

const TRUSTED_CWD = '/tmp/cwb-pty-run'

let server: ServerProc | undefined

beforeAll(async () => {
  if (!existsSync(TRUSTED_CWD)) {
    throw new Error(`前提缺失：${TRUSTED_CWD} 不存在（先 mkdir）`)
  }
  server = await bootServer()
}, 30_000)

afterAll(async () => {
  await server?.stop()
})

describe('L3 真实 claude（claude --version 经协议全链）', () => {
  it(
    "spawn argv=['claude','--version']（裸名经 PATH 增强解析）→data 含版本→exit code 0",
    async () => {
      const ws = await connect(server!.port)
      const taskId = 'l3-claude-version-1'
      const collect = collector(ws, taskId)
      try {
        // spawn→attach 背靠背（request 调用即发送：spawn 帧先出；帧序串行化保证
        // attach 后于 spawn 生效——真实客户端发送形态，且消除快速退出竞态）
        const spawnP = request(ws, {
          type: 'task.spawn',
          rid: 'cl-1',
          req: { taskId, argv: ['claude', '--version'], cwd: TRUSTED_CWD, cols: 100, rows: 30 }
        })
        const attachP = request(ws, { type: 'task.attach', rid: 'cl-2', taskId })
        const spawned = await spawnP
        expect(spawned.ok).toBe(true)
        expect((await attachP).ok).toBe(true)
        // 版本输出字节回流（claude --version 输出 "2.1.321 (Claude Code)"；
        // 按累计文本断言——PTY 输出可分帧，单帧谓词漏跨帧短语）
        // exit 等待先注册（claude --version 打完即退——回执 await 与帧到达竞态）
        const exitP = waitFor(ws, (f) => f.type === 'task.exit' && f.taskId === taskId, 30_000)
        expect(await waitForText(ws, taskId, 'Claude Code', 30_000, collect.text())).toMatch(
          /Claude Code/
        )
        expect(collect.text()).toMatch(/Claude Code/)

        // 自然退出：task.exit code 0 → 注册表移除
        const exit = await exitP
        if (exit.type !== 'task.exit') throw new Error('unreachable')
        expect(exit.exitCode).toBe(0)
        const listed = await request(ws, { type: 'task.list', rid: 'cl-3' })
        expect((listed.payload as Array<{ taskId: string }>).map((s) => s.taskId)).not.toContain(
          taskId
        )
      } finally {
        ws.close()
      }
    },
    60_000
  )
})
