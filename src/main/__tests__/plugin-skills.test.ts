import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginSkills, isValidPluginId } from '../plugin-skills'

/**
 * v1.2.1 插件 skill 来源：用户报障「在线搜索装完，已安装列表里没有，重启也不行」。
 * 根因是 `claude plugin install` 只往 ~/.claude/plugins/cache 检出插件，
 * 从不写 ~/.claude/skills；本模块补的就是这条扫描链。
 */

let home: string

/** 造一个插件检出：<cache>/<market>/<plugin>/<ver>/skills/<name>/SKILL.md */
function makePlugin(opts: {
  market?: string
  plugin: string
  version?: string
  skills?: string[]
  manifest?: unknown
}): string {
  const root = join(
    home,
    '.claude/plugins/cache',
    opts.market ?? 'official',
    opts.plugin,
    opts.version ?? '1.0.0'
  )
  for (const name of opts.skills ?? ['the-skill']) {
    const dir = join(root, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n正文\n`
    )
  }
  if (opts.manifest !== undefined) {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify(opts.manifest))
  }
  return root
}

/** 写 installed_plugins.json（v2 形态：id → 条目数组） */
function registerPlugins(entries: Record<string, string[]>): void {
  const dir = join(home, '.claude/plugins')
  mkdirSync(dir, { recursive: true })
  const plugins: Record<string, unknown> = {}
  for (const [id, paths] of Object.entries(entries)) {
    plugins[id] = paths.map((p) => ({ scope: 'user', installPath: p, version: '1.0.0' }))
  }
  writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
}

function writeEnabledPlugins(map: Record<string, boolean>): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: map }))
}

/** 写插件清单（目录不存在时先建） */
function writeManifest(installPath: string, manifest: unknown): void {
  mkdirSync(join(installPath, '.claude-plugin'), { recursive: true })
  writeFileSync(join(installPath, '.claude-plugin/plugin.json'), JSON.stringify(manifest))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cwb-plugin-skills-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('isValidPluginId', () => {
  it('<plugin>@<marketplace> 形状白名单', () => {
    expect(isValidPluginId('skill-creator@claude-plugins-official')).toBe(true)
    expect(isValidPluginId('a.b_c-d@mkt.1')).toBe(true)
    expect(isValidPluginId('no-at-sign')).toBe(false)
    expect(isValidPluginId('a@b@c')).toBe(false)
    expect(isValidPluginId('a@b&calc')).toBe(false)
    expect(isValidPluginId('')).toBe(false)
    expect(isValidPluginId('x@' + 'y'.repeat(300))).toBe(false)
  })
})

describe('PluginSkills.list', () => {
  it('市场安装的插件 skill 被列出（source=plugin + pluginId + 启用态）——用户报障的核心场景', () => {
    const installPath = makePlugin({ plugin: 'skill-creator', skills: ['skill-creator'] })
    registerPlugins({ 'skill-creator@official': [installPath] })
    writeEnabledPlugins({ 'skill-creator@official': true })

    const list = new PluginSkills({ home: () => home }).list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      name: 'skill-creator',
      description: 'skill-creator 的描述',
      source: 'plugin',
      pluginId: 'skill-creator@official',
      pluginEnabled: true,
      dir: join(installPath, 'skills', 'skill-creator')
    })
  })

  it('停用插件同样列出，但 pluginEnabled=false（界面要标出来，否则用户以为装了就能用）', () => {
    const installPath = makePlugin({ plugin: 'postman' })
    registerPlugins({ 'postman@official': [installPath] })
    writeEnabledPlugins({}) // settings 里没有它 = 停用

    const list = new PluginSkills({ home: () => home }).list()
    expect(list[0]).toMatchObject({ pluginId: 'postman@official', pluginEnabled: false })
  })

  it('一个插件多个 skill 全部列出；无 SKILL.md 的子目录跳过', () => {
    const installPath = makePlugin({ plugin: 'superpowers', skills: ['a', 'b'] })
    mkdirSync(join(installPath, 'skills', 'not-a-skill'), { recursive: true })
    registerPlugins({ 'superpowers@official': [installPath] })
    expect(
      new PluginSkills({ home: () => home })
        .list()
        .map((s) => s.name)
    ).toEqual(['a', 'b'])
  })

  it('plugin.json 声明的自定义 skills 路径（字符串/数组）被采纳；越界路径丢弃', () => {
    const installPath = makePlugin({ plugin: 'custom', skills: [] })
    const extra = join(installPath, 'extra-skills', 'declared')
    mkdirSync(extra, { recursive: true })
    writeFileSync(join(extra, 'SKILL.md'), '---\nname: declared\ndescription: 声明路径\n---\n')
    const outside = join(home, 'outside-skill')
    mkdirSync(outside, { recursive: true })
    writeFileSync(
      join(outside, 'SKILL.md'),
      '---\nname: outside\ndescription: 越界\n---\n'
    )
    writeManifest(installPath, {
      name: 'custom',
      skills: ['./extra-skills/declared', '../../../outside-skill']
    })
    registerPlugins({ 'custom@official': [installPath] })

    const names = new PluginSkills({ home: () => home })
      .list()
      .map((s) => s.name)
    expect(names).toContain('declared')
    expect(names).not.toContain('outside')
  })

  it('skills 声明为目录时展开其下子目录', () => {
    const installPath = makePlugin({ plugin: 'dirsy', skills: [] })
    const dir = join(installPath, 'pkgs', 's1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: s1\ndescription: 目录声明\n---\n')
    writeManifest(installPath, { name: 'dirsy', skills: ['pkgs'] })
    registerPlugins({ 'dirsy@official': [installPath] })
    expect(
      new PluginSkills({ home: () => home })
        .list()
        .map((s) => s.name)
    ).toEqual(['s1'])
  })

  it('多 scope 同目录去重；非法 id 与缺失 installPath 跳过；注册表缺失 → 空列表', () => {
    const installPath = makePlugin({ plugin: 'dup' })
    const dir = join(home, '.claude/plugins')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'dup@official': [
            { scope: 'user', installPath },
            { scope: 'project', installPath }
          ],
          'bad id@official': [{ scope: 'user', installPath }],
          'ghost@official': [{ scope: 'user' }]
        }
      })
    )
    expect(new PluginSkills({ home: () => home }).list()).toHaveLength(1)

    rmSync(join(dir, 'installed_plugins.json'))
    expect(new PluginSkills({ home: () => home }).list()).toEqual([])
  })

  it('installedIds：只回合法 id（启用/停用的白名单来源）', () => {
    const installPath = makePlugin({ plugin: 'dup' })
    const dir = join(home, '.claude/plugins')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'dup@official': [{ installPath }], 'bad id@official': [{ installPath }] }
      })
    )
    expect(new PluginSkills({ home: () => home }).installedIds()).toEqual(['dup@official'])
  })
})