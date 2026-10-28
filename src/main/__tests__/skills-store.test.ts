import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillInfo } from '../../shared/types'

/** trashItem 桩（回收站调用断言；绝不真删） */
const trashItem = vi.hoisted(() => vi.fn(async (_path: string) => {}))
vi.mock('electron', () => ({ shell: { trashItem } }))

import { SkillsStore, parseSkillFrontmatter } from '../skills-store'
import { PluginSkills } from '../plugin-skills'

/** 建一个 skill 目录（frontmatter 可定制） */
function makeSkill(root: string, name: string, skillMd?: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd ?? `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n正文\n`)
  return dir
}

/**
 * 建 store：插件来源指向 temp 主目录（缺省会读真实 ~/.claude/plugins，把本机已装
 * 插件混进断言）。需要验证插件扫描的用例用 opts.pluginHome 指定自己的假 home。
 */
function makeStore(opts: {
  userRoot?: () => string
  projects?: () => ReadonlyArray<{ id: string; dir: string }>
  pluginHome: string
}): SkillsStore {
  return new SkillsStore({
    ...(opts.userRoot !== undefined ? { userRoot: opts.userRoot } : {}),
    ...(opts.projects !== undefined ? { projects: opts.projects } : {}),
    pluginSkills: new PluginSkills({ home: () => opts.pluginHome })
  })
}

describe('parseSkillFrontmatter（容忍缺字段/超长）', () => {
  it('解析 name/description/version/author；非 frontmatter 文件返回空', () => {
    expect(
      parseSkillFrontmatter('---\nname: a\ndescription: d\nversion: 1.2.3\nauthor: 张三\n---\nbody')
    ).toEqual({ name: 'a', description: 'd', version: '1.2.3', author: '张三' })
    expect(parseSkillFrontmatter('no frontmatter here')).toEqual({})
  })

  it('未知字段忽略；缺闭合 --- 容忍（读到尾）', () => {
    const out = parseSkillFrontmatter('---\nname: x\nlicense: MIT\nfoo: bar')
    expect(out).toEqual({ name: 'x' })
  })
})

describe('SkillsStore.list（用户级+项目级扫描）', () => {
  let tempDir: string
  let userRoot: string
  let projectDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cwb-skills-'))
    userRoot = join(tempDir, 'user-skills')
    projectDir = join(tempDir, 'proj')
    trashItem.mockClear()
  })
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }))

  it('两级来源合并；name 缺省用目录名；无 SKILL.md/zip 文件形态跳过', () => {
    makeSkill(userRoot, 'global-skill', '---\nname: global-skill\ndescription: 全局技能\nversion: 0.1.0\n---\n')
    mkdirSync(join(userRoot, 'no-skill-md'), { recursive: true }) // 无 SKILL.md → 跳过
    writeFileSync(join(userRoot, 'packed.skill'), 'zip-bytes') // zip 文件形态（.skill 包）→ 跳过
    makeSkill(join(projectDir, '.claude', 'skills'), 'proj-skill', '---\ndescription: 仅描述缺 name\n---\n')

    const store = makeStore({ userRoot: () => userRoot, projects: () => [{ id: 'p1', dir: projectDir }], pluginHome: join(tempDir, 'plugin-home') })
    const list = store.list()
    expect(list).toHaveLength(2)
    const global = list.find((s) => s.source === 'user')
    expect(global).toMatchObject({
      name: 'global-skill',
      description: '全局技能',
      version: '0.1.0',
      source: 'user',
      dir: join(userRoot, 'global-skill')
    })
    expect('projectId' in (global ?? {})).toBe(false)
    const proj = list.find((s) => s.source === 'project')
    expect(proj).toMatchObject({
      name: 'proj-skill', // name 缺省=目录名
      source: 'project',
      projectId: 'p1'
    })
  })

  it('超长 description（~500 字单行）截断至 120 字；author 有则带出', () => {
    const long = '长'.repeat(500)
    makeSkill(userRoot, 'long-desc', `---\ndescription: ${long}\nauthor: someone\n---\n`)
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    const skill = store.list()[0]
    expect(skill?.description).toBe('长'.repeat(120))
    expect(skill?.author).toBe('someone')
  })

  it('skills 根缺失 → 空列表不抛；项目级同理', () => {
    const store = makeStore({ userRoot: () => join(tempDir, 'missing'), pluginHome: join(tempDir, 'plugin-home') })
    expect(store.list()).toEqual([])
  })
})

describe('SkillsStore.importSkillFolder（复制+冲突检测）', () => {
  let tempDir: string
  let userRoot: string
  let sourceDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cwb-skills-imp-'))
    userRoot = join(tempDir, 'user-skills')
    sourceDir = makeSkill(join(tempDir, 'incoming'), 'my-skill', '---\nname: my-skill\ndescription: 导入\n---\n')
    writeFileSync(join(sourceDir, 'extra.md'), '附属文件') // 非仅 SKILL.md 一件
  })
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }))

  it('复制到目标 scope（含附属文件）并返回新 SkillInfo', () => {
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    const info = store.importSkillFolder(sourceDir, { scope: 'user' })
    expect(info).toMatchObject({ name: 'my-skill', source: 'user', dir: join(userRoot, 'my-skill') })
    expect(existsSync(join(userRoot, 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(userRoot, 'my-skill', 'extra.md'))).toBe(true)
    expect(store.list()).toContainEqual(info)
  })

  it('同名冲突抛错且不覆盖', () => {
    makeSkill(userRoot, 'my-skill')
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    expect(() => store.importSkillFolder(sourceDir, { scope: 'user' })).toThrow(/同名 skill 已存在/)
    expect(existsSync(join(userRoot, 'my-skill', 'extra.md'))).toBe(false) // 未覆盖
  })

  it('源缺 SKILL.md / 源不存在 / 项目 scope 未知 projectId → 抛错', () => {
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    const notSkill = join(tempDir, 'not-a-skill')
    mkdirSync(notSkill, { recursive: true })
    expect(() => store.importSkillFolder(notSkill, { scope: 'user' })).toThrow(/SKILL\.md/)
    expect(() => store.importSkillFolder(join(tempDir, 'missing-src'), { scope: 'user' })).toThrow(/不存在/)
    expect(() =>
      store.importSkillFolder(sourceDir, { scope: 'project', projectId: 'no-such' })
    ).toThrow(/project not found/)
  })
})

describe('SkillsStore.removeSkill（realpath 归属校验 + 回收站）', () => {
  let tempDir: string
  let userRoot: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cwb-skills-rm-'))
    userRoot = join(tempDir, 'user-skills')
    trashItem.mockClear()
  })
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }))

  it('界内目录 → shell.trashItem（回收站，非永久删除）以 realpath 解析后的路径调用', async () => {
    const dir = makeSkill(userRoot, 'removable')
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    await store.removeSkill({ name: 'removable', description: '', source: 'user', dir })
    expect(trashItem).toHaveBeenCalledTimes(1)
    expect(trashItem).toHaveBeenCalledWith(dir)
  })

  it('越界目录（skills 根之外）拒绝且不调 trashItem', async () => {
    mkdirSync(userRoot, { recursive: true }) // 根存在（空）——归属校验才有比对对象
    const outside = makeSkill(join(tempDir, 'elsewhere'), 'outside')
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    await expect(
      store.removeSkill({ name: 'outside', description: '', source: 'user', dir: outside })
    ).rejects.toThrow(/越界/)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('dir 恰为 skills 根本身 → 拒绝（防整根误删）；不存在目录 → 报错', async () => {
    mkdirSync(userRoot, { recursive: true })
    const store = makeStore({ userRoot: () => userRoot, pluginHome: join(tempDir, 'plugin-home') })
    await expect(
      store.removeSkill({ name: 'root', description: '', source: 'user', dir: userRoot })
    ).rejects.toThrow(/越界/)
    await expect(
      store.removeSkill({ name: 'ghost', description: '', source: 'user', dir: join(userRoot, 'ghost') })
    ).rejects.toThrow(/不存在/)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('项目级移除：按 skill.projectId 定位根；项目记录缺失报错', async () => {
    const projectDir = join(tempDir, 'proj')
    const dir = makeSkill(join(projectDir, '.claude', 'skills'), 'p-skill')
    const store = makeStore({ userRoot: () => userRoot, projects: () => [{ id: 'p1', dir: projectDir }], pluginHome: join(tempDir, 'plugin-home') })
    const skill: SkillInfo = { name: 'p-skill', description: '', source: 'project', projectId: 'p1', dir }
    await store.removeSkill(skill)
    expect(trashItem).toHaveBeenCalledWith(dir)
    await expect(store.removeSkill({ ...skill, projectId: 'gone' })).rejects.toThrow(/project not found/)
  })
})
