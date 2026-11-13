# v2.1.1 发布说明

SSH Workbench v2.1.1 —— 四项实测反馈（首开全量上下文 / SSH 目录跟随 / 文件面板融合 / 纯 SSH 连接）

## 重点

- **修复：远程任务首开只见末尾、不能滚**——cwb-server 环形缓冲 8KB→2MB、attach 全量历史回放（≤1.5MB，可滚动）；cwb-server 0.1.1→0.1.2，首连自动升级
- **SSH 终端目录跟随**：shell 里 `cd`，下方文件面板自动进对应目录（「跟随目录」开关默认开）
- **远程文件面板融合进 SSH 终端**：右侧「远程文件」按钮移除；远程项目菜单改「在 SSH 终端中打开」；**任务上下文打开 SSH 终端自动 cd 到项目目录**（worktree 任务到 worktree），文件面板同步直达
- **纯 SSH 连接类型**：连接档案新增「纯 SSH」——仅控制台+文件面板，跳过 claude 自检与 cwb-server，不可注册远程项目（侧栏/下拉带 SSH 徽标）

完整条目见仓库 CHANGELOG.md。

## 安装

Windows：`SSH-Workbench-Setup-2.1.1.exe` 覆盖安装（配置保留）。首连会自动升级 VM 内 cwb-server 至 0.1.2。

## 附件（3 个全部上传）

- `SSH-Workbench-Setup-2.1.1.exe`
- `SSH-Workbench-Setup-2.1.1.exe.blockmap`
- `latest.yml`（自动更新源，已校验 sha512/size）
