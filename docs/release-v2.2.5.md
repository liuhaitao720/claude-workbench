# v2.2.5 发布说明

SSH Workbench v2.2.5 —— Git 工作台（IDEA Git 工具窗式）：分支管理 + 多分支
graph 修改记录 + cherry-pick/stash/远程管理；**代码审查窗口并入**。cwb-server
保持 0.2.2。

## 1. Git 工作台（用户需求，界面参考 IDEA）

入口：项目树项目菜单「Git 管理…」→ 主区「⑂ Git」虚拟 tab（任务/SSH 三方
互斥，终端常驻退后台）。

**顶栏**：
- 模式切换 **工作区 | 历史**；当前分支 + ↑ahead/↓behind 徽记
- Stash（带数量）/ 远程管理 / ⟳ 刷新 / 拉取 / 推送

**左栏 分支**（右键菜单，IDEA branches popup 项集）：
- 检出 checkout（**远程分支检出=自动建同名本地跟踪分支**）
- 从此处新建分支…（可指定基点）
- 合并到当前分支…（**模式可选：常规 / --ff-only 仅快进 / --no-ff 保留合并提交**）
- 拉取 / 推送
- 删除分支…（-d 安全删；含未合并提交时 -D 强删确认）

**中栏 修改记录**：
- **多分支 graph 时间线**：`git log --graph --all` 拓扑逐字符渲染——竖线/
  点/斜线原样呈现分叉与合并曲线
- 搜索（提交信息/作者/hash 短码）
- 提交行：短 hash + HEAD 标 + 主题 + 作者·相对时间
- **提交右键**：cherry-pick 到当前分支（确认窗）/ 复制短 hash / 复制完整 hash

**右栏 提交详情**：
- 完整提交信息 + hash（复制按钮）+ 作者/时间
- 变更文件列表（M/A/D/R 着色 + ±行数；改名显示 old → new）
- 点击文件 → 该提交此文件的 diff 弹窗（审查视图同款渲染）

**拉取/推送弹窗**：
- 拉取模式：常规 / **--rebase** / --ff-only
- 推送：当前分支推上游（无上游自动 -u 建跟踪）；**勾选 -f 强推 → 醒目警示 +
  确认弹窗 + 二次 window.confirm**

**Stash 面板**：列表（序号+消息）/ 暂存当前变更（可带消息）/ 恢复（pop）/
应用（apply 保留副本）/ 删除（确认）。

**远程管理**：remote -v 列表 + 新增（名称+URL）/ set-url 改址 / remove（确认）。

## 2. 审查窗口并入（用户指令）

原 v2.0.2 的代码审查窗口（工作区变更 diff）**移除独立 tab**——成为 Git 工作
台的「工作区」模式（DiffReview 组件原样嵌入，文件列表/单文件 diff/hunk 键盘
跳转不变）。全部既有入口（任务完成 toast「审查」/项目菜单「审查改动…」/右
缘竖条）照旧，打开的就是 Git 工作台的工作区模式；tab 合并为单个「⑂ Git」
（带变更文件数角标）。

## 3. 实现

- **全部 git 自带命令**：for-each-ref / log --graph --all / show / switch /
  switch -c --track / merge / pull / push / branch -d / cherry-pick / stash /
  remote——本地项目 execFile git，远程项目 SSH exec（同源 GitRunner）
- 安全：ref/hash/远程名/URL 白名单校验后才进命令（防选项注入/路径穿透）；
  危险动作（-D / -f / stash drop / remote remove）一律确认窗
- 设计原型 `design/git-manager.html`（含六项需求标注：URL 管理/--rebase/
  --ff-merge/-f 确认/cherry-pick+stash/多分支 graph）

## 4. 验收建议

- 项目菜单「Git 管理…」：分支列表与终端 `git branch -a` 一致；当前分支高亮
- 提交右键 cherry-pick 一个旧提交 → 当前分支顶部出现该提交
- 拉取弹窗选「变基 --rebase」→ `git log` 确认 rebase 生效
- 推送勾选 -f → 两次确认后才强推
- 工作区模式（旧审查入口）文件双击 diff 照旧可用
