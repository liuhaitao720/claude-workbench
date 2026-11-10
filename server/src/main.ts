/**
 * cwb-server 入口（S3）：argv 解析 → CwbServer 起监听 → 信号驱动优雅停机。
 *
 * 监听 127.0.0.1:17717（与客户端约定固定口）；--port 可覆写（测试用动态口：
 * --port 0 = OS 分配）。stdout 只打一行机器可读启动行（S7 安装器/测试消费）：
 *   {"event":"listening","port":<实际端口>,"host":"127.0.0.1","version":"..."}
 * 其余日志走 stderr（元数据级，8.1=A）。
 *
 * 帧协议实现见 cwb-server.ts；PTY 注册表见 pty-registry.ts；帧编解码见
 * frames.ts；远程代理见 proxy-core.ts；契约=src/shared/remote-protocol.ts
 * （server/src/shared/ 同步副本，tools/sync-protocol.mjs 校验一致）。
 */
import { CwbServer, DEFAULT_PORT, VERSION } from './cwb-server'

function parsePort(argv: string[]): number | undefined {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--port' && argv[i + 1] !== undefined) {
      const n = Number(argv[i + 1])
      if (Number.isInteger(n) && n >= 0 && n <= 65_535) return n
      process.stderr.write(`[cwb-server:error] invalid --port ${argv[i + 1]}\n`)
      process.exit(2)
    }
    if (a.startsWith('--port=')) {
      const raw = a.slice('--port='.length)
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 0 && n <= 65_535) return n
      process.stderr.write(`[cwb-server:error] invalid --port ${raw}\n`)
      process.exit(2)
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const port = parsePort(process.argv) ?? DEFAULT_PORT
  const server = new CwbServer({ port })
  const bound = await server.start()
  process.stdout.write(
    `${JSON.stringify({ event: 'listening', port: bound.port, host: bound.host, version: VERSION })}\n`
  )

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    // 5.9=b：停机=detach 全部+PTY 不杀+proxy 停止监听（见 CwbServer.shutdown）
    void server.shutdown(`signal ${signal}`).finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((err: unknown) => {
  process.stderr.write(`[cwb-server:error] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
