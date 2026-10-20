import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PtyManager, buildNewSessionArgs, resolveClaudeCommand } from '../pty-manager'

const execFileAsync = promisify(execFile)

/** CSI 转义序列（终端 TUI 首屏证据） */
const CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/
const MIN_BYTES = 200
const WAIT_FIRST_SCREEN_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** temp git 仓库（init + 空提交；内联身份避免依赖全局 git config） */
async function makeGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init'])
  await execFileAsync('git', [
    '-C',
    dir,
    '-c',
    'user.name=CWB E2E',
    '-c',
    'user.email=cwb-e2e@invalid',
    'commit',
    '--allow-empty',
    '-m',
    'init'
  ])
}

describe('S4 e2e ②：真实 claude 会话 spawn（经 PtyManager 真实路径）', () => {
  it(
    'spawnClaude(buildNewSessionArgs) 于 temp git cwd：isRunning、10s 内 ≥200B 且含 CSI、kill 后 isRunning=false',
    { timeout: 30_000 },
    async () => {
      // 证据：实际解析的 claude 二进制与版本（spec-v1.md §7 要求记录）
      const claudeCmd = await resolveClaudeCommand()
      let version = '(version check failed)'
      try {
        const { stdout } = await execFileAsync('cmd.exe', ['/c', claudeCmd, '--version'], {
          timeout: 20_000
        })
        version = stdout.trim()
      } catch (err) {
        version = `(version check failed: ${err instanceof Error ? err.message : String(err)})`
      }
      console.log(`[e2e-claude] resolveClaudeCommand() -> ${claudeCmd}`)
      console.log(`[e2e-claude] \`${claudeCmd} --version\` -> ${version}`)

      const dir = mkdtempSync(join(tmpdir(), 'cwb-e2e-claude-'))
      try {
        await makeGitRepo(dir)

        const chunks: string[] = []
        const exits: string[] = []
        const mgr = new PtyManager({
          onData: (e) => chunks.push(e.data),
          onExit: (taskId) => exits.push(taskId)
        })

        const sessionId = randomUUID() // 真实路径约定 id === sessionId
        await mgr.spawnClaude(sessionId, buildNewSessionArgs(sessionId, 'e2e任务'), dir)
        expect(mgr.isRunning(sessionId)).toBe(true)

        // 等待首屏（空闲会话：工作区信任对话框，≥200B + CSI）
        const deadline = Date.now() + WAIT_FIRST_SCREEN_MS
        let output = chunks.join('')
        while (
          Date.now() < deadline &&
          !exits.includes(sessionId) &&
          (Buffer.byteLength(output, 'utf8') < MIN_BYTES || !CSI_RE.test(output))
        ) {
          await sleep(150)
          output = chunks.join('')
        }

        const totalBytes = Buffer.byteLength(output, 'utf8')
        console.log(
          `[e2e-claude] first screen: ${totalBytes} bytes, CSI=${CSI_RE.test(output)}, exited early=${exits.includes(sessionId)}`
        )
        console.log(
          `[e2e-claude] first 300 bytes (escaped): ${JSON.stringify(Buffer.from(output, 'utf8').subarray(0, 300).toString('utf8'))}`
        )

        expect(totalBytes).toBeGreaterThanOrEqual(MIN_BYTES)
        expect(CSI_RE.test(output)).toBe(true)

        mgr.kill(sessionId)
        await vi.waitFor(() => expect(mgr.isRunning(sessionId)).toBe(false), {
          timeout: 5_000,
          interval: 100
        })
        expect(exits).toContain(sessionId)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
