import { describe, it, expect } from 'vitest'
import { spawn, type IPty } from 'node-pty'
import { existsSync } from 'node:fs'

const CLAUDE_CMD = 'C:\\Users\\liuhait1\\AppData\\Roaming\\npm\\claude.cmd'
const WORK_DIR = 'D:\\SourceCode\\agent'
const CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/
const MIN_BYTES = 200
const WAIT_DEADLINE_MS = 12_000
const TEST_TIMEOUT_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('S1 spike: node-pty spawns claude CLI (main/node domain)', () => {
  it(
    'captures ANSI first screen from claude TUI via cmd.exe wrapper',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      expect(existsSync(CLAUDE_CMD)).toBe(true)

      const chunks: string[] = []
      let exited = false

      // .cmd 不能被 CreateProcess 直接解析，用 cmd.exe /c 包装 npm 的 claude.cmd
      const pty: IPty = spawn('cmd.exe', ['/c', CLAUDE_CMD], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: WORK_DIR,
        env: process.env as Record<string, string>
      })

      pty.onData((data) => chunks.push(data))
      pty.onExit(() => {
        exited = true
      })

      try {
        const deadline = Date.now() + WAIT_DEADLINE_MS
        let output = chunks.join('')
        while (
          Date.now() < deadline &&
          !exited &&
          (Buffer.byteLength(output, 'utf8') < MIN_BYTES || !CSI_RE.test(output))
        ) {
          await sleep(150)
          output = chunks.join('')
        }

        const totalBytes = Buffer.byteLength(output, 'utf8')
        const first500 = Buffer.from(output, 'utf8').subarray(0, 500).toString('utf8')
        console.log(`[spike] total bytes: ${totalBytes}, exited: ${exited}, chunks: ${chunks.length}`)
        console.log(`[spike] first 500 bytes (escaped):\n${JSON.stringify(first500)}`)

        expect(totalBytes).toBeGreaterThanOrEqual(MIN_BYTES)
        expect(CSI_RE.test(output)).toBe(true)
      } finally {
        try {
          pty.kill()
        } catch {
          // 已退出时 kill 可能抛错，忽略
        }
      }
    }
  )
})
