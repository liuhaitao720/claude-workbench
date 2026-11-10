# Claude Workbench

在桌面上管理多个 claude code 会话的终端工作台：项目/任务树、每任务独立 PTY 终端、
hooks 任务活动裁决（awaiting/busy/idle）、Skills 与插件管理、多 API provider 与
本地代理、应用自更新。v1.4 起 Windows 与 Ubuntu 双平台，v1.5 起新增 SSH 远程客户端
模式（见下节）。构建说明见 [BUILD-LINUX.md](BUILD-LINUX.md)，版本更新说明见
[CHANGELOG.md](CHANGELOG.md)。

## SSH 远程模式（v1.5.0）

在 Windows 客户端上开发、源码与 claude 会话运行在 Linux VM（VMware Ubuntu 等）：
每个项目可独立选择本机或远程——远程项目的任务终端、claude 会话、hooks、skills、
模型服务出口全部落在 VM 侧，客户端经 SSH 隧道驱动。断线或关闭客户端任务不丢
（远端 cwb-server 保活），重连/重启后点击任务即自动恢复现场。

### 前置条件（VM 侧）

- **sshd**：已安装并启动（`sudo apt install openssh-server`），允许密钥或密码认证；
  反向转发（`AllowTcpForwarding`，Ubuntu 默认开启）用于 hooks 事件回流
- **node ≥ 18**：cwb-server 与 claude CLI 的运行时（`node -v` 自检可见）
- **claude CLI**：VM 内可解析（登录 shell PATH，nvm 安装形态亦可）
- **可选 build-essential / python3 / make / g++**：仅当遇到 node-pty ABI 不匹配需要
  在 VM 内重编译时使用（见下文 O6）

### 客户端打包前置（重要）

Windows 客户端打包（或任何平台的正式安装包构建）前须先产出 cwb-server 交付包：

```bash
npm run build:server   # 产物 release/server-dist/server-<v>.tgz + manifest.json
```

electron-builder 经 `extraResources` 自动把 tgz 打进安装包；开发态（未打包）首连
推送会自动从 `release/server-dist` 解析。**该步骤必须在 Linux 构建机执行**——tgz 内
的 node-pty 原生产物（pty.node）随构建机平台与 node 大版本编译（原因同
BUILD-LINUX.md「为什么不能在 Windows 上交叉打 Linux 包」）。

### 首连推送安装流程

1. 设置 → 远程连接 → 新增连接（host/port/用户名/私钥或密码），「测试连接」做只读
   自检（sshd / claude / node / cwb-server 四项），首次连接会有主机指纹确认（TOFU）
2. 首次「连接」时，若 VM 内尚无 cwb-server，会弹出安装确认框：确认后客户端经
   SFTP 推送 tgz（sha256 校验）→ 解压到 VM 的 `~/.cwb-server/versions/<v>/` →
   nohup 启动 → 健康探测（真实协议 ping）→ 自动重连。全程不改动 VM 内其他文件
3. 升级：客户端交付版本高于远端运行版本时同样弹确认框，滚动替换（旧进程优雅停止、
   保留最近 2 个版本目录）；正在跑的任务不受升级影响
4. 连接成功后：「新建远程项目…」输入 VM 内绝对路径（可 SFTP 浏览）注册，注册即
   自动导入该目录的 claude 历史会话；新建任务即真实 spawn VM 内 claude

### O6：node-pty ABI 说明

tgz 内 pty.node 绑定构建机的 node 大版本（ABI）。若 VM 内 node 与构建机不一致，
server 启动时加载 node-pty 失败——健康探测会明确报错（`healthFailed`/`notRunning`
并附 server 日志尾部与诊断）。修复指引：在 VM 内执行

```bash
cd ~/.cwb-server/versions/<v>/node_modules/node-pty && npm rebuild
#（需要 build-essential/python3；或改用与构建机一致的 node 大版本）后重连
```

### O7：延迟指标边界

应用内远程终端的击键→回显延迟在 localhost 冒烟环境测得基线约为
**P50 ≈ 60ms / P95 ≈ 60–65ms**（本机回环、含 TUI 重绘）。这是**上限基线**：真实
Windows 客户端 ↔ VM 链路包含 SSH 隧道加密与物理网络往返，指标必然高于该值，
须在 Windows 侧实测评估，不以 localhost 数字作为远程体验结论。
