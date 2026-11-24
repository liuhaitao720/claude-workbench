# v2.2.6 发布说明

SSH Workbench v2.2.6 —— 修复终端粘贴失效（Electron 原生 clipboard 桥）+ Git
工作台补「工作区未提交变更」入口。cwb-server 保持 0.2.2。

## 1. 修复：SSH/开发终端右键与 Ctrl+V 粘贴失效

**现象**：SSH 终端里右键粘贴与 Ctrl+V 均无反应（v2.2.4 修双贴后出现）。

**根因**：粘贴路径依赖 `navigator.clipboard.readText()`——该 Web API 受**权限/
瞬时用户手势/文档焦点**约束，条件不满足时**静默 reject**（旧代码 `.catch` 全
吞，无任何提示）；v2.2.4 为修「Ctrl+V 双贴」加的 `preventDefault` 又移除了原生
paste 事件兜底——两条路都断，粘贴彻底失灵。右键路径同依赖 readText，故一起失效。

**修复**：全部剪贴板读写改走 **Electron 原生 clipboard 模块**（preload 桥
`clipboardReadText/clipboardWriteText`，无权限/手势/焦点约束）。覆盖：
- SSH 终端 + 开发终端：Ctrl+V / Ctrl+Shift+V / Shift+Insert、右键智能粘贴、
  Shift+右键菜单「粘贴」
- 全部复制路径（选中右键复制、Ctrl+C 有选中、菜单复制）
- Git 面板 hash 复制

`preventDefault`（防双贴）保留——现在只剩 Electron 通道一份粘贴，单次不重复。

## 2. 历史模式顶部：工作区变更卡（原型还原）

Git 工作台历史模式下，提交时间线**顶部**渲染显眼卡片：

```
⚙ 工作区未提交变更 · N 个文件 · 点击查看 diff →
```

- 仅当存在未提交变更时显示（计数随状态刷新：动作执行后/⟳ 自动重载）
- 点击直达**工作区模式**——即原代码审查窗口的完整能力：
  - 变更文件列表（M/A/D/R/U 状态 + ±行数）
  - 单文件 diff（hunk 上下跳转、未跟踪文件占位）
  - 顶栏「工作区 | 历史」模式切换随时往返，两模式共享 Git 顶栏操作
    （分支/拉取/推送/Stash/远程）

## 3. 验收建议

- SSH 终端/开发终端：Ctrl+V、Shift+Insert、右键（无选中）、Shift+右键菜单
  「粘贴」——四条路径都应正常粘贴且**只粘一份**；选中后右键/Ctrl+C 复制正常
- 项目有改动 → 打开 Git 面板（历史模式）：log 顶部出现绿色变更卡（文件数正确）
- 点卡 → 进入工作区模式，文件列表与 diff 可用
- 提交/暂存后计数刷新（或点 ⟳），无变更时卡片消失
