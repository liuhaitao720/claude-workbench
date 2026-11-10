import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEGACY_DIR_NAMES,
  MIGRATION_MARKER,
  migrateLegacyUserData
} from '../userdata-migrate'

/**
 * S9 更名 userData 迁移单测（tmp 目录双态）：迁移发生（旧目录整树拷入新目录 +
 * 标记文件）/ 新目录非空跳过；另覆盖幂等（二次运行跳过）、注入态跳过、双旧目录
 * 优先级（打包态名优先）、失败不抛（旧"目录"实为文件 → cpSync 报错被吞）。
 */

const APP_NAME = 'SSH Workbench'

let appData: string

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'cwb-userdata-migrate-'))
})

afterEach(() => {
  rmSync(appData, { recursive: true, force: true })
})

/** 在 appData 下铺一个带内容的"旧安装"userData 目录 */
const seedLegacy = (name: string): string => {
  const dir = join(appData, name)
  mkdirSync(join(dir, 'projects'), { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{"theme":"dark"}')
  writeFileSync(join(dir, 'projects', 'p1.json'), '{"id":"p1"}')
  return dir
}

describe('migrateLegacyUserData（S9 更名一次性迁移）', () => {
  it('态一：新目录不存在 && 旧目录存在 → 递归拷贝 + 写迁移标记，旧目录保留', () => {
    const legacy = seedLegacy('Claude Workbench')
    const newDir = join(appData, APP_NAME)

    const r = migrateLegacyUserData({ newDir, appDataDir: appData })

    expect(r.migrated).toBe(true)
    expect(r.from).toBe(legacy)
    expect(readFileSync(join(newDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(newDir, 'projects', 'p1.json'), 'utf8')).toBe('{"id":"p1"}')
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(true)
    const marker = JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8')) as {
      from: string
      product: string
    }
    expect(marker.from).toBe(legacy)
    expect(marker.product).toBe(APP_NAME)
    // 旧目录保留（不删——回滚安装旧版仍可用）
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true)
  })

  it('态二：新目录已非空 → 跳过（不拷贝、不写标记），旧目录原样', () => {
    const legacy = seedLegacy('Claude Workbench')
    const newDir = join(appData, APP_NAME)
    mkdirSync(newDir)
    writeFileSync(join(newDir, 'fresh.json'), '{}')

    const r = migrateLegacyUserData({ newDir, appDataDir: appData })

    expect(r.migrated).toBe(false)
    expect(r.reason).toBe('new-dir-non-empty')
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(false)
    expect(readdirSync(newDir)).toEqual(['fresh.json'])
    expect(existsSync(join(legacy, 'settings.json'))).toBe(true)
  })

  it('幂等：迁移后再跑一次 → 新目录非空跳过，内容不重复拷贝', () => {
    seedLegacy('Claude Workbench')
    const newDir = join(appData, APP_NAME)
    expect(migrateLegacyUserData({ newDir, appDataDir: appData }).migrated).toBe(true)

    const again = migrateLegacyUserData({ newDir, appDataDir: appData })

    expect(again.migrated).toBe(false)
    expect(again.reason).toBe('new-dir-non-empty')
    expect(readdirSync(newDir).filter((f) => f === MIGRATION_MARKER)).toHaveLength(1)
  })

  it('CWB_USER_DATA 注入态（冒烟/测试隔离）→ 跳过，绝不把真实用户数据拷进临时目录', () => {
    seedLegacy('Claude Workbench')
    const newDir = join(appData, APP_NAME)

    const r = migrateLegacyUserData({ newDir, appDataDir: appData, injected: true })

    expect(r.migrated).toBe(false)
    expect(r.reason).toBe('injected')
    expect(existsSync(newDir)).toBe(false)
  })

  it('双旧目录并存 → 打包态 "Claude Workbench" 优先于开发态 "claude-workbench"', () => {
    const packaged = seedLegacy(LEGACY_DIR_NAMES[0])
    seedLegacy(LEGACY_DIR_NAMES[1])
    const newDir = join(appData, APP_NAME)

    const r = migrateLegacyUserData({ newDir, appDataDir: appData })

    expect(r.migrated).toBe(true)
    expect(r.from).toBe(packaged)
    expect(readFileSync(join(newDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('旧"目录"实为文件（异常态）→ cpSync 报错被吞，返回 copy-failed 且不抛出', () => {
    writeFileSync(join(appData, 'Claude Workbench'), 'not-a-dir')
    const newDir = join(appData, APP_NAME)

    const r = migrateLegacyUserData({ newDir, appDataDir: appData })

    expect(r.migrated).toBe(false)
    expect(r.reason).toMatch(/^copy-failed:/)
    expect(existsSync(join(newDir, MIGRATION_MARKER))).toBe(false)
  })

  it('无任何旧目录 → no-legacy-dir（全新安装路径）', () => {
    const newDir = join(appData, APP_NAME)
    const r = migrateLegacyUserData({ newDir, appDataDir: appData })
    expect(r.migrated).toBe(false)
    expect(r.reason).toBe('no-legacy-dir')
    expect(existsSync(newDir)).toBe(false)
  })
})
