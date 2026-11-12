# v2.1.0 发布说明

SSH Workbench v2.1.0 —— 新功能：SSH 纯终端模式（不启动 claude CLI）

## 重点

- **SSH 纯终端**：连接远程后随手敲命令（systemd/docker/vim/top），**不建任务、不碰 claude/hook 链路**
  - 入口：右缘竖条「SSH 终端」或 **Ctrl+Shift+S**
  - 虚拟「▣ SSH」tab 与任务/审查 tab 三方互斥互切；**Esc/Ctrl+D 直通 shell 不拦截**
  - **上下分栏**：上=裸 shell，下=远程文件面板（上传/下载/拖拽/删除全可用）；分隔条拖拽/双击复位/↑↓ 键盘步进，比例按连接记忆
  - 断连/远端退出→冻结层「重连/重开会话」；open→订阅竞态窗输出缓冲冲放
- 评审驱动修复 6 项（会话身份/失败黑洞/零任务 tab 入口/删连接级联/分栏持久化/open 串行化）

完整条目见仓库 CHANGELOG.md。

## 安装

Windows：`SSH-Workbench-Setup-2.1.0.exe` 覆盖安装（配置保留）。

## 附件（3 个全部上传）

- `SSH-Workbench-Setup-2.1.0.exe`
- `SSH-Workbench-Setup-2.1.0.exe.blockmap`
- `latest.yml`（自动更新源，已校验 sha512/size）
