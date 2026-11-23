import { describe, expect, it } from 'vitest'
import {
  buildExistsCommand,
  buildTarCommand,
  compressEntriesError,
  compressNameError,
  defaultCompressName
} from '../../shared/remote-compress'

/**
 * v2.2.4 压缩纯逻辑（shared——renderer 默认名/校验与 main 命令构造同源）：
 * 名称/条目白名单、缺省名、POSIX 引号硬化命令构造。
 */

describe('v2.2.4 压缩：名称校验（compressNameError）', () => {
  it('合法名（含 .tar.gz/中文/空格）→ null', () => {
    for (const n of ['docs.tar.gz', '打包 01.tar.gz', 'a-b_c.d']) {
      expect(compressNameError(n)).toBeNull()
    }
  })
  it('空/纯空白 → empty；>200 → tooLong', () => {
    expect(compressNameError('')).toBe('files.compressErrEmpty')
    expect(compressNameError('   ')).toBe('files.compressErrEmpty')
    expect(compressNameError('x'.repeat(201))).toBe('files.compressErrTooLong')
  })
  it('含 / → slash；前导 - → dash；. / .. → dot（防路径穿越与 tar 选项注入）', () => {
    expect(compressNameError('a/b.tar.gz')).toBe('files.compressErrSlash')
    expect(compressNameError('-x.tar.gz')).toBe('files.compressErrDash')
    expect(compressNameError('.')).toBe('files.compressErrDot')
    expect(compressNameError('..')).toBe('files.compressErrDot')
  })
})

describe('v2.2.4 压缩：目标校验（compressEntriesError）', () => {
  it('空/超 500 项/含非法项 → entries', () => {
    expect(compressEntriesError([])).toBe('files.compressErrEntries')
    expect(compressEntriesError(new Array(501).fill('f'))).toBe('files.compressErrEntries')
    for (const bad of [[''], ['a/b'], ['.'], ['..'], ['-rf']]) {
      expect(compressEntriesError(bad)).toBe('files.compressErrEntries')
    }
  })
  it('合法相对名列表 → null', () => {
    expect(compressEntriesError(['docs', 'deploy.md', 'a b'])).toBeNull()
  })
})

describe('v2.2.4 压缩：缺省名（defaultCompressName）', () => {
  it('单选 → 基名.tar.gz；已带后缀不叠加', () => {
    expect(defaultCompressName(['docs'])).toBe('docs.tar.gz')
    expect(defaultCompressName(['deploy.md'])).toBe('deploy.md.tar.gz')
    expect(defaultCompressName(['x.tar.gz'])).toBe('x.tar.gz')
  })
  it('多选 → archive-YYYYMMDD-HHmm.tar.gz（注入固定时刻）', () => {
    const fixed = new Date(2026, 10, 23, 9, 5)
    expect(defaultCompressName(['a', 'b'], fixed)).toBe('archive-20261123-0905.tar.gz')
  })
})

describe('v2.2.4 压缩：命令构造（POSIX 引号硬化）', () => {
  it('tar：cd + -- 分隔 + 逐项引号 + printf 回执', () => {
    expect(buildTarCommand('/home/dev', 'docs.tar.gz', ['docs', 'deploy.md'])).toBe(
      `cd '/home/dev' && tar -czf 'docs.tar.gz' -- 'docs' 'deploy.md' && printf compressed`
    )
  })
  it('含空格/单引号条目与文件名 → 引号转义不断裂', () => {
    expect(buildTarCommand('/home/dev', `o'brien.tar.gz`, [`it's a dir`, `a b`])).toBe(
      `cd '/home/dev' && tar -czf 'o'\\''brien.tar.gz' -- 'it'\\''s a dir' 'a b' && printf compressed`
    )
  })
  it('碰撞预检：test -e + printf exists', () => {
    expect(buildExistsCommand('/home/dev', 'docs.tar.gz')).toBe(
      `cd '/home/dev' && test -e 'docs.tar.gz' && printf exists`
    )
  })
})
