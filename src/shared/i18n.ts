/**
 * 界面文案字典（v1.1.2 中英双语）。
 *
 * 约定：
 * - 唯一事实源是 `zh`（中文原文即产品语言），`en` 的类型是 `Record<MessageKey, string>`
 *   —— 漏译会在编译期报错（不会出现"半个界面是英文"）。
 * - 占位符用 `{name}`，由 translate 做替换；不使用模板拼接，避免中英语序差异。
 * - 组件注释保持中文（开发文档），只翻译用户可见文本。
 */

export type Language = 'zh' | 'en'

export const zh = {
  // ── 通用 ────────────────────────────────────────────────
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.save': '保存',
  'common.remove': '移除',
  'common.enable': '启用',
  'common.detecting': '检测中…',
  'common.loading': '加载中…',
  'common.refresh': '刷新',

  // ── 主区/空态 ───────────────────────────────────────────
  'app.emptyHint': '从左侧“打开目录”注册一个项目开始',

  // ── 侧栏 ────────────────────────────────────────────────
  'sidebar.collapsed': '侧栏（已折叠）',
  'sidebar.searchExpand': '搜索（展开侧栏）',
  'sidebar.openDir': '打开目录',
  'sidebar.gitProject': 'git 项目',
  'sidebar.skills': 'Skills 管理',
  'sidebar.settings': '设置',
  'sidebar.about': '关于 Claude Workbench',
  'sidebar.expand': '展开侧栏 (Ctrl+B)',
  'sidebar.searchPlaceholder': '搜索任务/项目…',
  'sidebar.searchAria': '搜索任务/项目',
  'sidebar.empty': '尚未注册项目，点击“打开目录”开始',
  'sidebar.recent': '最近',
  'sidebar.newVersion': '有新版本 v{version}',
  'sidebar.skipPermsTitle':
    '该任务启动 claude 时附加 --dangerously-skip-permissions：跳过全部权限确认（含文件写入与命令执行）。仅建议在可信目录使用。',
  'sidebar.skipPermsLabel': '跳过权限确认（--dangerously-skip-permissions）',

  // ── 新建任务弹窗 ────────────────────────────────────────
  'newTask.aria': '新建任务',
  'newTask.title': '在 “{project}” 新建任务',
  'newTask.namePlaceholder': '任务名',
  'newTask.create': '新建任务',
  'newTask.cancel': '取消',
  'newTask.isolationHint': 'git 项目推荐使用 worktree 隔离，避免多任务互相覆盖工作区（主按钮为上次选择）',
  'newTask.worktree': '创建隔离分支（git worktree，分支 cwb/<新ID>）',
  'newTask.shared': '改用共享目录',

  // ── 项目树 ──────────────────────────────────────────────
  'tree.noMatch': '无匹配结果',
  'tree.newTask': '新建任务',
  'tree.rename': '重命名',
  'tree.remove': '移除',
  'tree.removeConfirm': '移除项目 “{name}”？（仅移除记录，不删除磁盘目录）',
  'tree.collapseTasks': '折叠 {name} 的任务',
  'tree.expandTasks': '展开 {name} 的任务',
  'tree.collapse': '折叠任务',
  'tree.expand': '展开任务',
  'tree.projectActions': '项目操作',
  'tree.noTasks': '暂无任务',
  'tree.groupToday': '今天',
  'tree.groupYesterday': '昨天',
  'tree.groupWeek': '近 7 天',
  'tree.groupOlder': '更早',
  'tree.stop': '停止',
  'tree.resume': '恢复',
  'tree.copySessionId': '复制 sessionId',
  'tree.delete': '删除',
  'tree.skipPermsOn': '跳过权限确认：开（点击关闭）',
  'tree.skipPermsOff': '跳过权限确认：关（点击开启）',
  'tree.taskActions': '任务操作',
  'tree.skipPermsBadge': '已开启 --dangerously-skip-permissions（下次启动生效）',
  'tree.deleteTitle': '删除任务 “{name}”？',
  'tree.deleteWorktree': '同时删除 worktree 分支',
  'tree.confirmDelete': '确认删除',
  'tree.deleteAria': '确认删除任务',

  // ── 任务状态提示 ────────────────────────────────────────
  'status.busy': '正在执行',
  'status.awaiting': '等待答复（权限/选项确认）',
  'status.idle': '空闲就绪',
  'status.stopped': '已停止（可恢复）',
  'status.exited': '已退出',
  'status.closed': '未打开终端',

  // ── 终端 ────────────────────────────────────────────────
  'term.copy': '复制',
  'term.paste': '粘贴',
  'term.selectAll': '全选',
  'term.clear': '清屏',
  'term.searchPlaceholder': '在终端中查找…',
  'term.searchAria': '终端搜索',
  'term.prevMatch': '上一个匹配',
  'term.nextMatch': '下一个匹配',
  'term.closeSearch': '关闭搜索',
  'term.empty': '暂无打开的终端——点击任务行打开终端 tab',
  'term.exceeded': '>{count}',
  'tab.closeStop': '关闭 tab 并停止任务',
  'tab.close': '关闭 tab',

  // ── 设置：通用 ──────────────────────────────────────────
  'settings.aria': '设置',
  'settings.title': '设置',
  'settings.navAria': '设置分类',
  'settings.sectionAppearance': '外观',
  'settings.sectionTerminal': '终端',
  'settings.sectionNotify': '通知',
  'settings.sectionCli': 'claude CLI',
  'settings.sectionUpdate': '应用更新',
  'settings.sectionStartup': '启动',
  'settings.language': '语言 / Language',

  // ── 设置：外观 ──────────────────────────────────────────
  'settings.themeAria': '界面主题',
  'settings.themeSystem': '跟随系统',
  'settings.themeDark': '深色',
  'settings.themeLight': '浅色',
  'settings.termFollow': '终端跟随界面主题',
  'settings.termFollowHint':
    '默认关闭——claude CLI 的 ANSI 彩色输出在浅色底上对比不足，终端保持深色更可读',

  // ── 设置：终端 ──────────────────────────────────────────
  'settings.fontAria': '终端字体',
  'settings.fontSizeAria': '终端字号',
  'settings.fontSizeHint': '字号 {min}-{max}，终端内 Ctrl+滚轮可即时调整',
  'settings.fontNotInstalled': '未安装',

  // ── 设置：通知 ──────────────────────────────────────────
  'settings.notifyTitle': '通知设置（webhook 推送）',
  'settings.notifyPlaceholder': '企业微信/钉钉群机器人 webhook URL',
  'settings.notifySaved': '已保存',
  'settings.notifySaveFailed': '保存失败：{error}',
  'settings.notifyTest': '测试推送',
  'settings.notifyTestOk': '测试推送成功',
  'settings.notifyTestFailed': '测试推送失败：{error}',
  'settings.notifyUnknownError': '未知错误',
  'settings.notifyNeedUrl': '先填写 URL',
  'settings.notifyHint': 'URL 属凭据，仅保存在本机（userData），不入仓库、不上传',
  'settings.notifyStateUnset': '未配置',
  'settings.notifyStateOn': '已启用',
  'settings.notifyStateOff': '未启用',

  // ── 设置：claude CLI ────────────────────────────────────
  'settings.cliVersion': '版本 {version}',
  'settings.cliPath': '路径 {path}',
  'settings.cliNotInstalled': '未安装 claude CLI',
  'settings.installMethodsAria': '安装方式',
  'settings.installNative': '原生安装器（推荐，无需 Node）',
  'settings.installNpm': 'npm 安装（需本机已有 Node/npm）',
  'settings.installNpmNoNode': '未检测到 node/npm',
  'settings.install': '下载安装',
  'settings.installDocs': '打开官方文档手动安装',
  'settings.checkUpdate': '检查更新',
  'settings.update': '更新',
  'settings.starting': '启动中…',
  'settings.updating': '更新中…',
  'settings.installing': '安装中…',
  'settings.cliDegraded': '无法查询最新版本（未检测到 node 环境）——可直接执行 claude update',
  'settings.cliVersionLine': '当前 {current} · 最新 {latest} · {state}',
  'settings.cliUpToDate': '已是最新',
  'settings.cliUpdatable': '可更新',
  'settings.cliStateNotInstalled': '未安装',
  'settings.notesNone': '未找到该版本的更新说明',
  'settings.notesFailed': '更新说明获取失败：{error}',
  'settings.installConfirm': '即将执行安装命令：\n\n  {cmd}\n\n确认执行？（请确认来源可信）',

  // ── 设置：应用更新 ──────────────────────────────────────
  'settings.appUpdateTitle': '应用更新',
  'settings.appDownload': '下载更新',
  'settings.appDownloading': '下载中 {percent}%',
  'settings.appVerifying': '校验中…',
  'settings.appRestartInstall': '重启并升级',
  'settings.appUpdateLine': '当前 v{current} · 最新 v{latest} · {state}',
  'settings.appManifestError': '（清单获取失败：{error}）',
  'settings.appUpdateHint':
    '当前 v{version}；升级包来自本仓 GitHub Releases（sha256 校验通过才安装），更新说明来自仓库 CHANGELOG.md',
  'settings.appInstallConfirm':
    '将退出应用并升级到新版本（运行中的任务会被终止），完成后自动重启。\n\n确认继续？',
  'settings.appDownloadFailed': '下载失败',
  'settings.appInstallStartFailed': '启动升级失败',
  'settings.updateStateUnchecked': '未检测',
  'settings.updateStateLatest': '最新 v{version}',
  'settings.updateStateAvailable': '可更新 v{version}',

  // ── 设置：启动 ──────────────────────────────────────────
  'settings.startupTitle': '启动与窗口',
  'settings.closeBehaviorAria': '关闭按钮行为',
  'settings.closeToTray': '最小化到托盘（常驻）',
  'settings.closeToTraySummary': '托盘常驻',
  'settings.quitApp': '退出应用',
  'settings.launchAtLogin': '开机自启',
  'settings.startupHint': '退出应用时如有运行中任务仍会先确认；开机自启仅安装版实际生效',

  // ── Skills ──────────────────────────────────────────────
  'skills.aria': 'Skills 管理',
  'skills.title': 'Skills 管理',
  'skills.empty': '暂无已安装 skill——可通过下方导入',
  'skills.userLevel': '用户级 · 全局生效',
  'skills.userLevelSub': '（~/.claude/skills，本机所有 claude 会话可用）',
  'skills.projectLevel': '项目级 · 仅该项目',
  'skills.projectLevelSub': '（<项目>/.claude/skills）',
  'skills.import': '导入',
  'skills.importHint': '仅安装可信来源——skill 可携带可执行脚本',
  'skills.importScopeAria': '导入目标',
  'skills.userScope': '用户级（全局生效）',
  'skills.projectScope': '项目级（{name}）',
  'skills.projectScopeNone': '项目级（未选中项目）',
  'skills.selectProjectFirst': '先在侧栏选中项目',
  'skills.importFolder': '导入文件夹…',
  'skills.noProject': '未选中项目——请先在侧栏选择项目',
  'skills.commandPlaceholder': '如：claude plugin install xxx@marketplace',
  'skills.commandAria': 'claude CLI 命令',
  'skills.run': '执行',
  'skills.removeConfirm': '移除 skill “{name}”？（移入回收站，可从回收站恢复）',
  'skills.effectHint': '新 skill 对已运行会话不生效——新任务自动生效，旧任务恢复后生效',
  'skills.importTitle': '导入',
  'skills.marketTitle': '在线搜索并安装',
  'skills.marketHint':
    '搜索本机已配置的 marketplace 目录；安装与刷新由 claude CLI 联网完成（沿用 CLI 的凭据与代理设置）',
  'skills.marketSearchPlaceholder': '搜索 skill（名称/描述/分类）…',
  'skills.marketSearchAria': '搜索 skill 市场',
  'skills.marketFilterAria': 'marketplace 过滤',
  'skills.marketAll': '全部 marketplace',
  'skills.marketRefresh': '刷新目录',
  'skills.marketRefreshing': '刷新中…',
  'skills.marketEmpty': '未找到匹配的 skill',
  'skills.marketNoMarketplaces': '未配置 marketplace——请先用下方命令添加，如 claude plugin marketplace add <仓库>',
  'skills.marketInstall': '安装',
  'skills.marketInstalling': '安装中…',
  'skills.marketInstalls': '{count} 次安装',
  'skills.marketInstallFailed': '安装失败：{error}',
  'skills.marketCount': '共 {count} 条',

  // ── About ───────────────────────────────────────────────
  'about.aria': '关于',
  'about.version': '版本 v{version}',
  'about.build': ' · 构建 {date}',
  'about.license': '许可证',
  'about.licenseTail': '（源码随仓库分发，见 LICENSE 文件）',
  'about.author': '作者 Liu Haitao',
  'about.settingsEntry': 'claude CLI / 更多配置 →',
  'about.openSettings': '打开设置',

  // ── CLI 输出区 ──────────────────────────────────────────
  'cliOutput.aria': '命令输出',
  'cliOutput.waiting': '（等待输出…）',
  'cliOutput.done': '已完成（退出码 {code}）——{hint}',
  'cliOutput.exitHint': '新任务生效，旧任务恢复（resume）后生效',

  // ── main 侧（托盘/退出确认）──────────────────────────────
  'tray.tooltip': 'Claude Workbench（{count} 个任务运行中）',
  'tray.show': '显示 Claude Workbench',
  'tray.quit': '退出（结束所有任务）',
  'quit.message': '仍有 {count} 个任务在运行',
  'quit.detail': '退出将结束所有运行中的任务会话。确定要退出吗？',
  'quit.confirm': '结束并退出',
  'quit.cancel': '取消',

  // ── main 侧：webhook 通知文案 ─────────────────────────────
  'notify.awaiting':
    '【Claude Workbench】任务「{name}」等待你的答复（权限确认/选择），请回电脑处理\n> {when}',
  'notify.test': '【Claude Workbench】测试推送：通知配置已生效',
  'notify.needUrl': '未配置 webhook URL',
  'notify.httpStatus': 'webhook 响应 HTTP {status}',
  'notify.urlIsAdminPage':
    '这是企业微信机器人的管理页地址，不是 Webhook 推送地址。请在 群设置 → 群机器人 → 复制 Webhook 地址（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）',
  'notify.urlScheme': 'URL 须以 http:// 或 https:// 开头',

  // ── main 侧：CLI 命令校验 ────────────────────────────────
  'cli.errEmpty': '命令为空',
  'cli.errNewline': '命令含换行（拒绝多语句注入）',
  'cli.errNotClaude': '命令必须以 claude 开头（实际首个词: {word}）',
  'cli.errMissingSub': '缺少子命令（claude 后须跟 plugin/update/upgrade/mcp）',
  'cli.errSubNotAllowed': '子命令不在白名单 {plugin, update, upgrade, mcp} 内: {word}',
  'cli.errMetachar': '命令含被禁止的元字符（& | > < % ^ " 反引号 或换行）: {word}',

  // ── main 侧：marketplace 安装目标校验 ──────────────────────
  'skill.errIdFormat': 'installId 格式非法（应为 <name>@<marketplace>）',
  'skill.errNameChars': '插件名含非法字符',
  'skill.errMarketChars': 'marketplace 名含非法字符',
  'skill.errParam': '参数非法',

  // ── main 侧：skill 导入/移除校验 ────────────────────────────
  'skills.errSrcMissing': '源文件夹不存在: {dir}',
  'skills.errSrcNotDir': '源路径不是文件夹: {dir}',
  'skills.errNoSkillMd': '所选文件夹缺少 SKILL.md（不是有效 skill 目录）: {dir}',
  'skills.errConflict': '同名 skill 已存在，导入取消（如需覆盖请先移除既有项）: {name}',
  'skills.errDirGone': 'skill 目录不存在或不可解析: {dir}',
  'skills.errOutOfRoot': '拒绝移除：目录不在对应 skills 根之下（越界防护）: {dir}',

  // ── main 侧：会话导入默认任务名 ────────────────────────────
  'session.defaultName': '会话 {id}',

  // ── main 侧：应用自更新错误 ────────────────────────────────
  'appUpd.errManifestNoVersion': '清单格式异常（无 version）',
  'appUpd.errNoManifest': '尚未检查更新（无清单）',
  'appUpd.errDevMode': '开发模式运行，不支持自升级',
  'appUpd.errHttp': '下载失败 HTTP {status}',
  'appUpd.errSha': 'sha256 校验失败（下载损坏或被篡改）',
  'appUpd.errIncomplete': '下载不完整 {received}/{total}',
  'appUpd.errPackageMissing': '安装包未就绪（请先下载）',
  'appUpd.errPackageEmpty': '安装包为空',

  // ── main 侧：claude CLI 版本/更新说明错误 ───────────────────
  'cliVer.errRegistryNoVersion': 'registry 响应无 version',
  'cliVer.errBothFailed': '{primary}；atom 兜底 {fallback}'
} as const

export type MessageKey = keyof typeof zh

/**
 * 英文文案。类型约束为全量键集合——新增中文键而未补英文会编译失败。
 * 翻译口径：界面术语与 Windows Terminal / VS Code 对齐（如 tab / skip permissions）。
 */
export const en: Record<MessageKey, string> = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.remove': 'Remove',
  'common.enable': 'Enable',
  'common.detecting': 'Detecting…',
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',

  'app.emptyHint': 'Open a folder on the left to register your first project',

  'sidebar.collapsed': 'Sidebar (collapsed)',
  'sidebar.searchExpand': 'Search (expand sidebar)',
  'sidebar.openDir': 'Open folder',
  'sidebar.gitProject': 'Git project',
  'sidebar.skills': 'Manage skills',
  'sidebar.settings': 'Settings',
  'sidebar.about': 'About Claude Workbench',
  'sidebar.expand': 'Expand sidebar (Ctrl+B)',
  'sidebar.searchPlaceholder': 'Search tasks / projects…',
  'sidebar.searchAria': 'Search tasks and projects',
  'sidebar.empty': 'No projects yet — click “Open folder” to start',
  'sidebar.recent': 'Recent',
  'sidebar.newVersion': 'New version v{version} available',
  'sidebar.skipPermsTitle':
    'This task starts claude with --dangerously-skip-permissions: all permission prompts are skipped (including file writes and command execution). Use only in trusted folders.',
  'sidebar.skipPermsLabel': 'Skip permission prompts (--dangerously-skip-permissions)',

  'newTask.aria': 'New task',
  'newTask.title': 'New task in “{project}”',
  'newTask.namePlaceholder': 'Task name',
  'newTask.create': 'Create task',
  'newTask.cancel': 'Cancel',
  'newTask.isolationHint':
    'Git projects should use worktree isolation so parallel tasks do not overwrite each other (the primary button reflects your last choice)',
  'newTask.worktree': 'Create isolated branch (git worktree, branch cwb/<new-id>)',
  'newTask.shared': 'Use shared folder instead',

  'tree.noMatch': 'No matches',
  'tree.newTask': 'New task',
  'tree.rename': 'Rename',
  'tree.remove': 'Remove',
  'tree.removeConfirm': 'Remove project “{name}”? (Removes the record only; the folder is kept.)',
  'tree.collapseTasks': 'Collapse tasks in {name}',
  'tree.expandTasks': 'Expand tasks in {name}',
  'tree.collapse': 'Collapse tasks',
  'tree.expand': 'Expand tasks',
  'tree.projectActions': 'Project actions',
  'tree.noTasks': 'No tasks yet',
  'tree.groupToday': 'Today',
  'tree.groupYesterday': 'Yesterday',
  'tree.groupWeek': 'Previous 7 days',
  'tree.groupOlder': 'Older',
  'tree.stop': 'Stop',
  'tree.resume': 'Resume',
  'tree.copySessionId': 'Copy sessionId',
  'tree.delete': 'Delete',
  'tree.skipPermsOn': 'Skip permission prompts: on (click to turn off)',
  'tree.skipPermsOff': 'Skip permission prompts: off (click to turn on)',
  'tree.taskActions': 'Task actions',
  'tree.skipPermsBadge': '--dangerously-skip-permissions is on (takes effect on next start)',
  'tree.deleteTitle': 'Delete task “{name}”?',
  'tree.deleteWorktree': 'Also delete the worktree branch',
  'tree.confirmDelete': 'Delete',
  'tree.deleteAria': 'Confirm delete task',

  'status.busy': 'Running',
  'status.awaiting': 'Waiting for your answer (permission / choice)',
  'status.idle': 'Idle, ready',
  'status.stopped': 'Stopped (resumable)',
  'status.exited': 'Exited',
  'status.closed': 'Terminal not open',

  'term.copy': 'Copy',
  'term.paste': 'Paste',
  'term.selectAll': 'Select all',
  'term.clear': 'Clear',
  'term.searchPlaceholder': 'Find in terminal…',
  'term.searchAria': 'Terminal search',
  'term.prevMatch': 'Previous match',
  'term.nextMatch': 'Next match',
  'term.closeSearch': 'Close search',
  'term.empty': 'No terminals open — click a task to open its terminal tab',
  'term.exceeded': '>{count}',
  'tab.closeStop': 'Close tab and stop task',
  'tab.close': 'Close tab',

  'settings.aria': 'Settings',
  'settings.title': 'Settings',
  'settings.navAria': 'Settings categories',
  'settings.sectionAppearance': 'Appearance',
  'settings.sectionTerminal': 'Terminal',
  'settings.sectionNotify': 'Notifications',
  'settings.sectionCli': 'claude CLI',
  'settings.sectionUpdate': 'App updates',
  'settings.sectionStartup': 'Startup',
  'settings.language': 'Language / 语言',

  'settings.themeAria': 'Interface theme',
  'settings.themeSystem': 'Follow system',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.termFollow': 'Terminal follows interface theme',
  'settings.termFollowHint':
    "Off by default — claude CLI's ANSI colors lack contrast on light backgrounds; a dark terminal is more readable",

  'settings.fontAria': 'Terminal font',
  'settings.fontSizeAria': 'Terminal font size',
  'settings.fontSizeHint': 'Size {min}-{max}; Ctrl+wheel adjusts it inside the terminal',
  'settings.fontNotInstalled': 'not installed',

  'settings.notifyTitle': 'Notifications (webhook push)',
  'settings.notifyPlaceholder': 'WeCom / DingTalk group bot webhook URL',
  'settings.notifySaved': 'Saved',
  'settings.notifySaveFailed': 'Save failed: {error}',
  'settings.notifyTest': 'Send test',
  'settings.notifyTestOk': 'Test push succeeded',
  'settings.notifyTestFailed': 'Test push failed: {error}',
  'settings.notifyUnknownError': 'unknown error',
  'settings.notifyNeedUrl': 'Enter a URL first',
  'settings.notifyHint':
    'The URL is a credential: stored locally only (userData), never committed or uploaded',
  'settings.notifyStateUnset': 'Not configured',
  'settings.notifyStateOn': 'Enabled',
  'settings.notifyStateOff': 'Disabled',

  'settings.cliVersion': 'Version {version}',
  'settings.cliPath': 'Path {path}',
  'settings.cliNotInstalled': 'claude CLI is not installed',
  'settings.installMethodsAria': 'Install method',
  'settings.installNative': 'Native installer (recommended, no Node required)',
  'settings.installNpm': 'npm install (requires Node/npm)',
  'settings.installNpmNoNode': 'node/npm not found',
  'settings.install': 'Download and install',
  'settings.installDocs': 'Open official docs for manual install',
  'settings.checkUpdate': 'Check for updates',
  'settings.update': 'Update',
  'settings.starting': 'Starting…',
  'settings.updating': 'Updating…',
  'settings.installing': 'Installing…',
  'settings.cliDegraded':
    "Cannot query the latest version (no Node environment detected) — you can run claude update directly",
  'settings.cliVersionLine': 'Current {current} · Latest {latest} · {state}',
  'settings.cliUpToDate': 'up to date',
  'settings.cliUpdatable': 'update available',
  'settings.cliStateNotInstalled': 'Not installed',
  'settings.notesNone': 'No release notes found for this version',
  'settings.notesFailed': 'Could not fetch release notes: {error}',
  'settings.installConfirm':
    'The following install command will run:\n\n  {cmd}\n\nContinue? (Make sure the source is trustworthy.)',

  'settings.appUpdateTitle': 'App updates',
  'settings.appDownload': 'Download update',
  'settings.appDownloading': 'Downloading {percent}%',
  'settings.appVerifying': 'Verifying…',
  'settings.appRestartInstall': 'Restart and update',
  'settings.appUpdateLine': 'Current v{current} · Latest v{latest} · {state}',
  'settings.appManifestError': ' (manifest fetch failed: {error})',
  'settings.appUpdateHint':
    'Current v{version}; packages come from this repo’s GitHub Releases (installed only after sha256 verification), release notes come from CHANGELOG.md',
  'settings.appInstallConfirm':
    'The app will quit and upgrade to the new version (running tasks will be terminated), then restart automatically.\n\nContinue?',
  'settings.appDownloadFailed': 'Download failed',
  'settings.appInstallStartFailed': 'Failed to start the upgrade',
  'settings.updateStateUnchecked': 'Not checked',
  'settings.updateStateLatest': 'Latest v{version}',
  'settings.updateStateAvailable': 'Update available: v{version}',

  'settings.startupTitle': 'Startup and window',
  'settings.closeBehaviorAria': 'Close button behavior',
  'settings.closeToTray': 'Minimize to tray (stay running)',
  'settings.closeToTraySummary': 'Stays in tray',
  'settings.quitApp': 'Quit app',
  'settings.launchAtLogin': 'Launch at login',
  'settings.startupHint':
    'Quitting with running tasks still asks for confirmation; launch at login only applies to the installed build',

  'skills.aria': 'Manage skills',
  'skills.title': 'Manage skills',
  'skills.empty': 'No skills installed yet — import one below',
  'skills.userLevel': 'User level · global',
  'skills.userLevelSub': '(~/.claude/skills, available to every claude session on this machine)',
  'skills.projectLevel': 'Project level · this project only',
  'skills.projectLevelSub': '(<project>/.claude/skills)',
  'skills.import': 'Import',
  'skills.importHint': 'Install from trusted sources only — skills can carry executable scripts',
  'skills.importScopeAria': 'Import target',
  'skills.userScope': 'User level (global)',
  'skills.projectScope': 'Project level ({name})',
  'skills.projectScopeNone': 'Project level (no project selected)',
  'skills.selectProjectFirst': 'Select a project in the sidebar first',
  'skills.importFolder': 'Import folder…',
  'skills.noProject': 'No project selected — pick one in the sidebar first',
  'skills.commandPlaceholder': 'e.g. claude plugin install xxx@marketplace',
  'skills.commandAria': 'claude CLI command',
  'skills.run': 'Run',
  'skills.removeConfirm': 'Remove skill “{name}”? (Moved to the recycle bin; restorable.)',
  'skills.effectHint':
    'New skills do not affect running sessions — new tasks pick them up, older tasks after resume',
  'skills.importTitle': 'Import',
  'skills.marketTitle': 'Search and install online',
  'skills.marketHint':
    'Searches the marketplace catalogs configured on this machine; installs and refreshes go through the claude CLI (which uses its own credentials and proxy settings)',
  'skills.marketSearchPlaceholder': 'Search skills (name / description / category)…',
  'skills.marketSearchAria': 'Search skill marketplace',
  'skills.marketFilterAria': 'Marketplace filter',
  'skills.marketAll': 'All marketplaces',
  'skills.marketRefresh': 'Refresh catalogs',
  'skills.marketRefreshing': 'Refreshing…',
  'skills.marketEmpty': 'No matching skills',
  'skills.marketNoMarketplaces':
    'No marketplaces configured — add one with the command below, e.g. claude plugin marketplace add <repo>',
  'skills.marketInstall': 'Install',
  'skills.marketInstalling': 'Installing…',
  'skills.marketInstalls': '{count} installs',
  'skills.marketInstallFailed': 'Install failed: {error}',
  'skills.marketCount': '{count} results',

  'about.aria': 'About',
  'about.version': 'Version v{version}',
  'about.build': ' · built {date}',
  'about.license': 'License',
  'about.licenseTail': ' (source ships with the repository, see LICENSE)',
  'about.author': 'Author: Liu Haitao',
  'about.settingsEntry': 'claude CLI / more settings →',
  'about.openSettings': 'Open settings',

  'cliOutput.aria': 'Command output',
  'cliOutput.waiting': '(waiting for output…)',
  'cliOutput.done': 'Done (exit code {code}) — {hint}',
  'cliOutput.exitHint': 'takes effect for new tasks; existing tasks after resume',

  'tray.tooltip': 'Claude Workbench ({count} task(s) running)',
  'tray.show': 'Show Claude Workbench',
  'tray.quit': 'Quit (ends all tasks)',
  'quit.message': '{count} task(s) still running',
  'quit.detail': 'Quitting will end all running task sessions. Quit anyway?',
  'quit.confirm': 'End and quit',
  'quit.cancel': 'Cancel',

  'notify.awaiting':
    '[Claude Workbench] Task "{name}" is waiting for your answer (permission / choice). Please come back to your computer.\n> {when}',
  'notify.test': '[Claude Workbench] Test push: notification settings are working',
  'notify.needUrl': 'No webhook URL configured',
  'notify.httpStatus': 'webhook responded HTTP {status}',
  'notify.urlIsAdminPage':
    'This is the WeCom bot management page, not a webhook URL. Copy the webhook from Group Settings → Group Bots (it looks like https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...)',
  'notify.urlScheme': 'URL must start with http:// or https://',

  'cli.errEmpty': 'Command is empty',
  'cli.errNewline': 'Command contains a newline (multi-statement injection rejected)',
  'cli.errNotClaude': 'Command must start with claude (first word: {word})',
  'cli.errMissingSub': 'Missing subcommand (claude must be followed by plugin/update/upgrade/mcp)',
  'cli.errSubNotAllowed': 'Subcommand is not in the whitelist {plugin, update, upgrade, mcp}: {word}',
  'cli.errMetachar':
    'Command contains a forbidden metacharacter (& | > < % ^ " backtick or newline): {word}',

  'skill.errIdFormat': 'Invalid installId (expected <name>@<marketplace>)',
  'skill.errNameChars': 'Plugin name contains invalid characters',
  'skill.errMarketChars': 'Marketplace name contains invalid characters',
  'skill.errParam': 'Invalid argument',

  'skills.errSrcMissing': 'Source folder does not exist: {dir}',
  'skills.errSrcNotDir': 'Source path is not a folder: {dir}',
  'skills.errNoSkillMd': 'The selected folder has no SKILL.md (not a valid skill directory): {dir}',
  'skills.errConflict':
    'A skill with the same name already exists; import cancelled (remove the existing one to replace it): {name}',
  'skills.errDirGone': 'Skill directory is missing or unresolvable: {dir}',
  'skills.errOutOfRoot':
    'Removal refused: directory is not under the expected skills root: {dir}',

  'session.defaultName': 'Session {id}',

  'appUpd.errManifestNoVersion': 'Malformed manifest (no version)',
  'appUpd.errNoManifest': 'Update not checked yet (no manifest)',
  'appUpd.errDevMode': 'Self-update is not supported in development mode',
  'appUpd.errHttp': 'Download failed: HTTP {status}',
  'appUpd.errSha': 'sha256 verification failed (corrupted or tampered download)',
  'appUpd.errIncomplete': 'Incomplete download {received}/{total}',
  'appUpd.errPackageMissing': 'Package not ready (download it first)',
  'appUpd.errPackageEmpty': 'Package is empty',

  'cliVer.errRegistryNoVersion': 'Registry response has no version',
  'cliVer.errBothFailed': '{primary}; atom fallback {fallback}'
}

const DICTS: Record<Language, Record<MessageKey, string>> = { zh, en }

/** 取文案并替换 `{name}` 占位符；缺键返回键名本身（便于发现漏配） */
export function translate(
  lang: Language,
  key: MessageKey,
  params?: Record<string, string | number>
): string {
  const dict = DICTS[lang] ?? zh
  let text = dict[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v))
    }
  }
  return text
}

/** 语言显示名（选择器用；两边都显示母语名，避免用户看不懂当前选项） */
export const LANGUAGE_LABELS: Record<Language, string> = {
  zh: '简体中文',
  en: 'English'
}