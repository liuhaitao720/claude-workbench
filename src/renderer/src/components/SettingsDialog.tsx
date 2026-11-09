import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { Theme } from '../theme'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { CliOutputView } from './CliOutputView'
import { changeFontFamily, changeFontSize } from './TerminalPanel'
import { FONT_FAMILY_WHITELIST, loadFontFamily } from '../font-family'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, clampFontSize, loadFontSize } from '../font-size'
import { APP_VERSION, BUILD_DATE } from '../app-info'
import { useI18n, useLanguageStore, LANGUAGE_LABELS } from '../i18n'
import type { Language, MessageKey } from '../i18n'
import type {
  AppChangelogEntry,
  AppUpdateInfo,
  AppUpdateProgressEvent,
  LocalProxyStatus,
  ProviderConfig,
  ProviderRegistryState
} from '../../../shared/types'

/** v1.4.1 provider 表单态（models 单行一模型：每行 {name, oneM}；oneM=声明支持 1M 上下文） */
interface ModelRow {
  name: string
  oneM: boolean
}

interface ProviderFormState {
  id: string
  name: string
  format: 'anthropic' | 'openai'
  baseUrl: string
  apiKey: string
  apiKeyType: 'auth_token' | 'api_key'
  modelRows: ModelRow[]
  defaultModel: string
  proxyUrl: string
  slotSonnet: string
  slotOpus: string
  slotFable: string
  slotHaiku: string
}

const emptyProviderForm = (): ProviderFormState => ({
  id: '',
  name: '',
  format: 'anthropic',
  baseUrl: '',
  apiKey: '',
  apiKeyType: 'auth_token',
  modelRows: [],
  defaultModel: '',
  proxyUrl: '',
  slotSonnet: '',
  slotOpus: '',
  slotFable: '',
  slotHaiku: ''
})

/** v1.4.1 [1m] 类命名自动预勾（如 claude-sonnet-4-5[1m]、xxx-1m-pro）——仅默认值，行内可手动改 */
function looksLike1M(name: string): boolean {
  return /\[1m\]/i.test(name) || /(^|[^a-z0-9])1m([^a-z0-9]|$)/i.test(name)
}

/** 档案 → 行（models1M 已存=以存值为准（空数组=明确全否）；未存（旧档案/探测新行）=按命名预勾） */
function providerModelRows(p: Pick<ProviderConfig, 'models' | 'models1M'>): ModelRow[] {
  return p.models.map((n) => ({
    name: n,
    oneM: p.models1M !== undefined ? p.models1M.includes(n) : looksLike1M(n)
  }))
}

/** v1.4.1 下拉候选：模型行 trim 去重保序（oneM 随行供选项标注） */
function modelSelectOptions(rows: ModelRow[]): ModelRow[] {
  const seen = new Set<string>()
  const out: ModelRow[] = []
  for (const r of rows) {
    const name = r.name.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push({ name, oneM: r.oneM })
  }
  return out
}

/** v1.4.1 档位下拉候选：预设模型行 + 兜底保留当前值（旧档案手填、不在预设列表时不丢数据） */
function slotSelectOptions(rows: ModelRow[], current: string): ModelRow[] {
  const opts = modelSelectOptions(rows)
  const cur = current.trim()
  if (cur !== '' && !opts.some((o) => o.name === cur)) opts.push({ name: cur, oneM: false })
  return opts
}

/** v1.4.1 表单态 → 档案对象（行名 trim 去空去重；models 非空时恒写 models1M——空数组=明确声明全不支持） */
function providerFormToConfig(f: ProviderFormState): ProviderConfig {
  const slots: NonNullable<ProviderConfig['slotModels']> = {}
  if (f.slotSonnet.trim() !== '') slots['sonnet'] = f.slotSonnet.trim()
  if (f.slotOpus.trim() !== '') slots['opus'] = f.slotOpus.trim()
  if (f.slotFable.trim() !== '') slots['fable'] = f.slotFable.trim()
  if (f.slotHaiku.trim() !== '') slots['haiku'] = f.slotHaiku.trim()
  const names = [...new Set(f.modelRows.map((r) => r.name.trim()).filter((s) => s !== ''))]
  const declared1M = [
    ...new Set(f.modelRows.filter((r) => r.oneM && r.name.trim() !== '').map((r) => r.name.trim()))
  ].filter((n) => names.includes(n))
  return {
    id: f.id,
    name: f.name.trim(),
    format: f.format,
    baseUrl: f.baseUrl.trim(),
    apiKey: f.apiKey.trim(),
    apiKeyType: f.apiKeyType,
    models: names,
    ...(names.length > 0 ? { models1M: declared1M } : {}),
    ...(f.defaultModel !== '' ? { defaultModel: f.defaultModel } : {}),
    ...(f.proxyUrl.trim() !== '' ? { proxyUrl: f.proxyUrl.trim() } : {}),
    ...(Object.keys(slots).length > 0 ? { slotModels: slots } : {})
  }
}

/** v1.4 已解析 JSON（unknown，main 侧同链校验）→ 表单态（models 数组并回行；models1M 同 providerModelRows 语义） */
function providerConfigToForm(raw: Record<string, unknown>, fallbackId: string): ProviderFormState {
  const str = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '')
  const slots = (raw['slotModels'] as Record<string, unknown> | undefined) ?? {}
  const slotStr = (k: string): string => (typeof slots[k] === 'string' ? (slots[k] as string) : '')
  const modelNames = Array.isArray(raw['models'])
    ? (raw['models'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : []
  const declared1M =
    raw['models1M'] !== undefined && Array.isArray(raw['models1M'])
      ? (raw['models1M'] as unknown[]).filter((m): m is string => typeof m === 'string')
      : undefined
  return {
    id: str('id') !== '' ? str('id') : fallbackId,
    name: str('name'),
    format: raw['format'] === 'openai' ? 'openai' : 'anthropic',
    baseUrl: str('baseUrl'),
    apiKey: str('apiKey'),
    apiKeyType: raw['apiKeyType'] === 'api_key' ? 'api_key' : 'auth_token',
    modelRows: modelNames.map((n) => ({
      name: n,
      oneM: declared1M !== undefined ? declared1M.includes(n) : looksLike1M(n)
    })),
    defaultModel: str('defaultModel'),
    proxyUrl: str('proxyUrl'),
    slotSonnet: slotStr('sonnet'),
    slotOpus: slotStr('opus'),
    slotFable: slotStr('fable'),
    slotHaiku: slotStr('haiku')
  }
}

/** 5.1 安装方式展示模板（执行走 installClaudeCli 固定契约法，不经自由命令面；
 * spec R5：执行前完整展示命令 + 二次确认）——迁自 AboutDialog。
 * v1.3：与 main 侧 platform.ts 安装模板同源按平台分流（linux 显示官方 install.sh） */
const IS_LINUX_UI = (window as unknown as { cwb?: { platform?: string } }).cwb?.platform === 'linux'
const NATIVE_INSTALL_CMD = IS_LINUX_UI
  ? 'curl -fsSL https://claude.ai/install.sh | bash'
  : 'powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
const NPM_INSTALL_CMD = 'npm install -g @anthropic-ai/claude-code'
const CLAUDE_DOCS_URL = 'https://claude.ai/docs/setup'

/** 设置中心分类 id（v1.4 重构：外观+终端+通知+启动 合并为「通用」，左栏收敛 4 项） */
type SettingsSectionId = 'general' | 'providers' | 'cli' | 'about'

/** 设置中心导航（id 稳定作 activeSection 锚点；label 经 i18n）。
 *  v1.4：通用（外观/终端/通知/启动）→ 模型服务（provider + 本地代理）→ claude CLI → 关于。 */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; labelKey: MessageKey }> = [
  { id: 'general', labelKey: 'settings.sectionGeneral' },
  { id: 'providers', labelKey: 'settings.sectionProviders' },
  { id: 'cli', labelKey: 'settings.sectionCli' },
  { id: 'about', labelKey: 'settings.sectionAbout' }
]

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 设置中心弹窗（v0.9 9 项设置 + S14 双栏重设计，/frontend-design 定稿）：
 * macOS 系统设置式左导航 + 右内容——
 * - 左栏分类导航项，每项附当前值摘要（主题 / 字体·字号 / 通知 / CLI 版本 /
 *   启动行为 / 应用更新状态），全部从既有 state 派生——不打开分类也能扫出当前值
 * - 右栏按 activeSection 条件渲染（默认「外观」；非当前 section 不渲染）；
 *   各 section 内部 JSX 沿 v0.9 原样（交互/测试锚点不动，只重新分区布局）
 * - v0.9 全部保留项不动：外观 主题三选+终端跟随；终端 字体族+字号 stepper；
 *   通知 webhook；claude CLI 版本/更新/安装（CliOutputView 含 commandIdRef
 *   卸载 kill）；启动与窗口 关闭行为+开机自启
 * - v1.2.2：左栏 6 分类——「应用更新」并入末项「关于」（身份+更新同页）
 * - Escape/遮罩关闭/useEscapeClose、底部「关闭」按钮（跨栏）全保留
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useI18n()
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const termFollowsTheme = useAppStore((s) => s.termFollowsTheme)
  const setTermFollowsTheme = useAppStore((s) => s.setTermFollowsTheme)

  const [fontFamily, setFontFamily] = useState<string>(() => loadFontFamily())
  const [fontSizeInput, setFontSizeInput] = useState<string>(() => String(loadFontSize()))
  /** v0.9.4：本机已装等宽字体（main 扫描契约）——与白名单合并为下拉全集 */
  const [installedFonts, setInstalledFonts] = useState<string[]>([])

  const [cliInfo, setCliInfo] = useState<{ version: string; path: string } | null>(null)
  const [cliError, setCliError] = useState('')
  const [updateInfo, setUpdateInfo] = useState<{
    current: string
    latest: string
    upToDate: boolean
    degraded?: boolean
  } | null>(null)
  // v1.1.0 claude CLI 更新说明（checkUpdate 成功且非 degraded 时自动拉取）
  const [cliNotes, setCliNotes] = useState<{ notes: AppChangelogEntry[]; error?: string } | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [checking, setChecking] = useState(false)
  const [installMethod, setInstallMethod] = useState<'native' | 'npm'>('native')
  const [installError, setInstallError] = useState('')
  /** runCliCommand/installClaudeCli 的当前命令（同一时刻至多一个，共用输出区） */
  const [commandId, setCommandId] = useState<string | null>(null)
  /** v1.1.0：点击更新/安装后立即显示「正在执行」——原实现要等首个输出帧才出现
   *  输出区，用户以为点击没生效（claude update 冷启动 1~3s 无输出） */
  const [starting, setStarting] = useState(false)
  const [notifyUrl, setNotifyUrl] = useState('')
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [notifyMsg, setNotifyMsg] = useState('')
  const [notifyTest, setNotifyTest] = useState<{ ok: boolean; error?: string } | null>(null)
  // v1.4 模型服务：档案列表 + 表单态（null=列表态）+ 操作反馈
  const [providerState, setProviderState] = useState<ProviderRegistryState>({ providers: [] })
  const [providerForm, setProviderForm] = useState<ProviderFormState | null>(null)
  const [providerError, setProviderError] = useState('')
  const [providerMsg, setProviderMsg] = useState('')
  /** v1.4 模型列表探测中标记（按钮禁用 + 文案切换） */
  const [providerProbing, setProviderProbing] = useState(false)
  /** v1.4 表单/JSON 双模式编辑（JSON 直改——行内「JSON」按钮直达） */
  const [providerFormMode, setProviderFormMode] = useState<'form' | 'json'>('form')
  const [providerJsonText, setProviderJsonText] = useState('')
  /** v1.4 本地代理：状态卡 + 随应用启动开关 */
  const [proxyStatus, setProxyStatus] = useState<LocalProxyStatus | null>(null)
  const [proxyAutoStart, setProxyAutoStart] = useState(false)
  const [proxyError, setProxyError] = useState('')
  const [closeToTray, setCloseToTray] = useState(true)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  // v1.1.0 应用自更新：检查结果（初值取启动静默检查落库值）/进度/已就绪标记
  const [appUpd, setAppUpd] = useState<AppUpdateInfo | null>(() => useAppStore.getState().appUpdateInfo)
  const [appUpdChecking, setAppUpdChecking] = useState(false)
  const [appUpdError, setAppUpdError] = useState('')
  const [appUpdProgress, setAppUpdProgress] = useState<AppUpdateProgressEvent | null>(null)
  const [appUpdReady, setAppUpdReady] = useState(false)
  /** v1.2.1 自动升级开关（main settings.json 持久化；缺省开） */
  const [autoUpdate, setAutoUpdate] = useState(true)
  /** S14：当前展示的分类（默认首项「外观」；v1.2.2 起无 ⓘ 直达入口） */
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general')

  // v1.1.0 下载进度订阅（main 经 cwb:event:app-update-progress 推送；v1.2.1 增加
  // available=自动检查结果 / waiting-tasks=等任务结束）
  useEffect(() => {
    return window.cwb.onAppUpdateProgress((e) => {
      if (e.phase === 'available') {
        setAppUpd(e.info)
        useAppStore.getState().setAppUpdateInfo(e.info)
        return
      }
      setAppUpdProgress(e)
      setAppUpdReady(e.phase === 'ready' || e.phase === 'waiting-tasks' || e.phase === 'installing')
    })
  }, [])

  const checkAppUpd = async (): Promise<void> => {
    setAppUpdChecking(true)
    setAppUpdError('')
    try {
      // v1.2.1：手动点检查 → force 重新拉清单（不复用启动自动检查的缓存）
      const info = await window.cwb.checkAppUpdate(true)
      setAppUpd(info)
      setAppUpdReady(false)
      useAppStore.getState().setAppUpdateInfo(info) // 同步侧栏版本按钮角标
    } catch (err) {
      setAppUpdError(errMsg(err))
    } finally {
      setAppUpdChecking(false)
    }
  }

  const downloadAppUpd = async (): Promise<void> => {
    setAppUpdError('')
    setAppUpdReady(false)
    const r = await window.cwb.downloadAppUpdate()
    if (!r.ok) setAppUpdError(r.error ?? t('settings.appDownloadFailed'))
    // 下载成功由 main 的 ready 进度事件置 appUpdReady → 显示「立即升级」
    // （自动升级开关打开时，main 侧会自行完成重启，这个按钮是手动路径/兜底）
  }

  const installAppUpd = async (): Promise<void> => {
    if (!window.confirm(t('settings.appInstallConfirm'))) return
    const r = await window.cwb.installAppUpdate()
    if (!r.ok) setAppUpdError(r.error ?? t('settings.appInstallStartFailed'))
  }

  // npm 安装项禁用条件（S9 定夺）：S8 未提供 node 检测契约 → 暂用 false 默认可点；
  // 无 node 机器上安装失败经输出区回显报错（可接受的自愈路径），待后续契约补
  // node 检测后接入真实条件（concern 已记报告）——迁自 AboutDialog
  const npmInstallDisabled = false

  const refreshCliInfo = async () => {
    try {
      setCliInfo(await window.cwb.getClaudeVersionInfo())
      setCliError('')
    } catch (err) {
      setCliInfo(null)
      setCliError(errMsg(err))
    }
  }

  // 打开即实测版本信息 + 读通知配置 + 读应用设置 + 扫描本机字体（读取失败保持默认值，不阻塞弹窗）
  useEffect(() => {
    void refreshCliInfo()
    window.cwb
      .getInstalledMonoFonts()
      .then((list) => setInstalledFonts(list))
      .catch(() => {})
    window.cwb
      .getNotifyConfig()
      .then((c) => {
        setNotifyUrl(c.url)
        setNotifyEnabled(c.enabled)
      })
      .catch(() => {})
    // v1.4 模型服务档案（读取失败保持空列表，不阻塞弹窗）
    window.cwb
      .listProviders()
      .then(setProviderState)
      .catch(() => {})
    // v1.4 本地代理状态
    window.cwb
      .getProxyStatus()
      .then(setProxyStatus)
      .catch(() => {})
    window.cwb
      .getAppSettings()
      .then((s) => {
        setCloseToTray(s.closeToTray)
        setLaunchAtLogin(s.launchAtLogin)
        setAutoUpdate(s.autoUpdate !== false)
        setProxyAutoStart(s.proxyAutoStart === true)
      })
      .catch(() => {})
  }, [])

  /** v1.4 模型服务页激活时轮询代理状态（时长/统计刷新；离开即停） */
  useEffect(() => {
    if (activeSection !== 'providers') return
    const refresh = (): void => {
      window.cwb
        .getProxyStatus()
        .then(setProxyStatus)
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => window.clearInterval(timer)
  }, [activeSection])

  /** v1.4 本地代理启停（结果直接落状态卡；失败行内提示） */
  const toggleProxy = async (): Promise<void> => {
    setProxyError('')
    try {
      const r = proxyStatus?.running
        ? await window.cwb.stopProxy()
        : await window.cwb.startProxy()
      setProxyStatus(r)
    } catch (err) {
      setProxyError(t('settings.proxyStartFailed', { error: errMsg(err) }))
    }
  }

  const toggleProxyAutoStart = (on: boolean): void => {
    setProxyAutoStart(on)
    void window.cwb.setAppSettings({ proxyAutoStart: on })
  }

  /** 运行时长文案：startedAt → "H 时 M 分"（<1h 只显示分） */
  const proxyRunFor = (): string => {
    if (proxyStatus?.startedAt === undefined) return ''
    const mins = Math.max(0, Math.floor((Date.now() - new Date(proxyStatus.startedAt).getTime()) / 60_000))
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return h > 0 ? t('settings.proxyRunFor', { h, m }) : t('settings.proxyRunForMin', { m })
  }

  // 关闭防孤儿：卸载时终止仍在执行的 CLI 命令（覆盖 overlay/Escape/按钮全关闭路径）
  const commandIdRef = useRef(commandId)
  commandIdRef.current = commandId
  useEffect(
    () => () => {
      if (commandIdRef.current !== null) window.cwb.killCliCommand(commandIdRef.current)
    },
    []
  )

  const installed = cliInfo !== null && cliInfo.version !== ''

  // A1：document 级 Escape——焦点留在触发按钮（侧栏设置按钮）上也能关
  useEscapeClose(onClose)

  const themeChoices: ReadonlyArray<{ value: Theme; label: string }> = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'dark', label: t('settings.themeDark') },
    { value: 'light', label: t('settings.themeLight') }
  ]

  // S14 左栏当前值摘要：全部从既有 state 派生（字号输入清空的中间态回退到实际
  // 生效值；CLI 检测中/失败均不属于「已装」——失败与未装同示「未安装」；
  // v1.2.2「关于」摘要改为应用更新状态——分类里更新是主要动态信息，版本号在内容区首行）
  const sectionSummaries: Record<SettingsSectionId, string> = {
    general: `${themeChoices.find((c) => c.value === theme)?.label ?? ''} · ${
      fontSizeInput === '' ? String(loadFontSize()) : fontSizeInput
    }px`,
    providers:
      providerState.providers.length === 0
        ? t('settings.providerSummaryNone')
        : (providerState.providers.find((p) => p.id === providerState.defaultProviderId)?.name ??
          t('settings.providerSummaryCount', { count: providerState.providers.length })),
    cli: installed
      ? cliInfo.version
      : cliInfo !== null || cliError !== ''
        ? t('settings.cliStateNotInstalled')
        : t('common.detecting'),
    about:
      appUpd === null
        ? t('settings.updateStateUnchecked')
        : appUpd.upToDate
          ? t('settings.updateStateLatest', { version: appUpd.current })
          : t('settings.updateStateAvailable', { version: appUpd.latest })
  }

  const checkUpdate = async () => {
    setChecking(true)
    setUpdateError('')
    setCliNotes(null)
    try {
      const info = await window.cwb.checkClaudeUpdate()
      setUpdateInfo(info)
      // v1.1.0：版本对比成功后拉更新说明（已是最新也展示当前版本段，和「应用更新」一致）
      if (info.current !== '' && info.latest !== '' && info.degraded !== true) {
        try {
          setCliNotes(await window.cwb.getClaudeChangelog(info.current, info.latest))
        } catch (err) {
          setCliNotes({ notes: [], error: errMsg(err) })
        }
      }
    } catch (err) {
      setUpdateError(errMsg(err))
    } finally {
      setChecking(false)
    }
  }

  const runUpdate = async () => {
    setUpdateError('')
    setStarting(true) // v1.1.0：立即给反馈（spawn 有 0.5~3s 冷启动，期间界面无变化）
    try {
      const r = await window.cwb.runCliCommand('claude update')
      setCommandId(r.commandId)
    } catch (err) {
      setUpdateError(errMsg(err))
    } finally {
      setStarting(false)
    }
  }

  const runInstall = async () => {
    const cmd = installMethod === 'native' ? NATIVE_INSTALL_CMD : NPM_INSTALL_CMD
    if (!window.confirm(t('settings.installConfirm', { cmd }))) return
    setInstallError('')
    setStarting(true)
    try {
      const r = await window.cwb.installClaudeCli(installMethod)
      setCommandId(r.commandId)
    } catch (err) {
      setInstallError(errMsg(err))
    } finally {
      setStarting(false)
    }
  }

  const saveNotify = async () => {
    try {
      await window.cwb.setNotifyWebhook(notifyUrl.trim(), notifyEnabled)
      setNotifyMsg(t('settings.notifySaved'))
    } catch (err) {
      setNotifyMsg(t('settings.notifySaveFailed', { error: errMsg(err) }))
    }
  }

  const sendTest = async () => {
    try {
      setNotifyTest(await window.cwb.sendTestNotify())
    } catch (err) {
      setNotifyTest({ ok: false, error: errMsg(err) })
    }
  }

  // ── v1.4 模型服务 provider 动作 ────────────────────────────────────────
  const reloadProviders = async (): Promise<void> => {
    try {
      setProviderState(await window.cwb.listProviders())
    } catch {
      // 读取失败保持现值（列表 UI 不被网络/IPC 抖动清空）
    }
  }

  const saveProviderForm = async (): Promise<void> => {
    if (providerForm === null) return
    setProviderError('')
    setProviderMsg('')
    // JSON 模式：解析直改文本（main 侧同链校验——字段问题以 i18n 文案拒绝）
    let config: ProviderConfig
    if (providerFormMode === 'json') {
      try {
        const parsed: unknown = JSON.parse(providerJsonText)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error(t('settings.providerJsonParseError', { error: 'object' }))
        }
        config = { ...(providerFormToConfig(providerForm) as ProviderConfig), ...(parsed as ProviderConfig) }
      } catch (err) {
        setProviderError(
          err instanceof SyntaxError
            ? t('settings.providerJsonParseError', { error: err.message })
            : errMsg(err)
        )
        return
      }
    } else {
      config = providerFormToConfig(providerForm)
    }
    try {
      await window.cwb.saveProvider(config)
      setProviderForm(null)
      setProviderFormMode('form')
      setProviderMsg(t('settings.providerSaved'))
      await reloadProviders()
    } catch (err) {
      setProviderError(errMsg(err)) // main 侧校验拒绝（名称/URL/格式）逐字展示
    }
  }

  /** 表单/JSON 双模式切换：进 JSON 序列化当前表单；回表单先解析（语法错误留在 JSON 页并提示） */
  const switchProviderFormMode = (mode: 'form' | 'json'): void => {
    if (providerForm === null || mode === providerFormMode) return
    setProviderError('')
    if (mode === 'json') {
      setProviderJsonText(JSON.stringify(providerFormToConfig(providerForm), null, 2))
      setProviderFormMode('json')
      return
    }
    try {
      const parsed: unknown = JSON.parse(providerJsonText)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('object')
      }
      setProviderForm(providerConfigToForm(parsed as Record<string, unknown>, providerForm.id))
      setProviderFormMode('form')
    } catch (err) {
      setProviderError(
        err instanceof SyntaxError
          ? t('settings.providerJsonParseError', { error: err.message })
          : errMsg(err)
      )
    }
  }

  /** 行内「JSON」按钮：直接以该档案的 JSON 打开编辑（显示内容=可直改保存） */
  const openProviderJson = (p: ProviderConfig): void => {
    setProviderError('')
    setProviderMsg('')
    setProviderForm({
      id: p.id,
      name: p.name,
      format: p.format,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      apiKeyType: p.apiKeyType ?? 'auth_token',
      modelRows: providerModelRows(p),
      defaultModel: p.defaultModel ?? '',
      proxyUrl: p.proxyUrl ?? '',
      slotSonnet: p.slotModels?.sonnet ?? '',
      slotOpus: p.slotModels?.opus ?? '',
      slotFable: p.slotModels?.fable ?? '',
      slotHaiku: p.slotModels?.haiku ?? ''
    })
    setProviderJsonText(JSON.stringify(p, null, 2))
    setProviderFormMode('json')
  }

  /** v1.4 模型列表探测：按已保存档案请求 {baseUrl}/v1/models，结果合并进预设模型（去重保序） */
  const probeModels = async (): Promise<void> => {
    if (providerForm === null || providerForm.id === '') return
    setProviderProbing(true)
    setProviderError('')
    setProviderMsg('')
    try {
      const r = await window.cwb.probeProviderModels(providerForm.id)
      if (!r.ok) {
        setProviderError(t('settings.providerProbeFailed', { error: r.error ?? '' }))
        return
      }
      const fetched = r.models ?? []
      const existing = new Set(
        providerForm.modelRows.map((r) => r.name.trim()).filter((n) => n !== '')
      )
      // v1.4.1 新探测到的模型追加为新行（[1m] 类命名预勾），已有行（含勾选态）不动
      const appended = fetched
        .map((n) => n.trim())
        .filter((n) => n !== '' && !existing.has(n))
        .map((n) => ({ name: n, oneM: looksLike1M(n) }))
      setProviderForm({ ...providerForm, modelRows: [...providerForm.modelRows, ...appended] })
      setProviderMsg(t('settings.providerProbeOk', { count: fetched.length }))
    } catch (err) {
      setProviderError(t('settings.providerProbeFailed', { error: errMsg(err) }))
    } finally {
      setProviderProbing(false)
    }
  }

  /** v1.4 布局重构：编辑目标切换/新增（列表行按钮与双栏 rail 共用） */
  const startEditProvider = (p: ProviderConfig): void => {
    setProviderError('')
    setProviderMsg('')
    setProviderForm({
      id: p.id,
      name: p.name,
      format: p.format,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      apiKeyType: p.apiKeyType ?? 'auth_token',
      modelRows: providerModelRows(p),
      defaultModel: p.defaultModel ?? '',
      proxyUrl: p.proxyUrl ?? '',
      slotSonnet: p.slotModels?.sonnet ?? '',
      slotOpus: p.slotModels?.opus ?? '',
      slotFable: p.slotModels?.fable ?? '',
      slotHaiku: p.slotModels?.haiku ?? ''
    })
    setProviderFormMode('form')
  }

  const startAddProvider = (): void => {
    setProviderError('')
    setProviderMsg('')
    setProviderForm(emptyProviderForm())
    setProviderFormMode('form')
  }

  const makeProviderDefault = async (id: string): Promise<void> => {
    setProviderError('')
    setProviderMsg('')
    try {
      await window.cwb.setDefaultProvider(id)
      setProviderMsg(t('settings.providerSaved'))
      await reloadProviders()
    } catch (err) {
      setProviderError(errMsg(err))
    }
  }

  const removeProviderRow = async (p: ProviderConfig): Promise<void> => {
    if (!window.confirm(t('settings.providerRemoveConfirm', { name: p.name }))) return
    setProviderError('')
    setProviderMsg('')
    try {
      await window.cwb.removeProvider(p.id)
      await reloadProviders()
    } catch (err) {
      setProviderError(errMsg(err))
    }
  }

  /** 字号 stepper（10-22）：经 changeFontSize 单一入口落地（clamp+persist+全实例
   *  options+活动 fit/ptyResize——与 Ctrl+=/-、Ctrl+滚轮同一通路）；显示值收敛回实际落地 */
  const applyFontSize = (raw: string): void => {
    if (raw === '') return // number 输入清空（含非数字中间态）不动当前值
    const applied = changeFontSize(clampFontSize(Number(raw)) - loadFontSize())
    setFontSizeInput(String(applied))
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog settings-dialog" role="dialog" aria-label={t('settings.aria')}>
        <p className="dialog-title">{t('settings.title')}</p>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('settings.navAria')}>
            {SETTINGS_SECTIONS.map((sec) => {
              const id = sec.id as SettingsSectionId
              const label = t(sec.labelKey)
              return (
                <button
                  key={id}
                  type="button"
                  className={activeSection === id ? 'settings-nav-item active' : 'settings-nav-item'}
                  aria-label={label}
                  aria-current={activeSection === id ? 'true' : undefined}
                  onClick={() => setActiveSection(id)}
                >
                  <span className="settings-nav-label">{label}</span>
                  <span className="settings-nav-summary">{sectionSummaries[id]}</span>
                </button>
              )
            })}
          </nav>
          <div className="settings-body">
            {/* 外观：主题三选（迁自 About）+ 终端跟随开关（默认关——ANSI 彩色浅底不可读）
                + 界面语言（v1.2.0 中英切换，即时生效并同步 main 侧托盘/退出文案） */}
                        {activeSection === 'general' && (
              <div className="dialog-section">
                {/* v1.4「通用」= 外观+终端+通知+启动 合并（左栏收敛 4 分类）；单一 110px 行栅格 */}
                <p className="form-subtitle">{t('settings.sectionAppearance')}</p>
                <div className="settings-form">
                  <div className="form-row">
                    <span className="form-label">{t('settings.themeAria')}</span>
                    <div className="form-control theme-choice" role="radiogroup" aria-label={t('settings.themeAria')}>
                      {themeChoices.map((c) => (
                        <label key={c.value}>
                          <input
                            type="radio"
                            name="ui-theme"
                            checked={theme === c.value}
                            onChange={() => setTheme(c.value)}
                          />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="form-row">
                    <span className="form-label">{t('settings.language')}</span>
                    <div className="form-control">
                      <select
                        className="settings-select val"
                        aria-label={t('settings.language')}
                        value={language}
                        onChange={(e) => setLanguage(e.target.value as Language)}
                      >
                        {(Object.keys(LANGUAGE_LABELS) as Language[]).map((lang) => (
                          <option key={lang} value={lang}>
                            {LANGUAGE_LABELS[lang]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <span className="form-label">{t('settings.termFollow')}</span>
                    <div className="form-control">
                      <input
                        type="checkbox"
                        aria-label={t('settings.termFollow')}
                        checked={termFollowsTheme}
                        onChange={(e) => setTermFollowsTheme(e.target.checked)}
                      />
                      <span className="hint-inline">{t('settings.termFollowHint')}</span>
                    </div>
                  </div>
                </div>

                <p className="form-subtitle">{t('settings.sectionTerminal')}</p>
                <div className="settings-form">
                  <div className="form-row">
                    <span className="form-label">{t('settings.fontAria')}</span>
                    <div className="form-control">
                      <select
                        className="settings-select val"
                        aria-label={t('settings.fontAria')}
                        value={fontFamily}
                        onChange={(e) => {
                          const applied = changeFontFamily(e.target.value)
                          setFontFamily(applied)
                        }}
                      >
                        {/* v0.9.4（用户指令：不显示本机不支持的字体）：仅显示已装——
                            白名单∩已装 + 本机检测到的其余等宽字体；扫描失败回退白名单全集 */}
                        {(() => {
                          const fontOptions =
                            installedFonts.length > 0
                              ? installedFonts
                              : (FONT_FAMILY_WHITELIST as readonly string[])
                          return fontOptions.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))
                        })()}
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <span className="form-label">{t('settings.fontSizeAria')}</span>
                    <div className="form-control">
                      <input
                        className="settings-num"
                        type="number"
                        aria-label={t('settings.fontSizeAria')}
                        min={FONT_SIZE_MIN}
                        max={FONT_SIZE_MAX}
                        step={1}
                        value={fontSizeInput}
                        onChange={(e) => applyFontSize(e.target.value)}
                      />
                      <span className="hint-inline">
                        {t('settings.fontSizeHint', { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
                      </span>
                    </div>
                  </div>
                </div>

                <p className="form-subtitle">{t('settings.notifyTitle')}</p>
                {/* 通知区：现有代码原样搬入（用户确认——交互/label/测试锚点不动） */}
                <div className="notify-legacy">
                <div className="notify-row">
                  <input
                    className="notify-url"
                    type="text"
                    placeholder={t('settings.notifyPlaceholder')}
                    aria-label="webhook URL"
                    value={notifyUrl}
                    onChange={(e) => {
                      setNotifyUrl(e.target.value)
                      setNotifyMsg('')
                    }}
                  />
                  <label className="dialog-check">
                    <input
                      type="checkbox"
                      checked={notifyEnabled}
                      onChange={(e) => {
                        setNotifyEnabled(e.target.checked)
                        setNotifyMsg('')
                      }}
                    />
                    {t('common.enable')}
                  </label>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn" onClick={() => void saveNotify()}>
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={notifyUrl.trim() === ''}
                    title={notifyUrl.trim() === '' ? t('settings.notifyNeedUrl') : undefined}
                    onClick={() => void sendTest()}
                  >
                    {t('settings.notifyTest')}
                  </button>
                </div>
                {notifyMsg !== '' && (
                  <p className="muted" role="status">
                    {notifyMsg}
                  </p>
                )}
                {notifyTest !== null && (
                  <p className={notifyTest.ok ? 'muted ok' : 'inline-error'} role="status">
                    {notifyTest.ok
                      ? t('settings.notifyTestOk')
                      : t('settings.notifyTestFailed', {
                          error: notifyTest.error ?? t('settings.notifyUnknownError')
                        })}
                  </p>
                )}
                <p className="hint-small">{t('settings.notifyHint')}</p>
              
                </div>

                <p className="form-subtitle">{t('settings.startupTitle')}</p>
                <div className="settings-form">
                  <div className="form-row">
                    <span className="form-label">{t('settings.closeBehaviorLabel')}</span>
                    <div className="form-control theme-choice" role="radiogroup" aria-label={t('settings.closeBehaviorAria')}>
                  <label>
                    <input
                      type="radio"
                      name="close-behavior"
                      checked={closeToTray}
                      onChange={() => {
                        setCloseToTray(true)
                        void window.cwb.setAppSettings({ closeToTray: true })
                      }}
                    />
                    {t('settings.closeToTray')}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="close-behavior"
                      checked={!closeToTray}
                      onChange={() => {
                        setCloseToTray(false)
                        void window.cwb.setAppSettings({ closeToTray: false })
                      }}
                    />
                    {t('settings.quitApp')}
                  </label>
                    </div>
                  </div>
                  <div className="form-row">
                    <span className="form-label">{t('settings.launchAtLogin')}</span>
                    <div className="form-control">
<input
                    type="checkbox"
                    aria-label={t('settings.launchAtLogin')}
                    checked={launchAtLogin}
                    onChange={(e) => {
                      setLaunchAtLogin(e.target.checked)
                      void window.cwb.setAppSettings({ launchAtLogin: e.target.checked })
                    }}
                  />
                      <span className="hint-inline">{t('settings.startupHint')}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* v1.4 模型服务：provider 档案列表 + 新增/编辑表单 + 默认切换（参考 cc-switch） */}
            {activeSection === 'providers' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.providerTitle')}</p>

                {/* v1.4 本地代理状态卡（参考 cc-switch 形态；纯隧道——协议由 CLI/网关承担） */}
                <div className={proxyStatus?.running === true ? 'proxy-card' : 'proxy-card off'}>
                  <span className="proxy-dot" />
                  <div className="proxy-info">
                    <b>{t('settings.proxyName')}</b>
                    <span className="proxy-meta">
                      {proxyStatus === null
                        ? t('common.detecting')
                        : proxyStatus.running
                          ? `127.0.0.1:${proxyStatus.port ?? ''} · ${proxyRunFor()}`
                          : t('settings.proxyStopped')}
                    </span>
                    <span className="proxy-meta soft">{t('settings.proxyRouteHint')}</span>
                  </div>
                  {proxyStatus?.running === true && (
                    <span className="proxy-stats">
                      {t('settings.proxyRequests', { n: proxyStatus.stats.total })}
                      {' · '}
                      {t('settings.proxyActive', { n: proxyStatus.stats.active })}
                      <br />
                      {t('settings.proxySplit', {
                        d: proxyStatus.stats.direct,
                        v: proxyStatus.stats.viaProxy
                      })}
                    </span>
                  )}
                  <button
                    type="button"
                    className={proxyStatus?.running === true ? 'btn' : 'btn primary'}
                    onClick={() => void toggleProxy()}
                  >
                    {proxyStatus?.running === true
                      ? t('settings.proxyStopBtn')
                      : t('settings.proxyStartBtn')}
                  </button>
                </div>
                <div className="settings-form" style={{ marginBottom: 14 }}>
                  <div className="form-row">
                    <span className="form-label">{t('settings.proxyAutoStartLabel')}</span>
                    <div className="form-control">
                      <input
                        type="checkbox"
                        aria-label={t('settings.proxyAutoStartLabel')}
                        checked={proxyAutoStart}
                        onChange={(e) => toggleProxyAutoStart(e.target.checked)}
                      />
                      <span className="hint-inline">{t('settings.proxyAutoStartHint')}</span>
                    </div>
                  </div>
                </div>
                {proxyError !== '' && <p className="inline-error">{proxyError}</p>}

                <p className="hint-small">{t('settings.providerHint')}</p>

                {/* v1.4 布局：浏览=单列列表；编辑=双栏（左 rail 切换目标 / 右编辑器独立滚动）
                    ——表单不再叠在列表下方，消除长滚动（参考 cc-switch 主从布局） */}
                {providerForm === null ? (
                  <>
                {providerState.providers.length === 0 && (
                  <p className="muted">{t('settings.providerEmpty')}</p>
                )}
                {providerState.providers.length > 0 && (
                  <ul className="provider-list">
                    {providerState.providers.map((p) => (
                      <li key={p.id} className="provider-row">
                        <span className={`provider-fmt ${p.format}`}>
                          {p.format === 'anthropic'
                            ? t('settings.providerFmtAnthropic')
                            : t('settings.providerFmtOpenai')}
                        </span>
                        <span className="provider-name">
                          {p.name}
                          {p.id === providerState.defaultProviderId && (
                            <span className="provider-default-tag">
                              {t('settings.providerDefaultTag')}
                            </span>
                          )}
                        </span>
                        <span className="provider-url" title={p.baseUrl}>
                          {p.baseUrl}
                        </span>
                        <span className="provider-actions">
                          {p.id !== providerState.defaultProviderId && (
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => void makeProviderDefault(p.id)}
                            >
                              {t('settings.providerSetDefault')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => startEditProvider(p)}
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            title={t('settings.providerJsonHint')}
                            onClick={() => openProviderJson(p)}
                          >
                            {t('settings.providerJsonTab')}
                          </button>
                          <button
                            type="button"
                            className="btn small danger"
                            onClick={() => void removeProviderRow(p)}
                          >
                            {t('common.remove')}
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="dialog-actions">
                  <button type="button" className="btn" onClick={startAddProvider}>
                    {t('settings.providerAdd')}
                  </button>
                </div>
                {providerMsg !== '' && (
                  <p className="muted ok" role="status">
                    {providerMsg}
                  </p>
                )}
                {providerError !== '' && <p className="inline-error">{providerError}</p>}
                  </>
                ) : (
                  <div className="providers-layout">
                    <div className="providers-rail">
                      <button
                        type="button"
                        className={`providers-rail-item add${providerForm.id === '' ? ' on' : ''}`}
                        onClick={startAddProvider}
                      >
                        ＋ {t('settings.providerAdd')}
                      </button>
                      {providerState.providers.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`providers-rail-item${providerForm.id === p.id ? ' on' : ''}`}
                          title={p.baseUrl}
                          onClick={() => startEditProvider(p)}
                        >
                          <span className={`provider-fmt ${p.format}`}>
                            {p.format === 'anthropic'
                              ? t('settings.providerFmtAnthropic')
                              : t('settings.providerFmtOpenai')}
                          </span>
                          <span className="rail-name">{p.name}</span>
                          {p.id === providerState.defaultProviderId && (
                            <span className="rail-default" title={t('settings.providerDefaultTag')}>
                              ●
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="providers-main">
                {/* 编辑器（providerForm 非 null；表单/JSON 双模式——JSON 直改保存，校验与表单同链） */}
                  <div className="provider-form" role="form" aria-label={t('settings.providerTitle')}>
                    <p className="section-title">
                      {providerForm.id === ''
                        ? t('settings.providerAddTitle')
                        : t('settings.providerEditTitle')}
                    </p>
                    <div className="form-mode-toggle" role="tablist">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={providerFormMode === 'form'}
                        className={providerFormMode === 'form' ? 'on' : ''}
                        onClick={() => switchProviderFormMode('form')}
                      >
                        {t('settings.providerFormTab')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={providerFormMode === 'json'}
                        className={providerFormMode === 'json' ? 'on' : ''}
                        onClick={() => switchProviderFormMode('json')}
                      >
                        {t('settings.providerJsonTab')}
                      </button>
                    </div>
                    {providerFormMode === 'json' && (
                      <p className="hint-small">{t('settings.providerJsonHint')}</p>
                    )}
                    {providerFormMode === 'form' && (
                      <div className="settings-form">
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerName')}</span>
                      <div className="form-control">
                        <input
                          className="settings-input grow"
                          type="text"
                          aria-label={t('settings.providerName')}
                          placeholder={t('settings.providerNamePlaceholder')}
                          value={providerForm.name}
                          onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerFormat')}</span>
                      <div className="form-control">
                        <select
                          className="settings-select val"
                          aria-label={t('settings.providerFormat')}
                          value={providerForm.format}
                          onChange={(e) =>
                            setProviderForm({
                              ...providerForm,
                              format: e.target.value === 'openai' ? 'openai' : 'anthropic'
                            })
                          }
                        >
                          <option value="anthropic">{t('settings.providerFmtAnthropic')}</option>
                          <option value="openai">{t('settings.providerFmtOpenai')}</option>
                        </select>
                      </div>
                    </div>
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerBaseUrl')}</span>
                      <div className="form-control">
                        <input
                          className="settings-input grow mono"
                          type="text"
                          aria-label={t('settings.providerBaseUrl')}
                          placeholder={t('settings.providerBaseUrlPlaceholder')}
                          value={providerForm.baseUrl}
                          onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerApiKey')}</span>
                      <div className="form-control">
                        <input
                          className="settings-input grow mono"
                          type="password"
                          autoComplete="off"
                          aria-label={t('settings.providerApiKey')}
                          value={providerForm.apiKey}
                          onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerApiKeyType')}</span>
                      <div className="form-control">
                        <select
                          className="settings-select val"
                          aria-label={t('settings.providerApiKeyType')}
                          value={providerForm.apiKeyType}
                          onChange={(e) =>
                            setProviderForm({
                              ...providerForm,
                              apiKeyType: e.target.value === 'api_key' ? 'api_key' : 'auth_token'
                            })
                          }
                        >
                          <option value="auth_token">{t('settings.providerApiKeyTypeToken')}</option>
                          <option value="api_key">{t('settings.providerApiKeyTypeKey')}</option>
                        </select>
                      </div>
                    </div>
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerModels')}</span>
                      <div className="form-control">
                        {/* v1.4.1 单行一模型：每行 = 模型名 + 1M 上下文声明勾选 + 移除；defaultModel 跟随清空 */}
                        {providerForm.modelRows.map((row, i) => (
                          <div className="model-row" key={i}>
                            <input
                              className="settings-input grow mono"
                              type="text"
                              aria-label={t('settings.providerModelName')}
                              placeholder={t('settings.providerModelsPlaceholder')}
                              value={row.name}
                              onChange={(e) => {
                                const name = e.target.value
                                const modelRows = providerForm.modelRows.map((r, j) =>
                                  j === i ? { ...r, name } : r
                                )
                                // defaultModel 跟随：当前值不在新列表时清空，避免悬空选择
                                const names = modelRows
                                  .map((r) => r.name.trim())
                                  .filter((x) => x !== '')
                                if (
                                  providerForm.defaultModel !== '' &&
                                  !names.includes(providerForm.defaultModel)
                                ) {
                                  setProviderForm({ ...providerForm, modelRows, defaultModel: '' })
                                  return
                                }
                                setProviderForm({ ...providerForm, modelRows })
                              }}
                            />
                            <label className="model-1m" title={t('settings.providerModel1MHint')}>
                              <input
                                type="checkbox"
                                checked={row.oneM}
                                onChange={(e) => {
                                  const oneM = e.target.checked
                                  setProviderForm({
                                    ...providerForm,
                                    modelRows: providerForm.modelRows.map((r, j) =>
                                      j === i ? { ...r, oneM } : r
                                    )
                                  })
                                }}
                              />
                              {t('settings.providerModel1M')}
                            </label>
                            <button
                              type="button"
                              className="btn small"
                              aria-label={t('settings.providerModelRemove')}
                              onClick={() => {
                                const modelRows = providerForm.modelRows.filter((_, j) => j !== i)
                                const names = modelRows
                                  .map((r) => r.name.trim())
                                  .filter((x) => x !== '')
                                if (
                                  providerForm.defaultModel !== '' &&
                                  !names.includes(providerForm.defaultModel)
                                ) {
                                  setProviderForm({ ...providerForm, modelRows, defaultModel: '' })
                                  return
                                }
                                setProviderForm({ ...providerForm, modelRows })
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <div className="model-row-actions">
                          <button
                            type="button"
                            className="btn small"
                            onClick={() =>
                              setProviderForm({
                                ...providerForm,
                                modelRows: [...providerForm.modelRows, { name: '', oneM: false }]
                              })
                            }
                          >
                            {t('settings.providerModelAdd')}
                          </button>
                          {/* v1.4 探测：GET {baseUrl}/v1/models（官方端点经代理出口）；须先保存 */}
                          <button
                            type="button"
                            className="btn small"
                            disabled={providerProbing || providerForm.id === ''}
                            title={
                              providerForm.id === ''
                                ? t('settings.providerProbeNeedSave')
                                : undefined
                            }
                            onClick={() => void probeModels()}
                          >
                            {providerProbing ? t('common.detecting') : t('settings.providerProbe')}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="form-row">
                      <span className="form-label">{t('settings.providerDefaultModel')}</span>
                      <div className="form-control">
                        <select
                          className="settings-select val"
                          aria-label={t('settings.providerDefaultModel')}
                          value={providerForm.defaultModel}
                          onChange={(e) =>
                            setProviderForm({ ...providerForm, defaultModel: e.target.value })
                          }
                        >
                          <option value="">{t('settings.providerDefaultModelNone')}</option>
                          {modelSelectOptions(providerForm.modelRows).map((o) => (
                            <option key={o.name} value={o.name}>
                              {o.name}
                              {o.oneM ? t('settings.providerModel1MTag') : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* v1.4 Anthropic 专属组常驻置灰（切换格式零跳动；配置保留不丢） */}
                    <div
                      className={
                        providerForm.format === 'anthropic' ? 'fmt-block' : 'fmt-block disabled'
                      }
                      aria-disabled={providerForm.format !== 'anthropic'}
                    >
                      <p className="form-subtitle">{t('settings.providerSlotTitle')}</p>
                      <div className="settings-form">
                        <div className="form-row">
                          <span className="form-label">　</span>
                          <div className="form-control slots">
                            {/* v1.4.1 档位=从预设模型行下拉选择（含 1M 标注；不在列表的旧值兜底保留） */}
                            <div className="slot">
                              <span>Sonnet</span>
                              <select
                                aria-label={t('settings.providerSlotSonnet')}
                                value={providerForm.slotSonnet}
                                onChange={(e) =>
                                  setProviderForm({ ...providerForm, slotSonnet: e.target.value })
                                }
                              >
                                <option value="">{t('settings.providerSlotNone')}</option>
                                {slotSelectOptions(providerForm.modelRows, providerForm.slotSonnet).map(
                                  (o) => (
                                    <option key={o.name} value={o.name}>
                                      {o.name}
                                      {o.oneM ? t('settings.providerModel1MTag') : ''}
                                    </option>
                                  )
                                )}
                              </select>
                            </div>
                            <div className="slot">
                              <span>Opus</span>
                              <select
                                aria-label={t('settings.providerSlotOpus')}
                                value={providerForm.slotOpus}
                                onChange={(e) =>
                                  setProviderForm({ ...providerForm, slotOpus: e.target.value })
                                }
                              >
                                <option value="">{t('settings.providerSlotNone')}</option>
                                {slotSelectOptions(providerForm.modelRows, providerForm.slotOpus).map(
                                  (o) => (
                                    <option key={o.name} value={o.name}>
                                      {o.name}
                                      {o.oneM ? t('settings.providerModel1MTag') : ''}
                                    </option>
                                  )
                                )}
                              </select>
                            </div>
                            <div className="slot">
                              <span>Fable</span>
                              <select
                                aria-label={t('settings.providerSlotFable')}
                                value={providerForm.slotFable}
                                onChange={(e) =>
                                  setProviderForm({ ...providerForm, slotFable: e.target.value })
                                }
                              >
                                <option value="">{t('settings.providerSlotNone')}</option>
                                {slotSelectOptions(providerForm.modelRows, providerForm.slotFable).map(
                                  (o) => (
                                    <option key={o.name} value={o.name}>
                                      {o.name}
                                      {o.oneM ? t('settings.providerModel1MTag') : ''}
                                    </option>
                                  )
                                )}
                              </select>
                            </div>
                            <div className="slot">
                              <span>Haiku</span>
                              <select
                                aria-label={t('settings.providerSlotHaiku')}
                                value={providerForm.slotHaiku}
                                onChange={(e) =>
                                  setProviderForm({ ...providerForm, slotHaiku: e.target.value })
                                }
                              >
                                <option value="">{t('settings.providerSlotNone')}</option>
                                {slotSelectOptions(providerForm.modelRows, providerForm.slotHaiku).map(
                                  (o) => (
                                    <option key={o.name} value={o.name}>
                                      {o.name}
                                      {o.oneM ? t('settings.providerModel1MTag') : ''}
                                    </option>
                                  )
                                )}
                              </select>
                            </div>
                          </div>
                        </div>
                      </div>
                      <p className="form-subtitle">{t('settings.providerNetTitle')}</p>
                      <div className="settings-form">
                        <div className="form-row">
                          <span className="form-label">{t('settings.providerProxy')}</span>
                          <div className="form-control">
                            <input
                              className="settings-input grow mono"
                              type="text"
                              aria-label={t('settings.providerProxy')}
                              placeholder={t('settings.providerProxyPlaceholder')}
                              value={providerForm.proxyUrl}
                              onChange={(e) =>
                                setProviderForm({ ...providerForm, proxyUrl: e.target.value })
                              }
                            />
                          </div>
                        </div>
                        <div className="form-row">
                          <span className="form-label">　</span>
                          <div className="form-control">
                            <span className="hint-inline wrap">{t('settings.providerProxyHint')}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    {providerForm.format === 'openai' && (
                      <p className="hint-small">{t('settings.providerOpenaiNote')}</p>
                    )}
                      </div>
                    )}

                    {providerFormMode === 'json' && (
                      <textarea
                        className="provider-json-input"
                        aria-label={t('settings.providerJsonTab')}
                        spellCheck={false}
                        value={providerJsonText}
                        onChange={(e) => {
                          setProviderJsonText(e.target.value)
                          setProviderError('')
                        }}
                      />
                    )}
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="btn primary"
                        disabled={
                          providerFormMode === 'json'
                            ? providerJsonText.trim() === ''
                            : providerForm.name.trim() === '' || providerForm.baseUrl.trim() === ''
                        }
                        onClick={() => void saveProviderForm()}
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setProviderForm(null)
                          setProviderFormMode('form')
                          setProviderError('')
                        }}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                    {providerMsg !== '' && (
                      <p className="muted ok" role="status">
                        {providerMsg}
                      </p>
                    )}
                    {providerError !== '' && <p className="inline-error">{providerError}</p>}
                  </div>
                    </div>
                  </div>
                )}
                <p className="hint-small">{t('settings.providerSecretHint')}</p>
              </div>
            )}

            {/* claude CLI：版本/路径/更新/安装（迁自 About） */}
            {activeSection === 'cli' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.sectionCli')}</p>
                {cliInfo === null && cliError === '' && <p className="muted">{t('common.detecting')}</p>}
                {cliError !== '' && <p className="inline-error">{cliError}</p>}
                {installed && (
                  <>
                    <div className="kv">{t('settings.cliVersion', { version: cliInfo.version })}</div>
                    <div className="kv path" title={cliInfo.path}>
                      {t('settings.cliPath', { path: cliInfo.path })}
                    </div>
                  </>
                )}
                {cliInfo !== null && !installed && (
                  <>
                    <div className="kv warn">{t('settings.cliNotInstalled')}</div>
                    {/* 5.1 下载安装区：方式选择 + 二次确认 + 固定模板契约法 */}
                    <div className="install-methods" role="radiogroup" aria-label={t('settings.installMethodsAria')}>
                      <label>
                        <input
                          type="radio"
                          name="install-method"
                          checked={installMethod === 'native'}
                          onChange={() => setInstallMethod('native')}
                        />
                        {t('settings.installNative')}
                      </label>
                      <label title={npmInstallDisabled ? t('settings.installNpmNoNode') : undefined}>
                        <input
                          type="radio"
                          name="install-method"
                          checked={installMethod === 'npm'}
                          disabled={npmInstallDisabled}
                          onChange={() => setInstallMethod('npm')}
                        />
                        {t('settings.installNpm')}
                      </label>
                    </div>
                    <div className="dialog-actions">
                      <button type="button" className="btn primary" onClick={() => void runInstall()}>
                        {t('settings.install')}
                      </button>
                      <a className="btn" href={CLAUDE_DOCS_URL} target="_blank" rel="noreferrer">
                        {t('settings.installDocs')}
                      </a>
                    </div>
                    {installError !== '' && <p className="inline-error">{installError}</p>}
                  </>
                )}
                {installed && (
                  <>
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={checking}
                        onClick={() => void checkUpdate()}
                      >
                        {checking ? t('common.detecting') : t('settings.checkUpdate')}
                      </button>
                      {updateInfo !== null && !updateInfo.upToDate && (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={commandId !== null || starting}
                          onClick={() => void runUpdate()}
                        >
                          {starting
                            ? t('settings.starting')
                            : commandId !== null
                              ? t('settings.updating')
                              : t('settings.update')}
                        </button>
                      )}
                    </div>
                    {updateInfo !== null &&
                      (updateInfo.degraded === true ? (
                        <p className="muted">{t('settings.cliDegraded')}</p>
                      ) : (
                        <p className="muted">
                          {t('settings.cliVersionLine', {
                            current: updateInfo.current,
                            latest: updateInfo.latest,
                            state: updateInfo.upToDate
                              ? t('settings.cliUpToDate')
                              : t('settings.cliUpdatable')
                          })}
                        </p>
                      ))}
                    {updateError !== '' && <p className="inline-error">{updateError}</p>}
                    {/* v1.1.0 claude CLI 更新说明（版本对比成功后自动拉取，与「应用更新」同款展示） */}
                    {cliNotes !== null && cliNotes.notes.length > 0 && (
                      <div className="upd-notes">
                        {cliNotes.notes.map((n) => (
                          <div key={n.version} className="upd-notes-ver">
                            <p className="upd-notes-title">v{n.version}</p>
                            <ul>
                              {n.items.map((it, i) => (
                                <li key={i}>{it}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                    {cliNotes !== null && cliNotes.notes.length === 0 && cliNotes.error === undefined && (
                      <p className="muted">{t('settings.notesNone')}</p>
                    )}
                    {cliNotes?.error !== undefined && (
                      <p className="muted">{t('settings.notesFailed', { error: cliNotes.error })}</p>
                    )}
                  </>
                )}
                {/* 更新/安装执行输出（轻量只读区，非完整 xterm） */}
                <CliOutputView
                  commandId={commandId}
                  onExit={() => {
                    // 完成后刷新版本信息（安装/更新都会改变 CLI 版本；spec T9 对应动作）
                    void refreshCliInfo()
                  }}
                />
              </div>
            )}

            {/* 关于（v1.2.1 并入设置；v1.2.2 再把「应用更新」并进来）：应用身份在上
                （纯静态只读），更新检测/升级链路在下——同属"这个应用本身"的信息与操作 */}
            {activeSection === 'about' && (
              <div className="dialog-section">
                <p className="section-title">{t('settings.sectionAbout')}</p>
                <div className="kv about-app-name">Claude Workbench</div>
                <div className="kv">
                  {t('about.version', { version: APP_VERSION })}
                  {BUILD_DATE !== '' && t('about.build', { date: BUILD_DATE })}
                </div>
                <div className="kv">
                  {t('about.license')}{' '}
                  <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noreferrer">
                    MIT
                  </a>
                  {t('about.licenseTail')}
                </div>
                <div className="kv">{t('about.author')}</div>

                <p className="section-title about-update-title">{t('settings.appUpdateTitle')}</p>
                {/* v1.2.1 自动升级开关（缺省开）：无需点按钮——下载就绪且无运行任务即自动重启升级 */}
                <label className="dialog-check">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(e) => {
                      setAutoUpdate(e.target.checked)
                      void window.cwb.setAppSettings({ autoUpdate: e.target.checked })
                    }}
                  />
                  {t('settings.autoUpdate')}
                </label>
                <p className="hint-small">{t('settings.autoUpdateHint')}</p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={appUpdChecking}
                    onClick={() => void checkAppUpd()}
                  >
                    {appUpdChecking ? t('common.detecting') : t('settings.checkUpdate')}
                  </button>
                  {/* v1.3：平台不支持自动升级（linux）时不显示下载/升级按钮，改手动更新指引 */}
                  {appUpd?.platformSupported === false && (
                    <p className="muted" role="note">
                      {t('appUpd.manualUpdateHint')}
                    </p>
                  )}
                  {appUpd !== null && !appUpd.upToDate && !appUpdReady && appUpd.platformSupported !== false && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={
                        appUpdProgress?.phase === 'downloading' || appUpdProgress?.phase === 'verifying'
                      }
                      onClick={() => void downloadAppUpd()}
                    >
                      {appUpdProgress?.phase === 'downloading'
                        ? t('settings.appDownloading', { percent: appUpdProgress.percent })
                        : appUpdProgress?.phase === 'verifying'
                          ? t('settings.appVerifying')
                          : t('settings.appDownload')}
                    </button>
                  )}
                  {appUpdReady && (
                    <button type="button" className="btn primary" onClick={() => void installAppUpd()}>
                      {t('settings.appInstallNow')}
                    </button>
                  )}
                </div>
                {/* 自动升级进行中状态：等待任务结束 / 正在退出升级 */}
                {appUpdProgress?.phase === 'waiting-tasks' && (
                  <p className="muted" role="status">
                    {t('settings.appWaitingTasks', { count: appUpdProgress.count })}
                  </p>
                )}
                {appUpdProgress?.phase === 'installing' && (
                  <p className="muted" role="status">
                    {t('settings.appAutoInstalling')}
                  </p>
                )}
                {appUpd !== null && (
                  <p className="muted">
                    {t('settings.appUpdateLine', {
                      current: appUpd.current,
                      latest: appUpd.latest,
                      state: appUpd.upToDate
                        ? t('settings.cliUpToDate')
                        : t('settings.cliUpdatable')
                    })}
                    {appUpd.manifestError !== undefined &&
                      t('settings.appManifestError', { error: appUpd.manifestError })}
                  </p>
                )}
                {appUpdProgress?.phase === 'downloading' && (
                  <progress className="upd-progress" max={100} value={appUpdProgress.percent} />
                )}
                {appUpd !== null && appUpd.notes.length > 0 && (
                  <div className="upd-notes">
                    {appUpd.notes.map((n) => (
                      <div key={n.version} className="upd-notes-ver">
                        <p className="upd-notes-title">v{n.version}</p>
                        <ul>
                          {n.items.map((it, i) => (
                            <li key={i}>{it}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
                {appUpd !== null && appUpd.notesError !== undefined && (
                  <p className="muted">{t('settings.notesFailed', { error: appUpd.notesError })}</p>
                )}
                {appUpdError !== '' && <p className="inline-error">{appUpdError}</p>}
                <p className="hint-small">{t('settings.appUpdateHint', { version: APP_VERSION })}</p>
              </div>
            )}

          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
