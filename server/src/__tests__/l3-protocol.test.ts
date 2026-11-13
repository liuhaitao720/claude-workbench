import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import {
  alive,
  bootServer,
  collector,
  connect,
  request,
  serverRoot,
  waitFor,
  waitForText,
  type ServerProc
} from './l3-harness'

/**
 * L3 真实执行：真实子进程 server（esbuild 打包 → node 子进程 --port 0 动态口）
 * + 真实 WS 客户端逐帧断言。覆盖：spawn→data→exit 全链、断连保活（5.9=b：
 * ps 级进程存活断言）、re-attach 两条重绘路径（toggle/回放）、kill 语义、
 * rid 回执关联、畸形帧拒绝路径、SIGTERM 优雅停机（conn.closed+退出码 0）。
 *
 * 真实 claude 用例见 l3-claude.test.ts；代理全链见 l3-proxy.test.ts。
 */

let server: ServerProc | undefined
let childPort = 0
let workDir = ''

beforeAll(async () => {
  server = await bootServer()
  childPort = server.port
  workDir = server.workDir
}, 30_000)

afterAll(async () => {
  await server?.stop()
})

describe('L3 协议全链（真实子进程 server + 真实 PTY）', () => {
  it('server.ping / server.version：rid 回执关联（inReplyTo）+ 版本=package.json', async () => {
    const ws = await connect(childPort)
    try {
      const pong = await request(ws, { type: 'server.ping', rid: 'ping-1' })
      expect(pong.ok).toBe(true)
      expect((pong.payload as { pong: boolean }).pong).toBe(true)
      const ver = await request(ws, { type: 'server.version', rid: 'ver-1' })
      const pkg = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8')) as {
        version: string
      }
      expect(ver.ok).toBe(true)
      expect((ver.payload as { version: string }).version).toBe(pkg.version)
    } finally {
      ws.close()
    }
  })

  it('task.spawn→attach→task.data 字节回流→kill→task.exit→list 空', async () => {
    const ws = await connect(childPort)
    const taskId = 'l3-basic-1'
    const collect = collector(ws, taskId)
    try {
      const spawned = await request(ws, {
        type: 'task.spawn',
        rid: 'sp-1',
        req: {
          taskId,
          argv: ['/bin/bash', '-c', 'echo hello-l3; sleep 10'],
          cwd: workDir,
          cols: 80,
          rows: 24
        }
      })
      expect(spawned.ok).toBe(true)
      const pid = (spawned.payload as { pid: number }).pid
      expect(pid).toBeGreaterThan(1)

      const attachRes = await request(ws, { type: 'task.attach', rid: 'at-1', taskId })
      expect(attachRes.ok).toBe(true)
      await waitForText(ws, taskId, 'hello-l3', 15_000, collect.text())
      expect(collect.text()).toContain('hello-l3')
      expect(alive(pid)).toBe(true) // 进程真实存活（ps 语义）

      const listed = await request(ws, { type: 'task.list', rid: 'ls-1' })
      const summaries = listed.payload as Array<{ taskId: string; pid: number; attached: boolean }>
      expect(summaries.map((s) => s.taskId)).toContain(taskId)
      expect(summaries.find((s) => s.taskId === taskId)!.attached).toBe(true)

      // 显式 kill → task.exit 到达 → 进程消失 → 注册表空
      const exitP = waitFor(ws, (f) => f.type === 'task.exit' && f.taskId === taskId)
      await request(ws, { type: 'task.kill', rid: 'kl-1', taskId })
      const exit = await exitP
      expect(exit.type).toBe('task.exit')
      if (exit.type === 'task.exit') expect(typeof exit.exitCode).toBe('number')
      await new Promise((r) => setTimeout(r, 150))
      expect(alive(pid)).toBe(false)
      const listed2 = await request(ws, { type: 'task.list', rid: 'ls-2' })
      expect((listed2.payload as Array<{ taskId: string }>).map((s) => s.taskId)).not.toContain(
        taskId
      )
    } finally {
      ws.close()
    }
  })

  it('task.write 键入透传（纯远端回显 4.2=A）：bash cat 读回', async () => {
    const ws = await connect(childPort)
    const taskId = 'l3-write-1'
    try {
      await request(ws, {
        type: 'task.spawn',
        rid: 'sp-2',
        req: { taskId, argv: ['/bin/bash', '-c', 'cat'], cwd: workDir, cols: 80, rows: 24 }
      })
      await request(ws, { type: 'task.attach', rid: 'at-2', taskId })
      await new Promise((r) => setTimeout(r, 100)) // attach 生效等待
      ws.send(JSON.stringify({ type: 'task.write', taskId, data: 'typed-输入\r' }))
      await waitForText(ws, taskId, 'typed-输入', 15_000)
      const exitP2 = waitFor(ws, (f) => f.type === 'task.exit' && f.taskId === taskId)
      await request(ws, { type: 'task.kill', rid: 'kl-2', taskId })
      await exitP2
    } finally {
      ws.close()
    }
  })

  it('畸形帧：连接不断、后续请求正常（拒绝路径不影响会话）', async () => {
    const ws = await connect(childPort)
    try {
      ws.send('{not json')
      ws.send(JSON.stringify({ type: 'task.nope' }))
      const pong = await request(ws, { type: 'server.ping', rid: 'still-alive' })
      expect(pong.ok).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('server.log 帧：生命周期元数据到达客户端且不含终端内容（8.1=A）', async () => {
    const ws = await connect(childPort)
    const taskId = 'l3-log-1'
    try {
      const logP = waitFor(
        ws,
        (f) => f.type === 'server.log' && f.message.includes('task spawned')
      )
      const spawnP = request(ws, {
        type: 'task.spawn',
        rid: 'lg-1',
        req: {
          taskId,
          argv: ['/bin/bash', '-c', 'echo secret-terminal-output; sleep 5'],
          cwd: workDir,
          cols: 80,
          rows: 24
        }
      })
      const attachP = request(ws, { type: 'task.attach', rid: 'lg-1a', taskId })
      const log = await logP
      expect((await spawnP).ok).toBe(true)
      expect((await attachP).ok).toBe(true)
      if (log.type !== 'server.log') throw new Error('unreachable')
      expect(log.level).toBe('info')
      expect(log.message).toContain(taskId) // 元数据：taskId 可含
      expect(log.message).not.toContain('secret-terminal-output') // 终端内容绝不进日志
      const exitP = waitFor(ws, (f) => f.type === 'task.exit' && f.taskId === taskId)
      await request(ws, { type: 'task.kill', rid: 'lg-2', taskId })
      await exitP
    } finally {
      ws.close()
    }
  })

  it('错误回执：attach 未知任务→ok=false + 脱敏 error', async () => {
    const ws = await connect(childPort)
    try {
      const res = await request(ws, { type: 'task.attach', rid: 'bad-1', taskId: 'no-such-task' })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('unknown task')
    } finally {
      ws.close()
    }
  })

  it('帧序串行化：spawn→attach 背靠背（不等 spawn 回执）按序生效', async () => {
    const ws = await connect(childPort)
    const taskId = 'l3-order-1'
    try {
      // spawn 帧先发送（request 调用即发送；handler 含 PATH 发现异步段）——
      // attach 紧随其后入队，必须等 spawn 完成后才执行
      const spawnP = request(ws, {
        type: 'task.spawn',
        rid: 'od-1',
        req: { taskId, argv: ['/bin/bash', '-c', 'sleep 10'], cwd: workDir, cols: 80, rows: 24 }
      })
      const attachP = request(ws, { type: 'task.attach', rid: 'od-2', taskId })
      const attach = await attachP
      expect(attach.ok).toBe(true) // 乱序则会 unknown task
      const spawned = await spawnP
      expect(spawned.ok).toBe(true)
      await request(ws, { type: 'task.kill', rid: 'od-3', taskId })
      await waitFor(ws, (f) => f.type === 'task.exit' && f.taskId === taskId)
    } finally {
      ws.close()
    }
  })
})

describe('L3 断连保活 + re-attach（5.9=b / 5.8=A / 5.1=A）', () => {
  it('断开后任务存活（ps 断言 pid）→重连 list 仍见→回放路径重绘→显式 kill 退出', async () => {
    const ws1 = await connect(childPort)
    const taskId = 'l3-keepalive-1'
    const spawned = await request(ws1, {
      type: 'task.spawn',
      rid: 'ka-1',
      req: {
        taskId,
        argv: ['/bin/bash', '-c', 'echo started-marker; sleep 10'],
        cwd: workDir,
        cols: 80,
        rows: 24
      }
    })
    const pid = (spawned.payload as { pid: number }).pid
    const collect1 = collector(ws1, taskId)
    await request(ws1, { type: 'task.attach', rid: 'ka-2', taskId })
    await waitForText(ws1, taskId, 'started-marker', 15_000, collect1.text())
    ws1.close() // 客户端断连（5.1=A：不得杀任务）
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(pid)).toBe(true) // ps 断言：PTY 进程仍存活

    const ws2 = await connect(childPort)
    try {
      const listed = await request(ws2, { type: 'task.list', rid: 'ka-3' })
      const summaries = listed.payload as Array<{ taskId: string; pid: number; attached: boolean }>
      const mine = summaries.find((s) => s.taskId === taskId)
      expect(mine).toBeDefined()
      expect(mine!.attached).toBe(false)

      // re-attach：sleep 10 对 SIGWINCH 无输出 → 300ms 无新数据 → 回放路径命中
      const collect2 = collector(ws2, taskId)
      await request(ws2, { type: 'task.attach', rid: 'ka-4', taskId })
      // 回放=环形缓冲尾部（≤4000B），单帧送达；seed 防到达竞态漏检
      await waitForText(ws2, taskId, 'started-marker', 10_000, collect2.text())
      expect(Buffer.byteLength(collect2.text(), 'utf8')).toBeLessThanOrEqual(4000) // 回放预算

      const exitP = waitFor(ws2, (f) => f.type === 'task.exit' && f.taskId === taskId)
      await request(ws2, { type: 'task.kill', rid: 'ka-5', taskId })
      await exitP
      await new Promise((r) => setTimeout(r, 150))
      expect(alive(pid)).toBe(false) // 显式 kill 后才退出
    } finally {
      ws2.close()
    }
  })

  it('v2.1.1 全量回放：attach 即得历史，之后新输出直送不重复', async () => {
    const ws = await connect(childPort)
    const taskId = 'l3-toggle-1'
    try {
      const spawned = await request(ws, {
        type: 'task.spawn',
        rid: 'tg-1',
        req: {
          taskId,
          argv: ['/bin/bash', '-c', 'echo boot-once; cat'],
          cwd: workDir,
          cols: 90,
          rows: 30
        }
      })
      expect(spawned.ok).toBe(true)
      // 等 boot 进 ring（attach 前产出不发帧）
      await new Promise((r) => setTimeout(r, 300))
      const collect = collector(ws, taskId)
      await request(ws, { type: 'task.attach', rid: 'tg-2', taskId })
      // v2.1.1：attach 即刻回放全量历史——boot-once 必在（旧 4KB/300ms 语义已废）
      await waitForText(ws, taskId, 'boot-once', 5_000, collect.text())
      // 写入回显 → 新输出直送；历史不重复
      // task.write 是 fire-and-forget 帧（无 rid 无回执）——直 send
      ws.send(JSON.stringify({ type: 'task.write', taskId, data: 'fresh-line\n' }))
      await waitForText(ws, taskId, 'fresh-line', 10_000, collect.text())
      expect(collect.text().indexOf('boot-once')).toBe(collect.text().lastIndexOf('boot-once'))
      await request(ws, { type: 'task.kill', rid: 'tg-9', taskId })
      await waitFor(ws, (f) => f.type === 'task.exit' && f.taskId === taskId)
    } finally {
      ws.close()
    }
  })

  it('SIGTERM→conn.closed 帧→进程退出码 0', async () => {
    const extra = await bootServer()
    const ws = await connect(extra.port)
    try {
      const closedP = waitFor(ws, (f) => f.type === 'conn.closed')
      extra.proc.kill('SIGTERM')
      const closed = await closedP
      expect(closed.type).toBe('conn.closed')
      if (closed.type === 'conn.closed') expect(closed.reason).toContain('SIGTERM')
      const [code] = (await once(extra.proc, 'exit')) as [number | null]
      expect(code).toBe(0)
    } finally {
      ws.close()
      await extra.stop()
    }
  })
})
