/**
 * jsdom 跑 xterm 6 的硬前提（实测缺一即抛构造错误）：
 * - window.matchMedia（jsdom 未提供 xterm 所需的完整形态）
 * - global.ResizeObserver（jsdom 完全没有）
 * 各测试文件首行 `import './test-setup'`（不改 vitest.config.ts）。
 */

window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
