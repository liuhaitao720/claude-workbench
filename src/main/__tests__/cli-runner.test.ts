import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * CliRunner 单测：校验器语料（纯函数）+ 假 PTY 缝（vi.mock('node-pty')）——
 * CI 绝不真跑 claude plugin install / 安装器，spawn 断言全用桩。
 */

const fakePtyModule = vi.hoisted(() => {
  const spawns: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
  class FakePty {
    readonly onDataCbs: Array<(d: string) => void> = []
    readonly onExitCbs: Array<(e: { exitCode: number }) => void> = []
    killed = false
    constructor(
      readonly file: string,
      readonly args: string[],
      readonly options: Record<string, unknown>
    ) {
      spawns.push({ file, args, options })
    }
    onData(cb: (d: string) => void): void {
      this.onDataCbs.push(cb)
    }
    onExit(cb: (e: { exitCode: number }) => void): void {
      this.onExitCbs.push(cb)
    }
    kill(): void {
      this.killed = true
    }
  }
  return { spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => new FakePty(file, args, options)), spawns, FakePty }
})

vi.mock('node-pty', () => ({ spawn: fakePtyModule.spawn }))

/** pty-manager 桩：resolveClaudeCommand 固定返回（防真实 where 探测的不确定性）；env 剥离逻辑用真实现 */
vi.mock('../pty-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pty-manager')>()
  return {
    ...actual,
    resolveClaudeCommand: vi.fn(async () => 'C:\\npm-global\\claude.cmd'),
    invalidateClaudePathCache: vi.fn()
  }
})

import {
  CliRunner,
  CLI_SUBCOMMAND_WHITELIST,
  tokenizeCommand,
  validateClaudeCommand
} from '../cli-runner'
import { buildClaudeEnv, resolveClaudeCommand } from '../pty-manager'
import type { CliOutputEvent } from '../../shared/types'

describe('tokenizeCommand（空白切分+去引号）', () => {
  it('普通空白切分；成对引号内空白保留、引号字符剔除', () => {
    expect(tokenizeCommand('claude plugin install foo')).toEqual(['claude', 'plugin', 'install', 'foo'])
    expect(tokenizeCommand('"C:\\Program Files\\claude.exe"  mcp   list')).toEqual([
      'C:\\Program Files\\claude.exe',
      'mcp',
      'list'
    ])
    expect(tokenizeCommand("'quoted arg' plain")).toEqual(['quoted arg', 'plain'])
  })

  it('换行/制表符同为空白；空串与纯空白 → 空数组', () => {
    expect(tokenizeCommand('a\r\nb\tc')).toEqual(['a', 'b', 'c'])
    expect(tokenizeCommand('   ')).toEqual([])
    expect(tokenizeCommand('')).toEqual([])
  })
})

describe('validateClaudeCommand（注入语料）', () => {
  it('合法命令：白名单四子命令 + 绝对路径 claude.cmd/claude.exe + 引号路径', () => {
    expect(validateClaudeCommand('claude update')).toEqual(['claude', 'update'])
    expect(validateClaudeCommand('claude upgrade')).toEqual(['claude', 'upgrade'])
    expect(validateClaudeCommand('claude mcp list')).toEqual(['claude', 'mcp', 'list'])
    expect(validateClaudeCommand('claude plugin install someone/my-plugin@1.0.0')).toEqual([
      'claude',
      'plugin',
      'install',
      'someone/my-plugin@1.0.0'
    ])
    expect(validateClaudeCommand('C:\\npm\\claude.cmd plugin list')).toEqual([
      'C:\\npm\\claude.cmd',
      'plugin',
      'list'
    ])
    expect(validateClaudeCommand('"D:\\Tools Dir\\claude.exe" mcp add x')).toEqual([
      'D:\\Tools Dir\\claude.exe',
      'mcp',
      'add',
      'x'
    ])
  })

  it('元字符注入拒绝（& | > < % ^ 反引号 换行），含引号剥离后的残留', () => {
    // cmd 管道/重定向
    expect(() => validateClaudeCommand('claude plugin install a & calc')).toThrow(/元字符/)
    expect(() => validateClaudeCommand('claude update && whoami')).toThrow(/元字符/)
    expect(() => validateClaudeCommand('claude update | clip')).toThrow(/元字符/)
    expect(() => validateClaudeCommand('claude mcp list > out.txt')).toThrow(/元字符/)
    expect(() => validateClaudeCommand('claude mcp list < in.txt')).toThrow(/元字符/)
    // %（环境变量展开）与 ^（转义符）
    expect(() => validateClaudeCommand('claude plugin install %PATH%')).toThrow(/元字符/)
    expect(() => validateClaudeCommand('claude update ^& calc')).toThrow(/元字符/)
    // 反引号与换行（多语句注入——裸换行在 tokenize 前先拒）
    expect(() => validateClaudeCommand('claude plugin install `x`')).toThrow(/元字符/)
    expect(() => validateClaudeCommand('claude update\ncalc')).toThrow(/换行/)
    expect(() => validateClaudeCommand('claude plugin install "a\r\nb"')).toThrow(/换行/)
    // token 中段的引号字符（tokenizer 只剥成对首尾引号）
    expect(() => validateClaudeCommand('claude plugin install a"b')).toThrow(/元字符/)
  })

  it('伪首 token / 白名单外子命令 / 缺子命令 / 空命令 拒绝（带原因）', () => {
    expect(() => validateClaudeCommand('notepad.exe foo')).toThrow(/必须以 claude 开头/)
    expect(() => validateClaudeCommand('claude.cmd.bak update')).toThrow(/必须以 claude 开头/)
    expect(() => validateClaudeCommand('claude install something')).toThrow(/白名单/)
    expect(() => validateClaudeCommand('claude --version')).toThrow(/白名单/)
    expect(() => validateClaudeCommand('claude')).toThrow(/缺少子命令/)
    expect(() => validateClaudeCommand('')).toThrow(/命令为空/)
    // 白名单冻结集合精确断言
    expect([...CLI_SUBCOMMAND_WHITELIST].sort()).toEqual(['mcp', 'plugin', 'update', 'upgrade'])
  })
})

describe('CliRunner（假 PTY 缝）', () => {
  let outputs: CliOutputEvent[]
  let exits: Array<{ commandId: string; exitCode: number }>
  let runner: CliRunner

  beforeEach(() => {
    vi.mocked(resolveClaudeCommand).mockClear()
    fakePtyModule.spawn.mockClear()
    fakePtyModule.spawns.length = 0
    outputs = []
    exits = []
    runner = new CliRunner({
      onData: (e) => outputs.push(e),
      onExit: (commandId, exitCode) => exits.push({ commandId, exitCode })
    })
  })

  it('run 合法命令：受控 args 经 cmd.exe 包装（不拼接用户原文）；onData/onExit 回调外送', async () => {
    const { commandId } = await runner.run('claude plugin install someone/skill@1.0')
    expect(fakePtyModule.spawns).toEqual([
      {
        file: 'cmd.exe',
        args: ['/c', 'C:\\npm-global\\claude.cmd', 'plugin', 'install', 'someone/skill@1.0'],
        options: expect.objectContaining({ env: buildClaudeEnv() })
      }
    ])
    expect(runner.isRunning(commandId)).toBe(true)

    const pty = fakePtyModule.spawn.mock.results[0]?.value
    pty?.onDataCbs[0]?.('安装输出…')
    expect(outputs).toEqual([{ commandId, data: '安装输出…' }])
    pty?.onExitCbs[0]?.({ exitCode: 0 })
    expect(exits).toEqual([{ commandId, exitCode: 0 }])
    expect(runner.isRunning(commandId)).toBe(false) // 退出即清表
  })

  it('run 非法命令抛带原因 Error 且不 spawn', async () => {
    await expect(runner.run('claude x & calc')).rejects.toThrow(/白名单/)
    expect(fakePtyModule.spawns).toHaveLength(0)
  })

  it('kill：终止活跃命令（表项由 onExit 清）；未知 commandId no-op', async () => {
    const { commandId } = await runner.run('claude mcp list')
    const pty = fakePtyModule.spawn.mock.results[0]?.value
    runner.kill(commandId)
    expect(pty?.killed).toBe(true)
    pty?.onExitCbs[0]?.({ exitCode: 1 })
    expect(runner.isRunning(commandId)).toBe(false)
    expect(() => runner.kill('no-such-command')).not.toThrow()
  })

  it('20min 超时 kill（防孤儿）；退出清定时器', async () => {
    vi.useFakeTimers()
    try {
      const { commandId } = await runner.run('claude update')
      const pty = fakePtyModule.spawn.mock.results.at(-1)?.value
      vi.advanceTimersByTime(20 * 60 * 1000)
      expect(pty?.killed).toBe(true)
      // 退出路径：清定时器（再推进无副作用）+ onceExit 回调
      let done = false
      runner.onceExit(commandId, () => {
        done = true
      })
      pty?.onExitCbs[0]?.({ exitCode: 0 })
      expect(done).toBe(true)
      expect(runner.isRunning(commandId)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawnFixed：固定模板（installClaudeCli 用）不经白名单；cwd=homedir、TERM 透传', async () => {
    const { commandId } = await runner.spawnFixed('powershell.exe', ['-NoProfile', '-Command', 'irm x | iex'])
    expect(fakePtyModule.spawns[0]?.file).toBe('powershell.exe')
    expect(fakePtyModule.spawns[0]?.args).toEqual(['-NoProfile', '-Command', 'irm x | iex'])
    expect(fakePtyModule.spawns[0]?.options).toMatchObject({ name: 'xterm-256color' })
    expect(runner.isRunning(commandId)).toBe(true)
  })

  it('onceExit 对已退出命令立即回调', () => {
    let called = false
    runner.onceExit('already-gone', () => {
      called = true
    })
    expect(called).toBe(true)
  })

  it('多个命令并存（commandId 隔离）', async () => {
    const a = await runner.run('claude plugin list')
    const b = await runner.run('claude mcp list')
    expect(a.commandId).not.toBe(b.commandId)
    expect(runner.isRunning(a.commandId)).toBe(true)
    expect(runner.isRunning(b.commandId)).toBe(true)
    const ptyB = fakePtyModule.spawn.mock.results[1]?.value
    ptyB?.onExitCbs[0]?.({ exitCode: 0 })
    expect(runner.isRunning(b.commandId)).toBe(false)
    expect(runner.isRunning(a.commandId)).toBe(true)
  })
})
