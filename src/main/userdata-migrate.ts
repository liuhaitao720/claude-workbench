import { cpSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * S9 更名一次性 userData 迁移（Claude Workbench → SSH Workbench，v1.5.0）。
 *
 * productName 变更会改变 Electron 的 userData 目录（userData = appData/<app.name>，
 * app.name 取 productName）：
 * - Linux：~/.config/Claude Workbench → ~/.config/SSH Workbench
 * - Windows：%APPDATA%\Claude Workbench → %APPDATA%\SSH Workbench
 * - macOS：~/Library/Application Support/Claude Workbench → …/SSH Workbench
 *
 * 行为（幂等，失败绝不阻断启动）：
 * - 新目录已存在且非空（含已写迁移标记）→ 跳过——老用户升级多开后不会重复拷贝；
 * - 新目录缺失/为空 && 旧目录存在 → cpSync 递归整目录拷贝（旧目录保留不删，
 *   回滚安装旧版仍可用），随后写标记文件 .migrated-from-claude-workbench；
 * - 旧目录候选两个（按优先级）：打包态 productName "Claude Workbench"、开发态
 *   package.json name "claude-workbench"（更名前 package.json 无 productName，
 *   开发态 userData 取 name 字段）；
 * - CWB_USER_DATA 注入（冒烟/测试隔离）→ 跳过，防把真实用户数据拷进临时目录。
 *
 * 时序红线：必须在单实例锁（requestSingleInstanceLock 会在 userData 落锁文件）与
 * 任何 store/日志读盘之前调用，否则新目录被判非空而永远不迁移。
 */

/** 迁移标记文件名（落在新 userData 根；存在即视为已迁移——其本身使新目录非空） */
export const MIGRATION_MARKER = '.migrated-from-claude-workbench'

/** 更名前的历史 userData 目录名（appData 之下），按优先级排列 */
export const LEGACY_DIR_NAMES: readonly string[] = ['Claude Workbench', 'claude-workbench']

export interface MigrateUserDataDeps {
  /** 迁移目标：当前应用的 userData 目录（productName=SSH Workbench 对应） */
  newDir: string
  /** appData 根目录（历史目录的父目录；Linux ~/.config、Win %APPDATA%、macOS …/Application Support） */
  appDataDir: string
  /** CWB_USER_DATA 等显式注入标记（冒烟/测试）→ 跳过迁移 */
  injected?: boolean
  /** 日志出口（默认 console.log；测试注入捕获） */
  log?: (msg: string) => void
}

export interface MigrateUserDataResult {
  migrated: boolean
  /** 实际迁移来源（migrated=true 时有值） */
  from?: string
  /** 未迁移原因（migrated=false 时有值：injected / new-dir-non-empty / no-legacy-dir / copy-failed:*） */
  reason?: string
}

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 执行一次性迁移。永不抛出（拷贝/写标记失败只记日志返回 copy-failed），
 * 调用方无须 try/catch——迁移失败时应用照常以全新空目录启动。
 */
export function migrateLegacyUserData(deps: MigrateUserDataDeps): MigrateUserDataResult {
  const log = deps.log ?? ((msg: string): void => { console.log(`[userdata-migrate] ${msg}`) })
  if (deps.injected) return { migrated: false, reason: 'injected' }
  if (listDir(deps.newDir).length > 0) return { migrated: false, reason: 'new-dir-non-empty' }

  const legacy =
    LEGACY_DIR_NAMES.map((name) => join(deps.appDataDir, name))
      .find((dir) => dir !== deps.newDir && existsSync(dir) && listDir(dir).length > 0)
    ?? LEGACY_DIR_NAMES.map((name) => join(deps.appDataDir, name))
      .find((dir) => dir !== deps.newDir && existsSync(dir))
  if (legacy === undefined) return { migrated: false, reason: 'no-legacy-dir' }

  try {
    cpSync(legacy, deps.newDir, { recursive: true })
    writeFileSync(
      join(deps.newDir, MIGRATION_MARKER),
      `${JSON.stringify({ from: legacy, at: new Date().toISOString(), product: 'SSH Workbench' }, null, 2)}\n`
    )
    log(`已从旧目录迁移 ${legacy} → ${deps.newDir}（旧目录保留）`)
    return { migrated: true, from: legacy }
  } catch (e) {
    log(`迁移失败（不阻断启动，以全新目录继续）：${String(e)}`)
    return { migrated: false, reason: `copy-failed:${e instanceof Error ? e.message : String(e)}` }
  }
}
