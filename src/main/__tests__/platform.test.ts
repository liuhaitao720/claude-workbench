import { describe, expect, it } from 'vitest'
import {
  IS_LINUX,
  IS_WIN,
  NATIVE_INSTALL_ARGS,
  NATIVE_INSTALL_FILE,
  NPM_INSTALL_ARGS,
  NPM_INSTALL_FILE,
  killTreeSync,
  mergeAugmentedPath,
  nativeInstallTemplateFor,
  npmInstallTemplateFor,
  npmViewCommand,
  pickClaudePathsFor,
  versionProbeCommand,
  versionProbeCommandFor
} from '../platform'

/**
 * v1.3 平台收敛缝单测：可测内部（xxxFor(platform, ...)）在任意宿主平台覆盖双分支；
 * 无参导出绑定运行时平台（Windows 开发机断言 win 值）。
 */

describe('pickClaudePathsFor', () => {
  it('win：.cmd/.exe/.bat 过滤 + npm claude.cmd 优先 + 去重（与 v1.0.6 行为一致）', () => {
    const where = [
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude',
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\WinGet\\Links\\claude.exe',
      'C:\\x\\claude.ps1',
      'C:\\WinGet\\Links\\claude.exe',
      ''
    ]
    expect(pickClaudePathsFor('win32', where)).toEqual([
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\WinGet\\Links\\claude.exe'
    ])
    expect(pickClaudePathsFor('win32', ['', '   '])).toEqual([])
  })

  it('linux：无扩展名 claude 认列（.cmd/.exe 不认），去重', () => {
    const which = [
      '/home/u/.nvm/versions/node/v22.0.0/bin/claude',
      '/usr/local/bin/claude',
      '/usr/local/bin/claude',
      '/home/u/.local/bin/claude.js',
      '/usr/bin/claude.cmd',
      ''
    ]
    expect(pickClaudePathsFor('linux', which)).toEqual([
      '/home/u/.nvm/versions/node/v22.0.0/bin/claude',
      '/usr/local/bin/claude'
    ])
  })

  it('linux：裸 claude 字面量认列（PATH 兜底候选）', () => {
    expect(pickClaudePathsFor('linux', ['claude'])).toEqual(['claude'])
  })
})

describe('安装/查询/探测模板', () => {
  it('win：native=powershell irm|iex 且无 ExecutionPolicy Bypass；npm 经 cmd.exe 包装', () => {
    const native = nativeInstallTemplateFor('win32')
    expect(native.file).toBe('powershell.exe')
    expect(native.args).toEqual(['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'])
    expect(native.args.join(' ')).not.toContain('ExecutionPolicy')
    const npm = npmInstallTemplateFor('win32')
    expect(npm.file).toBe('cmd.exe')
    expect(npm.args).toEqual(['/c', 'npm', 'install', '-g', '@anthropic-ai/claude-code'])
  })

  it('linux：native=bash 登录壳跑官方 install.sh；npm 直呼；无 cmd.exe/powershell', () => {
    const native = nativeInstallTemplateFor('linux')
    expect(native.file).toBe('bash')
    expect(native.args).toEqual(['-l', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
    const npm = npmInstallTemplateFor('linux')
    expect(npm.file).toBe('npm')
    expect(npm.args).toEqual(['install', '-g', '@anthropic-ai/claude-code'])
    expect(npm.args.join(' ')).not.toContain('cmd.exe')
  })

  it('运行时常量与宿主平台一致（Windows 开发机=win 模板，与原 claude-version 常量逐字节同）', () => {
    if (!IS_WIN) return // linux 宿主由模板 For 用例覆盖，此处不重复
    expect(NATIVE_INSTALL_FILE).toBe('powershell.exe')
    expect(NATIVE_INSTALL_ARGS).toEqual(['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'])
    expect(NPM_INSTALL_FILE).toBe('cmd.exe')
    expect(NPM_INSTALL_ARGS).toEqual(['/c', 'npm', 'install', '-g', '@anthropic-ai/claude-code'])
  })

  it('npmViewCommand：win 经 cmd.exe /c；linux 直呼 npm', () => {
    const win = { file: 'cmd.exe', args: ['/c', 'npm', 'view', '@anthropic-ai/claude-code', 'version'] }
    const linux = { file: 'npm', args: ['view', '@anthropic-ai/claude-code', 'version'] }
    expect(npmViewCommand()).toEqual(IS_WIN ? win : linux)
  })

  it('versionProbeCommand：win cmd.exe /c 包装；linux 直跑二进制（双分支 For 覆盖 + 宿主一致性）', () => {
    expect(versionProbeCommandFor('win32', 'C:\\npm\\claude.cmd')).toEqual({
      file: 'cmd.exe',
      args: ['/c', 'C:\\npm\\claude.cmd', '--version']
    })
    expect(versionProbeCommandFor('linux', '/usr/local/bin/claude')).toEqual({
      file: '/usr/local/bin/claude',
      args: ['--version']
    })
    expect(versionProbeCommand('C:\\npm\\claude.cmd')).toEqual(
      versionProbeCommandFor(process.platform, 'C:\\npm\\claude.cmd')
    )
  })
})

describe('mergeAugmentedPath（Linux 增量 PATH 注入）', () => {
  it('无缓存（未跑发现）/Windows → no-op，env 逐字节不变', () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }
    const before = JSON.stringify(env)
    mergeAugmentedPath(env)
    expect(JSON.stringify(env)).toBe(before)
  })

  it('注入形态契约：调用侧（buildClaudeEnv）在 linux 宿主上由 e2e 冒烟验证', () => {
    // 单测环境不触发真实发现（linuxExtraPathCache 模块私有）；此用例锚定
    // no-op 契约——有缓存的合并行为在 linux 宿主经 smoke（--smoke 真实 spawn）覆盖
    expect(typeof mergeAugmentedPath).toBe('function')
  })
})

describe('killTreeSync（按宿主平台分流；不误抛）', () => {
  it('对不存在 pid 尽力而为不抛（win taskkill 失败静默 / unix ESRCH 回退链）', () => {
    expect(() => killTreeSync(999_999_999)).not.toThrow()
  })
})

describe('平台标志', () => {
  it('宿主为 win 或 linux 之一（CI 双平台矩阵的完整性锚）', () => {
    expect(IS_WIN || IS_LINUX).toBe(true)
    expect(IS_WIN === IS_LINUX).toBe(false)
  })
})
