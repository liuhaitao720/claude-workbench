import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyManager, buildResumeArgs } from '../pty-manager'

/**
 * S4 e2e ③：真实 resume。
 * 固定测试 uuid 无任何历史会话——本测试的目的不是恢复成功，而是证明
 * buildResumeArgs 的参数形态（--resume <uuid> -n <name>）经 PtyManager
 * spawnClaude 真实可执行不崩：进程启动 + 产生输出字节 + kill 后 isRunning=false。
 * claude CLI 对不存在会话的实际行为（报错文本/交互选择器）作为证据记录。
 */
const FIXED_UUID = '00000000-0000-4000-8000-000000000042'
const WAIT_OUTPUT_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('S4 e2e ③：真实 claude --resume <uuid>（无历史会话，形态可执行性验证）', () => {
  it(
    'spawnClaude(buildResumeArgs(固定uuid))：进程启动、产生输出字节、kill 后 isRunning=false；记录 CLI 对不存在会话的实际行为',
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cwb-e2e-resume-'))
      try {
        const chunks: string[] = []
        const exits: string[] = []
        const mgr = new PtyManager({
          onData: (e) => chunks.push(e.data),
          onExit: (taskId) => exits.push(taskId)
        })

        await mgr.spawnClaude(FIXED_UUID, buildResumeArgs(FIXED_UUID, 'resume任务'), dir)
        // 语义断言：spawn 成功即进程启动（cmd.exe 包装层成立；claude 随后可能因会话不存在自行退出）
        expect(mgr.isRunning(FIXED_UUID)).toBe(true)

        // 观察实际行为：等输出字节（错误报文或交互选择器均是输出），最多 10s
        const deadline = Date.now() + WAIT_OUTPUT_MS
        let output = chunks.join('')
        while (Date.now() < deadline && !exits.includes(FIXED_UUID) && output.length === 0) {
          await sleep(150)
          output = chunks.join('')
        }

        const totalBytes = Buffer.byteLength(output, 'utf8')
        const exitedBySelf = exits.includes(FIXED_UUID)
        console.log(
          `[e2e-resume] claude --resume ${FIXED_UUID}: ${totalBytes} bytes, exited by itself=${exitedBySelf}`
        )
        console.log(
          `[e2e-resume] output (escaped, up to 500 bytes): ${JSON.stringify(Buffer.from(output, 'utf8').subarray(0, 500).toString('utf8'))}`
        )

        // 断言语义注明：进程启动 + 产生输出字节（无论 CLI 是报错退出还是进交互）
        expect(totalBytes).toBeGreaterThan(0)

        mgr.kill(FIXED_UUID) // 已自行退出时为安全 no-op
        await vi.waitFor(() => expect(mgr.isRunning(FIXED_UUID)).toBe(false), {
          timeout: 5_000,
          interval: 100
        })

        // 评审 F4：链路级验证——resize 落 lastSize → kill teardown → --resume 重开沿用记忆尺寸
        // （复刻真实场景：终端 fit 后 ptyResize → 停止 → 恢复，PTY 不得回退 80×24 致光标错位）
        mgr.resize(FIXED_UUID, 100, 30) // 无活跃 PTY 时仅记忆（renderer 停止期预热同路径）
        await mgr.spawnClaude(FIXED_UUID, buildResumeArgs(FIXED_UUID, 'resume任务'), dir)
        expect(mgr.currentSize(FIXED_UUID)).toEqual({ cols: 100, rows: 30 }) // spawn 同步以记忆尺寸构造
        console.log(`[e2e-resume] respawn after resize+kill: currentSize=${JSON.stringify(mgr.currentSize(FIXED_UUID))} (v0.1.2 尺寸记忆生效)`)

        mgr.kill(FIXED_UUID)
        await vi.waitFor(() => expect(mgr.isRunning(FIXED_UUID)).toBe(false), {
          timeout: 5_000,
          interval: 100
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
