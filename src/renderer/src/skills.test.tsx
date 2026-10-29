import './test-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CwbApiMock } from './test-helpers'
import type { SkillInfo } from '../../shared/types'
import { App } from './App'
import { installCwbMock, makeProject } from './test-helpers'
import { useAppStore } from './store'
import { useLanguageStore } from './i18n'

/** v0.5③：Skills 管理弹窗（分组列表/移除 confirm/导入双通道/CLI 输出区/安全提示/toast） */

const project = makeProject({ id: 'ps', name: 'SkillProj' })

const userSkill: SkillInfo = {
  name: 'pdf',
  description: 'PDF 文档处理与提取',
  version: '1.2.0',
  author: 'Alice',
  source: 'user',
  dir: 'C:\\Users\\u\\.claude\\skills\\pdf'
}
const projectSkill: SkillInfo = {
  name: 'deploy',
  description: '项目部署流程',
  source: 'project',
  projectId: 'ps',
  dir: 'D:\\skillproj\\.claude\\skills\\deploy'
}
/** v1.2.1：市场安装的插件 skill（落点在 ~/.claude/plugins/cache，不在 .claude/skills） */
const pluginSkill = (over: Partial<SkillInfo> = {}): SkillInfo => ({
  name: 'skill-creator',
  description: '创建与改进 skill',
  source: 'plugin',
  pluginId: 'skill-creator@official',
  pluginEnabled: true,
  dir: 'C:\\Users\\u\\.claude\\plugins\\cache\\official\\skill-creator\\1.0.0\\skills\\skill-creator',
  ...over
})

beforeEach(() => {
  // v1.2.0：语言 store 跨文件模块级共享——每个用例回到中文基线（英文用例自行切换）
  localStorage.removeItem('cwb-language')
  useLanguageStore.setState({ language: 'zh' })
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    skillsOpen: false
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

async function renderApp(skills: SkillInfo[] = []): Promise<CwbApiMock> {
  const api = installCwbMock({ projects: [project] })
  vi.mocked(api.listSkills).mockResolvedValue(skills)
  render(<App />)
  await waitFor(() => expect(document.querySelector('li[data-project-id="ps"]')).toBeDefined())
  return api
}

/** 侧栏「Skills」按钮开弹窗（rail 🧩 入口另有专门用例） */
async function openSkills(): Promise<ReturnType<typeof within>> {
  fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
  const dialog = await screen.findByRole('dialog', { name: 'Skills 管理' })
  return within(dialog)
}

/** v1.2.1 三页签：切到指定页签（已安装 / 在线搜索 / 导入） */
function gotoTab(skills: ReturnType<typeof within>, name: string): void {
  fireEvent.click(skills.getByRole('tab', { name: new RegExp(`^${name}`) }))
}

function fireCliOutput(
  api: CwbApiMock,
  e: { commandId: string; data?: string; type?: 'exit'; exitCode?: number }
): void {
  act(() => {
    for (const cb of api.cliOutputCallbacks) cb(e)
  })
}

const groupTitles = (): string[] =>
  Array.from(document.querySelectorAll('.skill-group-title')).map((el) => el.textContent ?? '')

describe('入口与列表', () => {
  it('侧栏「Skills」按钮 + 折叠态 rail 🧩 均开弹窗', async () => {
    await renderApp()
    const skills = await openSkills()
    expect(skills.getByText('Skills 管理')).toBeDefined()

    // rail 折叠态入口（注意勿用 ⚡——与 skipPermissions 徽标撞形）
    fireEvent.click(skills.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Skills 管理' })).toBeNull())
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // v0.5.1：顶部 ☰ 移除
    const rail = document.querySelector('.sidebar-rail') as HTMLElement
    expect(rail.textContent).toContain('🧩')
    fireEvent.click(within(rail).getByTitle('Skills 管理'))
    expect(await screen.findByRole('dialog', { name: 'Skills 管理' })).toBeDefined()
  })

  it('listSkills 按生效方式分组：默认生效组头；行=名称+描述+版本/作者+来源标签', async () => {
    await renderApp([userSkill, projectSkill])
    const skills = await openSkills()
    expect(await skills.findByText('pdf')).toBeDefined()
    const titles = groupTitles()
    // v1.2.1：组头从「来源」（用户级/项目级）改成「生效方式」——默认生效在前
    expect(titles.some((t) => t.includes('默认生效'))).toBe(true)
    expect(titles.some((t) => t.includes('用户级 · 全局生效'))).toBe(false)
    expect(skills.getByText('PDF 文档处理与提取')).toBeDefined() // 描述
    expect(skills.getByText('v1.2.0 · Alice · 用户级')).toBeDefined() // 版本/作者/来源
    expect(skills.getByText(/项目级 · SkillProj/)).toBeDefined() // 项目级行带所属项目名
  })

  it('安全提示常驻：仅安装可信来源——skill 可携带可执行脚本', async () => {
    await renderApp()
    const skills = await openSkills()
    gotoTab(skills, '导入')
    expect(skills.getByText('仅安装可信来源——skill 可携带可执行脚本')).toBeDefined()
  })

  it('三页签：默认「已安装」；切「在线搜索」「导入」显示各自内容（同一时刻只渲染一页）', async () => {
    await renderApp([userSkill])
    const skills = await openSkills()
    expect(skills.getByRole('tab', { name: /已安装/ }).getAttribute('aria-selected')).toBe('true')
    expect(skills.queryByLabelText('搜索 skill 市场')).toBeNull()

    gotoTab(skills, '在线搜索')
    expect(skills.getByLabelText('搜索 skill 市场')).toBeDefined()
    expect(skills.queryByText('默认生效', { exact: false })).toBeNull()

    gotoTab(skills, '导入')
    expect(skills.getByLabelText('claude CLI 命令')).toBeDefined()
    expect(skills.queryByLabelText('搜索 skill 市场')).toBeNull()
  })
})

describe('移除 skill', () => {
  it('confirm → removeSkill(skill 全参)；成功后刷新列表', async () => {
    const api = await renderApp([userSkill])
    const skills = await openSkills()
    await skills.findByText('pdf')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(skills.getByRole('button', { name: '移除' }))
    await waitFor(() =>
      expect(api.removeSkill).toHaveBeenCalledWith(expect.objectContaining({ name: 'pdf' }))
    )
    expect(confirmSpy.mock.calls[0][0]).toContain('移除 skill “pdf”') // 回收站语义提示
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2)) // 成功后刷新
  })

  it('confirm 取消 → removeSkill 不被调用', async () => {
    const api = await renderApp([userSkill])
    const skills = await openSkills()
    await skills.findByText('pdf')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(skills.getByRole('button', { name: '移除' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.removeSkill).not.toHaveBeenCalled()
  })

  it('移除失败（realpath 归属校验）→ 行内提示', async () => {
    const api = await renderApp([userSkill])
    vi.mocked(api.removeSkill).mockRejectedValue(new Error('路径归属校验失败：越界'))
    const skills = await openSkills()
    await skills.findByText('pdf')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(skills.getByRole('button', { name: '移除' }))
    expect(await skills.findByText(/路径归属校验失败/)).toBeDefined()
  })
})

describe('导入通道①：导入文件夹', () => {
  it('pickDirectory → scope 用户级 → importSkillFolder(dir, {scope:"user"})；成功→刷新+toast', async () => {
    const api = await renderApp([userSkill])
    vi.mocked(api.pickDirectory).mockResolvedValue('D:\\skill-src')
    vi.mocked(api.importSkillFolder).mockResolvedValue({ ...userSkill, name: 'new-skill' })
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.click(skills.getByRole('button', { name: '导入文件夹…' }))
    await waitFor(() =>
      expect(api.importSkillFolder).toHaveBeenCalledWith('D:\\skill-src', { scope: 'user' })
    )
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2)) // 列表刷新
    // 一次性 toast：新 skill 对已运行会话不生效
    expect(
      await skills.findByText('新 skill 对已运行会话不生效——新任务自动生效，旧任务恢复后生效')
    ).toBeDefined()
  })

  it('scope 项目级 → importSkillFolder(dir, {scope:"project", projectId})', async () => {
    const api = await renderApp()
    vi.mocked(api.pickDirectory).mockResolvedValue('D:\\skill-src')
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.click(skills.getByRole('radio', { name: /项目级（SkillProj）/ }))
    fireEvent.click(skills.getByRole('button', { name: '导入文件夹…' }))
    await waitFor(() =>
      expect(api.importSkillFolder).toHaveBeenCalledWith('D:\\skill-src', {
        scope: 'project',
        projectId: 'ps'
      })
    )
  })

  it('取消目录选择（null）→ importSkillFolder 不调用', async () => {
    const api = await renderApp()
    vi.mocked(api.pickDirectory).mockResolvedValue(null)
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.click(skills.getByRole('button', { name: '导入文件夹…' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.importSkillFolder).not.toHaveBeenCalled()
  })

  it('同名冲突 → 错误行内显示，无 toast', async () => {
    const api = await renderApp()
    vi.mocked(api.pickDirectory).mockResolvedValue('D:\\skill-src')
    vi.mocked(api.importSkillFolder).mockRejectedValue(new Error('同名 skill 已存在：pdf'))
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.click(skills.getByRole('button', { name: '导入文件夹…' }))
    expect(await skills.findByText(/同名 skill 已存在：pdf/)).toBeDefined()
    expect(screen.queryByText(/对已运行会话不生效/)).toBeNull() // 失败不 toast
  })
})

describe('v1.2.1 插件 skill（市场装完要能在已安装列表看到）', () => {
  it('已安装页按生效方式分组：启用的插件 skill 进「默认生效」，停用的进「已停用」组', async () => {
    await renderApp([
      pluginSkill(),
      pluginSkill({ name: 'ai-readiness', pluginId: 'postman@official', pluginEnabled: false })
    ])
    const skills = await openSkills()
    expect(await skills.findByText('skill-creator')).toBeDefined()
    const titles = groupTitles()
    expect(titles.some((t) => t.includes('默认生效'))).toBe(true)
    expect(titles.some((t) => t.includes('已停用'))).toBe(true)

    const enabledRow = document.querySelector('[data-skill-name="skill-creator"]') as HTMLElement
    expect(enabledRow.textContent).toContain('skill-creator@official')
    expect(enabledRow.querySelector('[data-plugin-toggle]')?.textContent).toBe('停用')

    const disabledRow = document.querySelector('[data-skill-name="ai-readiness"]') as HTMLElement
    expect(disabledRow.dataset.pluginEnabled).toBe('false')
    expect(disabledRow.textContent).toContain('已停用')
    expect(disabledRow.querySelector('[data-plugin-toggle]')?.textContent).toBe('启用')
  })

  it('插件行没有「移除」（目录归插件机制管），改为启用/停用', async () => {
    await renderApp([pluginSkill()])
    const skills = await openSkills()
    await skills.findByText('skill-creator')
    expect(skills.queryByRole('button', { name: '移除' })).toBeNull()
    expect(skills.getByRole('button', { name: '停用' })).toBeDefined()
  })

  it('点「停用」→ setSkillPluginEnabled(id,false)；命令退出后重扫列表', async () => {
    const api = await renderApp([pluginSkill()])
    const skills = await openSkills()
    await skills.findByText('skill-creator')
    fireEvent.click(skills.getByRole('button', { name: '停用' }))
    await waitFor(() =>
      expect(api.setSkillPluginEnabled).toHaveBeenCalledWith('skill-creator@official', false)
    )
    // 命令输出与退出后的重扫共用 CLI 输出通道
    await waitFor(() => expect(skills.getByRole('log')).toBeDefined())
    const before = vi.mocked(api.listSkills).mock.calls.length
    fireCliOutput(api, { commandId: 'skill-plugin-toggle-test', type: 'exit', exitCode: 0 })
    await waitFor(() =>
      expect(vi.mocked(api.listSkills).mock.calls.length).toBeGreaterThan(before)
    )
  })

  it('启用/停用失败 → 行内错误，不静默', async () => {
    const api = await renderApp([pluginSkill({ pluginEnabled: false })])
    vi.mocked(api.setSkillPluginEnabled).mockResolvedValue({
      ok: false,
      error: '插件未安装，无法切换启用状态: x@y'
    })
    const skills = await openSkills()
    await skills.findByText('skill-creator')
    fireEvent.click(skills.getByRole('button', { name: '启用' }))
    expect(await skills.findByText(/插件未安装/)).toBeDefined()
  })
})

describe('v1.2.1 生效方式分组与标注', () => {
  it('默认生效在前、需显式 /名称 的其次、停用的最后；行内标出各自方式', async () => {
    await renderApp([
      // 需要显式 /名称 的 skill（disable-model-invocation: true）
      { ...userSkill, name: 'zc-manual', dir: 'C:\\s\\zc-manual', activation: 'manual' },
      // 默认生效
      { ...userSkill, name: 'zc-auto', dir: 'C:\\s\\zc-auto', activation: 'auto' },
      // 已停用插件
      pluginSkill({ name: 'zc-off', pluginId: 'postman@official', pluginEnabled: false })
    ])
    const skills = await openSkills()
    await skills.findByText('zc-auto')

    const order = groupTitles()
    expect(order[0]).toContain('默认生效')
    expect(order[1]).toContain('需手动指定')
    expect(order[2]).toContain('已停用')

    const autoRow = document.querySelector('[data-skill-name="zc-auto"]') as HTMLElement
    expect(autoRow.dataset.activation).toBe('auto')
    expect(autoRow.textContent).not.toContain('需 /名称') // 默认项不挂标签

    const manualRow = document.querySelector('[data-skill-name="zc-manual"]') as HTMLElement
    expect(manualRow.dataset.activation).toBe('manual')
    expect(manualRow.textContent).toContain('需 /名称')
    // 手动组内仍是普通 skill：可移除
    expect(manualRow.querySelector('button')?.textContent).toBe('移除')

    // 组头说明文案（哪一档要显式指定）
    expect(skills.getByText(/模型不会自动调用——只有你输入 \/名称 时才生效/)).toBeDefined()
    expect(skills.getByText(/模型会按需自动调用；你也可以输入 \/名称 手动触发/)).toBeDefined()
  })

  it('paths（按文件触发）与 user-invocable:false（仅模型自动）也各有标注', async () => {
    await renderApp([
      { ...userSkill, name: 'zc-paths', dir: 'C:\\s\\zc-paths', activation: 'paths' },
      { ...userSkill, name: 'zc-model', dir: 'C:\\s\\zc-model', activation: 'modelOnly' }
    ])
    const skills = await openSkills()
    await skills.findByText('zc-paths')
    const pathsRow = document.querySelector('[data-skill-name="zc-paths"]') as HTMLElement
    const modelRow = document.querySelector('[data-skill-name="zc-model"]') as HTMLElement
    expect(pathsRow.textContent).toContain('按文件触发')
    expect(modelRow.textContent).toContain('仅模型自动')
    // 两者都属于「默认生效」组（模型会自己用到）
    expect(groupTitles().some((t) => t.includes('默认生效'))).toBe(true)
    expect(groupTitles().some((t) => t.includes('需手动指定'))).toBe(false)
  })
})

describe('v1.2.0 在线搜索与安装', () => {
  const entry = {
    name: 'pdf-tools',
    marketplace: 'official',
    description: 'PDF 处理',
    category: 'docs',
    author: 'alice',
    installs: 120,
    installId: 'pdf-tools@official'
  }

  async function openMarket(): Promise<ReturnType<typeof within>> {
    const api = installCwbMock({ projects: [project] })
    vi.mocked(api.listSkillMarketplaces).mockResolvedValue([
      { name: 'official', count: 315 },
      { name: 'superpowers', count: 10 }
    ])
    vi.mocked(api.searchSkillMarket).mockResolvedValue([entry])
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="ps"]')).toBeDefined())
    const skills = await openSkills()
    gotoTab(skills, '在线搜索')
    await skills.findByText('pdf-tools')
    return skills
  }

  it('打开即搜（空词）：渲染条目（marketplace/分类/作者/安装量）+ marketplace 过滤器', async () => {
    const skills = await openMarket()
    expect(await skills.findByText('pdf-tools')).toBeDefined()
    expect(skills.getByText(/official · docs · alice · 120 次安装/)).toBeDefined()
    expect(skills.getByText('PDF 处理')).toBeDefined()
    // 过滤器含全部 marketplace 项（名 + 条目数）
    expect(skills.getByRole('option', { name: 'official (315)' })).toBeDefined()
    expect(skills.getByRole('option', { name: 'superpowers (10)' })).toBeDefined()
    expect(skills.getByRole('option', { name: '全部 marketplace' })).toBeDefined()
  })

  it('输入关键词 → 带词搜索；切换 marketplace → 带过滤重查', async () => {
    const api = await renderApp()
    vi.mocked(api.listSkillMarketplaces).mockResolvedValue([{ name: 'official', count: 1 }])
    vi.mocked(api.searchSkillMarket).mockResolvedValue([entry])
    const skills = await openSkills()
    gotoTab(skills, '在线搜索')
    await skills.findByText('pdf-tools')

    fireEvent.change(skills.getByLabelText('搜索 skill 市场'), { target: { value: 'pdf' } })
    await waitFor(() =>
      expect(api.searchSkillMarket).toHaveBeenCalledWith('pdf', undefined, 100)
    )

    fireEvent.change(skills.getByLabelText('marketplace 过滤'), {
      target: { value: 'official' }
    })
    await waitFor(() =>
      expect(api.searchSkillMarket).toHaveBeenCalledWith('pdf', 'official', 100)
    )
  })

  it('安装 → installMarketSkill(installId)，输出进共享输出区；退出后刷新已装列表与市场', async () => {
    const api = installCwbMock({ projects: [project] })
    vi.mocked(api.searchSkillMarket).mockResolvedValue([entry])
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="ps"]')).toBeDefined())
    const skills = await openSkills()
    gotoTab(skills, '在线搜索')
    fireEvent.click(await skills.findByRole('button', { name: '安装' }))
    await waitFor(() => expect(api.installMarketSkill).toHaveBeenCalledWith('pdf-tools@official'))
    // 安装命令的 commandId 挂进 CliOutputView
    await waitFor(() => expect(skills.getByRole('log')).toBeDefined())
    fireCliOutput(api, { commandId: 'skill-install-test', data: 'Installing pdf-tools...\n' })
    await waitFor(() =>
      expect(skills.getByRole('log').textContent).toContain('Installing pdf-tools')
    )
    const listCallsBefore = vi.mocked(api.listSkills).mock.calls.length
    fireCliOutput(api, { commandId: 'skill-install-test', type: 'exit', exitCode: 0 })
    await waitFor(() =>
      expect(vi.mocked(api.listSkills).mock.calls.length).toBeGreaterThan(listCallsBefore)
    )
  })

  it('安装返回失败（非法目标/CLI 启动失败）→ 行内错误', async () => {
    const api = installCwbMock({ projects: [project] })
    vi.mocked(api.searchSkillMarket).mockResolvedValue([entry])
    vi.mocked(api.installMarketSkill).mockResolvedValue({ ok: false, error: '插件名含非法字符' })
    render(<App />)
    await waitFor(() => expect(document.querySelector('li[data-project-id="ps"]')).toBeDefined())
    const skills = await openSkills()
    gotoTab(skills, '在线搜索')
    fireEvent.click(await skills.findByRole('button', { name: '安装' }))
    expect(await skills.findByText(/安装失败：插件名含非法字符/)).toBeDefined()
  })

  it('刷新目录 → refreshSkillMarket()；未配置 marketplace 显示引导文案', async () => {
    const api = await renderApp()
    vi.mocked(api.searchSkillMarket).mockResolvedValue([])
    vi.mocked(api.refreshSkillMarket).mockResolvedValue({ ok: true, commandId: 'skill-refresh-test' })
    const skills = await openSkills()
    gotoTab(skills, '在线搜索')
    expect(await skills.findByText(/未配置 marketplace/)).toBeDefined()
    fireEvent.click(skills.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(api.refreshSkillMarket).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(skills.getByRole('log')).toBeDefined()) // 刷新输出可见
  })

  it('英文界面：在线搜索区文案随语言切换', async () => {
    useLanguageStore.setState({ language: 'en' })
    const api = await renderApp()
    vi.mocked(api.searchSkillMarket).mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage skills' })
    fireEvent.click(within(dialog).getByRole('tab', { name: /^Find skills/ }))
    expect(within(dialog).getByPlaceholderText('Search skills (name / description / category)…')).toBeDefined()
  })
})

describe('导入通道②：CLI 命令', () => {

  it('执行 → runCliCommand(命令)；输出区 onCliOutput 追加；exit(0) → 刷新列表+toast', async () => {
    const api = await renderApp()
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.change(skills.getByLabelText('claude CLI 命令'), {
      target: { value: 'claude plugin install foo@marketplace' }
    })
    fireEvent.click(skills.getByRole('button', { name: '执行' }))
    await waitFor(() =>
      expect(api.runCliCommand).toHaveBeenCalledWith('claude plugin install foo@marketplace')
    )
    // mock runCliCommand → {commandId:'cmd-test'}：输出经 onCliOutput 追加
    await waitFor(() => expect(skills.getByRole('log')).toBeDefined())
    fireCliOutput(api, { commandId: 'cmd-test', data: 'Installing foo...\n' })
    await waitFor(() => expect(skills.getByRole('log').textContent).toContain('Installing foo'))
    fireCliOutput(api, { commandId: 'cmd-test', type: 'exit', exitCode: 0 })
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2)) // 执行完自动刷新
    // toast 与 exit 提示文案同源——用 .toast 选择器锚定一次性 toast 本体
    await waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toContain('对已运行会话不生效')
    )
  })

  it('校验失败（白名单外命令）→ 错误原因行内显示', async () => {
    const api = await renderApp()
    vi.mocked(api.runCliCommand).mockRejectedValue(
      new Error('命令不合法：仅允许 plugin/update/upgrade/mcp 子命令')
    )
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.change(skills.getByLabelText('claude CLI 命令'), {
      target: { value: 'claude danger --flag' }
    })
    fireEvent.click(skills.getByRole('button', { name: '执行' }))
    expect(await skills.findByText(/命令不合法：仅允许 plugin\/update\/upgrade\/mcp/)).toBeDefined()
  })

  it('关闭弹窗 → killCliCommand 防孤儿', async () => {
    const api = await renderApp()
    const skills = await openSkills()
    gotoTab(skills, '导入')
    fireEvent.change(skills.getByLabelText('claude CLI 命令'), {
      target: { value: 'claude plugin install foo' }
    })
    fireEvent.click(skills.getByRole('button', { name: '执行' }))
    await waitFor(() => expect(api.runCliCommand).toHaveBeenCalledTimes(1))
    fireEvent.click(skills.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(api.killCliCommand).toHaveBeenCalledWith('cmd-test'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Skills 管理' })).toBeNull())
  })
})
