# v2.1.3 发布说明（含 Windows 免安装包）

SSH Workbench v2.1.3 —— 在 v2.1.1 四项（首开全量回放 / SSH 目录跟随 / 文件面板融合 / 纯 SSH 连接）之上：

- SSH/开发**两视图分治**：SSH 视图自带左侧服务器列表（纯SSH/开发两组分列）；开发视图（作用域 chips/项目树/设置/档案列表/代理面板）剔除纯 SSH 连接
- 零连接死锁解除：竖条常驻 + 零连接进空态引导；Ctrl+Shift+S 无连接不再无响应
- 打开终端首屏修复：bootstrap 就绪门注入（静默 400ms / 提示符 / 8s 兜底）+ 重开分支对称清理
- 纯 SSH 连接专用新建/编辑对话框；连接表单恢复恒「远程开发」口径

## v2.1.3 修复

- **SSH 终端 bootstrap 注入卡壳根治**（任务窗口打开显示一串脚本不执行、需 Ctrl+C）：就绪门改原始订阅防历史缓冲误触 + 三步分时注入 + OSC 7 回执确认重试
- **SSH 终端交互对齐开发终端**：粘贴三键 / 智能 Ctrl+C 复制 / 恒复制键 / 右键智能粘贴复制 + Shift+右键菜单（全选/清屏等）/ Ctrl+=/- 字号 / 链接点击 / CJK 保真与 WebGL 渲染

## 重点

- **修复：远程任务首开只见末尾、不能滚**——cwb-server 环形缓冲 8KB→2MB、attach 全量历史回放（≤1.5MB，可滚动）；cwb-server 0.1.1→0.1.2，首连自动升级
- **SSH 终端目录跟随**：shell 里 `cd`，下方文件面板自动进对应目录（「跟随目录」开关默认开）
- **远程文件面板融合进 SSH 终端**：右侧「远程文件」按钮移除；远程项目菜单改「在 SSH 终端中打开」；**任务上下文打开 SSH 终端自动 cd 到项目目录**（worktree 任务到 worktree），文件面板同步直达
- **纯 SSH 连接类型**：连接档案新增「纯 SSH」——仅控制台+文件面板，跳过 claude 自检与 cwb-server，不可注册远程项目（侧栏/下拉带 SSH 徽标）

完整条目见仓库 CHANGELOG.md。

## 安装

Windows 覆盖安装：`SSH-Workbench-Setup-2.1.3.exe`（配置保留）。

**免安装版**：`SSH-Workbench-2.1.3-win-portable.zip`（156MB）——解压到任意目录，双击 `SSH Workbench.exe` 直接运行；与安装版共用同一配置目录（%APPDATA%\SSH Workbench），二者不要同时运行。首连自动升级 VM 内 cwb-server 至 0.1.2。

## 附件（4 个全部上传）

- `SSH-Workbench-Setup-2.1.3.exe`（覆盖安装）
- `SSH-Workbench-Setup-2.1.3.exe.blockmap`
- `SSH-Workbench-2.1.3-win-portable.zip`（免安装版）
- `latest.yml`（自动更新源，已校验 sha512/size）
