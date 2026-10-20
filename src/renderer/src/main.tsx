import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { applyDomTheme, loadTheme, resolveTheme } from './theme'

// FOUC 防护第二层（v0.5.3）：index.html 内联脚本已设 dataset.theme，渲染前按
// 持久化值幂等重申（防内联脚本异常/被剥离场景）；store 创建时还有第三层。
applyDomTheme(resolveTheme(loadTheme()))

const container = document.getElementById('root')
if (!container) throw new Error('#root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
