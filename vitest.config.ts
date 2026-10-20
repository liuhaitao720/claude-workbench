import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 双环境分域：main 域 node / renderer 域 jsdom，include 互斥
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.{test,spec}.ts'],
          // spec-v1.md §8：electron 启动/claude spawn/长驻进程仅串行段（S1 spike、S4 e2e）
          fileParallelism: false
        }
      },
      {
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}']
        }
      }
    ]
  }
})
