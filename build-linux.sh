#!/usr/bin/env bash
# Claude Workbench Linux（Ubuntu）一键构建：依赖检查 → npm ci（node-pty 源码编译）
# → 构建 → 测试 → electron-builder 产出 AppImage + deb。
# 用法：在 Ubuntu（或 WSL2 Ubuntu）上的仓库根执行 ./build-linux.sh
set -euo pipefail
cd "$(dirname "$0")"

# 网络较差的环境默认走 npmmirror（node-gyp 的 node headers / Electron 二进制下载易被卡）
export npm_config_disturl="${npm_config_disturl:-https://npmmirror.com/mirrors/node/}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "==> 1/5 系统依赖检查"
missing=()
for cmd in node npm python3 make g++; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
# Electron 运行库（构建期的 electron 二进制与打包后运行都需要）
for pkg in libnss3 libgtk-3-0t64 libgbm1 libasound2t64; do
  # Ubuntu 24.04+ 是 t64 后缀；老版本回退无后缀包名
  if ! dpkg -s "$pkg" >/dev/null 2>&1 && ! dpkg -s "${pkg%t64}" >/dev/null 2>&1; then
    missing+=("$pkg")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "缺失依赖: ${missing[*]}"
  echo "安装命令: sudo apt-get update && sudo apt-get install -y build-essential python3 libnss3 libgtk-3-0 libgbm1 libasound2 xvfb"
  exit 1
fi
node -e 'process.exit(process.versions.node.split(".")[0] >= 24 ? 0 : 1)' \
  || { echo "需要 node >= 24（当前 $(node -v)）——实测 node 22 下 renderer 测试会因 jsdom 内置 undici 崩溃；建议 nvm 装 24 LTS"; exit 1; }

echo "==> 2/5 npm ci（node-pty 1.1.0 无 Linux prebuild，将源码编译——首次较慢）"
npm ci

echo "==> 3/5 构建（electron-vite）"
npm run build

echo "==> 4/5 测试（跨平台改造后应全绿；4 个 win 专属用例自动跳过）"
npm test

echo "==> 5/5 打包 AppImage + deb（electron-builder）"
npx electron-builder --linux

echo ""
echo "构建完成："
ls -la release/*.AppImage release/*.deb 2>/dev/null || true
echo ""
echo "冒烟验证（无桌面环境时）：xvfb-run -a ./node_modules/.bin/electron out/main/index.js --smoke"
echo "安装 deb：sudo apt install ./release/claude-workbench_*.deb"
echo "AppImage 直跑：chmod +x release/*.AppImage && ./release/*.AppImage"
