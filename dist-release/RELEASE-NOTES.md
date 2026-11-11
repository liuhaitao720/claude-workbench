# v1.7.6 发布说明（粘贴到 GitHub Release）

SSH Workbench v1.7.6

## 本版修复

- **连接抖动会重置 Webhook 通知表单的未保存勾选**——通知配置此前随连接状态重载，抖动一次就把未保存的「启用」勾选/URL 重置回旧值，保存即落 `enabled=false`；现仅在切换作用域时加载
- 完整更新日志见仓库 CHANGELOG.md（1.7.0 起含设置中心作用域化重构、远程模型配置、Skills 移植、npm allow-scripts 等全部条目）

## 安装

Windows：下载 `SSH-Workbench-Setup-1.7.6.exe` 安装（覆盖升级，配置保留）。

## 附件（3 个全部上传）

- `SSH-Workbench-Setup-1.7.6.exe`（安装包）
- `SSH-Workbench-Setup-1.7.6.exe.blockmap`（增量更新用）
- `latest.yml`（自动更新源——必须与 exe 同名对齐，已校验 sha512/size）
