# v2.0.2 发布说明（覆盖更新）

SSH Workbench v2.0.2 —— 四项实测修复 + 新功能：AI 开发成果 git diff 审查

## 重点

- **新功能：git diff 审查（主区审查模式）**——AI 开发完成后快速过改动
  - 文件列表（M/A/D/R/未跟踪 徽标 + 每文件 +/− 行数）+ 统一 diff 视图（行号/修改点高亮）
  - **↑/↓ 在修改点间跳转**（列表聚焦换文件、diff 聚焦跳 hunk，越过文件尾自动续下一文件）
  - TabBar **虚拟「审查」tab** 与任务 tab 一键互切（审查↔终端来回，状态留存）
  - 入口：**Ctrl+Shift+D** / 项目菜单「审查改动…」/ AI 任务结束提示 toast（每项目 10 分钟节流）
  - 本地与远程项目同链路；worktree 任务自动审查其 worktree 目录
- **修复：只配 1 个远程却出现 2 条相同连接记录**（新增按 user@host:port 去重 + 防连点）
- **修复：侧栏远程作用域「＋」按钮点击无响应**（改开注册对话框：手输路径/SFTP 浏览）
- **修复：项目内任务排序失真**（一直在用的长跑任务被新建任务压在下面——按真实使用信号刷新排序键）
- **修复：客户端重启后远程任务每轮 `Stop hook error: ECONNREFUSED`**（hook 转发口改稳定优先口，重连后旧会话不再撞死口；修复前的存量会话停止再恢复一次即消）

完整条目见仓库 CHANGELOG.md。

## 安装

Windows：`SSH-Workbench-Setup-2.0.2.exe` 覆盖安装（配置保留）。

## 附件（3 个全部上传）

- `SSH-Workbench-Setup-2.0.2.exe`
- `SSH-Workbench-Setup-2.0.2.exe.blockmap`
- `latest.yml`（自动更新源，已校验 sha512/size）
