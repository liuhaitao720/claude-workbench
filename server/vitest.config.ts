import { defineConfig } from 'vitest/config'

/**
 * cwb-server 工程测试配置（S3）。
 *
 * 根 vitest.config.ts 的 projects 只含 src/main 与 src/renderer（include 互斥），
 * 不含 server/**——server 测试经本配置独立运行（vitest 二进制复用根 node_modules，
 * server/package.json test script 挂载；不向根 package.json/lock 添加依赖）：
 *   npx vitest run --config server/vitest.config.ts   （或 cd server && npm test）
 *
 * fileParallelism=false：真实 PTY/子进程/端口监听——照根 main 工程先例串行。
 */
export default defineConfig({
  test: {
    name: 'cwb-server',
    environment: 'node',
    include: ['src/__tests__/**/*.{test,spec}.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
