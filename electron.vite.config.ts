import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // S1 入口按任务书为 src/main/main.ts（electron-vite 默认约定是 src/main/index.ts，故显式指定）
        input: { index: resolve(__dirname, 'src/main/main.ts') },
        // node-pty 是原生模块，必须外部化（externalizeDepsPlugin 已覆盖 dependencies，此处显式兜底）
        external: ['node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define: { __BUILD_DATE__: JSON.stringify(new Date().toISOString()) },
    plugins: [react()],
    resolve: {
      alias: {
        // 目录级预留：src/shared 目前不存在，别名先行配置（alias 仅在实际 import 时解析）
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})
