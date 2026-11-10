import type { Language, MessageKey } from '../../../shared/i18n'

/**
 * S6（SSH 远程 UI）补充文案字典——renderer 侧专用。
 *
 * 为什么不进 src/shared/i18n.ts：S1 批0 锁定的「S6 填值区」只有 20 键（侧栏服务器
 * 节点/连接对话框/断连冻结层），而 v2 设计给 S6 追加了设置「远程连接」分类、远程项目
 * 注册对话框、server 安装确认弹窗、远程代理面板（评审①F5/①F7）——这些界面的文案
 * 超出该区且 S1 注释明言「增删键须走契约红」。本批以 renderer 侧补充字典满足 9.2=A
 * （zh/en 双语齐备随功能发布），键并入 shared 须待主控契约流程（NEEDS_CONTEXT 已随
 * S6 报告上报）；届时把这里的键值搬进 shared 后删除本文件即可，行为零变化。
 *
 * 约定与 shared 相同：zh 是唯一事实源；en 类型约束为全量键集合（漏译编译期报错）；
 * 占位符 `{name}`；键名以 `s6.` 前缀避免与 shared 键冲突。
 */
export const s6Zh = {
  // ── 设置中心「远程连接」分类（连接档案 CRUD + 测试自检 2.2/9.2） ──────────
  's6.addConnection': '新增连接',
  's6.fieldInvalid': '{field} 未填写或不合法',
  's6.connEmpty': '还没有配置远程连接',
  's6.connTestOk': '连接测试通过',
  's6.connTestNeedSave': '先保存后测试（测试按已保存的档案连接）',
  's6.saveFailed': '保存失败（详见运行日志）',
  's6.connHintsTitle': '常见排障提示',
  's6.hintVmDown': 'VM 未启动或被挂起——启动虚拟机后重试',
  's6.hintNoSshd': 'sshd 未安装或未启动——VM 内执行 sudo apt install openssh-server 并启动 ssh 服务',
  's6.hintNat': 'NAT 网络未转发——检查 VMware 虚拟网络/端口转发设置，或改用 host-only 网络',
  's6.hintKeyDenied': '密钥未授权——把公钥追加到 VM 内 ~/.ssh/authorized_keys，或改用密码认证',
  's6.authKey': '私钥',
  's6.pwdHint':
    '密码经系统凭据保护加密保存；编辑已有档案时留空=保持原密码',
  's6.keyPassphrase': '密钥口令（可选）',
  's6.keyPassphraseHint':
    '私钥口令与密码同样经系统凭据保护加密保存；编辑时留空=保持原值（无口令私钥可不填）',
  's6.hostKeyFingerprint': '主机指纹',
  's6.confirmHostKey': '确认并锁定指纹',
  's6.hostKeyChangedWarn':
    '指纹与已锁定值不一致，连接已阻断——确认是 VM 重装等预期变更后，重新确认锁定新指纹',
  // ── 远程代理面板（6.4=c：配置存 VM 侧，客户端经 SSH/server 协议读写） ──────
  's6.remoteProxy': '远程代理',
  's6.remoteProxyHint':
    '代理由远程 server 内置实现，配置保存在 VM 侧；此处经 SSH/server 协议读写（留空=直连）',
  // ── claude CLI 分类远程上下文占位说明（版本/更新面向远端，S5 接管） ─────────
  's6.cliRemoteNote':
    '远程任务使用 VM 内的 claude CLI——其版本检测与更新面向远端，由「远程连接」分类接管（本页仅管理本机 CLI）。',
  // ── 远程项目注册对话框（3.1=C：手输 VM 绝对路径 + SFTP 目录浏览器） ─────────
  's6.remotePathLabel': 'VM 内绝对路径',
  's6.browse': '浏览…',
  's6.register': '注册',
  's6.pathInvalid': '路径须为以 / 开头的 VM 绝对路径',
  's6.browseTitle': '浏览远程目录',
  's6.browseUp': '上一级',
  's6.browseEmpty': '（空目录）',
  's6.browsePick': '选择当前目录',
  // ── server 安装/升级确认弹窗（6.7=A：首连推送，确认后执行；promise=S7） ─────
  's6.installTitle': '安装 cwb-server',
  's6.installBody':
    '首次连接需把 cwb-server 组件推送到 VM 的用户目录（~/.cwb-server）并启动；升级时滚动替换为新版，均不改动 VM 内其他文件。',
  's6.installBtn': '推送并安装',
  's6.installing': '安装中…',
  's6.installOk': '安装完成，正在重新连接…',
  's6.installFailed': '安装失败：{error}',
  // ── 侧栏服务器节点（3.5/3.8/3.11=a 轻分组头） ─────────────────────────────
  's6.serverActions': '服务器操作',
  's6.collapseServer': '折叠 {name}',
  's6.expandServer': '展开 {name}',
  // ── 删除服务器级联确认（3.9=A：仅删客户端记录，语义必须显式） ──────────────
  's6.removeServerTitle': '删除服务器 “{name}”？',
  's6.removeServerAffects': '将一并移除 {projects} 个远程项目记录与 {tasks} 个任务记录（仅客户端记录）'
} as const

export type S6MessageKey = keyof typeof s6Zh

/** en 全量翻译（缺键编译期报错，同 shared/i18n.ts 先例） */
export const s6En: Record<S6MessageKey, string> = {
  's6.addConnection': 'Add connection',
  's6.fieldInvalid': '{field} is missing or invalid',
  's6.connEmpty': 'No remote connections configured yet',
  's6.connTestOk': 'Connection test passed',
  's6.connTestNeedSave': 'Save first — the test connects with the saved profile',
  's6.saveFailed': 'Save failed (see the runtime log)',
  's6.connHintsTitle': 'Common troubleshooting',
  's6.hintVmDown': 'VM not started or suspended — start the VM and retry',
  's6.hintNoSshd':
    'sshd missing or not running — run sudo apt install openssh-server inside the VM and start the ssh service',
  's6.hintNat':
    'NAT forwarding missing — check the VMware virtual network / port forwarding, or switch to host-only networking',
  's6.hintKeyDenied':
    'Key not authorized — append the public key to ~/.ssh/authorized_keys inside the VM, or switch to password auth',
  's6.authKey': 'Private key',
  's6.pwdHint':
    'The password is stored encrypted via OS credential protection; leave it blank when editing to keep the current one',
  's6.keyPassphrase': 'Key passphrase (optional)',
  's6.keyPassphraseHint':
    'The key passphrase is stored encrypted exactly like the password; leave blank when editing to keep the current value (skip for passphrase-less keys)',
  's6.hostKeyFingerprint': 'Host key fingerprint',
  's6.confirmHostKey': 'Confirm and lock fingerprint',
  's6.hostKeyChangedWarn':
    'The fingerprint no longer matches the locked value; the connection is blocked — after confirming an expected change (e.g. VM reinstall), confirm and lock the new fingerprint',
  's6.remoteProxy': 'Remote proxy',
  's6.remoteProxyHint':
    'The proxy is built into the remote server and its config is stored inside the VM; it is read/written here over SSH / the server protocol (empty = direct)',
  's6.cliRemoteNote':
    'Remote tasks use the claude CLI inside the VM — its version checks and updates target the remote side and are handled under “Remote connections”; this page manages the local CLI only.',
  's6.remotePathLabel': 'Absolute path inside the VM',
  's6.browse': 'Browse…',
  's6.register': 'Register',
  's6.pathInvalid': 'The path must be an absolute VM path starting with /',
  's6.browseTitle': 'Browse remote folders',
  's6.browseUp': 'Up one level',
  's6.browseEmpty': '(empty folder)',
  's6.browsePick': 'Choose this folder',
  's6.installTitle': 'Install cwb-server',
  's6.installBody':
    'The first connection pushes the cwb-server component to the VM user directory (~/.cwb-server) and starts it; upgrades replace it in place. No other VM files are touched.',
  's6.installBtn': 'Push and install',
  's6.installing': 'Installing…',
  's6.installOk': 'Installed, reconnecting…',
  's6.installFailed': 'Install failed: {error}',
  's6.serverActions': 'Server actions',
  's6.collapseServer': 'Collapse {name}',
  's6.expandServer': 'Expand {name}',
  's6.removeServerTitle': 'Remove server “{name}”?',
  's6.removeServerAffects':
    'This also removes {projects} remote project record(s) and {tasks} task record(s) (client-side records only)'
}

const S6_DICTS: Record<Language, Record<S6MessageKey, string>> = { zh: s6Zh, en: s6En }

/** renderer 侧统一键类型：shared 全量键 + S6 补充键 */
export type AnyMessageKey = MessageKey | S6MessageKey

/** S6 补充键判定（键名 `s6.` 前缀） */
export function isS6Key(key: AnyMessageKey): key is S6MessageKey {
  return typeof key === 'string' && key.startsWith('s6.')
}

/** S6 补充键的取文案（占位符替换语义同 shared translate） */
export function translateS6(
  lang: Language,
  key: S6MessageKey,
  params?: Record<string, string | number>
): string {
  const dict = S6_DICTS[lang] ?? s6Zh
  let text = dict[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v))
    }
  }
  return text
}
