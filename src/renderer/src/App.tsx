import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  Activity,
  AppWindow,
  ArrowRight,
  BadgeDollarSign,
  Bell,
  Bot,
  Box,
  BookOpen,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleStop,
  CloudDownload,
  Code2,
  Copy,
  Download,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  FileClock,
  Flame,
  Folder,
  FolderCog,
  Gauge,
  Gamepad2,
  Github,
  Globe2,
  HardDriveDownload,
  Heart,
  Home,
  Images,
  Info,
  KeyRound,
  Library,
  ListPlus,
  LoaderCircle,
  LogOut,
  Maximize2,
  Menu,
  MessageCircle,
  MessageSquareText,
  Minus,
  Moon,
  Package,
  PackageCheck,
  Palette,
  PawPrint,
  PanelTopOpen,
  Pin,
  Play,
  Plus,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  SquareTerminal,
  Sun,
  Trash2,
  TrendingUp,
  Upload,
  WalletCards,
  Wrench,
  Workflow,
  X
} from 'lucide-react'
import type {
  EnvironmentItem,
  LauncherSettings,
  LauncherSnapshot,
  LauncherGameItem,
  LauncherNewsDetail,
  LauncherNewsItem,
  LauncherResourceItem,
  LauncherResourceEngagement,
  ModelProviderDraft,
  ModelProviderTemplate,
  MultimodalTestRequest,
  MultimodalTestResult,
  PageId,
  PetSpecies,
  PetStyle,
  SkinMediaKind,
  SkinStyle,
  SourceHealth
} from '../../shared/types'
import { mockSnapshot } from './mock'
import deepseekLogo from './assets/deepseek-logo.svg'

const navigation: Array<{ label: string; items: Array<{ id: PageId; label: string; icon: typeof Home }> }> = [
  { label: '运行', items: [{ id: 'home', label: '首页', icon: Home }] },
  { label: '能力库', items: [
    { id: 'prompts', label: '提示词', icon: MessageSquareText },
    { id: 'skills', label: 'Skill', icon: Sparkles },
    { id: 'workflows', label: '工作流', icon: Workflow },
    { id: 'knowledge', label: '知识库', icon: Database },
    { id: 'tools', label: 'AI 工具', icon: Wrench },
    { id: 'agents', label: '智能体', icon: Bot },
    { id: 'library', label: '安装列表', icon: PackageCheck },
    { id: 'models', label: '模型连接', icon: Library }
  ] },
  { label: '发现', items: [{ id: 'news', label: 'AI 新闻', icon: Bell }, { id: 'games', label: 'AI 游戏', icon: Gamepad2 }, { id: 'careers', label: '职场进化', icon: BriefcaseBusiness }] },
  { label: '个性化', items: [{ id: 'skins', label: '皮肤商店', icon: Palette }, { id: 'pets', label: '宠物商店', icon: PawPrint }] },
  { label: '管理', items: [{ id: 'versions', label: '版本管理', icon: Box }, { id: 'workspaces', label: '工作区', icon: Folder }, { id: 'diagnostics', label: '日志诊断', icon: SquareTerminal }, { id: 'settings', label: '设置', icon: Settings }] }
]

const pageTitles: Record<PageId, { title: string; subtitle: string }> = {
  home: { title: 'DeepSeek Harness', subtitle: '深蓝启动器 · DeepSeek Harness 驾驭工程教学' },
  skins: { title: '皮肤商店', subtitle: '免费、开源、按页加载；原媒体仅在应用时下载。' },
  pets: { title: '宠物商店', subtitle: '选择会互动的网页伙伴，也可以导入自己的宠物。' },
  versions: { title: '版本管理', subtitle: '每个版本独立安装，切换前保留用户数据备份。' },
  prompts: { title: '提示词', subtitle: '同步 AI历史书精选提示词；复制、收藏或加入 DSH 能力库。' },
  skills: { title: 'Skill', subtitle: '读取完整 SKILL.md，审核后安装到 Harness 原生 Skill 目录。' },
  workflows: { title: '工作流', subtitle: '查看步骤与蓝图，加入安装列表后保存到本机能力库。' },
  knowledge: { title: '知识库', subtitle: '保存可信来源与结构化资料，供后续项目和智能体复用。' },
  tools: { title: 'AI 工具', subtitle: 'ChatGPT 等同类工具放在能力资源之后，按真实任务选择。' },
  agents: { title: '智能体', subtitle: '查看同类 Agent 的用途、限制、源码与真实评价。' },
  library: { title: '能力安装列表', subtitle: '集中确认待安装资源；Skill 原生安装，其他资料进入受控能力库。' },
  models: { title: '模型连接', subtitle: '连接主流平台或自定义接口；只有已添加的模型会进入全局切换器。' },
  news: { title: 'AI 新闻', subtitle: '免费浏览最新 10 条与热门排行；登录后继续在启动器内展开。' },
  games: { title: 'AI 游戏试玩', subtitle: '同步网站完整游戏与项目目录；本站作品可在启动器内登录试玩。' },
  careers: { title: '职场进化', subtitle: '直接读取网站 33 个职业及工作模块；只有长课程教学按需打开网页。' },
  workspaces: { title: '工作区', subtitle: '选择 Harness 启动目录，并快速返回最近项目。' },
  diagnostics: { title: '日志诊断', subtitle: '把环境、网络和进程问题说清楚，再提供可执行的修复动作。' },
  settings: { title: '设置', subtitle: '调整启动行为、更新通道与国内下载源。' }
}

const SKIN_STORE_REPOSITORY_URL = 'https://gitee.com/wanggp123/deepseek-harness-skins'
const PET_STORE_REPOSITORY_URL = 'https://gitee.com/wanggp123/deepseek-harness-pets'

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ')
}

function openExternal(url: string): void {
  if (window.launcher) void window.launcher.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

function BrandMark(): ReactNode {
  return (
    <span className="brand-mark" aria-hidden="true"><img src={deepseekLogo} alt="" /></span>
  )
}

function WindowControls(): ReactNode {
  if (!window.launcher) return <span className="preview-badge">界面预览</span>
  return (
    <div className="window-controls">
      <button aria-label="最小化" onClick={() => void window.launcher?.windowAction('minimize')}><Minus size={15} /></button>
      <button aria-label="最大化" onClick={() => void window.launcher?.windowAction('maximize')}><Maximize2 size={13} /></button>
      <button className="window-close" aria-label="关闭" onClick={() => void window.launcher?.windowAction('close')}><X size={15} /></button>
    </div>
  )
}

function StatusDot({ status }: { status: EnvironmentItem['status'] | SourceHealth['status'] }): ReactNode {
  return <span className={`status-dot status-${status}`} />
}

function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: string; action?: ReactNode }): ReactNode {
  return (
    <section className={classNames('card', className)}>
      {(title || action) && <div className="card-heading"><h2>{title}</h2>{action}</div>}
      {children}
    </section>
  )
}

function OpenSourceInvite({ name, url }: { name: string; url: string }): ReactNode {
  const displayUrl = url.replace(/^https:\/\//, '')
  return (
    <div className="store-open-source">
      <Code2 aria-hidden="true" />
      <div>
        <strong>开源地址</strong>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`打开${name}开源仓库：${displayUrl}`}
          onClick={(event) => {
            if (!window.launcher) return
            event.preventDefault()
            void window.launcher.openExternal(url)
          }}
        >
          {displayUrl}<ExternalLink aria-hidden="true" />
        </a>
        <span>欢迎所有人提交原创素材、完善目录和文档，一起共创免费商店。</span>
      </div>
    </div>
  )
}

function EnvironmentRows({ items }: { items: EnvironmentItem[] }): ReactNode {
  const itemIcons = { node: Code2, harness: Box, pnpm: Package, network: Globe2 }
  return (
    <div className="detail-list">
      {items.map((item) => {
        const Icon = itemIcons[item.id]
        return (
          <div className="detail-row" key={item.id}>
            <span className="row-icon"><Icon size={17} /></span>
            <span className="row-main"><strong>{item.label}</strong><small>{item.detail}</small></span>
            <span className="row-version">{item.version || (item.status === 'checking' ? '检查中' : '—')}</span>
            <span className="row-status"><StatusDot status={item.status} />{item.status === 'ready' ? '就绪' : item.status === 'missing' ? '缺失' : item.status === 'warning' ? '注意' : '检查中'}</span>
          </div>
        )
      })}
    </div>
  )
}

function SourceRows({ sources }: { sources: SourceHealth[] }): ReactNode {
  return (
    <div className="detail-list">
      {sources.map((source) => (
        <div className="detail-row source-row" key={source.id}>
          <span className={`source-logo source-${source.id}`}>{source.id === 'github' ? <Github size={16} /> : source.id === 'oss' ? <CloudDownload size={16} /> : source.name.slice(0, 1)}</span>
          <span className="row-main"><strong>{source.name}</strong><small>{source.enabled ? (source.baseUrl || '等待填写地址') : '尚未启用'}</small></span>
          <span className="row-status"><StatusDot status={source.status} />{source.status === 'available' ? '可用' : source.status === 'slow' ? '较慢' : source.status === 'checking' ? '检测中' : source.status === 'unconfigured' ? '待配置' : '不可用'}</span>
          <span className="latency">{source.latencyMs ? `${source.latencyMs}ms` : '—'}</span>
        </div>
      ))}
    </div>
  )
}

function compactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)} MB`
}

function modulePhaseLabel(phase: NonNullable<LauncherSnapshot['tasks'][number]['steps']>[number]['phase']): string {
  return phase === 'queued' ? '等待'
    : phase === 'source-check' ? '检测渠道'
      : phase === 'source-ready' ? '渠道可用'
        : phase === 'source-fallback' ? '切换渠道'
          : phase === 'download' ? '下载'
            : phase === 'verify' ? '校验'
              : phase === 'extract' ? '解压'
                : phase === 'probe' ? '运行检测'
                  : phase === 'activate' ? '启用'
                    : '完成'
}

function moduleSourceLabel(source?: string): string {
  return source === 'github' ? 'GitHub' : source === 'gitee' ? 'Gitee' : source === 'oss' ? 'OSS' : ''
}

function Tasks({ snapshot }: { snapshot: LauncherSnapshot }): ReactNode {
  if (!snapshot.tasks.length) return <EmptyState icon={<FileClock />} title="还没有任务" text="安装、更新和修复进度会显示在这里。" />
  return (
    <div className="task-list">
      {snapshot.tasks.slice(0, 4).map((task) => (
        <div className={classNames('task-item', !!task.steps?.length && 'task-item-detailed')} key={task.id}>
          <span className={classNames('task-symbol', task.status)}>{task.status === 'running' ? <LoaderCircle className="spin" size={18} /> : task.status === 'failed' ? <CircleAlert size={18} /> : <Check size={18} />}</span>
          <div className="task-copy">
            <div><strong>{task.title}</strong><span>{task.detail}</span></div>
            <div className="progress-track" role="progressbar" aria-label={`${task.title} 总进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}><span style={{ width: `${task.progress}%` }} /></div>
            {!!task.totalBytes && <div className="task-total"><span>总加载进度</span><strong>{compactBytes(task.receivedBytes || 0)} / {compactBytes(task.totalBytes)}</strong></div>}
            {!!task.steps?.length && <div className="task-step-list" aria-label="模块加载明细">
              {task.steps.map((step) => <div className={classNames('task-step', `is-${step.status}`)} key={step.id}>
                <div className="task-step-heading"><strong>{step.label}</strong><span>{moduleSourceLabel(step.source)}{step.source ? ' · ' : ''}{modulePhaseLabel(step.phase)}</span><b>{step.progress}%</b></div>
                <div className="task-step-track" role="progressbar" aria-label={`${step.label}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.progress}><span style={{ width: `${step.progress}%` }} /></div>
                <small>{compactBytes(step.receivedBytes)} / {compactBytes(step.totalBytes)}{step.message ? ` · ${step.message}` : ''}</small>
              </div>)}
            </div>}
          </div>
          <strong className="task-percent">{task.progress}%</strong>
        </div>
      ))}
    </div>
  )
}

function Logs({ snapshot, expanded = false }: { snapshot: LauncherSnapshot; expanded?: boolean }): ReactNode {
  return (
    <div className={classNames('terminal', expanded && 'terminal-expanded')} role="log" aria-live="polite">
      {snapshot.logs.slice(expanded ? -120 : -8).map((line) => (
        <div className={`terminal-line log-${line.level.toLowerCase()}`} key={line.id}>
          <time>{line.time}</time><span>{line.level}</span><p>{line.message}</p>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }): ReactNode {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>
}

function HomePage({ snapshot, busy, onStart, onStop, onRepair, onWorkspace, onSources }: {
  snapshot: LauncherSnapshot
  busy: string
  onStart: () => void
  onStop: () => void
  onRepair: () => void
  onWorkspace: () => void
  onSources: () => void
}): ReactNode {
  const ready = snapshot.environment.every((item) => item.status === 'ready')
  const running = snapshot.runStatus === 'running'
  const transitioning = snapshot.runStatus === 'starting' || snapshot.runStatus === 'stopping'
  return (
    <div className="dashboard-grid">
      <section className="deepseek-hero">
        <div className="deepseek-hero-logo" aria-hidden="true"><img src={deepseekLogo} alt="" /></div>
        <div className="deepseek-hero-copy">
          <h2>DeepSeek Harness</h2>
          <strong>一键启动整合包</strong>
          <p>无需手动下载源码或配置开发环境，选择工作区后即可启动。</p>
        </div>
        <div className="deepseek-hero-meta">
          <span>{snapshot.distributionMode === 'offline' ? '完整离线版' : '在线轻量版'}</span>
          <small>Windows 64 位</small>
          <small>非官方启动辅助工具</small>
        </div>
      </section>

      <Card className="launch-card">
        <div className="launch-status">
          <span className={classNames('launch-status-icon', ready && 'ready', snapshot.runStatus === 'error' && 'error')}>
            {snapshot.runStatus === 'error' ? <CircleAlert /> : running ? <Activity /> : <Check />}
          </span>
          <div><span>运行状态</span><h2>{running ? 'Harness 正在运行' : ready ? '环境已就绪' : '需要完成环境修复'}</h2><p>{running ? `本地服务已在 ${snapshot.serviceUrl} 就绪。` : ready ? '所有必要组件已准备好，可以立即启动。' : '启动器会尝试补齐缺失组件。'}</p></div>
        </div>
        <div className="launch-actions">
          <button className={classNames('launch-button', running && 'stop')} disabled={transitioning || !!busy} onClick={running ? onStop : onStart}>
            {transitioning ? <LoaderCircle className="spin" /> : running ? <CircleStop /> : <Play fill="currentColor" />}
            {snapshot.runStatus === 'starting' ? '正在启动…' : snapshot.runStatus === 'stopping' ? '正在停止…' : running ? '停止 DeepSeek Harness' : '启动 DeepSeek Harness'}
          </button>
          <button className="api-billing-button" onClick={() => void window.launcher?.openExternal('https://platform.deepseek.com/usage')}>
            <WalletCards size={20} />
            <span><strong>DeepSeek API 充值</strong><small>DeepSeek 官网</small></span>
            <ExternalLink size={15} />
          </button>
        </div>
        <div className="launch-foot">
          <span>{running ? '关闭启动器前请先停止服务' : `启动后访问 http://127.0.0.1:${snapshot.settings.port}`}</span>
          {running && snapshot.serviceUrl && <button className="text-button" onClick={() => void window.launcher?.openExternal(snapshot.serviceUrl!)}>打开应用 <ExternalLink size={13} /></button>}
        </div>
      </Card>

      <Card className="configuration-card" title="当前配置">
        <div className="config-row"><span><Box size={17} />Harness 版本</span><strong>{snapshot.activeHarnessVersion}</strong><button>更改</button></div>
        <div className="config-row"><span><Globe2 size={17} />运行端口</span><strong>{snapshot.settings.port}</strong><button>更改</button></div>
        <div className="config-row"><span><Folder size={17} />工作区</span><strong title={snapshot.settings.workspace}>{snapshot.settings.workspace}</strong><button onClick={onWorkspace}>更改</button></div>
        <button className="secondary-wide" onClick={onWorkspace}><Folder size={16} />选择工作区</button>
      </Card>

      <Card title="环境就绪检查" action={<button className="quiet-button" onClick={onRepair} disabled={!!busy}><Wrench size={15} />快速修复</button>}>
        <EnvironmentRows items={snapshot.environment} />
      </Card>

      <Card title="源站健康状态" action={<button className="text-button" onClick={onSources}><RefreshCw size={14} />重新检测</button>}>
        <SourceRows sources={snapshot.sources} />
      </Card>

      <Card title="最近任务"><Tasks snapshot={snapshot} /></Card>
      <Card title="运行日志" action={<span className="muted-label">最近 {Math.min(8, snapshot.logs.length)} 条</span>}><Logs snapshot={snapshot} /></Card>
    </div>
  )
}

function VersionsPage({ snapshot, busy, onInstall, onRollback, onSources, onLauncherUpdate }: {
  snapshot: LauncherSnapshot
  busy: string
  onInstall: (version: string) => void
  onRollback: (version: string) => void
  onSources: () => void
  onLauncherUpdate?: () => void
}): ReactNode {
  const newest = snapshot.versions[0]
  const hasUpdate = newest && newest.version !== snapshot.activeHarnessVersion
  return (
    <div className="version-layout">
      <Card className="version-summary">
        <div><span className="summary-icon"><Box /></span><p>当前已安装</p><strong>{snapshot.activeHarnessVersion}</strong><small>Harness</small></div>
        <div><span className="summary-icon"><Code2 /></span><p>内置 Node.js</p><strong>24.16.0</strong><small>{snapshot.platform}</small></div>
        <div><span className="summary-icon"><Sparkles /></span><p>启动器版本</p><strong>v{snapshot.launcherVersion}</strong><small>当前版本</small></div>
        <div><span className="summary-icon success"><ShieldCheck /></span><p>系统健康状态</p><strong className="success-text">完整</strong><small>核心组件正常</small></div>
      </Card>

      {snapshot.launcherUpdate && <Card className="launcher-update-banner"><span className="catalog-icon"><AppWindow /></span><div><span>启动器更新</span><h2>深蓝DeepSeekHarness启动器 {snapshot.launcherUpdate.version}</h2><p>{snapshot.launcherUpdate.notes.join(' · ')}</p></div><button className="primary-button" onClick={onLauncherUpdate} disabled={!!busy}><HardDriveDownload size={16} />下载整合包</button></Card>}

      <div className="version-main-column">
        <Card className="update-card">
          <div className="update-illustration"><Package /></div>
          <div className="update-copy">
            <span className="eyebrow">{hasUpdate ? '发现新版本' : '当前已是最新整合版本'}</span>
            <h2>{hasUpdate ? newest.version : snapshot.activeHarnessVersion}</h2>
            <ul>{(newest?.notes || ['整合包内置版本可离线启动', '在线源配置后可检查后续版本']).map((note) => <li key={note}>{note}</li>)}</ul>
            <button className="text-button">查看完整更新日志 <ArrowRight size={14} /></button>
          </div>
          <div className="update-action">
            <span>安装策略</span><strong>保留用户数据与上一版本</strong>
            <button className="primary-button" disabled={!hasUpdate || !!busy} onClick={() => newest && onInstall(newest.version)}><Download size={17} />{hasUpdate ? '更新并保留备份' : '无需更新'}</button>
          </div>
        </Card>

        <Card title="版本历史">
          <div className="version-list">
            {snapshot.versions.map((version) => (
              <div className="version-row" key={version.version}>
                <span className={classNames('version-cube', version.active && 'active')}><Box size={17} /></span>
                <strong>{version.version}</strong>
                <span>{version.active ? '当前版本' : version.installed ? '本机版本' : '远程版本'}</span>
                <span>{version.publishedAt || '—'}</span>
                <span>{version.sizeMb ? `${version.sizeMb} MB` : '—'}</span>
                <span className={classNames('soft-badge', version.active ? 'green' : version.rollbackReady ? 'blue' : '')}>{version.active ? '已安装' : version.rollbackReady ? '可回滚' : '可安装'}</span>
                {version.rollbackReady ? <button className="small-button" onClick={() => onRollback(version.version)}><RotateCcw size={14} />回滚</button> : !version.installed ? <button className="small-button" onClick={() => onInstall(version.version)}>安装</button> : <span />}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="version-side-column">
        <Card title="下载源" action={<button className="icon-button" onClick={onSources}><RefreshCw size={15} /></button>}>
          <p className="card-intro">下载前逐个探测；默认优先 GitHub，失败后自动切换到签名清单中的下一条可用渠道。</p>
          <div className="source-priority">
            {snapshot.sources.map((source, index) => (
              <div key={source.id}><span>{index + 1}</span><strong>{source.name}</strong><StatusDot status={source.status} /><small>{source.latencyMs ? `${source.latencyMs}ms` : source.status === 'unconfigured' ? '待配置' : '—'}</small></div>
            ))}
          </div>
        </Card>
        <Card title="更新保护">
          <div className="protection-item"><ShieldCheck /><div><strong>更新前自动备份</strong><p>备份 Harness 用户数据和 Profile 配置。</p></div><span className="toggle on" /></div>
          <div className="protection-item"><CheckCircle2 /><div><strong>完整性校验</strong><p>签名目录与模块包均校验 SHA-256。</p></div><span className="toggle on" /></div>
          <div className="protection-item"><RotateCcw /><div><strong>并行版本目录</strong><p>新版本验证失败时可切回旧版本。</p></div><span className="toggle on" /></div>
        </Card>
      </div>
    </div>
  )
}

function resourceKindLabel(type: string): string {
  return type === 'prompt' ? '提示词'
    : type === 'skill' ? 'Skill'
    : type === 'workflow' ? '工作流'
      : type === 'knowledge_base' ? '知识库'
      : type === 'agent' ? '智能体'
        : type === 'workflow_platform' ? '工作流平台'
          : type === 'software_tool' ? '软件工具'
            : 'AI 工具'
}

function resourceCopyText(item: LauncherResourceItem): string {
  const sections = [
    `${item.title}｜${resourceKindLabel(item.type)}`,
    `作者：${item.author}`,
    `简介：${item.longDescription || item.summary}`,
    item.capabilities.length ? `适合：${item.capabilities.join('、')}` : '',
    `第一步：${item.firstStep}`,
    item.inputs?.length ? `准备材料：\n- ${item.inputs.join('\n- ')}` : '',
    item.steps?.length ? `使用步骤：\n${item.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : '',
    item.outcomes?.length ? `预期产出：\n- ${item.outcomes.join('\n- ')}` : '',
    item.limitations ? `人工复核与边界：${item.limitations}` : '',
    item.promptText ? `提示词：\n${item.promptText}` : '',
    item.skillContent ? `Skill 内容：\n${item.skillContent}` : '',
    item.repositoryUrl ? `开源地址：${item.repositoryUrl}` : '',
    `AI历史书资源编号：${item.id}`
  ]
  return sections.filter(Boolean).join('\n\n')
}

function ResourceDetailSheet({ item, loading, error, favorite, accountStatus, favoriteStatus, queued, onClose, onToggleFavorite, onQueue, onInstall, onLogin }: {
  item: LauncherResourceItem
  loading: boolean
  error?: string
  favorite: boolean
  accountStatus: LauncherSnapshot['account']['status']
  favoriteStatus: LauncherSnapshot['favorites']['status']
  queued?: LauncherSnapshot['resourceLibrary'][number]
  onClose: () => void
  onToggleFavorite: () => void
  onQueue: () => void
  onInstall: () => void
  onLogin: () => void
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)
  const [repoCopied, setRepoCopied] = useState(false)
  const [engagement, setEngagement] = useState<LauncherResourceEngagement>()
  const [engagementError, setEngagementError] = useState('')
  const [comment, setComment] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', keydown)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', keydown)
  }, [onClose])
  useEffect(() => {
    let active = true
    setEngagement(undefined)
    setEngagementError('')
    if (!window.launcher) return () => { active = false }
    void window.launcher.resourceEngagement(item.id)
      .then((value) => { if (active) setEngagement(value) })
      .catch((reason: unknown) => { if (active) setEngagementError(reason instanceof Error ? reason.message : '评价暂时无法读取') })
    return () => { active = false }
  }, [item.id, accountStatus])
  const copy = async (): Promise<void> => {
    const value = resourceCopyText(item)
    if (window.launcher) await window.launcher.copyText(value)
    else await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  const copyRepository = async (): Promise<void> => {
    if (!item.repositoryUrl) return
    if (window.launcher) await window.launcher.copyText(item.repositoryUrl)
    else await navigator.clipboard.writeText(item.repositoryUrl)
    setRepoCopied(true)
    window.setTimeout(() => setRepoCopied(false), 1600)
  }
  const submitComment = async (): Promise<void> => {
    if (accountStatus !== 'signed_in') { onLogin(); return }
    if (!window.launcher || commentBusy || comment.trim().length < 2) return
    setCommentBusy(true); setEngagementError('')
    try {
      setEngagement(await window.launcher.commentResource(item.id, comment))
      setComment('')
    } catch (reason) {
      setEngagementError(reason instanceof Error ? reason.message : '评价发布失败')
    } finally { setCommentBusy(false) }
  }
  return <div className="detail-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="resource-detail-title">
      <header className="detail-sheet-header"><div><span className="eyebrow">{resourceKindLabel(item.type)} · 启动器内详情</span><h2 id="resource-detail-title">{item.title}</h2><p>{item.author}{item.verifiedAt ? ` · 核验于 ${item.verifiedAt}` : ''}</p></div><button ref={closeRef} className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={17} /></button></header>
      <div className="detail-sheet-body">
        {loading && <div className="detail-loading"><LoaderCircle className="spin" size={16} />正在读取完整结构化资料…</div>}
        {error && <div className="model-message"><CircleAlert size={15} />{error}，已显示目录摘要。</div>}
        <p className="detail-lead">{item.longDescription || item.summary}</p>
        <div className="detail-facts"><span><b>评分</b>{item.rating > 0 ? `${item.rating.toFixed(1)} / 5（${item.ratingCount}）` : '等待用户评分'}</span><span><b>热度</b>{Math.round(item.popularityScore)}</span><span><b>GitHub</b>{item.stars ? `${item.stars.toLocaleString('zh-CN')} Stars` : '未公开'}</span><span><b>难度</b>{item.difficulty}</span></div>
        {item.repositoryUrl && <article className="repository-strip"><Github size={18} /><div><strong>开源项目地址</strong><a href={item.repositoryUrl} onClick={(event) => { event.preventDefault(); openExternal(item.repositoryUrl!) }}>{item.repositoryUrl.replace(/^https:\/\//, '')}</a></div><button className="small-button" onClick={() => void copyRepository()}><Copy size={14} />{repoCopied ? '已复制' : '复制地址'}</button></article>}
        {item.editorialComment && <article className="editorial-comment"><ShieldCheck size={17} /><div><strong>AI历史书编辑点评</strong><p>{item.editorialComment}</p></div></article>}
        {item.capabilities.length > 0 && <div className="tag-row detail-tags">{item.capabilities.map((tag) => <span key={tag}>{tag}</span>)}</div>}
        <article className="detail-first-step"><CheckCircle2 size={17} /><div><strong>先做这一步</strong><p>{item.firstStep}</p></div></article>
        {(item.inputs?.length || item.outcomes?.length) && <div className="detail-two-column">
          {item.inputs?.length ? <article><h3>准备材料</h3><ul>{item.inputs.map((value) => <li key={value}>{value}</li>)}</ul></article> : null}
          {item.outcomes?.length ? <article><h3>完成后得到</h3><ul>{item.outcomes.map((value) => <li key={value}>{value}</li>)}</ul></article> : null}
        </div>}
        {item.steps?.length ? <article className="detail-section"><h3>使用步骤</h3><ol>{item.steps.map((value) => <li key={value}>{value}</li>)}</ol></article> : null}
        {item.promptText ? <article className="detail-section detail-code"><h3>可复制提示词</h3><pre>{item.promptText}</pre></article> : null}
        {item.skillContent ? <article className="detail-section detail-code"><h3>Skill 内容</h3><pre>{item.skillContent}</pre></article> : null}
        {item.workflowBlueprint ? <article className="detail-section detail-code"><h3>工作流蓝图</h3><pre>{JSON.stringify(item.workflowBlueprint, null, 2)}</pre></article> : null}
        {item.limitations && <article className="detail-boundary"><ShieldCheck size={17} /><div><strong>人工复核与使用边界</strong><p>{item.limitations}</p></div></article>}
        <section className="resource-reviews" aria-label="用户评价">
          <div className="resource-reviews-heading"><div><h3>用户评价</h3><p>{engagement ? `${engagement.counts.comment} 条评论 · ${engagement.counts.favorite} 次收藏` : '正在读取真实互动数据'}</p></div><MessageCircle size={19} /></div>
          {engagementError && <div className="model-message"><CircleAlert size={15} />{engagementError}</div>}
          <div className="review-list">{engagement?.comments.slice(-12).map((entry) => <article key={entry.id}><div><strong>{entry.authorName}</strong><time>{entry.createdAt}</time></div><p>{entry.body}</p></article>)}</div>
          {engagement && !engagement.comments.length && <p className="empty-reviews">还没有评价。使用过再说，少写空泛夸赞。</p>}
          <div className="review-composer"><textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1200} placeholder={accountStatus === 'signed_in' ? '写下你真实用过后的评价（2—1200字）' : '登录后可以发表评论'} disabled={accountStatus !== 'signed_in'} /><button className="primary-button" disabled={commentBusy || (accountStatus === 'signed_in' && comment.trim().length < 2)} onClick={() => void submitComment()}>{accountStatus === 'signed_in' ? commentBusy ? '发布中' : '发布评价' : '登录后评价'}</button></div>
        </section>
      </div>
      <footer className="detail-sheet-actions"><button className={classNames('small-button', favorite && 'is-favorite')} disabled={favoriteStatus === 'loading'} onClick={onToggleFavorite}><Heart size={16} fill={favorite ? 'currentColor' : 'none'} />{accountStatus !== 'signed_in' ? '登录后收藏' : favorite ? '已收藏' : '收藏'}</button><button className="small-button" onClick={queued?.status === 'queued' || queued?.status === 'failed' ? onInstall : onQueue}>{queued?.status === 'installed' ? <Check size={16} /> : queued ? <Download size={16} /> : <ListPlus size={16} />}{queued?.status === 'installed' ? '已安装' : queued ? '立即安装' : '加入安装列表'}</button><button className="primary-button" onClick={() => void copy()}><Copy size={16} />{copied ? '已复制' : '复制完整用法'}</button></footer>
    </section>
  </div>
}

function PluginsPage({ snapshot, busy, onAction, onToggleFavorite }: { snapshot: LauncherSnapshot; busy: string; onAction: (action: 'install' | 'update' | 'remove', spec: string) => void; onToggleFavorite: (id: string) => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [customSpec, setCustomSpec] = useState('')
  const [tab, setTab] = useState<'tools' | 'extensions' | 'favorites' | 'installed' | 'manual'>('tools')
  const [visibleCount, setVisibleCount] = useState(24)
  const [selectedResource, setSelectedResource] = useState<LauncherResourceItem>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string>()
  const detailRequest = useRef(0)
  const favoriteIds = new Set(snapshot.favorites.resourceIds)
  const allResources = [...snapshot.discovery.tools, ...snapshot.discovery.extensions]
  const source: LauncherResourceItem[] = tab === 'extensions' ? snapshot.discovery.extensions : tab === 'favorites' ? allResources.filter((item) => favoriteIds.has(item.id)) : snapshot.discovery.tools
  const filteredResources = source.filter((item) => `${item.title} ${item.author} ${item.summary} ${item.firstStep} ${item.capabilities.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const filteredPlugins = snapshot.plugins.filter((plugin) => `${plugin.name} ${plugin.description} ${plugin.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()) && plugin.installed)
  const tabs = [
    ['tools', `AI 工具 ${snapshot.discovery.tools.length}`], ['extensions', `Skill / 工作流 ${snapshot.discovery.extensions.length}`], ['favorites', `我的收藏 ${snapshot.favorites.resourceIds.length}`], ['installed', `已安装 ${filteredPlugins.length}`], ['manual', '手动安装']
  ] as const
  const openResource = (item: LauncherResourceItem): void => {
    const request = ++detailRequest.current
    setSelectedResource(item)
    setDetailError(undefined)
    if (!window.launcher) return
    setDetailLoading(true)
    void window.launcher.resourceDetail(item.id)
      .then((detail) => { if (request === detailRequest.current) setSelectedResource(detail) })
      .catch((error: unknown) => { if (request === detailRequest.current) setDetailError(error instanceof Error ? error.message : '详情读取失败') })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false) })
  }
  return (
    <div className="stack-layout">
      <div className="section-tabs" role="tablist" aria-label="AI 工具分类">
        {tabs.map(([id, label]) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} key={id} onClick={() => { setTab(id); setVisibleCount(24) }}>{label}</button>)}
      </div>
      {(tab === 'tools' || tab === 'extensions' || tab === 'favorites' || tab === 'installed') && <>
      <Card className="catalog-toolbar">
        <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(24) }} placeholder="搜索名称、用途、能力或作者" /></div>
        <div className="toolbar-stats"><span><strong>{snapshot.discovery.tools.length}</strong> 工具</span><span><strong>{snapshot.discovery.extensions.length}</strong> Skill / 工作流</span><span><strong>在线同步</strong> AI历史书目录</span></div>
      </Card>
      {tab === 'favorites' && snapshot.account.status !== 'signed_in' && <Card><EmptyState icon={<Heart />} title="登录后查看同步收藏" text="收藏属于你的 AI历史书账号。登录后，这台电脑会显示网站和其他设备上的同一份收藏。" /></Card>}
      {tab === 'favorites' && snapshot.account.status === 'signed_in' && snapshot.favorites.status === 'unavailable' && <Card><EmptyState icon={<CircleAlert />} title="收藏同步暂时不可用" text={snapshot.favorites.message || '请检查网络后重试；启动器不会用本地数据冒充账号收藏。'} /></Card>}
      {tab === 'favorites' && snapshot.account.status === 'signed_in' && snapshot.favorites.status === 'loading' && <Card><EmptyState icon={<LoaderCircle className="spin" />} title="正在同步账号收藏" text="正在从 AI历史书读取这位用户的最新收藏。" /></Card>}
      {tab === 'installed' ? <div className="catalog-grid">
        {filteredPlugins.map((plugin) => (
          <Card className="catalog-card" key={plugin.id}>
            <div className="catalog-card-top"><span className="catalog-icon"><Plug /></span><div><h2>{plugin.name}</h2><p>{plugin.author}</p></div>{plugin.featured && <span className="soft-badge blue">推荐</span>}</div>
            <p className="catalog-description">{plugin.description}</p>
            <div className="tag-row">{plugin.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className="catalog-meta"><code>{plugin.packageSpec}</code><span>{plugin.version}</span></div>
            <button className={plugin.installed ? 'small-button danger' : 'primary-button'} disabled={!!busy} onClick={() => onAction(plugin.installed ? 'remove' : 'install', plugin.packageSpec)}>{plugin.installed ? <><Trash2 size={15} />卸载</> : <><Download size={15} />安装到 web profile</>}</button>
          </Card>
        ))}
        {!filteredPlugins.length && <Card><EmptyState icon={<Plug />} title="还没有已安装插件" text="可以从可信包地址手动安装；在线目录用于发现，不会静默执行第三方代码。" /></Card>}
      </div> : <>
        <div className="resource-directory-grid">
          {filteredResources.slice(0, visibleCount).map((item) => <article className="card resource-directory-card resource-market-card" key={item.id} tabIndex={0} aria-label={`查看${item.title}详情`} onClick={() => openResource(item)} onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            openResource(item)
          }}>
            <div className="resource-type-row"><span>{item.type === 'skill' ? 'Skill' : item.type === 'workflow' ? '工作流' : item.type === 'agent' ? '智能体' : item.type === 'workflow_platform' ? '工作流平台' : 'AI 工具'}</span><small>{item.difficulty} · {item.pricingMode === 'free' ? '免费' : item.pricingMode}</small></div>
            <h2>{item.title}</h2><p>{item.summary}</p>
            <div className="resource-first-step"><CheckCircle2 size={14} /><span><b>第一步：</b>{item.firstStep}</span></div>
            <div className="tag-row">{item.capabilities.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
            <div className="resource-card-footer"><span>{item.author}</span><button className="quiet-button" onClick={(event) => { event.stopPropagation(); openResource(item) }}>启动器内查看<ChevronRight size={14} /></button></div>
          </article>)}
        </div>
        {!filteredResources.length && !(tab === 'favorites' && (snapshot.account.status !== 'signed_in' || snapshot.favorites.status === 'loading' || snapshot.favorites.status === 'unavailable')) && <Card><EmptyState icon={<Search />} title={tab === 'favorites' ? '还没有收藏' : '没有匹配条目'} text={tab === 'favorites' ? '打开任意工具、Skill、工作流或智能体详情，收藏后会同步到 AI历史书账号。' : '换一个关键词，或刷新在线目录后重试。'} /></Card>}
        {visibleCount < filteredResources.length && <button className="load-more-directory" onClick={() => setVisibleCount((count) => count + 24)}>继续显示 {Math.min(24, filteredResources.length - visibleCount)} 项</button>}
      </>}
      </>}
      {tab === 'manual' && <Card className="catalog-card custom-plugin manual-install-card">
          <div className="catalog-card-top"><span className="catalog-icon"><Package /></span><div><h2>安装其他插件</h2><p>npm / Git / 本地 tarball</p></div></div>
          <p className="catalog-description">仅安装你信任的插件。插件代码会在 Harness 进程中运行。</p>
          <input value={customSpec} onChange={(event) => setCustomSpec(event.target.value)} placeholder="安装填包地址；更新/卸载填包名" />
          <div className="custom-plugin-actions">
            <button className="primary-button" disabled={!customSpec.trim() || !!busy} onClick={() => onAction('install', customSpec.trim())}><Download size={15} />安装</button>
            <button className="small-button" disabled={!customSpec.trim() || !!busy} onClick={() => onAction('update', customSpec.trim())}><RefreshCw size={15} />更新</button>
            <button className="small-button danger" disabled={!customSpec.trim() || !!busy} onClick={() => onAction('remove', customSpec.trim())}><Trash2 size={15} />卸载</button>
          </div>
        </Card>}
      {selectedResource && <ResourceDetailSheet item={selectedResource} loading={detailLoading} error={detailError} favorite={favoriteIds.has(selectedResource.id)} accountStatus={snapshot.account.status} favoriteStatus={snapshot.favorites.status} queued={snapshot.resourceLibrary.find((entry) => entry.id === selectedResource.id)} onClose={() => { detailRequest.current += 1; setSelectedResource(undefined); setDetailLoading(false) }} onToggleFavorite={() => onToggleFavorite(selectedResource.id)} onQueue={() => undefined} onInstall={() => undefined} onLogin={() => undefined} />}
    </div>
  )
}

type ResourcePageKind = 'prompts' | 'skills' | 'workflows' | 'knowledge' | 'tools' | 'agents'

function resourcesForPage(snapshot: LauncherSnapshot, kind: ResourcePageKind): LauncherResourceItem[] {
  if (kind === 'prompts') return snapshot.discovery.prompts
  if (kind === 'skills') return snapshot.discovery.skills
  if (kind === 'workflows') return snapshot.discovery.workflows
  if (kind === 'knowledge') return snapshot.discovery.knowledgeBases
  if (kind === 'agents') return snapshot.discovery.agents
  return snapshot.discovery.tools
}

function ResourceDirectoryPage({ kind, snapshot, busy, onRefresh, onToggleFavorite, onQueue, onInstall, onLogin }: {
  kind: ResourcePageKind
  snapshot: LauncherSnapshot
  busy: string
  onRefresh: () => void
  onToggleFavorite: (id: string) => void
  onQueue: (id: string) => void
  onInstall: (id: string) => void
  onLogin: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(24)
  const [selectedResource, setSelectedResource] = useState<LauncherResourceItem>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string>()
  const requestRef = useRef(0)
  const source = resourcesForPage(snapshot, kind)
  const filtered = source.filter((item) => `${item.title} ${item.author} ${item.summary} ${item.capabilities.join(' ')} ${item.repositoryUrl || ''}`.toLowerCase().includes(query.toLowerCase()))
  const favoriteIds = new Set(snapshot.favorites.resourceIds)
  const openResource = (item: LauncherResourceItem): void => {
    const request = ++requestRef.current
    setSelectedResource(item); setDetailError(undefined)
    if (!window.launcher) return
    setDetailLoading(true)
    void window.launcher.resourceDetail(item.id)
      .then((detail) => { if (request === requestRef.current) setSelectedResource(detail) })
      .catch((reason: unknown) => { if (request === requestRef.current) setDetailError(reason instanceof Error ? reason.message : '详情读取失败') })
      .finally(() => { if (request === requestRef.current) setDetailLoading(false) })
  }
  const copyRepository = async (event: ReactMouseEvent, item: LauncherResourceItem): Promise<void> => {
    event.stopPropagation()
    if (!item.repositoryUrl) return
    if (window.launcher) await window.launcher.copyText(item.repositoryUrl)
    else await navigator.clipboard.writeText(item.repositoryUrl)
  }
  return <div className="stack-layout resource-page">
    <Card className="catalog-toolbar resource-toolbar">
      <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(24) }} placeholder={`搜索${pageTitles[kind].title}名称、用途、作者或开源项目`} /></div>
      <div className="toolbar-stats"><span><strong>{source.length}</strong> 条在线资源</span><span><strong>{snapshot.resourceLibrary.filter((entry) => entry.type === source[0]?.type).length}</strong> 已加入本机</span><button className="quiet-button" disabled={busy === 'discovery'} onClick={onRefresh}><RefreshCw size={14} className={busy === 'discovery' ? 'spin' : ''} />同步网站目录</button></div>
    </Card>
    {snapshot.discovery.message && <div className="model-message"><CircleAlert size={15} />{snapshot.discovery.message}</div>}
    <div className="resource-directory-grid">
      {filtered.slice(0, visibleCount).map((item) => {
        const queued = snapshot.resourceLibrary.find((entry) => entry.id === item.id)
        return <article className="card resource-directory-card resource-market-card" key={item.id} tabIndex={0} aria-label={`查看${item.title}详情`} onClick={() => openResource(item)} onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          openResource(item)
        }}>
          <div className="resource-type-row"><span>{resourceKindLabel(item.type)}</span><small>{item.difficulty} · {item.pricingMode === 'free' ? '免费' : item.pricingMode}</small></div>
          <h2>{item.title}</h2><p>{item.summary}</p>
          <div className="resource-metrics"><span><Star size={13} fill="currentColor" />{item.rating > 0 ? item.rating.toFixed(1) : '暂无'}</span><span><Flame size={13} />{Math.round(item.popularityScore)}</span>{item.stars ? <span><Github size={13} />{item.stars.toLocaleString('zh-CN')}</span> : null}</div>
          {item.repositoryUrl ? <button className="repository-copy" title="复制开源地址" onClick={(event) => void copyRepository(event, item)}><Github size={14} /><span>{item.repositoryUrl.replace(/^https:\/\/github.com\//, '')}</span><Copy size={13} /></button> : <div className="repository-copy is-muted"><ShieldCheck size={14} /><span>AI历史书核验目录</span></div>}
          <div className="tag-row">{item.capabilities.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
          <div className="resource-card-actions"><button className="quiet-button" onClick={(event) => { event.stopPropagation(); openResource(item) }}>查看详情与评价<ChevronRight size={14} /></button><button className={classNames('small-button', queued?.status === 'installed' && 'is-installed')} disabled={queued?.status === 'installed'} onClick={(event) => { event.stopPropagation(); queued ? onInstall(item.id) : onQueue(item.id) }}>{queued?.status === 'installed' ? <Check size={14} /> : queued ? <Download size={14} /> : <ListPlus size={14} />}{queued?.status === 'installed' ? '已安装' : queued ? '安装' : '加入列表'}</button></div>
        </article>
      })}
    </div>
    {!filtered.length && <Card><EmptyState icon={<Search />} title="没有匹配资源" text="换一个关键词，或同步网站最新目录后重试。" /></Card>}
    {visibleCount < filtered.length && <button className="load-more-directory" onClick={() => setVisibleCount((count) => count + 24)}>继续显示 {Math.min(24, filtered.length - visibleCount)} 项</button>}
    {selectedResource && <ResourceDetailSheet item={selectedResource} loading={detailLoading} error={detailError} favorite={favoriteIds.has(selectedResource.id)} accountStatus={snapshot.account.status} favoriteStatus={snapshot.favorites.status} queued={snapshot.resourceLibrary.find((entry) => entry.id === selectedResource.id)} onClose={() => { requestRef.current += 1; setSelectedResource(undefined); setDetailLoading(false) }} onToggleFavorite={() => onToggleFavorite(selectedResource.id)} onQueue={() => onQueue(selectedResource.id)} onInstall={() => onInstall(selectedResource.id)} onLogin={onLogin} />}
  </div>
}

function ResourceLibraryPage({ snapshot, busy, onInstall, onRemove, onOpen }: { snapshot: LauncherSnapshot; busy: string; onInstall: (id: string) => void; onRemove: (id: string) => void; onOpen: (path: string) => void }): ReactNode {
  return <div className="stack-layout library-page">
    <Card className="library-explainer"><PackageCheck size={25} /><div><h2>先加入列表，再确认安装</h2><p>Skill 会写入 Harness 原生 <code>skills</code> 目录，并默认关闭模型自动调用；提示词、工作流和知识库写入本机受控能力库，不执行任意仓库代码。</p></div><span>{snapshot.resourceLibrary.length} 项</span></Card>
    <div className="library-list">{snapshot.resourceLibrary.map((entry) => <article className="card library-row" key={entry.id}><div className={classNames('library-status', entry.status)}>{entry.status === 'installed' ? <Check /> : entry.status === 'failed' ? <CircleAlert /> : <Package />}</div><div><span>{resourceKindLabel(entry.type)}</span><h2>{entry.title}</h2><p>{entry.message || (entry.type === 'skill' ? '将安装为可由用户主动调用的 DSH Skill。' : '将保存为 DSH 本机能力资料。')}</p>{entry.repositoryUrl && <button className="text-link" onClick={() => openExternal(entry.repositoryUrl!)}><Github size={13} />{entry.repositoryUrl.replace(/^https:\/\//, '')}</button>}</div><div className="library-actions">{entry.installedPath && <button className="quiet-button" onClick={() => onOpen(entry.installedPath!)}><Folder size={14} />打开目录</button>}<button className="primary-button" disabled={busy === `library-${entry.id}` || entry.status === 'installed'} onClick={() => onInstall(entry.id)}>{entry.status === 'installed' ? '已安装' : entry.status === 'failed' ? '重新安装' : '确认安装'}</button><button className="icon-button danger" aria-label={`移除${entry.title}`} onClick={() => onRemove(entry.id)}><Trash2 size={15} /></button></div></article>)}</div>
    {!snapshot.resourceLibrary.length && <Card><EmptyState icon={<PackageCheck />} title="安装列表是空的" text="在提示词、Skill、工作流或知识库页面把资源加入列表，再回到这里确认安装。" /></Card>}
  </div>
}

const skinStyleLabels: Record<SkinStyle, string> = {
  realistic: '真人风',
  anime: '二次元',
  cyber: '赛博',
  pixel: '像素风',
  nature: '自然',
  minimal: '极简'
}

const skinKindLabels: Record<SkinMediaKind, string> = {
  image: '高清图',
  'animated-image': '动画',
  video: '视频壁纸'
}

function SkinStorePage({ snapshot, busy, onRefresh, onApply, onClear }: {
  snapshot: LauncherSnapshot
  busy: string
  onRefresh: () => void
  onApply: (skinId: string) => void
  onClear: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [style, setStyle] = useState<SkinStyle | 'all'>('all')
  const [kind, setKind] = useState<SkinMediaKind | 'all'>('all')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const filtered = snapshot.skins.items.filter((skin) => {
    const matchesQuery = `${skin.name} ${skin.description} ${skin.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (style === 'all' || skin.styles.includes(style)) && (kind === 'all' || skin.mediaKind === kind)
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const items = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const downloaded = new Set(snapshot.skins.downloadedSkinIds)
  const chooseStyle = (next: SkinStyle | 'all'): void => { setStyle(next); setPage(1) }
  const chooseKind = (next: SkinMediaKind | 'all'): void => { setKind(next); setPage(1) }
  return (
    <div className="skin-store-layout">
      <Card className="skin-store-hero">
        <div className="skin-hero-icon"><Palette /></div>
        <div><span>DEEPSEEKHARNESS SKIN STORE</span><h2>让工作台像你喜欢的世界</h2><p>目录按页加载缩略图；只有点击应用才下载原图或视频。每项都带作者、来源和许可证。</p><OpenSourceInvite name="皮肤商店" url={SKIN_STORE_REPOSITORY_URL} /></div>
        <div className="skin-hero-actions">
          <span className={classNames('soft-badge', snapshot.skins.source === 'remote' ? 'green' : 'blue')}>{snapshot.skins.source === 'remote' ? 'Gitee 在线目录' : '内置离线目录'}</span>
          <button className="quiet-button" disabled={busy === 'skins'} onClick={onRefresh}><RefreshCw size={15} className={busy === 'skins' ? 'spin' : ''} />同步目录</button>
          <button className="quiet-button" onClick={() => void window.launcher?.openExternal(SKIN_STORE_REPOSITORY_URL)}><Github size={15} />去仓库参与共创</button>
        </div>
      </Card>

      {snapshot.skins.message && <div className="skin-notice"><Info size={15} />{snapshot.skins.message}</div>}

      <Card className="skin-toolbar">
        <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="搜索皮肤、画风或场景" /></div>
        <div className="skin-filter-row" aria-label="媒体分类">
          {(['all', 'image', 'animated-image', 'video'] as const).map((value) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => chooseKind(value)}>{value === 'all' ? '全部媒体' : skinKindLabels[value]}</button>)}
        </div>
        <div className="skin-filter-row" aria-label="画风分类">
          {(['all', 'realistic', 'anime', 'cyber', 'pixel', 'nature', 'minimal'] as const).map((value) => <button key={value} className={style === value ? 'active' : ''} onClick={() => chooseStyle(value)}>{value === 'all' ? '全部画风' : skinStyleLabels[value]}</button>)}
        </div>
      </Card>

      {items.length ? <div className="skin-grid">{items.map((skin) => {
        const active = snapshot.skins.activeSkinId === skin.id
        const cached = downloaded.has(skin.id)
        return (
          <article className={classNames('skin-card', active && 'active')} key={skin.id}>
            <div className="skin-preview">
              <img src={skin.thumbnail.url} loading="lazy" alt={`${skin.name}皮肤预览`} />
              <span className="skin-kind"><Images size={13} />{skinKindLabels[skin.mediaKind]}</span>
              {skin.featured && <span className="skin-featured"><Sparkles size={13} />精选</span>}
              {active && <span className="skin-active"><Check size={14} />当前使用</span>}
            </div>
            <div className="skin-card-body">
              <div className="skin-title-row"><div><h2>{skin.name}</h2><p>{skin.description}</p></div></div>
              <div className="tag-row">{skin.styles.map((entry) => <span key={entry}>{skinStyleLabels[entry]}</span>)}{skin.tags.filter((tag) => !skin.styles.some((entry) => skinStyleLabels[entry] === tag)).slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}</div>
              <div className="skin-license"><ShieldCheck size={14} /><span>{skin.license.name} · {skin.license.author}</span><button onClick={() => void window.launcher?.openExternal(skin.license.sourceUrl)}><ExternalLink size={12} /></button></div>
              <button className={active ? 'small-button' : 'primary-button'} disabled={!!busy || active} onClick={() => onApply(skin.id)}>{active ? <><Check size={15} />已应用</> : cached ? <><Palette size={15} />立即应用</> : <><CloudDownload size={15} />下载并应用 · {(skin.media.size / 1024 / 1024).toFixed(1)} MB</>}</button>
            </div>
          </article>
        )
      })}</div> : <Card><EmptyState icon={<Palette />} title="没有匹配的皮肤" text="换一个分类或清空搜索词。" /></Card>}

      <div className="skin-pagination">
        <span>第 {currentPage} / {pageCount} 页 · 每页最多 20 个</span>
        <div><button className="small-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button className="small-button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
        {snapshot.skins.activeSkinId && <button className="text-button danger" disabled={!!busy} onClick={onClear}>恢复 Harness 默认皮肤</button>}
      </div>
    </div>
  )
}

const petSpeciesLabels: Record<PetSpecies, string> = {
  cat: '猫咪',
  dog: '狗狗',
  whale: '鲸鱼',
  fantasy: '幻想生物',
  robot: '机器人',
  pixel: '像素生物',
  other: '其他'
}

const petStyleLabels: Record<PetStyle, string> = {
  cute: '可爱',
  calm: '治愈',
  playful: '活泼',
  cyber: '赛博',
  pixel: '像素风'
}

function PetStorePage({ snapshot, busy, onRefresh, onApply, onClear, onImport, onRemove }: {
  snapshot: LauncherSnapshot
  busy: string
  onRefresh: () => void
  onApply: (petId: string) => void
  onClear: () => void
  onImport: () => void
  onRemove: (petId: string) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [species, setSpecies] = useState<PetSpecies | 'all'>('all')
  const [style, setStyle] = useState<PetStyle | 'all'>('all')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const filtered = snapshot.pets.items.filter((pet) => {
    const matchesQuery = `${pet.name} ${pet.description} ${pet.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (species === 'all' || pet.species === species) && (style === 'all' || pet.styles.includes(style))
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const items = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const downloaded = new Set(snapshot.pets.downloadedPetIds)
  const chooseSpecies = (next: PetSpecies | 'all'): void => { setSpecies(next); setPage(1) }
  const chooseStyle = (next: PetStyle | 'all'): void => { setStyle(next); setPage(1) }
  return (
    <div className="pet-store-layout">
      <Card className="pet-store-hero">
        <div className="pet-hero-icon"><PawPrint /></div>
        <div><span>DEEPSEEKHARNESS PET STORE</span><h2>给工作台找一个小伙伴</h2><p>宠物可以点击互动、拖到喜欢的位置，并在下次打开时记住位置。原图只在应用时下载。</p><OpenSourceInvite name="宠物商店" url={PET_STORE_REPOSITORY_URL} /></div>
        <div className="pet-hero-actions">
          <span className={classNames('soft-badge', snapshot.pets.source === 'remote' ? 'green' : 'blue')}>{snapshot.pets.source === 'remote' ? 'Gitee 在线目录' : '内置离线目录'}</span>
          <button className="quiet-button" disabled={busy === 'pets'} onClick={onRefresh}><RefreshCw size={15} className={busy === 'pets' ? 'spin' : ''} />同步目录</button>
          <button className="quiet-button" disabled={!!busy} onClick={onImport}><Upload size={15} />添加本地宠物</button>
          <button className="quiet-button" onClick={() => void window.launcher?.openExternal(PET_STORE_REPOSITORY_URL)}><Github size={15} />去仓库参与共创</button>
        </div>
      </Card>

      {snapshot.pets.message && <div className="skin-notice"><Info size={15} />{snapshot.pets.message}</div>}

      <Card className="skin-toolbar pet-toolbar">
        <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="搜索宠物、物种或画风" /></div>
        <div className="skin-filter-row" aria-label="宠物分类">
          {(['all', 'cat', 'dog', 'whale', 'fantasy', 'robot', 'pixel', 'other'] as const).map((value) => <button key={value} className={species === value ? 'active' : ''} onClick={() => chooseSpecies(value)}>{value === 'all' ? '全部宠物' : petSpeciesLabels[value]}</button>)}
        </div>
        <div className="skin-filter-row" aria-label="宠物画风">
          {(['all', 'cute', 'calm', 'playful', 'cyber', 'pixel'] as const).map((value) => <button key={value} className={style === value ? 'active' : ''} onClick={() => chooseStyle(value)}>{value === 'all' ? '全部画风' : petStyleLabels[value]}</button>)}
        </div>
      </Card>

      {items.length ? <div className="pet-grid">{items.map((pet) => {
        const active = snapshot.pets.activePetId === pet.id
        const cached = downloaded.has(pet.id)
        const custom = pet.origin === 'custom'
        return (
          <article className={classNames('pet-card', active && 'active')} key={pet.id}>
            <div className="pet-preview">
              <span className="pet-stage" />
              <img src={pet.previewDataUrl || (import.meta.env.DEV ? `/__pet-preview/${pet.thumbnail.url.split('/').at(-1)}` : pet.thumbnail.url)} loading="lazy" alt={`${pet.name}宠物预览`} />
              <span className="skin-kind"><PawPrint size={13} />{petSpeciesLabels[pet.species]}</span>
              {pet.featured && <span className="skin-featured"><Sparkles size={13} />精选</span>}
              {custom && <span className="pet-custom"><Upload size={13} />本机</span>}
              {active && <span className="skin-active"><Check size={14} />当前使用</span>}
            </div>
            <div className="skin-card-body">
              <div className="skin-title-row"><div><h2>{pet.name}</h2><p>{pet.description}</p></div>{custom && <button className="icon-danger" aria-label={`删除${pet.name}`} disabled={!!busy} onClick={() => onRemove(pet.id)}><Trash2 size={15} /></button>}</div>
              <div className="tag-row">{pet.styles.map((entry) => <span key={entry}>{petStyleLabels[entry]}</span>)}{pet.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}</div>
              <div className="pet-behavior"><span>点击：{pet.behavior.clickMotion === 'hop' ? '跳一跳' : pet.behavior.clickMotion === 'spin' ? '转圈' : '冒爱心'}</span><span>可拖动</span>{pet.mediaKind === 'animated' && <span>帧动画</span>}{pet.behavior.autoSpeakIntervalSec && <span>主动问候</span>}</div>
              <div className="skin-license"><ShieldCheck size={14} /><span>{custom ? '仅保存在本机' : `${pet.license.name} · ${pet.license.author}`}</span>{!custom && <button onClick={() => void window.launcher?.openExternal(pet.license.sourceUrl)}><ExternalLink size={12} /></button>}</div>
              <button className={active ? 'small-button' : 'primary-button'} disabled={!!busy || active} onClick={() => onApply(pet.id)}>{active ? <><Check size={15} />已应用</> : cached ? <><PawPrint size={15} />立即应用</> : <><CloudDownload size={15} />下载并应用 · {(pet.media.size / 1024 / 1024).toFixed(1)} MB</>}</button>
            </div>
          </article>
        )
      })}</div> : <Card><EmptyState icon={<PawPrint />} title="没有匹配的宠物" text="换一个分类、清空搜索词，或添加本地宠物。" /></Card>}

      <div className="skin-pagination">
        <span>第 {currentPage} / {pageCount} 页 · 每页最多 20 个</span>
        <div><button className="small-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button className="small-button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
        {snapshot.pets.activePetId && <button className="text-button danger" disabled={!!busy} onClick={onClear}>关闭网页宠物</button>}
      </div>
    </div>
  )
}

const multimodalPrompts = [
  { label: '快速读图', value: '请先用一句话说明你看到了什么，再列出图片中的关键信息；不确定的内容请明确标注。' },
  { label: '提取文字', value: '请按阅读顺序提取图片中清晰可见的文字，保留原有层级；无法确认的字用〔不清楚〕标注。' },
  { label: '检查界面', value: '请从信息层级、可读性、交互提示和明显错误四个方面检查这个界面，并给出最优先的三项修改。' },
  { label: '解读图表', value: '请说明这张图表表达的核心结论、关键数据、异常点，以及不能从图中推出的内容。' }
]

function MultimodalTestLab({ snapshot, onTest }: {
  snapshot: LauncherSnapshot
  onTest: (request: MultimodalTestRequest) => Promise<MultimodalTestResult>
}): ReactNode {
  const options = useMemo(() => snapshot.modelHub.providers.flatMap((provider) => provider.configured
    ? provider.models.map((model) => ({ value: `${provider.id}::${model.id}`, provider: provider.id, model: model.id, label: `${provider.name} · ${model.name}` }))
    : []), [snapshot.modelHub.providers])
  const defaultValue = options.some((item) => item.provider === snapshot.modelHub.active.provider && item.model === snapshot.modelHub.active.model)
    ? `${snapshot.modelHub.active.provider}::${snapshot.modelHub.active.model}`
    : options[0]?.value || ''
  const [selection, setSelection] = useState(defaultValue)
  const [prompt, setPrompt] = useState(multimodalPrompts[0]!.value)
  const [image, setImage] = useState<MultimodalTestRequest['image']>()
  const [result, setResult] = useState<MultimodalTestResult>()
  const [localError, setLocalError] = useState('')
  const [running, setRunning] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const optionSignature = options.map((item) => item.value).join('|')

  useEffect(() => {
    if (!options.some((item) => item.value === selection)) setSelection(defaultValue)
  }, [defaultValue, optionSignature, options, selection])

  const readImage = (file?: File): void => {
    setResult(undefined)
    setLocalError('')
    if (!file) return
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    if (!allowed.has(file.type)) { setImage(undefined); setLocalError('仅支持 JPG、PNG、WebP 或 GIF 图片'); return }
    if (!file.size || file.size > 10 * 1024 * 1024) { setImage(undefined); setLocalError('请选择不超过 10 MB 的图片'); return }
    const reader = new FileReader()
    reader.onerror = () => setLocalError('图片读取失败，请重新选择')
    reader.onload = () => {
      if (typeof reader.result !== 'string') { setLocalError('图片读取失败，请重新选择'); return }
      setImage({ name: file.name, mimeType: file.type as MultimodalTestRequest['image']['mimeType'], dataUrl: reader.result })
    }
    reader.readAsDataURL(file)
  }

  const fileChange = (event: ChangeEvent<HTMLInputElement>): void => readImage(event.target.files?.[0])
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    readImage(event.dataTransfer.files?.[0])
  }
  const runTest = async (): Promise<void> => {
    const [provider, model] = selection.split('::')
    if (!provider || !model) { setLocalError('请先添加并配置一个模型'); return }
    if (!image) { setLocalError('请先选择一张测试图片'); return }
    if (!prompt.trim()) { setLocalError('请输入希望模型完成的任务'); return }
    setRunning(true)
    setResult(undefined)
    setLocalError('')
    try {
      setResult(await onTest({ provider, model, prompt: prompt.trim(), image }))
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '多模态测试失败，请检查模型连接')
    } finally {
      setRunning(false)
    }
  }
  const clearImage = (): void => {
    setImage(undefined)
    setResult(undefined)
    setLocalError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  return <section className="multimodal-lab" aria-label="多模态实测">
    <div className="multimodal-workbench">
      <div className="multimodal-input-column">
        <div className="test-model-row">
          <label><span>测试模型</span><select value={selection} disabled={!options.length || running} onChange={(event) => { setSelection(event.target.value); setResult(undefined) }}>
            {!options.length && <option value="">还没有已配置 Key 的模型</option>}
            {options.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select></label>
          <span className="single-call-note"><ShieldCheck size={15} />一次点击只发送一次请求</span>
        </div>

        <div className={classNames('image-dropzone', image && 'has-image')} onDragOver={(event) => event.preventDefault()} onDrop={drop}>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={fileChange} />
          {image ? <><img src={image.dataUrl} alt={`待测试图片：${image.name}`} /><div className="image-file-bar"><span><Images size={15} /><strong>{image.name}</strong></span><button type="button" onClick={clearImage}>移除</button></div></> : <button type="button" className="dropzone-action" onClick={() => fileInput.current?.click()}><span><Upload size={23} /></span><strong>选择或拖入测试图片</strong><small>JPG、PNG、WebP、GIF · 最大 10 MB</small></button>}
        </div>
        {image && <button className="quiet-button replace-image" type="button" onClick={() => fileInput.current?.click()}><Upload size={14} />更换图片</button>}
        <p className="privacy-note"><ShieldCheck size={14} />图片只在本次测试中直接发送给所选模型服务商，启动器不保存图片或回答。</p>
      </div>

      <div className="multimodal-prompt-column">
        <div className="prompt-heading"><div><h2>告诉模型要检查什么</h2><p>用同一张图切换模型，可直接比较识别质量、速度和实际 Token。</p></div><Sparkles size={20} /></div>
        <div className="prompt-presets" aria-label="测试任务模板">{multimodalPrompts.map((item) => <button type="button" className={prompt === item.value ? 'active' : ''} key={item.label} onClick={() => { setPrompt(item.value); setResult(undefined) }}>{item.label}</button>)}</div>
        <label className="test-prompt"><span>测试问题</span><textarea value={prompt} maxLength={4000} rows={5} onChange={(event) => { setPrompt(event.target.value); setResult(undefined) }} /></label>
        {localError && <div className="test-inline-error" role="alert"><CircleAlert size={16} />{localError}</div>}
        <button className="primary-button run-vision-test" type="button" disabled={running || !options.length || !image || !prompt.trim()} onClick={() => void runTest()}>{running ? <><LoaderCircle className="spin" size={17} />正在等待模型识图</> : <><Play size={17} />发送一次真实测试</>}</button>
        <small className="billing-warning">本操作会使用你自己的 API 额度；启动器不会自动重试或并发测试。</small>
      </div>
    </div>

    <div className={classNames('multimodal-result', result && `is-${result.status}`)} aria-live="polite">
      {!result && !running && <div className="result-empty"><Images size={24} /><div><strong>测试结果会显示在这里</strong><p>成功后同时显示回答、耗时和服务商返回的 Token；不支持图片时会明确标注。</p></div></div>}
      {running && <div className="result-running"><LoaderCircle className="spin" size={24} /><div><strong>模型正在读取图片</strong><p>最长等待 45 秒，期间不会发送第二次请求。</p></div></div>}
      {result && <><header><div><span className="result-status">{result.status === 'success' ? <><CheckCircle2 size={16} />识图成功</> : result.status === 'unsupported' ? <><CircleAlert size={16} />模型不支持图片</> : <><CircleAlert size={16} />调用失败</>}</span><strong>{options.find((item) => item.value === `${result.provider}::${result.model}`)?.label || `${result.provider} · ${result.model}`}</strong></div><div className="result-metrics"><span>{result.latencyMs.toLocaleString('zh-CN')} ms</span>{result.usage && <><span>输入 {result.usage.inputTokens.toLocaleString('zh-CN')}</span><span>输出 {result.usage.outputTokens.toLocaleString('zh-CN')}</span></>}</div></header>{result.text && <div className="model-answer">{result.text}</div>}{result.error && <div className="model-test-error">{result.error}</div>}</>}
    </div>
  </section>
}

function ModelsPage({ snapshot, busy, onSave, onRemove, onSetActive, onRefreshUsage, onTest }: {
  snapshot: LauncherSnapshot
  busy: string
  onSave: (draft: ModelProviderDraft) => Promise<boolean>
  onRemove: (providerId: string) => void
  onSetActive: (provider: string, model: string) => void
  onRefreshUsage: () => void
  onTest: (request: MultimodalTestRequest) => Promise<MultimodalTestResult>
}): ReactNode {
  const [mode, setMode] = useState<'connections' | 'test'>('connections')
  const [dialogView, setDialogView] = useState<'closed' | 'picker' | 'editor'>('closed')
  const [editorOrigin, setEditorOrigin] = useState<'add' | 'edit'>('add')
  const [draft, setDraft] = useState<ModelProviderDraft>()
  const [modelLines, setModelLines] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [templateScope, setTemplateScope] = useState<'china' | 'global' | 'all'>('china')
  const [templatePage, setTemplatePage] = useState(0)
  const [connectionPage, setConnectionPage] = useState(0)
  const dialogCloseRef = useRef<HTMLButtonElement>(null)
  const providers = snapshot.modelHub.providers
  const availableTemplates = snapshot.modelHub.templates.filter((template) => template.custom || !providers.some((provider) => provider.id === template.id))
  const scopedTemplates = availableTemplates.filter((template) => templateScope === 'all'
    || (templateScope === 'china' ? template.region === 'china' : template.region !== 'china'))
  const templatePageSize = 9
  const templatePageCount = Math.max(1, Math.ceil(scopedTemplates.length / templatePageSize))
  const safeTemplatePage = Math.min(templatePage, templatePageCount - 1)
  const visibleTemplates = scopedTemplates.slice(safeTemplatePage * templatePageSize, (safeTemplatePage + 1) * templatePageSize)
  const connectionPageSize = 4
  const connectionPageCount = Math.max(1, Math.ceil(providers.length / connectionPageSize))
  const safeConnectionPage = Math.min(connectionPage, connectionPageCount - 1)
  const visibleProviders = providers.slice(safeConnectionPage * connectionPageSize, (safeConnectionPage + 1) * connectionPageSize)
  const activeProvider = providers.find((item) => item.id === snapshot.modelHub.active.provider)
  const activeUsage = snapshot.modelHub.usage[`${snapshot.modelHub.active.provider}:${snapshot.modelHub.active.model}`]
  const formatTokens = (value: number): string => new Intl.NumberFormat('zh-CN').format(value)

  const closeDialog = (): void => {
    setDialogView('closed')
    setDraft(undefined)
    setModelLines('')
    setShowKey(false)
  }
  useEffect(() => {
    if (dialogView === 'closed') return
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeDialog() }
    window.addEventListener('keydown', keydown)
    window.requestAnimationFrame(() => dialogCloseRef.current?.focus())
    return () => window.removeEventListener('keydown', keydown)
  }, [dialogView])

  const openPicker = (): void => {
    setTemplateScope('china')
    setTemplatePage(0)
    setDialogView('picker')
  }
  const startEdit = (template: ModelProviderTemplate, origin: 'add' | 'edit' = 'add'): void => {
    const existing = providers.find((item) => item.id === template.id)
    const recommendedModels = template.suggestedModels.filter((model) => model.recommended)
    const next: ModelProviderDraft = existing ? {
      id: existing.id, name: existing.name, api: existing.api, baseURL: existing.baseURL,
      models: existing.models, docsUrl: existing.docsUrl, billingUrl: existing.billingUrl, custom: existing.custom
    } : {
      id: template.id === 'custom' ? `custom-${Date.now().toString(36).slice(-4)}` : template.id,
      name: template.name, api: template.api, baseURL: template.baseURL,
      models: template.custom ? [] : (recommendedModels.length ? recommendedModels : template.suggestedModels.slice(0, 1)), docsUrl: template.docsUrl, billingUrl: template.billingUrl, custom: template.custom
    }
    setEditorOrigin(origin)
    setDraft(next)
    setModelLines(next.models.map((model) => `${model.id}${model.name !== model.id ? ` | ${model.name}` : ''}`).join('\n'))
    setShowKey(false)
    setDialogView('editor')
  }
  const submit = async (): Promise<void> => {
    if (!draft) return
    const customModels = modelLines.split(/[\n,]+/).map((line) => {
      const parts = line.split('|').map((part) => part.trim())
      const id = parts[0] || ''
      return { id, name: parts[1] || id }
    }).filter((model) => model.id)
    const saved = await onSave({ ...draft, models: draft.custom ? customModels : draft.models })
    if (saved) closeDialog()
  }

  const templateForProvider = (provider: typeof providers[number]): ModelProviderTemplate => snapshot.modelHub.templates.find((template) => template.id === provider.id) || {
    id: provider.id, name: provider.name, description: '', region: provider.custom ? 'custom' : 'global', api: provider.api,
    baseURL: provider.baseURL, apiKeyEnv: provider.apiKeyEnv, docsUrl: provider.docsUrl || '', billingUrl: provider.billingUrl,
    custom: provider.custom, featured: false, catalogUpdatedAt: '本机连接', suggestedModels: provider.models
  }
  const activeDraftTemplate = draft ? snapshot.modelHub.templates.find((template) => template.id === draft.id) : undefined

  return (
    <div className="model-hub-layout model-hub-screen">
      <Card className="active-model-card">
        <div className="active-model-copy"><h2>{snapshot.modelHub.active.displayName}</h2><p>与 Harness 网页双向同步 · 切换只影响新会话</p></div>
        <label className="model-switcher"><span>切换已保存模型</span><select value={`${snapshot.modelHub.active.provider}::${snapshot.modelHub.active.model}`} onChange={(event) => {
          const [provider, model] = event.target.value.split('::')
          if (provider && model) onSetActive(provider, model)
        }}>
          {providers.flatMap((provider) => provider.models.map((model) => <option key={`${provider.id}:${model.id}`} value={`${provider.id}::${model.id}`}>{provider.name} · {model.name}{provider.configured ? '' : '（待填 Key）'}</option>))}
        </select></label>
        <div className="active-model-status"><span className={classNames('soft-badge', activeProvider?.configured ? 'green' : 'blue')}>{activeProvider?.configured ? 'Key 已加密保存' : '需要配置 API Key'}</span><small>{activeProvider?.baseURL}</small></div>
      </Card>

      {snapshot.modelHub.message && <div className="model-message"><Info size={15} />{snapshot.modelHub.message}</div>}

      <div className="model-mode-tabs" role="tablist" aria-label="模型目录功能">
        <button type="button" role="tab" aria-selected={mode === 'connections'} className={mode === 'connections' ? 'active' : ''} onClick={() => setMode('connections')}><Library size={16} />我的模型</button>
        <button type="button" role="tab" aria-selected={mode === 'test'} className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}><Images size={16} />多模态实测</button>
      </div>

      {mode === 'test' ? <MultimodalTestLab snapshot={snapshot} onTest={onTest} /> : <>
      <div className="model-control-grid">
        <Card className="model-connections-card" title="我的模型连接" action={<button className="primary-button add-model-button" onClick={openPicker}><Plus size={15} />添加模型</button>}>
          <p className="model-section-intro">这里只显示已保存的连接。已知平台从官方目录勾选模型，自定义服务才需要手填参数。</p>
          <div className="provider-connection-list">
            {visibleProviders.map((provider) => <div className="provider-connection-row" key={provider.id}><div className="provider-monogram">{provider.name.slice(0, 2)}</div><div><h2>{provider.name}</h2><p>{provider.models.map((model) => model.name).join(' · ')}</p><small>{provider.configured ? `Key 已安全保存 · ${provider.models.length} 个模型` : `尚未保存 Key · ${provider.models.length} 个模型`}</small></div><div className="provider-actions"><button className="quiet-button" onClick={() => startEdit(templateForProvider(provider), 'edit')}>{provider.custom ? '设置参数' : '管理模型'}</button>{provider.id !== 'deepseek-official' && <button className="icon-danger" aria-label={`移除${provider.name}`} onClick={() => onRemove(provider.id)}><Trash2 size={15} /></button>}</div></div>)}
          </div>
          {connectionPageCount > 1 && <div className="compact-pagination" aria-label="模型连接分页"><button type="button" disabled={safeConnectionPage === 0} onClick={() => setConnectionPage(Math.max(0, safeConnectionPage - 1))}><ChevronLeft size={15} />上一页</button><span>{safeConnectionPage + 1} / {connectionPageCount}</span><button type="button" disabled={safeConnectionPage >= connectionPageCount - 1} onClick={() => setConnectionPage(Math.min(connectionPageCount - 1, safeConnectionPage + 1))}>下一页<ChevronRight size={15} /></button></div>}
        </Card>

        <Card className="model-usage-card" title="当前模型用量" action={<button className="quiet-button" disabled={busy === 'model-usage'} onClick={onRefreshUsage}><RefreshCw size={14} className={busy === 'model-usage' ? 'spin' : ''} />刷新</button>}>
          <div className="usage-grid">
            <div><span>请求</span><strong>{activeUsage?.requests || 0}</strong></div>
            <div><span>输入 Token</span><strong>{formatTokens(activeUsage?.inputTokens || 0)}</strong></div>
            <div><span>输出 Token</span><strong>{formatTokens(activeUsage?.outputTokens || 0)}</strong></div>
            <div><span>缓存读取</span><strong>{formatTokens(activeUsage?.cacheReadTokens || 0)}</strong></div>
          </div>
          <div className="usage-note"><BadgeDollarSign size={16} /><p><strong>仅统计 Harness 本地会话。</strong>金额和余额以服务商账单为准。</p></div>
          {activeProvider?.billingUrl && <button className="quiet-button" onClick={() => openExternal(activeProvider.billingUrl!)}>打开服务商用量账单<ExternalLink size={14} /></button>}
          <div className="model-security-strip"><ShieldCheck size={16} /><span>API Key 同步到 Harness 可写凭据，并在 Windows 安全存储保留加密镜像。</span></div>
        </Card>
      </div>
      </>}

      {dialogView !== 'closed' && <div className="model-dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }}>
        <section className={classNames('model-dialog', dialogView === 'editor' && 'is-editor')} role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
          {dialogView === 'picker' ? <>
            <header className="model-dialog-header"><div><h2 id="model-dialog-title">添加模型连接</h2><p>先选择平台；未保存的模型不会出现在切换列表。</p></div><button ref={dialogCloseRef} type="button" className="icon-button" aria-label="关闭模型列表" onClick={closeDialog}><X size={17} /></button></header>
            <div className="model-dialog-body provider-picker-body">
              <div className="provider-picker-toolbar"><div className="provider-scope-tabs" aria-label="模型平台范围">
                <button type="button" aria-pressed={templateScope === 'china'} onClick={() => { setTemplateScope('china'); setTemplatePage(0) }}>国内平台</button>
                <button type="button" aria-pressed={templateScope === 'global'} onClick={() => { setTemplateScope('global'); setTemplatePage(0) }}>海外与自定义</button>
                <button type="button" aria-pressed={templateScope === 'all'} onClick={() => { setTemplateScope('all'); setTemplatePage(0) }}>全部</button>
              </div><span>{scopedTemplates.length} 个可添加平台</span></div>
              <div className="provider-picker-grid">
                {visibleTemplates.map((template) => <button className="provider-choice" key={template.id} type="button" onClick={() => startEdit(template, 'add')}><span className="provider-monogram">{template.name.slice(0, 2)}</span><span><strong>{template.name}</strong><small>{template.description}</small></span><ChevronRight size={17} /></button>)}
              </div>
            </div>
            <footer className="model-dialog-footer"><div className="compact-pagination"><button type="button" disabled={safeTemplatePage === 0} onClick={() => setTemplatePage(Math.max(0, safeTemplatePage - 1))}><ChevronLeft size={15} />上一页</button><span>{safeTemplatePage + 1} / {templatePageCount}</span><button type="button" disabled={safeTemplatePage >= templatePageCount - 1} onClick={() => setTemplatePage(Math.min(templatePageCount - 1, safeTemplatePage + 1))}>下一页<ChevronRight size={15} /></button></div><button type="button" className="quiet-button" onClick={closeDialog}>取消</button></footer>
          </> : draft ? <form className="provider-dialog-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <header className="model-dialog-header"><div className="model-dialog-title-row">{editorOrigin === 'add' && <button type="button" className="icon-button" aria-label="返回模型列表" onClick={() => { setDialogView('picker'); setDraft(undefined); setModelLines('') }}><ChevronLeft size={17} /></button>}<div><h2 id="model-dialog-title">{editorOrigin === 'edit' ? `设置 ${draft.name}` : `添加 ${draft.name}`}</h2><p>{draft.custom ? '填写自定义接口参数；保存后才会进入全局切换列表。' : '选择官方模型并填写 Key；接口地址和模型 ID 已锁定。'}</p></div></div><button ref={dialogCloseRef} type="button" className="icon-button" aria-label="关闭模型设置" onClick={closeDialog}><X size={17} /></button></header>
            <div className="model-dialog-body provider-editor-body"><div className="provider-form-grid">
              {draft.custom && <><label><span>连接名称</span><input required autoComplete="off" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label><span>连接 ID</span><input required autoComplete="off" disabled={providers.some((provider) => provider.id === draft.id)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></label>
              <label className="wide"><span>API 地址</span><input required autoComplete="off" value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label><span>兼容协议</span><select value={draft.api} onChange={(event) => setDraft({ ...draft, api: event.target.value as ModelProviderDraft['api'] })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label></>}
              <label className={draft.custom ? '' : 'wide'}><span>API Key {providers.some((provider) => provider.id === draft.id) && <small>留空保留原 Key</small>}</span><div className="secret-input"><input type={showKey ? 'text' : 'password'} autoComplete="new-password" value={draft.apiKey || ''} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="与本机 Harness 网页安全同步" /><button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
              {draft.custom ? <label className="wide"><span>模型列表 <small>仅自定义服务手填，每行：模型 ID | 显示名称</small></span><textarea required value={modelLines} onChange={(event) => setModelLines(event.target.value)} rows={4} placeholder={'model-id | 模型显示名称\nmodel-id-pro | Pro'} /></label> : activeDraftTemplate ? <fieldset className="wide official-model-fieldset"><legend>选择官方模型</legend><div className="official-model-meta"><span>目录更新于 {activeDraftTemplate.catalogUpdatedAt}</span><button type="button" className="text-link" onClick={() => openExternal(activeDraftTemplate.docsUrl)}>查看官方目录<ExternalLink size={13} /></button></div><div className="official-model-options">{activeDraftTemplate.suggestedModels.map((model) => {
                const checked = draft.models.some((selected) => selected.id === model.id)
                return <label className={classNames('official-model-option', checked && 'is-selected')} key={model.id}><input type="checkbox" checked={checked} onChange={(event) => setDraft({ ...draft, models: event.target.checked ? [...draft.models.filter((selected) => selected.id !== model.id), { id: model.id, name: model.name }] : draft.models.filter((selected) => selected.id !== model.id) })} /><span><strong>{model.name}{model.recommended ? <em>推荐</em> : null}</strong><small>{model.description}</small><code>{model.id}</code></span></label>
              })}</div><p className="official-model-note"><ShieldCheck size={14} />模型 ID、接口地址与协议来自官方目录快照；实际可用范围仍以你的账号权限为准。</p></fieldset> : null}
            </div></div>
            <footer className="model-dialog-footer provider-editor-actions"><span><ShieldCheck size={14} />Key 不回显；启动器与 Harness 网页共用。</span><div><button type="button" className="quiet-button" onClick={closeDialog}>取消</button><button type="submit" className="primary-button" disabled={!snapshot.modelHub.secureStorageAvailable || busy === 'model-provider'}>{busy === 'model-provider' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{editorOrigin === 'edit' ? '保存设置' : '保存并加入切换器'}</button></div></footer>
          </form> : null}
        </section>
      </div>}
    </div>
  )
}

function NewsDetailSheet({ item, onClose }: { item: LauncherNewsItem; onClose: () => void }): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [detail, setDetail] = useState<LauncherNewsDetail>()
  const [error, setError] = useState('')
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', keydown); closeRef.current?.focus()
    return () => window.removeEventListener('keydown', keydown)
  }, [onClose])
  useEffect(() => {
    let active = true
    setDetail(undefined)
    setError('')
    if (!window.launcher) return () => { active = false }
    void window.launcher.newsDetail(item.id).then((value) => {
      if (active) setDetail(value)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '新闻详情暂时无法读取')
    })
    return () => { active = false }
  }, [item.id])
  const readingText = detail?.content || ''
  const showReadingText = readingText && readingText.trim() !== item.summary.trim()
  const paragraphs = showReadingText ? readingText.split(/\n+/).map((paragraph) => paragraph.trim()).filter(Boolean) : []
  return <div className="detail-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="detail-sheet news-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="news-detail-title">
    <header className="detail-sheet-header"><div><span className="news-detail-category">{item.category} · {item.sourceName || '公开来源'}</span><h2 id="news-detail-title">{item.title}</h2><p>{item.publishedAt} · {item.sourceCount} 个来源 · 热度 {Math.round(item.heat)}</p></div><button ref={closeRef} className="icon-button" aria-label="关闭新闻" onClick={onClose}><X size={17} /></button></header>
    <div className="detail-sheet-body">
      {window.launcher && !detail && !error && <div className="detail-loading"><LoaderCircle className="spin" size={15} />正在读取网站同一条新闻…</div>}
      {error && <div className="detail-loading is-error"><CircleAlert size={15} />{error}，先显示新闻摘要。</div>}
      <p className="detail-lead">{item.summary}</p>
      {paragraphs.length > 0 && <article className="news-reading"><header><strong>{detail?.contentLabel || '来源公开内容'}</strong><span>与 AI历史书网页使用同一条新闻数据</span></header><div>{paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 18)}`}>{paragraph}</p>)}</div></article>}
      {detail && detail.sources.length > 0 && <article className="news-sources"><h3>来源</h3>{detail.sources.map((source) => <button type="button" key={`${source.name}-${source.url}`} onClick={() => openExternal(source.url)}><span><strong>{source.name}</strong><small>{source.title}</small></span><ExternalLink size={14} /></button>)}</article>}
      <article className="detail-boundary"><ShieldCheck size={17} /><div><strong>阅读边界</strong><p>这里只展示网站同一条新闻的摘要与来源公开内容，不再添加通用的影响判断或行动建议；事实仍以原始来源为准。</p></div></article>
    </div>
    <footer className="detail-sheet-actions"><button className="primary-button" onClick={() => openExternal(item.url)}>查证原始来源<ExternalLink size={14} /></button></footer>
  </section></div>
}

function NewsPage({ snapshot, busy, onRefresh, onLogin }: { snapshot: LauncherSnapshot; busy: string; onRefresh: () => void; onLogin: () => void }): ReactNode {
  const discovery = snapshot.discovery
  const signedIn = snapshot.account.status === 'signed_in'
  const visibleNews = signedIn ? discovery.news : discovery.news.slice(0, 10)
  const [selectedNews, setSelectedNews] = useState<LauncherNewsItem>()
  return <div className="discovery-layout news-layout">
    <Card className="discovery-toolbar"><div><span className="eyebrow">PUBLIC READING · 免费阅读</span><h2>{signedIn ? `已在启动器内显示 ${visibleNews.length} 条` : '最新 10 条'}</h2><p>{signedIn ? '新闻摘要、正文线索与网站保持同源；原始链接只用于查证。' : '不登录也能在启动器内读摘要和公开正文线索；登录后继续展开更多条目。'}</p></div><button className="quiet-button" disabled={busy === 'discovery'} onClick={onRefresh}><RefreshCw size={14} className={busy === 'discovery' ? 'spin' : ''} />刷新</button></Card>
    {discovery.status === 'offline' && <div className="model-message"><CircleAlert size={15} />{discovery.message}</div>}
    <section className="news-feed" aria-label="最新新闻">
      {visibleNews.map((item, index) => <article className="news-row" tabIndex={0} aria-label={`${item.title}，双击阅读`} key={item.id} onDoubleClick={() => setSelectedNews(item)} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedNews(item) }}><span className="news-index">{String(index + 1).padStart(2, '0')}</span><span className="news-copy"><span><b>{item.category}</b><time>{item.publishedAt}</time></span><strong>{item.title}</strong><p>{item.summary}</p><small>{item.sourceName || '公开来源'} · {Math.max(1, item.sourceCount)} 个来源</small><em>双击在启动器内阅读</em></span><button className="news-source-button" aria-label={`使用默认浏览器查证${item.title}的来源`} title="用默认浏览器打开原始来源" onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openExternal(item.url) }}><ExternalLink size={16} /></button></article>)}
      {!discovery.news.length && <Card><EmptyState icon={<Bell />} title="新闻目录暂不可用" text="本地 Harness 功能不受影响，稍后重新刷新即可。" /></Card>}
      {!signedIn && discovery.news.length > 0 && <button className="login-more-card" onClick={onLogin}><span><KeyRound /></span><div><strong>在启动器内登录查看更多</strong><p>最新 10 条始终免费；登录后仍在当前新闻页继续阅读。</p></div><ArrowRight /></button>}
      {signedIn && visibleNews.length > 10 && <div className="signed-in-news-note"><CheckCircle2 size={15} />已登录，更多新闻已直接加载到启动器，没有跳转网页。</div>}
    </section>
    <aside className="hot-panel"><div className="section-heading"><div><span className="eyebrow">HOT RANKING</span><h2>热门排行</h2></div></div>{discovery.hotNews.map((item, index) => <button key={item.id} onClick={() => setSelectedNews(item)}><span>{index + 1}</span><strong>{item.title}</strong><small><TrendingUp size={12} />热度 {Math.round(item.heat)}</small></button>)}</aside>
    {selectedNews && <NewsDetailSheet item={selectedNews} onClose={() => setSelectedNews(undefined)} />}
  </div>
}

function GameDetailSheet({ game, onClose, onPlay }: { game: LauncherGameItem; onClose: () => void; onPlay: () => void }): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', keydown)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', keydown)
  }, [onClose])
  const playable = game.mode === 'hosted_playable' || game.mode === 'external_playable'
  const copy = async (): Promise<void> => {
    const value = `${game.title}\n\n${game.summary}\n\n类型：${game.category}\n标签：${game.tags.join('、')}\n来源：${game.sourceName || 'AI历史书游戏目录'}`
    if (window.launcher) await window.launcher.copyText(value)
    else await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return <div className="detail-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="detail-sheet game-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="game-detail-title">
    <header className="detail-sheet-header"><div><span className="eyebrow">AI GAME · 启动器内资料</span><h2 id="game-detail-title">{game.title}</h2><p>{game.sourceName || 'AI历史书游戏目录'}{game.stars ? ` · ★ ${game.stars.toLocaleString('zh-CN')}` : ''}</p></div><button ref={closeRef} className="icon-button" aria-label="关闭游戏资料" onClick={onClose}><X size={17} /></button></header>
    <div className="detail-sheet-body"><div className="game-detail-cover">{game.coverUrl ? <img src={game.coverUrl} alt={`${game.title}封面`} referrerPolicy="no-referrer" /> : <Gamepad2 />}</div><p className="detail-lead">{game.summary}</p><div className="tag-row detail-tags">{game.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><article className="detail-boundary"><Info size={17} /><div><strong>{playable ? '试玩说明' : '项目资料'}</strong><p>{playable ? '按钮只在真正开始试玩时打开受控游戏窗口；目录说明始终留在启动器。' : '这是开源或经典项目档案，不会把“查看详情”伪装成网页跳转。'}</p></div></article></div>
    <footer className="detail-sheet-actions"><button className="small-button" onClick={() => void copy()}><Copy size={16} />{copied ? '已复制' : '复制项目简介'}</button>{playable && <button className="primary-button" onClick={onPlay}><Play size={15} />进入试玩</button>}{game.sourceUrl && <button className="quiet-button" onClick={() => openExternal(game.sourceUrl!)}>打开源码或官网<ExternalLink size={14} /></button>}</footer>
  </section></div>
}

function GamesPage({ snapshot, busy, onRefresh, onPlay }: { snapshot: LauncherSnapshot; busy: string; onRefresh: () => void; onPlay: (slug: string) => void }): ReactNode {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'all' | LauncherSnapshot['discovery']['games'][number]['mode']>('all')
  const [visibleCount, setVisibleCount] = useState(18)
  const [selectedGame, setSelectedGame] = useState<LauncherGameItem>()
  const games = snapshot.discovery.games.filter((game) => (mode === 'all' || game.mode === mode) && `${game.title} ${game.summary} ${game.tags.join(' ')} ${game.sourceName || ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="stack-layout">
    <Card className="discovery-toolbar"><div><span className="eyebrow">AI GAME LAB · 在线目录</span><h2>{snapshot.discovery.games.length} 款试玩与项目已同步</h2><p>本站游戏在启动器内登录并试玩；官方试玩与开源项目清楚标注来源。</p></div><button className="quiet-button" disabled={busy === 'discovery'} onClick={onRefresh}><RefreshCw size={14} className={busy === 'discovery' ? 'spin' : ''} />刷新目录</button></Card>
    <Card className="catalog-toolbar game-catalog-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(18) }} placeholder="搜索游戏、玩法、标签或来源" /></div><div className="game-mode-tabs">{([['all', '全部'], ['hosted_playable', '站内试玩'], ['external_playable', '官方试玩'], ['source_only', '开源项目'], ['official_landmark', '经典项目']] as const).map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => { setMode(id); setVisibleCount(18) }}>{label}</button>)}</div></Card>
    <div className="game-discovery-grid">{games.slice(0, visibleCount).map((game) => { const playable = game.mode === 'hosted_playable' || game.mode === 'external_playable'; return <article className="game-discovery-card" key={game.slug}><div className="game-cover">{game.coverUrl ? <img src={game.coverUrl} alt={`${game.title}封面`} loading="lazy" referrerPolicy="no-referrer" /> : <Gamepad2 />}<span>{game.mode === 'hosted_playable' ? '站内试玩' : game.mode === 'external_playable' ? '官方试玩' : game.mode === 'official_landmark' ? '经典项目' : '源码与资料'}</span></div><div><div className="game-title-line"><h2>{game.title}</h2>{game.stars ? <small>★ {game.stars.toLocaleString('zh-CN')}</small> : null}</div><p>{game.summary}</p><div className="tag-row">{game.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><small className="game-source">{game.sourceName || 'AI历史书游戏目录'}</small><button className="primary-button" onClick={() => playable ? onPlay(game.slug) : setSelectedGame(game)}>{playable ? <Play size={15} /> : <Info size={15} />}{game.mode === 'hosted_playable' ? (snapshot.account.status === 'signed_in' ? '启动器内试玩' : '登录并试玩') : game.mode === 'external_playable' ? '打开官方试玩' : '启动器内看资料'}</button></div></article> })}</div>
    {!games.length && <Card><EmptyState icon={<Gamepad2 />} title="没有匹配的游戏" text="换一个分类或关键词，目录内容不会因筛选被删除。" /></Card>}
    {visibleCount < games.length && <button className="load-more-directory" onClick={() => setVisibleCount((count) => count + 18)}>继续显示 {Math.min(18, games.length - visibleCount)} 款</button>}
    {selectedGame && <GameDetailSheet game={selectedGame} onClose={() => setSelectedGame(undefined)} onPlay={() => onPlay(selectedGame.slug)} />}
  </div>
}

function CareersPage({ snapshot, onRefresh }: { snapshot: LauncherSnapshot; onRefresh: () => void }): ReactNode {
  const [query, setQuery] = useState('')
  const careers = snapshot.discovery.careers.filter((career) => `${career.title} ${career.industryName} ${career.summary} ${career.tasks.map((task) => task.title).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  const [selectedId, setSelectedId] = useState(snapshot.discovery.careers[0]?.id || '')
  useEffect(() => { if (!snapshot.discovery.careers.some((career) => career.id === selectedId)) setSelectedId(snapshot.discovery.careers[0]?.id || '') }, [snapshot.discovery.careers, selectedId])
  const selected = snapshot.discovery.careers.find((career) => career.id === selectedId) || careers[0]
  return <div className="career-directory-layout">
    <aside className="career-role-panel"><div className="career-role-heading"><div><span className="eyebrow">职业目录</span><strong>{snapshot.discovery.careers.length} 个职业</strong></div><button className="icon-button" aria-label="刷新职业目录" onClick={onRefresh}><RefreshCw size={14} /></button></div><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索职业或模块" /></div><div className="career-role-list" role="tablist" aria-label="职业列表">{careers.map((career) => <button role="tab" aria-selected={selected?.id === career.id} key={career.id} onClick={() => setSelectedId(career.id)}><span>{career.title}</span><small>{career.industryName}</small></button>)}</div></aside>
    <section className="career-workspace-panel">{selected ? <><header><div><span className="eyebrow">{selected.industryName}</span><h2>{selected.title}</h2><p>{selected.summary}</p></div><button className="quiet-button" title="教学属于长内容，将用电脑默认浏览器打开" onClick={() => openExternal(`https://ailishishu.com/careers/?role=${encodeURIComponent(selected.id)}`)}>用浏览器学习完整课程<ExternalLink size={13} /></button></header><div className="career-task-list">{selected.tasks.map((task, index) => <article key={task.id}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{task.title}</h3><p>{task.summary}</p><small>对应知识、工具、模型、Skill 与人工复核由在线职业目录持续更新</small></div></article>)}</div><div className="career-data-note"><RefreshCw size={15} /><span>职业与模块就在启动器内浏览；只有系统课程这种长内容才交给默认浏览器。</span></div></> : <EmptyState icon={<BriefcaseBusiness />} title="职业目录暂不可用" text="点击刷新重新读取网站职业数据。" />}</section>
  </div>
}

function WorkspacesPage({ snapshot, onChoose, onOpen }: { snapshot: LauncherSnapshot; onChoose: () => void; onOpen: (path: string) => void }): ReactNode {
  return (
    <div className="stack-layout">
      <Card className="workspace-hero">
        <span className="workspace-icon"><FolderCog /></span><div><span>当前工作区</span><h2>{snapshot.settings.workspace}</h2><p>Harness 会把这里作为默认 workspace root；用户数据仍单独保存在启动器数据目录。</p></div><button className="primary-button" onClick={onChoose}><Folder size={16} />选择工作区</button>
      </Card>
      <Card title="最近使用">
        {snapshot.workspaces.length ? <div className="workspace-list">{snapshot.workspaces.map((workspace) => <button key={workspace.path} onClick={() => onOpen(workspace.path)}><span className="workspace-list-icon"><Folder /></span><span><strong>{workspace.name}</strong><small>{workspace.path}</small></span>{workspace.pinned && <Pin size={14} fill="currentColor" />}<time>{new Date(workspace.lastOpenedAt).toLocaleDateString('zh-CN')}</time><ChevronRight size={16} /></button>)}</div> : <EmptyState icon={<Folder />} title="尚无最近工作区" text="选择一次项目目录后，它会出现在这里。" />}
      </Card>
    </div>
  )
}

function DiagnosticsPage({ snapshot, busy, onRefresh, onRepair, onSources }: { snapshot: LauncherSnapshot; busy: string; onRefresh: () => void; onRepair: () => void; onSources: () => void }): ReactNode {
  const failures = snapshot.environment.filter((item) => item.status === 'missing').length + snapshot.sources.filter((item) => item.status === 'unavailable').length
  return (
    <div className="diagnostics-layout">
      <Card className="diagnostic-banner">
        <span className={classNames('diagnostic-score', failures === 0 && 'healthy')}>{failures === 0 ? <ShieldCheck /> : <CircleAlert />}</span><div><span>诊断结论</span><h2>{failures === 0 ? '本机环境可以运行 Harness' : `发现 ${failures} 个需要处理的问题`}</h2><p>{failures === 0 ? '本地组件完整；离线源不会阻止使用内置版本。' : '先运行快速修复，再重新检测下载源。'}</p></div><button className="primary-button" disabled={!!busy} onClick={onRepair}><Wrench size={16} />快速修复</button>
      </Card>
      <Card title="组件检查" action={<button className="quiet-button" onClick={onRefresh}><RefreshCw size={15} />重新检查</button>}><EnvironmentRows items={snapshot.environment} /></Card>
      <Card title="网络源检查" action={<button className="quiet-button" onClick={onSources}><Globe2 size={15} />测试全部</button>}><SourceRows sources={snapshot.sources} /></Card>
      <Card className="diagnostic-logs" title="完整运行日志" action={<span className="muted-label">日志不会包含 API Key</span>}><Logs snapshot={snapshot} expanded /></Card>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }): ReactNode {
  return <button type="button" role="switch" aria-checked={checked} className={classNames('toggle', checked && 'on')} onClick={() => onChange(!checked)}><span /></button>
}

function SettingsPage({ snapshot, onSave }: { snapshot: LauncherSnapshot; onSave: (settings: LauncherSettings) => void }): ReactNode {
  const [draft, setDraft] = useState(snapshot.settings)
  useEffect(() => setDraft(snapshot.settings), [snapshot.settings])
  const updateSource = (index: number, patch: Partial<LauncherSettings['sources'][number]>): void => {
    setDraft((current) => ({ ...current, sources: current.sources.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : source) }))
  }
  return (
    <div className="settings-layout">
      <Card title="启动行为">
        <label className="field-label"><span>默认端口<small>Harness Web 服务监听的本地端口</small></span><input type="number" min={1024} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></label>
        <label className="field-label"><span>启动后自动打开<small>服务就绪后使用系统默认浏览器打开</small></span><Toggle checked={draft.autoOpen} onChange={(autoOpen) => setDraft({ ...draft, autoOpen })} /></label>
        <label className="field-label"><span>安装方式<small>小白推荐 npm 发布包；源码模式需要 Git</small></span><select value={draft.installMode} onChange={(event) => setDraft({ ...draft, installMode: event.target.value as LauncherSettings['installMode'] })}><option value="package">整合包 / npm（推荐）</option><option value="source">Git 源码模式（高级）</option></select></label>
      </Card>
      <Card title="更新保护">
        <label className="field-label"><span>更新前备份用户数据<small>DeepSeek Harness 预发行阶段不承诺旧格式兼容</small></span><Toggle checked={draft.backupBeforeUpdate} onChange={(backupBeforeUpdate) => setDraft({ ...draft, backupBeforeUpdate })} /></label>
        <label className="field-label"><span>保留备份数量<small>超过数量后由后续清理流程处理</small></span><select value={draft.keepBackups} onChange={(event) => setDraft({ ...draft, keepBackups: Number(event.target.value) })}><option value={1}>1 份</option><option value={3}>3 份</option><option value={5}>5 份</option></select></label>
        <label className="field-label"><span>更新通道<small>稳定版优先；预览版更快获得新能力</small></span><select value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: event.target.value as LauncherSettings['channel'] })}><option value="stable">稳定版</option><option value="preview">预览版</option></select></label>
      </Card>
      <Card className="source-settings" title="下载与仓库源">
        <p className="card-intro">GitHub 可达时优先使用；Gitee 与 OSS 地址填好后会参与自动择优。npmmirror 负责 npm 软件包和插件依赖。</p>
        {draft.sources.map((source, index) => (
          <div className="source-setting-row" key={source.id}>
            <Toggle checked={source.enabled} onChange={(enabled) => updateSource(index, { enabled })} />
            <span className={`source-logo source-${source.id}`}>{source.id === 'github' ? <Github size={15} /> : source.id === 'oss' ? <CloudDownload size={15} /> : source.name.slice(0, 1)}</span>
            <label><strong>{source.name}</strong><small>{source.kind}</small></label>
            <input value={source.baseUrl} onChange={(event) => updateSource(index, { baseUrl: event.target.value })} placeholder={`${source.name} 地址，后续可填写`} />
          </div>
        ))}
        <div className="settings-actions"><span>设置存储在本机用户目录，不会提交到项目仓库。</span><button className="primary-button" onClick={() => onSave(draft)}><Check size={16} />保存设置</button></div>
      </Card>
      <Card className="source-settings" title="皮肤商店源">
        <label className="field-label"><span>签名皮肤目录<small>默认使用 Gitee 公共仓库，无需登录；目录签名不通过时自动回退。</small></span><input value={draft.skinCatalogUrl} onChange={(event) => setDraft({ ...draft, skinCatalogUrl: event.target.value })} /></label>
      </Card>
      <Card className="source-settings" title="宠物商店源">
        <label className="field-label"><span>签名宠物目录<small>只接受签名通过的图片目录；宠物媒体按需下载并校验完整性。</small></span><input value={draft.petCatalogUrl} onChange={(event) => setDraft({ ...draft, petCatalogUrl: event.target.value })} /></label>
      </Card>
    </div>
  )
}

export default function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot>(mockSnapshot)
  const [page, setPage] = useState<PageId>('home')
  const [busy, setBusy] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    if (!window.launcher) return
    void window.launcher.getSnapshot().then(setSnapshot)
    return window.launcher.onSnapshot(setSnapshot)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const currentPage = pageTitles[page]
  const statusLabel = useMemo(() => snapshot.runStatus === 'running' ? '运行中' : snapshot.runStatus === 'starting' ? '启动中' : snapshot.runStatus === 'error' ? '需要处理' : '未运行', [snapshot.runStatus])

  const run = async (name: string, action?: () => Promise<LauncherSnapshot | void>, demo?: () => void): Promise<boolean> => {
    if (busy) return false
    setBusy(name)
    try {
      if (action) {
        const result = await action()
        if (result) setSnapshot(result)
      } else if (demo) {
        demo()
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSnapshot((current) => ({ ...current, modelHub: { ...current.modelHub, message } }))
      return false
    } finally {
      setBusy('')
    }
  }

  const start = (): void => {
    if (window.launcher) void run('start', () => window.launcher!.startHarness())
    else {
      setSnapshot((current) => ({ ...current, runStatus: 'starting' }))
      window.setTimeout(() => setSnapshot((current) => ({ ...current, runStatus: 'running', serviceUrl: `http://127.0.0.1:${current.settings.port}`, logs: [...current.logs, { id: Date.now(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'INFO', message: `Harness 已就绪：http://127.0.0.1:${current.settings.port}` }] })), 900)
    }
  }
  const stop = (): void => {
    if (window.launcher) void run('stop', () => window.launcher!.stopHarness())
    else setSnapshot((current) => ({ ...current, runStatus: 'stopped', serviceUrl: undefined }))
  }
  const chooseWorkspace = (): void => { if (window.launcher) void run('workspace', () => window.launcher!.chooseWorkspace()) }
  const checkSources = (): void => {
    if (window.launcher) void run('sources', () => window.launcher!.checkSources())
    else setSnapshot((current) => ({ ...current, sources: current.sources.map((source) => source.enabled ? { ...source, status: 'available', latencyMs: source.latencyMs || 68 } : source) }))
  }
  const repair = (): void => { if (window.launcher) void run('repair', () => window.launcher!.repair()) }
  const refresh = (): void => { if (window.launcher) void run('refresh', () => window.launcher!.refreshEnvironment()) }
  const install = (version: string): void => { if (window.launcher) void run('install', () => window.launcher!.installHarness(version)) }
  const downloadLauncherUpdate = (): void => { if (window.launcher) void run('launcher-update', () => window.launcher!.downloadLauncherUpdate()) }
  const rollback = (version: string): void => { if (window.launcher) void run('rollback', () => window.launcher!.rollbackHarness(version)) }
  const pluginAction = (action: 'install' | 'update' | 'remove', spec: string): void => { if (window.launcher) void run('plugin', () => window.launcher!.pluginAction(action, spec)) }
  const refreshDiscovery = (): void => {
    if (window.launcher) void run('discovery', () => window.launcher!.refreshDiscovery())
  }
  const accountLogin = (): void => { if (window.launcher) void run('account-login', () => window.launcher!.accountLogin()) }
  const accountLogout = (): void => { if (window.launcher) void run('account-logout', () => window.launcher!.accountLogout()) }
  const playGame = (slug: string): void => { if (window.launcher) void run(`game-${slug}`, () => window.launcher!.playGame(slug)) }
  const toggleFavorite = (id: string): void => {
    if (window.launcher) void run('favorite', () => window.launcher!.toggleResourceFavorite(id))
  }
  const queueResource = (id: string): void => { if (window.launcher) void run(`library-${id}`, () => window.launcher!.queueResource(id)) }
  const installLibraryResource = (id: string): void => { if (window.launcher) void run(`library-${id}`, () => window.launcher!.installLibraryResource(id)) }
  const removeLibraryResource = (id: string): void => { if (window.launcher) void run(`library-${id}`, () => window.launcher!.removeLibraryResource(id)) }
  const saveModelProvider = async (draft: ModelProviderDraft): Promise<boolean> => {
    if (window.launcher) return run('model-provider', () => window.launcher!.saveModelProvider(draft))
    return run('model-provider', undefined, () => setSnapshot((current) => {
      const connection = {
        id: draft.id, name: draft.name, api: draft.api, baseURL: draft.baseURL,
        apiKeyEnv: `${draft.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`, configured: Boolean(draft.apiKey), secureStorage: true,
        custom: Boolean(draft.custom), updatedAt: new Date().toISOString(), docsUrl: draft.docsUrl, billingUrl: draft.billingUrl, models: draft.models
      }
      const existingIndex = current.modelHub.providers.findIndex((provider) => provider.id === draft.id)
      const providers = existingIndex >= 0
        ? current.modelHub.providers.map((provider, index) => index === existingIndex ? connection : provider)
        : [...current.modelHub.providers, connection]
      return { ...current, modelHub: { ...current.modelHub, providers, message: `${draft.name} 已加入模型切换列表` } }
    }))
  }
  const removeModelProvider = (providerId: string): void => {
    if (window.launcher) void run('model-provider', () => window.launcher!.removeModelProvider(providerId))
  }
  const setActiveModel = (provider: string, model: string): void => {
    if (window.launcher) void run('model-active', () => window.launcher!.setActiveModel(provider, model))
    else setSnapshot((current) => {
      const connection = current.modelHub.providers.find((item) => item.id === provider)
      const selected = connection?.models.find((item) => item.id === model)
      return selected ? { ...current, modelHub: { ...current.modelHub, active: { provider, model, displayName: selected.name } } } : current
    })
  }
  const refreshModelUsage = (): void => { if (window.launcher) void run('model-usage', () => window.launcher!.refreshModelUsage()) }
  const testMultimodal = async (request: MultimodalTestRequest): Promise<MultimodalTestResult> => {
    if (window.launcher) return window.launcher.testMultimodal(request)
    await new Promise((resolve) => window.setTimeout(resolve, 650))
    return {
      status: 'success', provider: request.provider, model: request.model,
      text: '演示结果：图片主体清晰，包含一个桌面应用界面。建议实际安装版使用已保存的 API Key 完成真实识图测试。',
      usage: { inputTokens: 218, outputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0 },
      latencyMs: 648, completedAt: new Date().toISOString()
    }
  }
  const refreshSkins = (): void => { if (window.launcher) void run('skins', () => window.launcher!.refreshSkins()) }
  const applySkin = (skinId: string): void => { if (window.launcher) void run(`skin-${skinId}`, () => window.launcher!.applySkin(skinId)) }
  const clearSkin = (): void => { if (window.launcher) void run('skin-clear', () => window.launcher!.clearSkin()) }
  const refreshPets = (): void => { if (window.launcher) void run('pets', () => window.launcher!.refreshPets()) }
  const applyPet = (petId: string): void => { if (window.launcher) void run(`pet-${petId}`, () => window.launcher!.applyPet(petId)) }
  const clearPet = (): void => { if (window.launcher) void run('pet-clear', () => window.launcher!.clearPet()) }
  const importPet = (): void => { if (window.launcher) void run('pet-import', () => window.launcher!.importPet()) }
  const removeCustomPet = (petId: string): void => { if (window.launcher) void run(`pet-remove-${petId}`, () => window.launcher!.removeCustomPet(petId)) }
  const saveSettings = (settings: LauncherSettings): void => {
    if (window.launcher) void run('settings', () => window.launcher!.saveSettings(settings))
    else setSnapshot((current) => ({ ...current, settings, sources: settings.sources.map((source) => ({ ...source, status: source.enabled && source.baseUrl ? 'checking' : 'unconfigured' })) }))
  }

  return (
    <div className="app-shell">
      <aside className={classNames('sidebar', sidebarOpen && 'sidebar-open')}>
        <div className="brand"><BrandMark /><div><strong>DeepSeek</strong><span>深蓝 Harness 启动器</span></div></div>
        <nav>{navigation.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id); setSidebarOpen(false) }}><Icon size={18} /><span>{item.label}</span>{page === item.id && <i />}</button> })}</div>)}</nav>
        <div className="sidebar-account">
          {snapshot.account.status === 'signed_in'
            ? <><button className="sidebar-account-main" onClick={() => setPage('library')} title="打开账号同步的本机能力"><span className="account-avatar">{snapshot.account.user?.name.slice(0, 1)}</span><span><strong>{snapshot.account.user?.name}</strong><small>AI历史书账号 · 会话已加密记住</small></span></button><button className="sidebar-account-exit" aria-label="退出 AI历史书账号" onClick={accountLogout}><LogOut size={15} /></button></>
            : <button className="sidebar-login" disabled={busy === 'account-login'} onClick={accountLogin}><KeyRound size={17} /><span><strong>登录 AI历史书</strong><small>同步收藏，参与评论</small></span></button>}
        </div>
        <div className="sidebar-status"><span><StatusDot status={snapshot.runStatus === 'running' ? 'ready' : snapshot.runStatus === 'error' ? 'missing' : 'warning'} />{statusLabel}</span><strong>DeepSeek Harness</strong><small>{snapshot.activeHarnessVersion} · {snapshot.distributionMode === 'offline' ? '完整离线版' : '在线轻量版'}</small></div>
        <div className="sidebar-version"><Info size={14} />v{snapshot.launcherVersion}<span>{snapshot.platform}</span></div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

      <main className="main-area">
        <header className="titlebar">
          <button className="mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu /></button>
          <div className="title-copy">
            <h1>{currentPage.title}</h1>
            {page === 'home'
              ? <a className="course-link" href="https://ailishishu.com/learn/deepseek-harness/" target="_blank" rel="noreferrer">{currentPage.subtitle}：https://ailishishu.com/learn/deepseek-harness/ <ExternalLink size={12} /></a>
              : <p>{currentPage.subtitle}</p>}
          </div>
          <div className="title-actions">
            <span className={classNames('distribution-badge', snapshot.distributionMode)}>{snapshot.distributionMode === 'offline' ? '完整离线版' : '在线轻量版'}</span>
            <button onClick={checkSources}><Bell size={18} /><span>检查更新</span></button>
            <button aria-label="切换主题" onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>
            <button aria-label="打开设置" onClick={() => setPage('settings')}><Settings size={18} /></button>
          </div>
          <WindowControls />
        </header>

        <div className="page-scroll">
          {page === 'home' && <HomePage snapshot={snapshot} busy={busy} onStart={start} onStop={stop} onRepair={repair} onWorkspace={chooseWorkspace} onSources={checkSources} />}
          {page === 'skins' && <SkinStorePage snapshot={snapshot} busy={busy} onRefresh={refreshSkins} onApply={applySkin} onClear={clearSkin} />}
          {page === 'pets' && <PetStorePage snapshot={snapshot} busy={busy} onRefresh={refreshPets} onApply={applyPet} onClear={clearPet} onImport={importPet} onRemove={removeCustomPet} />}
          {page === 'versions' && <VersionsPage snapshot={snapshot} busy={busy} onInstall={install} onRollback={rollback} onSources={checkSources} onLauncherUpdate={downloadLauncherUpdate} />}
          {(page === 'prompts' || page === 'skills' || page === 'workflows' || page === 'knowledge' || page === 'tools' || page === 'agents') && <ResourceDirectoryPage kind={page} snapshot={snapshot} busy={busy} onRefresh={refreshDiscovery} onToggleFavorite={toggleFavorite} onQueue={queueResource} onInstall={installLibraryResource} onLogin={accountLogin} />}
          {page === 'library' && <ResourceLibraryPage snapshot={snapshot} busy={busy} onInstall={installLibraryResource} onRemove={removeLibraryResource} onOpen={(target) => void window.launcher?.openPath(target)} />}
          {page === 'models' && <ModelsPage snapshot={snapshot} busy={busy} onSave={saveModelProvider} onRemove={removeModelProvider} onSetActive={setActiveModel} onRefreshUsage={refreshModelUsage} onTest={testMultimodal} />}
          {page === 'news' && <NewsPage snapshot={snapshot} busy={busy} onRefresh={refreshDiscovery} onLogin={accountLogin} />}
          {page === 'games' && <GamesPage snapshot={snapshot} busy={busy} onRefresh={refreshDiscovery} onPlay={playGame} />}
          {page === 'careers' && <CareersPage snapshot={snapshot} onRefresh={refreshDiscovery} />}
          {page === 'workspaces' && <WorkspacesPage snapshot={snapshot} onChoose={chooseWorkspace} onOpen={(path) => void window.launcher?.openPath(path)} />}
          {page === 'diagnostics' && <DiagnosticsPage snapshot={snapshot} busy={busy} onRefresh={refresh} onRepair={repair} onSources={checkSources} />}
          {page === 'settings' && <SettingsPage snapshot={snapshot} onSave={saveSettings} />}
        </div>
      </main>
    </div>
  )
}
