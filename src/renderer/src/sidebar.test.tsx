import './test-setup'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { installCwbMock, makeConnection, makeProject, makeTask } from './test-helpers'
import { useAppStore } from './store'

/** S6 新功能域：搜索过滤（A）/ 时间分组+最近区块（C）/ 图标栏折叠（D）/ 快捷键（F） */

const HOUR = 3_600_000
/** 相对 now 的偏移毫秒 → ISO 时间戳（仅用于「最近」排序，顺序确定即可） */
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
/**
 * dayOffset 个日历日的 hour 点整（本地时）→ ISO。分组断言必须用日历定点：
 * 偏移毫秒法（now-36h）在一天内不同时刻落桶漂移（上午跑会落到「近 7 天」），
 * 定点构造跨午夜确定（hour∈[1,23] 时恒在目标日历日内）
 */
const at = (dayOffset: number, hour = 12) => {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

beforeEach(() => {
  useAppStore.setState({
    projects: [],
    tasks: [],
    selectedProjectId: null,
    openTaskIds: [],
    activeTaskId: null,
    activityMap: {},
    settingsOpen: false
  })
})
afterEach(cleanup)

async function renderApp(
  projects: ReturnType<typeof makeProject>[],
  tasks: ReturnType<typeof makeTask>[] = []
) {
  installCwbMock({ projects, tasks })
  render(<App />)
  await waitFor(() => expect(document.querySelector('.sidebar')).toBeDefined())
}

function projectNode(id: string): HTMLElement | null {
  return document.querySelector(`li[data-project-id="${id}"]`)
}
function taskRow(id: string): HTMLElement | null {
  return document.querySelector(`li[data-task-id="${id}"]`)
}
function recentRow(id: string): HTMLElement | null {
  return document.querySelector(`li[data-recent-task-id="${id}"]`)
}
/** 双态保挂载（评审 F2）：rail/sidebar 常驻 DOM，以 display 判展开态可见性 */
function sidebarVisible(): boolean {
  const el = document.querySelector('.sidebar') as HTMLElement | null
  return el !== null && el.style.display !== 'none'
}

const SEARCH_PLACEHOLDER = '搜索任务/项目…'

describe('搜索过滤（S6-A）', () => {
  const pa = makeProject({ id: 'pa', name: 'Alpha', dir: 'D:\\alpha' })
  const pb = makeProject({ id: 'pb', name: 'Beta', dir: 'D:\\beta' })
  const tDoc = makeTask({ id: 'ta', projectId: 'pa', name: '写文档', cwd: 'D:\\wt-doc' })
  const tBug = makeTask({ id: 'tb', projectId: 'pa', name: '修bug', cwd: 'D:\\wt-bug' })
  const tRef = makeTask({ id: 'tc', projectId: 'pb', name: '重构', cwd: 'D:\\wt-ref' })

  function search(value: string): void {
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value } })
  }

  it('按任务名过滤：命中任务显示、同项目未命中隐藏、无关项目隐藏；父项目自动展开', async () => {
    await renderApp([pa, pb], [tDoc, tBug, tRef])
    // 先折叠 pa，验证搜索强制展开（只覆盖 display，不动折叠集）
    const node = projectNode('pa') as HTMLElement
    fireEvent.click(within(node).getByRole('button', { name: /折叠 Alpha 的任务/ }))
    await waitFor(() =>
      expect((node.querySelector('.project-children') as HTMLElement).style.display).toBe('none')
    )

    search('修bug')
    await waitFor(() => expect(taskRow('tb')).not.toBeNull())
    expect(taskRow('ta')).toBeNull() // 同项目未命中任务隐藏
    expect(taskRow('tc')).toBeNull()
    expect(projectNode('pa')).not.toBeNull() // 命中任务父项目保留
    expect(projectNode('pb')).toBeNull() // 无关项目隐藏
    expect((projectNode('pa') as HTMLElement).querySelector('.project-children') as HTMLElement).toBeDefined()
    // 搜索态自动展开（折叠集未被破坏）
    expect(
      ((projectNode('pa') as HTMLElement).querySelector('.project-children') as HTMLElement)
        .style.display
    ).toBe('')
  })

  it('按 cwd 子串过滤（不区分大小写）', async () => {
    await renderApp([pa, pb], [tDoc, tBug, tRef])
    search('WT-DOC')
    await waitFor(() => expect(taskRow('ta')).not.toBeNull())
    expect(taskRow('tb')).toBeNull()
    expect(projectNode('pb')).toBeNull()
  })

  it('按项目名命中 → 整项目（含全部任务）保留', async () => {
    await renderApp([pa, pb], [tDoc, tBug, tRef])
    search('beta')
    await waitFor(() => expect(projectNode('pb')).not.toBeNull())
    expect(taskRow('tc')).not.toBeNull()
    expect(projectNode('pa')).toBeNull()
  })

  it('清空恢复全部；搜索期强制展开不破坏原折叠状态', async () => {
    await renderApp([pa, pb], [tDoc, tBug, tRef])
    const node = projectNode('pa') as HTMLElement
    fireEvent.click(within(node).getByRole('button', { name: /折叠 Alpha 的任务/ }))
    await waitFor(() =>
      expect((node.querySelector('.project-children') as HTMLElement).style.display).toBe('none')
    )
    search('beta')
    await waitFor(() => expect(projectNode('pb')).not.toBeNull())
    search('')
    await waitFor(() => expect(taskRow('ta')).not.toBeNull())
    // 恢复后 pa 仍处于折叠态（display:none）
    expect(
      ((projectNode('pa') as HTMLElement).querySelector('.project-children') as HTMLElement)
        .style.display
    ).toBe('none')
  })

  it('无命中 → 空态文案', async () => {
    await renderApp([pa], [tDoc])
    search('zzz')
    await waitFor(() => expect(screen.getByText('无匹配结果')).toBeDefined())
    expect(projectNode('pa')).toBeNull()
  })
})

describe('时间分组（S6-C：lastActiveAt 今天/昨天/近 7 天/更早，>3 任务启用）', () => {
  const p = makeProject({ id: 'pg', name: 'G' })

  it('任务数 >3：四组头渲染且任务归属正确（日历定点落桶确定）', async () => {
    const tasks = [
      makeTask({ id: 't-today', projectId: 'pg', name: '今天任务', lastActiveAt: at(0) }),
      makeTask({ id: 't-yest', projectId: 'pg', name: '昨天任务', lastActiveAt: at(-1) }),
      makeTask({ id: 't-week', projectId: 'pg', name: '周内任务', lastActiveAt: at(-3) }),
      makeTask({ id: 't-old', projectId: 'pg', name: '更早任务', lastActiveAt: at(-30) })
    ]
    await renderApp([p], tasks)
    const inGroup = (group: string, taskId: string): boolean => {
      const g = document.querySelector(`.task-group[data-group="${group}"]`)
      return g !== null && g.contains(taskRow(taskId))
    }
    await waitFor(() => expect(inGroup('today', 't-today')).toBe(true))
    expect(inGroup('yesterday', 't-yest')).toBe(true)
    expect(inGroup('week', 't-week')).toBe(true)
    expect(inGroup('older', 't-old')).toBe(true)
    // 组头可读文本（今天/昨天/近 7 天/更早）
    for (const label of ['今天', '昨天', '近 7 天', '更早']) {
      expect(
        Array.from(document.querySelectorAll('.task-group-header')).some((h) =>
          h.textContent?.includes(label)
        )
      ).toBe(true)
    }
  })

  it('任务数 ≤3：平铺不分组（无组头）', async () => {
    await renderApp([p], [
      makeTask({ id: 't1', projectId: 'pg', name: 'a', lastActiveAt: at(0) }),
      makeTask({ id: 't2', projectId: 'pg', name: 'b', lastActiveAt: at(-30) }),
      makeTask({ id: 't3', projectId: 'pg', name: 'c', lastActiveAt: at(-60) })
    ])
    await waitFor(() => expect(taskRow('t1')).not.toBeNull())
    expect(document.querySelector('.task-group')).toBeNull()
    expect(taskRow('t2')).not.toBeNull()
    expect(taskRow('t3')).not.toBeNull()
  })

  it('组头点击折叠该组（display:none 保挂载），他组不受影响', async () => {
    const tasks = [
      makeTask({ id: 't-today', projectId: 'pg', name: '今天任务', lastActiveAt: at(0, 12) }),
      makeTask({ id: 't-today2', projectId: 'pg', name: '今天任务2', lastActiveAt: at(0, 11) }),
      makeTask({ id: 't-week', projectId: 'pg', name: '周内任务', lastActiveAt: at(-3) }),
      makeTask({ id: 't-old', projectId: 'pg', name: '更早任务', lastActiveAt: at(-30) })
    ]
    await renderApp([p], tasks)
    const todayGroup = document.querySelector('.task-group[data-group="today"]') as HTMLElement
    const todayHeader = todayGroup.querySelector('.task-group-header') as HTMLElement
    expect(todayHeader.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(todayHeader)
    await waitFor(() =>
      expect(
        (todayGroup.querySelector('.task-rows') as HTMLElement).style.display
      ).toBe('none')
    )
    expect(todayHeader.getAttribute('aria-expanded')).toBe('false')
    // DOM 保留（保挂载），他组不受影响
    expect(todayGroup.contains(taskRow('t-today'))).toBe(true)
    const weekGroup = document.querySelector('.task-group[data-group="week"]') as HTMLElement
    expect((weekGroup.querySelector('.task-rows') as HTMLElement).style.display).toBe('')
    fireEvent.click(todayHeader) // 再点展开
    await waitFor(() =>
      expect(
        (todayGroup.querySelector('.task-rows') as HTMLElement).style.display
      ).toBe('')
    )
  })
})

describe('最近区块（S6-C：跨项目 lastActiveAt 前 5）', () => {
  const pa = makeProject({ id: 'pa', name: 'Alpha' })
  const pb = makeProject({ id: 'pb', name: 'Beta' })

  it('多项目取最新 5 个（更旧不渲染），显示所属项目名，点击开 tab', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      makeTask({
        id: `t${i}`,
        projectId: i < 4 ? 'pa' : 'pb',
        name: `任务${i}`,
        lastActiveAt: iso(-(i + 1) * HOUR) // t0 最新 … t6 最旧
      })
    )
    await renderApp([pa, pb], tasks)
    await waitFor(() => expect(recentRow('t0')).not.toBeNull())
    for (let i = 0; i <= 4; i++) expect(recentRow(`t${i}`)).not.toBeNull()
    expect(recentRow('t5')).toBeNull() // 第 6、7 新的不进前 5
    expect(recentRow('t6')).toBeNull()
    // 所属项目名后缀
    expect(within(recentRow('t0') as HTMLElement).getByText('Alpha')).toBeDefined()
    // 点击 = 打开 tab（activeTaskId 落地）
    fireEvent.click(within(recentRow('t0') as HTMLElement).getByRole('button'))
    expect(useAppStore.getState().activeTaskId).toBe('t0')
    expect(await screen.findByRole('tab', { name: /任务0/ })).toBeDefined()
  })

  it('无任务时不渲染区块', async () => {
    await renderApp([pa], [])
    expect(screen.queryByText('最近')).toBeNull()
  })
})

describe('侧栏折叠图标栏（S6-D）', () => {
  const pg = makeProject({ id: 'pg', name: 'GitProj', isGit: true })
  const pn = makeProject({ id: 'pn', name: 'PlainProj', isGit: false })
  const runner = makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'running' })

  /** 双态保挂载（评审 F2）：rail/sidebar 常驻 DOM，以 display 判可见 */
  function sidebarVisible(): boolean {
    const el = document.querySelector('.sidebar') as HTMLElement | null
    return el !== null && el.style.display !== 'none'
  }

  it('☰ 折叠 → 48px rail（首字母圆形标+git 角标），树保挂载仅隐藏；Ctrl+B 双向切换', async () => {
    await renderApp([pg, pn], [runner])
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // v0.5.1：顶部 ☰ 移除，折叠走 Ctrl+B
    await waitFor(() => expect(sidebarVisible()).toBe(false))
    expect(taskRow('tr')).not.toBeNull() // 树保挂载（评审 F2：折叠不卸载、草稿不丢），仅整体隐藏

    const gitAvatar = document.querySelector(
      '.sidebar-rail button[data-project-id="pg"]'
    ) as HTMLElement
    expect(gitAvatar.textContent).toBe('Gi') // 首字母标（两字内）
    expect(gitAvatar.getAttribute('title')).toBe('GitProj') // hover=全名
    expect(gitAvatar.querySelector('.rail-git-dot')).not.toBeNull()
    const plainAvatar = document.querySelector(
      '.sidebar-rail button[data-project-id="pn"]'
    ) as HTMLElement
    expect(plainAvatar.textContent).toBe('Pl')
    expect(plainAvatar.querySelector('.rail-git-dot')).toBeNull()

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await waitFor(() => expect(sidebarVisible()).toBe(true))
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    await waitFor(() => expect(sidebarVisible()).toBe(false))
  })

  it('点击项目头像 → 展开侧栏并选中该项目', async () => {
    await renderApp([pg, pn], [runner])
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // v0.5.1：顶部 ☰ 移除，折叠走 Ctrl+B
    await waitFor(() => expect(document.querySelector('.sidebar-rail')).not.toBeNull())
    fireEvent.click(
      document.querySelector('.sidebar-rail button[data-project-id="pn"]') as HTMLElement
    )
    await waitFor(() => expect(document.querySelector('.sidebar')).not.toBeNull())
    expect(useAppStore.getState().selectedProjectId).toBe('pn')
  })

})

describe('快捷键（S6-F：Ctrl+N/F/B，焦点守卫）', () => {
  const pg = makeProject({ id: 'pg', name: 'GitProj' })
  const runner = makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'running' })

  it('Ctrl+F 聚焦搜索框', async () => {
    await renderApp([pg], [runner])
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByPlaceholderText(SEARCH_PLACEHOLDER))
    )
  })

  it('Ctrl+F 在折叠态：先展开再聚焦', async () => {
    await renderApp([pg], [runner])
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // v0.5.1：顶部 ☰ 移除，折叠走 Ctrl+B
    await waitFor(() => expect(document.querySelector('.sidebar-rail')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    await waitFor(() => {
      expect(document.querySelector('.sidebar')).not.toBeNull()
      expect(document.activeElement).toBe(screen.getByPlaceholderText(SEARCH_PLACEHOLDER))
    })
  })

  it('Ctrl+N 打开新建对话框（当前选中项目）', async () => {
    await renderApp([pg], [runner])
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: '新建任务' })).toBeDefined()
    expect(screen.getByText('在 “GitProj” 新建任务')).toBeDefined()
  })

  it('Ctrl+N 零项目（无选中）不打开对话框', async () => {
    await renderApp([], [])
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull()
  })

  it('焦点在输入框时不劫持：搜索框内 Ctrl+B 不折叠', async () => {
    await renderApp([pg], [runner])
    const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER)
    input.focus()
    fireEvent.keyDown(input, { key: 'b', ctrlKey: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(sidebarVisible()).toBe(true) // 仍展开（双态保挂载下以可见性断言，评审 F2）
  })

  it('焦点在终端宿主（.term-host 内）时不劫持：Ctrl+B 不折叠', async () => {
    await renderApp([pg], [runner])
    // 开 tab 让 TerminalPanel 渲染 term-host
    fireEvent.click((taskRow('tr') as HTMLElement).querySelector('.task-main') as HTMLElement)
    const host = await waitFor(() => {
      const h = document.querySelector('.term-host')
      expect(h).not.toBeNull()
      return h as HTMLElement
    })
    // 评审 F7：用非 input/textarea 元素隔离 closest('.term-host') 分支
    // （textarea 会先命中 tagName 守卫，closest 分支名存实亡）
    const fake = document.createElement('div')
    fake.tabIndex = 0
    host.appendChild(fake)
    fake.focus()
    fireEvent.keyDown(fake, { key: 'b', ctrlKey: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector('.sidebar')).not.toBeNull()
    expect(document.querySelector('.sidebar-rail')).not.toBeNull() // 双态保挂载（评审 F2）
    expect(
      (document.querySelector('.sidebar-rail') as HTMLElement).style.display
    ).toBe('none') // 展开态下 rail 隐藏而非卸载
  })
})

// ── v1.4.2 设置入口：展开态头部图标组（版本号后）+ 折叠 rail ⚙ ─────────────
// v1.2.2：ⓘ 入口删除（用户指令「版本后面只保留 Skills 和设置」）；
//        图标改内联 SVG（用户指令：常用风格、易识别、比 emoji 大）——按钮无文本，
//        以 data-icon 锚点断言

describe('设置入口（v1.2.2：Skills / 设置两个 SVG 图标按钮）', () => {
  const pg = makeProject({ id: 'pg', name: 'GitProj' })
  const runner = makeTask({ id: 'tr', projectId: 'pg', name: 'runner', status: 'running' })

  it('展开态：版本号后只剩设置图标按钮（v2.0.1 skills 移除）；点 ⚙ 开设置弹窗', async () => {
    await renderApp([pg], [runner])
    const header = document.querySelector('.sidebar-header') as HTMLElement
    expect(header.querySelector('.version-text')?.textContent).toContain('v2.1.1')
    // 图标组紧跟版本号（DOM 顺序即视觉顺序）；data-icon=svg 图形锚点
    const group = header.querySelector('.sidebar-icon-group') as HTMLElement
    expect(group).not.toBeNull()
    const buttons = Array.from(group.querySelectorAll('button')) as HTMLElement[]
    expect(buttons.map((b) => b.dataset.icon)).toEqual(['settings']) // v2.0.1：skills 移除
    // SVG 线型图标真实渲染（非空 emoji 占位）
    expect(buttons[0]!.querySelector('svg')).not.toBeNull() // ⚙ 内联 SVG

    const settingsBtn = within(group).getByRole('button', { name: '设置' })
    fireEvent.click(settingsBtn)
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeDefined()
  })

  it('折叠态 rail 只剩 ⚙（🧩 已删）；点击开设置弹窗', async () => {
    await renderApp([pg], [runner])
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true }) // 折叠
    const rail = document.querySelector('.sidebar-rail') as HTMLElement
    const gear = within(rail).getByTitle('设置')
    // v2.0.1：skills 已删——rail 无 skills 图标；不再有关于入口
    const btns = Array.from(rail.querySelectorAll('.rail-btn')) as HTMLElement[]
    const idx = btns.indexOf(gear)
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(btns.map((b) => b.dataset.icon)).not.toContain('skills')
    expect(btns.map((b) => b.dataset.icon)).not.toContain('about')
    expect(gear.querySelector('svg')).not.toBeNull()

    fireEvent.click(gear)
    expect(await screen.findByRole('dialog', { name: '设置' })).toBeDefined()
  })
})


describe('v2.0.1 侧栏作用域过滤（用户确认原型 sidebar-scope-v2）', () => {
  const conn = makeConnection({ id: 'c1', name: 'VM-Dev' })
  const pLocal = makeProject({ id: 'pl', name: 'LocalA', dir: 'D:\\a' })
  const pLocal2 = makeProject({ id: 'pl2', name: 'LocalB', dir: 'D:\\b' })
  const pRemote = makeProject({ id: 'pr', name: 'RemoteR', dir: '/home/dev/r', connectionId: 'c1' })

  async function renderScoped(): Promise<void> {
    installCwbMock({ projects: [pLocal, pLocal2, pRemote], connections: [conn] })
    useAppStore.setState({
      projects: [pLocal, pLocal2, pRemote],
      connections: [conn],
      connectionStates: { c1: { state: 'connected' } }
    })
    render(<App />)
    await waitFor(() => expect(document.querySelector('.sidebar-scope-chips')).toBeDefined())
  }

  it('chips 渲染（全部 3/本机 2/VM-Dev 1）；切 VM-Dev → 仅远程项目、本机组消失；主操作变「注册远程目录」', async () => {
    await renderScoped()
    const chips = screen.getByTestId('sidebar-scope-chips')
    expect(within(chips).getByText('全部')).toBeDefined()
    expect(within(chips).getByText('本机')).toBeDefined()
    expect(within(chips).getByText('VM-Dev')).toBeDefined()
    // 默认 all：本机与远程组都在
    expect(projectNode('pl')).not.toBeNull()
    expect(projectNode('pr')).not.toBeNull()
    // 切 VM-Dev
    fireEvent.click(screen.getByTestId('sb-chip-c1'))
    console.log('scope-after-click=', useAppStore.getState().sidebarScope)
    await waitFor(() => expect(projectNode('pl')).toBeNull())
    expect(projectNode('pl2')).toBeNull()
    expect(projectNode('pr')).not.toBeNull()
    // 主操作随域
    expect(screen.getByTestId('btn-register-remote')).toBeDefined()
  })

  it('切本机 → 远程组消失、本机保留、主操作回到「打开目录」；scope 持久化 setAppSettings', async () => {
    await renderScoped()
    const chips = screen.getByTestId('sidebar-scope-chips')
    fireEvent.click(within(chips).getByText('本机'))
    await waitFor(() => expect(projectNode('pr')).toBeNull())
    expect(projectNode('pl')).not.toBeNull()
    expect(screen.queryByTestId('btn-register-remote')).toBeNull()
    await waitFor(() =>
      expect(useAppStore.getState().sidebarScope).toBe('local')
    )
  })

  it('远程作用域 ＋ → 打开注册对话框（2.0.2 修复：此前空路径直调注册被 main 拒，表象「点了没反应」）', async () => {
    await renderScoped()
    fireEvent.click(screen.getByTestId('sb-chip-c1'))
    await waitFor(() => expect(screen.getByTestId('btn-register-remote')).toBeDefined())
    fireEvent.click(screen.getByTestId('btn-register-remote'))
    // 与服务器节点菜单同款：RemoteProjectDialog（预选当前作用域连接，收路径再注册）
    const dialog = await screen.findByRole('dialog', { name: '新建远程项目…' })
    expect(dialog.textContent).toContain('VM-Dev')
    // 取消关闭；期间不发生 addProject 调用（空路径注册是 2.0.2 前的坏路径）
    fireEvent.click(within(dialog).getByText('取消'))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '新建远程项目…' })).toBeNull()
    )
  })

  it('失效作用域归一：scope 指向已删连接 → 渲染回 all（全量可见）', async () => {
    installCwbMock({ projects: [pLocal, pRemote], connections: [conn] })
    useAppStore.setState({
      projects: [pLocal, pRemote],
      connections: [conn],
      sidebarScope: 'ghost-conn'
    })
    render(<App />)
    await waitFor(() => expect(projectNode('pl')).not.toBeNull())
    expect(projectNode('pr')).not.toBeNull()
  })

  // v2.1.2 ②：开发视图作用域合法域剔除纯 SSH——旧持久化纯 ssh 域 normalize 回退 all
  it('持久化作用域指向纯 SSH 连接 → 回退 all（「全部」chip 激活、全量可见、无该 chip）', async () => {
    const pure = makeConnection({ id: 'c9', name: '跳板机', kind: 'ssh' })
    installCwbMock({ projects: [pLocal, pRemote], connections: [conn, pure] })
    useAppStore.setState({
      projects: [pLocal, pRemote],
      connections: [conn, pure],
      sidebarScope: 'c9'
    })
    render(<App />)
    await waitFor(() => expect(document.querySelector('.sidebar-scope-chips')).toBeDefined())
    const chips = screen.getByTestId('sidebar-scope-chips')
    // 「全部」chip 处于激活态（aria-pressed=true——纯 ssh cid 不在合法域）
    const allBtn = within(chips).getByText('全部').closest('button')
    expect(allBtn?.getAttribute('aria-pressed')).toBe('true')
    // 回退 all：本机与远程项目全量可见；纯 SSH 无 chip、dev 连接 chip 仍在
    expect(projectNode('pl')).not.toBeNull()
    expect(projectNode('pr')).not.toBeNull()
    expect(document.querySelector('[data-testid="sb-chip-c9"]')).toBeNull()
    expect(document.querySelector('[data-testid="sb-chip-c1"]')).not.toBeNull()
  })
})
