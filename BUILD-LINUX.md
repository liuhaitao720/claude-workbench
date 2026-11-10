# SSH Workbench Linux（Ubuntu）构建与联调指南

v1.3 起支持 Windows 与 Ubuntu 双平台。本文档覆盖：本机构建、目标机（Ubuntu）安装联调、冒烟验证与常见问题。

## 一、平台支持矩阵

| 能力 | Windows | Ubuntu |
|---|---|---|
| claude 会话终端（PTY） | cmd.exe /c 包装（ConPTY） | 直 execvp（forkpty，shebang 脚本可执行） |
| claude CLI 发现 | `where` 多命中过滤 | `which -a` + 登录 shell PATH 探测 + nvm/volta/fnm/asdf/`~/.local/bin` 常见目录扫描 |
| 进程树回收 | taskkill /T /F | 负 pid 杀进程组（SIGKILL）回退单杀 |
| claude 安装器 | PowerShell irm install.ps1 | `bash -lc 'curl -fsSL https://claude.ai/install.sh \| bash'` |
| 字体扫描 | PowerShell System.Drawing 宽度实测 | `fc-list :spacing=mono family` |
| 应用自动升级 | ✅（updater.cmd/.vbs/robocopy） | ❌ 检查更新可用；下载/安装被门禁拒绝，UI 显示手动更新指引 |
| 打包格式 | nsis（win-unpacked portable） | AppImage + deb |

## 二、构建（在 Ubuntu / WSL2 Ubuntu 上执行）

```bash
# 1. 系统依赖（一次性）
sudo apt-get update
sudo apt-get install -y build-essential python3 libnss3 libgtk-3-0 libgbm1 libasound2 xvfb

# 2. node >= 24（建议 nvm 装 24 LTS；注意：实测 node 22 下 renderer 测试会因 jsdom 内置
#    undici 与该版本不兼容而崩——测试环节须 node 24。运行时 PATH 里要有 node：npm 形态的 claude 依赖它）

# 3. 一键构建（依赖检查 → npm ci → build → test → 打包）
./build-linux.sh

# 4. cwb-server 交付包（v1.5.0 SSH 远程模式需要——首连推送安装用的 server tgz）
npm run build:server
# 产物 release/server-dist/{server-<v>.tgz, manifest.json}（确定性打包，已 gitignore）。
# electron-builder 打正式包时会经 extraResources 自动携带；开发态首连推送自动从
# release/server-dist 解析。必须在 Linux 构建机跑（tgz 内 node-pty 原生产物绑定
# 构建机 node 大版本——ABI 策略见 README「SSH 远程模式」O6 说明）。
```

产物：`release/SSH Workbench-<版本>.AppImage` 与 `release/ssh-workbench_<版本>_amd64.deb`。

**为什么不能在 Windows 上交叉打 Linux 包**：`node_modules/node-pty` 的原生产物随宿主平台（prebuilds 或本机 node-gyp 编译产物），Windows 上打 Linux 包会打进 win32 二进制，Linux 运行时 `require pty.node` 直接失败。Linux 包必须在 Linux 环境（WSL 或目标机）完成 `npm ci` 与打包。

**网络注意事项**（本机网络实测对 nodejs.org/github 直连易 hang）：
- `build-linux.sh` 已默认注入 npmmirror 镜像：node-gyp 的 node headers（`npm_config_disturl`）、Electron 二进制（`ELECTRON_MIRROR`）、electron-builder 资源（`ELECTRON_BUILDER_BINARIES_MIRROR`）
- npm registry 本身不需要镜像；如需可 `npm config set registry https://registry.npmmirror.com`

## 三、目标机安装

```bash
# deb（推荐，系统包管理器管理升级）
sudo apt install ./release/ssh-workbench_*.deb
# 启动：应用菜单里找 "SSH Workbench"（deb 不装 /usr/bin 命令，desktop 入口 Exec 为 /opt 全路径）

# AppImage（免安装）
chmod +x release/*.AppImage
./release/SSH\ Workbench-*.AppImage
```

AppImage 需要 FUSE（Ubuntu 24.04 默认有；极简系统装 `libfuse2`）。无 FUSE 环境可用 `--appimage-extract-and-run`。

## 四、冒烟验证（L2.5 装配验证）

`--smoke` 模式端到端走真实链路：窗口加载 → `createTask` → PTY 真实 spawn claude → renderer 回执 → 清理退出（60s 自守超时）。

```bash
# 有桌面/WSLg：直接跑（WSLg 下窗口会闪现）
./node_modules/.bin/electron out/main/index.js --smoke

# 无桌面（headless 服务器/CI）：
xvfb-run -a ./node_modules/.bin/electron out/main/index.js --smoke
# 成功标志：最后打印 "[smoke] OK" 且退出码 0
```

注意：
- **不要用 `npm run smoke`**——它指向 `scripts/run-smoke.mjs`，而 `scripts/` 目录被 .gitignore 排除不在仓库（pre-existing 断链）
- smoke 需要 `claude` CLI 可被解析（见下节 PATH 说明）
- root / 容器内跑 Electron 需追加 `--no-sandbox`（Chrome sandbox 需非 root 或 setuid chrome-sandbox）

### SSH 远程模式端到端冒烟（v1.5.0 `--smoke-remote`）

本机 sshd（22 端口）可用时，可再跑远程全链冒烟（CWB_USER_DATA 隔离 + 临时密钥对
authorized_keys marker 追加/测毕 surgical 清理；远端=本机回环）。两相位分属两个进程：

```bash
# 相位 A：连接→server 推送安装→远程项目注册（注册即导入）→createTask 真实 claude
#        →hooks 反向转发 awaiting→击键回显延迟采样（localhost 基线 P50/P95/P99）
#        →断连冻结→重连 re-attach→app.quit 留远端 PTY 存活（退出码 0）
CWB_USER_DATA=/tmp/cwb-smoke npx electron out/main/index.js --smoke-remote=phase-a
# 驱动复核（独立 ssh 进程——证明 server 保活与客户端进程无关）：
ssh -i /tmp/cwb-smoke/smoke-remote/id_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null 127.0.0.1 "ps -o args= -p <相位A日志中的 SMOKE-REMOTE-PTY-PID>"
# 相位 B：二次启动（远程 running 不归一）→server 保活对账→显式 stopTask→远端进程
#        退出→环境清理（退出码 0；authorized_keys 行数复核见日志）
CWB_USER_DATA=/tmp/cwb-smoke npx electron out/main/index.js --smoke-remote=phase-b
```

相位 A 中途失败（退出码 1）会留下环境残留：本机 17717 端口的 server 进程、
authorized_keys 里的 marker+key 两行、`~/.cwb-server/task-settings/<taskId>.json` 与
种子会话目录——手动清理后再重跑（authorized_keys 只删 `# cwb-smoke-remote` marker
及其后一行；server 用 `kill $(cat <serverHome>/server.pid)`）。成功路径相位 B 自带
全量清理。

## 五、claude CLI 在 Linux 下的解析（PATH 发现）

Ubuntu 桌面/AppImage 启动的 Electron 继承的是**会话 PATH**——nvm/fnm/volta/asdf 装的 claude（`~/.nvm/versions/node/*/bin` 等）通常不在其中。应用内置两级发现（v1.3）：

1. `bash -l -c` 探测登录 shell PATH + 扫描常见安装目录（`~/.local/bin`、`~/.nvm/versions/node/*/bin`、`~/.volta/bin`、`~/.asdf/shims`、`~/.npm-global/bin`、`~/.bun/bin`、`~/bin`、`/usr/local/bin`、fnm default alias）
2. 命中的增量目录会**注入到 claude 子进程的 PATH**——npm 形态 claude 的 `#!/usr/bin/env node` shebang 也要求 node 在 PATH 里，注入后一并解决

仍解析不到时回退裸 `claude`（PTY 报 `execvp failed` 即 PATH 里确实没有）。可在设置中心用内置安装器（官方 install.sh）安装。

## 六、常见问题

| 现象 | 原因与处置 |
|---|---|
| npm ci 卡在 node-pty 编译 | node-gyp 下载 node headers 被卡——`build-linux.sh` 已设 npmmirror disturl；手动：`export npm_config_disturl=https://npmmirror.com/mirrors/node/` 后重跑 |
| 编译报缺 python3/make/g++ | `sudo apt-get install -y build-essential python3` |
| 启动黑屏/闪退 | 缺 Electron 运行库：`sudo apt-get install -y libnss3 libgtk-3-0 libgbm1 libasound2`（包名 24.04 起带 t64 后缀，apt 自动解析） |
| root 下启动报 sandbox 错 | 追加 `--no-sandbox`（个人机器可接受；公共机器建议专用非 root 用户） |
| 关窗后"消失但还在跑" | GNOME 默认无托盘区（需 AppIndicator 扩展）。关窗=最小化到托盘是默认行为——从任务栏/活动概览可唤回，或在设置中改为直接退出 |
| hooks settings 目录 | Linux 落 `~/.config/SSH Workbench/cwb/cwb-settings`（Windows 是 `%LOCALAPPDATA%`；无 LOCALAPPDATA 时统一回退 userData） |
| v1.5.0 更名迁移 | productName 由 Claude Workbench 改为 SSH Workbench，首次启动自动把旧数据目录（Linux `~/.config/Claude Workbench`、Windows `%APPDATA%\Claude Workbench`）一次性拷贝到新目录并写 `.migrated-from-claude-workbench` 标记；新目录非空则跳过，旧目录保留 |
| 应用更新 | Linux 检查更新可用（显示新版本与说明），下载/安装提示手动更新——自动替换链路是 Windows 专属，Linux 从 [GitHub Releases](https://github.com/liuhaitao720/ssh-workbench/releases) 手动下载覆盖 |
| 字体下拉为空/回白名单 | `fc-list` 不可用（极简系统装 `fontconfig`）；默认字体 Linux 为 DejaVu Sans Mono |

## 七、从 Windows 侧把代码带过去

仓库工作树（含未提交改动）拷入 WSL：

```powershell
# WSL 内（把 D 盘工作树复制到 ~/ssh-workbench，排除产物与依赖）
mkdir -p ~/ssh-workbench && cd /mnt/d/WorkWithAI/claude\ workbench/repos/ssh-workbench \
  && tar cf - --exclude=node_modules --exclude=release --exclude=out --exclude=.vitest . | (cd ~/ssh-workbench && tar xf -)
```

之后在 WSL 的 `~/ssh-workbench` 里跑 `./build-linux.sh`。
