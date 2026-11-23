/** v2.2.4 压缩错误 i18n 键（字面量联合——renderer t() 与 main 抛错共用同一命名） */
export type CompressErrKey =
  | 'files.compressErrEmpty'
  | 'files.compressErrTooLong'
  | 'files.compressErrSlash'
  | 'files.compressErrDash'
  | 'files.compressErrDot'
  | 'files.compressErrEntries'

/**
 * v2.2.4 远程压缩（用户需求 2026-11-23）：文件面板选中项 → tar.gz。
 *
 * 纯逻辑（可单测，shared——renderer 默认名/校验与 main 命令构造同源）：
 * 名称/条目校验 + tar 命令构造。执行在 ipc.ts 组合根（connection.exec——
 * 纯 SSH 与开发连接同链，不依赖 cwb-server）。
 *
 * 安全口径（同 FilesDelete 先例）：路径/名称逐个 POSIX 单引号包裹；名称
 * 白名单校验（无 '/'、不以 '-' 开头、非 '.'/'..'、长度上限）后才进命令行。
 */

/** 压缩产物缺省后缀 */
export const COMPRESS_EXT = '.tar.gz'

/**
 * 压缩文件名校验：非空、≤200 字节、不含 '/'、不以 '-' 开头、非 '.'/'..'。
 * 返回 null=合法；否则返回 i18n 错误 key（调用方翻译）。
 */
export function compressNameError(name: string): CompressErrKey | null {
  const t = name.trim()
  if (t === '') return 'files.compressErrEmpty'
  if (t.length > 200) return 'files.compressErrTooLong'
  if (t.includes('/')) return 'files.compressErrSlash'
  if (t.startsWith('-')) return 'files.compressErrDash'
  if (t === '.' || t === '..') return 'files.compressErrDot'
  return null
}

/**
 * 压缩目标（目录内相对名）校验：1..500 项、每项非空/无 '/'/非 '.'/'..'/
 * 不以 '-' 开头。返回 null=合法。
 */
export function compressEntriesError(entries: string[]): CompressErrKey | null {
  if (entries.length === 0 || entries.length > 500) return 'files.compressErrEntries'
  for (const e of entries) {
    if (e === '' || e.includes('/') || e === '.' || e === '..' || e.startsWith('-')) {
      return 'files.compressErrEntries'
    }
  }
  return null
}

/**
 * 缺省压缩名（对话框默认值）：
 * - 单文件/目录 → `<基名>.tar.gz`（已带后缀不重复叠加）
 * - 多选 → `archive-YYYYMMDD-HHmm.tar.gz`
 */
export function defaultCompressName(entries: string[], now: Date = new Date()): string {
  if (entries.length === 1) {
    const base = entries[0]!.endsWith(COMPRESS_EXT) ? entries[0]!.slice(0, -COMPRESS_EXT.length) : entries[0]!
    return `${base}${COMPRESS_EXT}`
  }
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `archive-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${COMPRESS_EXT}`
  )
}

/** POSIX 单引号包裹（与 server-installer.posixQuote 同式——独立导出避免循环依赖） */
function q(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** 目录绝对路径压缩命令（cd 归一 + -- 分隔 + 逐项引号） */
export function buildTarCommand(dir: string, name: string, entries: string[]): string {
  const quoted = entries.map((e) => q(e)).join(' ')
  return `cd ${q(dir)} && tar -czf ${q(name)} -- ${quoted} && printf compressed`
}

/** 目标已存在探测命令（碰撞预检——弹窗内就近报错，不覆盖既有文件） */
export function buildExistsCommand(dir: string, name: string): string {
  return `cd ${q(dir)} && test -e ${q(name)} && printf exists`
}
