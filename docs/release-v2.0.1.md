# v2.0.1 发布说明（覆盖更新）

SSH Workbench v2.0.1 —— 2.0.0 后七轮实测修复合入版（本版为覆盖更新，含 11/12 下午新增）

## 重点

- **应用更新默认不自动升级**：缺省仅检查新版本；可在 设置→关于 开启
- **远程文件管理**（FinalShell 式面板）：传输提速 ~28x（100MB 实测 68.9MB/s）、多选直删（Ctrl/Shift 范围/拖动框选）、小文本双击本机打开、家目录快捷键、mtime 列+底部状态条、软链接目录识别、远程项目直达工作目录、传输条保存目录一键打开
- **重启后首开远程任务无上下文根因修复**
- **侧栏作用域过滤**：一键切域（全部/本机/各服务器）
- **通知推送留痕自诊**：设置 Webhook 页显示最近 8 次推送尝试（sent/failed/skipped）
- npm≥12 安装白名单 / 英文标签自适应 / 通知缓存 TTL 等十余项修复

完整条目见仓库 CHANGELOG.md。

## 安装

Windows：`SSH-Workbench-Setup-2.0.1.exe` 覆盖安装（配置保留）。

## 附件（3 个全部上传）

- `SSH-Workbench-Setup-2.0.1.exe`
- `SSH-Workbench-Setup-2.0.1.exe.blockmap`
- `latest.yml`（自动更新源，已校验 sha512/size）
