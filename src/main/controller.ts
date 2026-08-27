import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { access, appendFile, chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { bundledModels, bundledPlugins, bundledVersions } from './catalog'
import { FIXED_PET_CATALOG_URL, FIXED_SKIN_CATALOG_URL, launcherDataPaths, readConfig, setLauncherStorageRoot, writeConfig, type PersistedConfig } from './config'
import { fetchLatestNpmVersion, fetchSignedCatalog, isNewerVersion, mergeBundledRuntimeMirrors, readBundledRuntimeModules } from './manifest'
import { ensureRuntimeDirectory, hasBundledHarness, isExecutable, readPackageVersion, resolveRuntime, sanitizedProcessEnvironment, spawnNode } from './runtime'
import { RuntimeModuleStore, type RuntimeModuleInstallProgress } from './runtime-modules'
import { RUNTIME_MODULE_LABELS, describeRuntimeModuleUpdates, planRuntimeModuleUpdates, runtimeModulePlan } from './runtime-update-plan'
import { SkinStore, type SkinDownloadProgress } from './skins'
import { applyWindowsDesktopWallpaper, desktopWallpaperSource } from './desktop-wallpaper'
import { DynamicWallpaperManager } from './dynamic-wallpaper'
import { PetStore, type PetDownloadProgress } from './pets'
import { DesktopPetManager } from './desktop-pet'
import { PetBalanceBridge } from './pet-balance-bridge'
import { bundledLauncherUiVersion, type LauncherUiSelection } from './launcher-ui'
import { assertHarnessPortAvailable, validateHarnessPort } from './port-settings'
import { readPnpmProfileEnvironment } from './pnpm-profile'
import { installAppearanceRuntimeAtomically, prepareAppearanceProfile } from './appearance-profile'
import { HarnessBrowserHandoff, prepareHarnessNoBrowserPatch } from './harness-browser'
import { installedLauncherRoot, silentLauncherUpdateArgs } from './launcher-update'
import { cleanPluginOutput, pluginActionLabel, updatePluginProgress } from './plugin-operation'
import { pluginOperationTimeoutMs, pluginPnpmArguments, profileHasActivePlugin, type WebProfileManifest } from './plugin-policy'
import { ModelStore } from './model-store'
import { fetchDiscovery, fetchNewsDetail, fetchResourceDetail, loadingDiscovery } from './discovery'
import { AccountService, openContentWindow } from './account'
import { coreRuntimeMissing } from '../shared/environment-health'
import { desktopWallpaperCapability } from '../shared/desktop-wallpaper'
import type {
  EnvironmentItem,
  HarnessVersion,
  LauncherCommunityRequest,
  LauncherSettings,
  LauncherInstallationState,
  LauncherSnapshot,
  LauncherLibraryEntry,
  LauncherResourceItem,
  LauncherTask,
  LauncherTaskStep,
  LogLine,
  ModelProviderDraft,
  MultimodalTestRequest,
  MultimodalTestResult,
  PetPreviewResult,
  PetStoreState,
  PetTransferOperation,
  PluginOperationState,
  RuntimeModuleId,
  RuntimeModuleRelease,
  SkinPreviewResult,
  SkinStoreState,
  SkinTransferOperation,
  SourceConfig,
  SourceHealth
} from '../shared/types'

const MAX_LOG_LINES = 400
const PNPM_ALLOWED_BUILDS = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs'
]

function moduleStepProgress(phase: LauncherTaskStep['phase'], receivedBytes: number, totalBytes: number): number {
  if (phase === 'queued') return 0
  if (phase === 'source-check') return 1
  if (phase === 'source-ready' || phase === 'source-fallback') return 3
  if (phase === 'download') return 5 + Math.round(Math.min(1, totalBytes > 0 ? receivedBytes / totalBytes : 0) * 75)
  if (phase === 'verify') return 84
  if (phase === 'extract') return 90
  if (phase === 'probe') return 96
  return 100
}

function moduleStepStatus(phase: LauncherTaskStep['phase']): LauncherTaskStep['status'] {
  if (phase === 'queued') return 'queued'
  if (phase === 'source-check' || phase === 'source-ready' || phase === 'source-fallback') return 'checking'
  if (phase === 'download') return 'downloading'
  if (phase === 'verify') return 'verifying'
  if (phase === 'activate' || phase === 'completed') return 'completed'
  return 'installing'
}

function runtimeSourceLabel(source?: string): string {
  return source === 'github' ? 'GitHub 最终备用' : source === 'gitee' ? 'Gitee' : source === 'oss' ? 'OSS 国内镜像' : '下载渠道'
}

function pluginPackageName(packageSpec: string): string {
  return packageSpec.startsWith('@')
    ? packageSpec.split('@').slice(0, 2).join('@')
    : packageSpec.split('@', 1)[0]!
}

export class LauncherController {
  private config!: PersistedConfig
  private snapshot!: LauncherSnapshot
  private service?: ChildProcessWithoutNullStreams
  private nextLogId = 1
  private distributionMode: 'online' | 'offline' = 'offline'
  private readonly skinStore = new SkinStore()
  private dynamicWallpaper!: DynamicWallpaperManager
  private desktopPet!: DesktopPetManager
  private petBalanceBridge!: PetBalanceBridge
  private readonly petStore = new PetStore()
  private readonly accountService = new AccountService()
  private modelStore!: ModelStore
  private moduleStore!: RuntimeModuleStore
  private runtimeModules: RuntimeModuleRelease[] = []
  private bundledRuntimeModules: RuntimeModuleRelease[] = []
  private lastVerifiedCatalogAt?: string
  private onlinePreparationStarted = false
  private startHarnessPromise?: Promise<LauncherSnapshot>
  private pluginActionPromise?: Promise<LauncherSnapshot>
  private readonly browserHandoff = new HarnessBrowserHandoff()

  constructor(private readonly window: BrowserWindow, private readonly launcherUi?: LauncherUiSelection) {}

  async initialize(): Promise<void> {
    this.config = await readConfig()
    setLauncherStorageRoot(this.config.settings.storageRoot)
    this.dynamicWallpaper = new DynamicWallpaperManager(
      path.join(launcherDataPaths().skins, 'desktop-state.json'),
      path.join(launcherDataPaths().skins, 'desktop-host')
    )
    await this.dynamicWallpaper.initialize()
    this.moduleStore = new RuntimeModuleStore(launcherDataPaths().runtime)
    // Rewrite the sanitized shape once so legacy device-local favorites cannot linger
    // in launcher.json and be mistaken for AI历史书 account data.
    await writeConfig(this.config)
    this.modelStore = new ModelStore(this.config, (state) => {
      this.snapshot.modelHub = state
      this.log('INFO', state.message || 'Harness 网页模型配置已同步')
      this.emit()
    })
    this.desktopPet = new DesktopPetManager(
      launcherDataPaths().petDesktopState,
      path.join(launcherDataPaths().pets, 'desktop-host'),
      launcherDataPaths().pets,
      () => this.modelStore.deepSeekBalance()
    )
    await this.desktopPet.initialize()
    this.petBalanceBridge = new PetBalanceBridge(() => this.modelStore.deepSeekBalance())
    this.distributionMode = await hasBundledHarness() ? 'offline' : 'online'
    const sources = this.config.settings.sources.map((source) => this.initialSourceHealth(source))
    this.snapshot = {
      launcherVersion: app.getVersion(),
      launcherUiVersion: this.launcherUi?.version || await bundledLauncherUiVersion(),
      launcherUiSource: this.launcherUi?.source || 'bundled',
      platform: `${process.platform}-${process.arch}`,
      distributionMode: this.distributionMode,
      runStatus: 'stopped',
      launchProgress: { status: 'idle', progress: 0, message: '等待启动' },
      activeHarnessVersion: this.config.activeVersion,
      latestHarnessVersion: '0.1.1-rc.2',
      runtimeUpdates: { status: 'idle', items: [], modules: [] },
      environment: this.checkingEnvironment(),
      sources,
      tasks: [],
      logs: [],
      versions: bundledVersions.map((entry) => ({
        ...entry,
        installed: this.distributionMode === 'offline' && entry.version === this.config.activeVersion,
        active: this.distributionMode === 'offline' && entry.version === this.config.activeVersion,
        rollbackReady: false
      })),
      plugins: structuredClone(bundledPlugins),
      pluginOperation: { status: 'idle', progress: 0, message: '等待插件操作', files: [], restartRequired: false },
      models: structuredClone(bundledModels),
      modelHub: this.modelStore.state(),
      account: { status: 'checking', sessionRemembered: false },
      favorites: { status: 'signed_out', resourceIds: [] },
      resourceLibrary: structuredClone(this.config.resourceLibrary),
      discovery: loadingDiscovery(),
      workspaces: this.config.workspaces,
      skins: {
        status: 'loading',
        source: 'bundled',
        generatedAt: '',
        desktopWallpaper: this.dynamicWallpaper.state(),
        downloadedSkinIds: [],
        favoriteSkinIds: [],
        transfers: {},
        items: []
      },
      pets: {
        status: 'loading',
        source: 'bundled',
        generatedAt: '',
        desktopPet: this.desktopPet.state(),
        downloadedPetIds: [],
        favoritePetIds: [],
        transfers: {},
        sources: [],
        items: []
      },
      settings: this.config.settings,
      installation: await this.installationState()
    }
    this.bundledRuntimeModules = await readBundledRuntimeModules()
    this.runtimeModules = structuredClone(this.bundledRuntimeModules)
    this.log('INFO', `深蓝DeepSeekHarness启动器 ${app.getVersion()} 已启动`)
    this.log('INFO', `数据目录：${launcherDataPaths().root}`)
    this.log('INFO', `发行模式：${this.distributionMode === 'offline' ? '完整离线版' : '在线轻量版'}`)
    if (this.runtimeModules.length) this.log('INFO', `已加载内置运行目录（${this.runtimeModules.length} 个模块），在线目录不可用时仍可安装`)
    // The snapshot is complete at this point, so the renderer can paint the
    // launcher immediately. Model migration, account refresh and store
    // hydration continue in the background and emit their own state updates.
    // A slow file lock or network endpoint must never hold the first window.
    void this.finishInitialization()
  }

  private async finishInitialization(): Promise<void> {
    try {
      await this.modelStore.initialize()
      this.snapshot.modelHub = this.modelStore.state()
      this.log('INFO', `当前模型：${this.snapshot.modelHub.active.displayName}`)
    } catch (error) {
      this.snapshot.modelHub = this.modelStore.state('模型配置读取失败，可在模型目录重新保存')
      this.log('WARN', `模型配置初始化失败：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.petBalanceBridge.start()
      this.log('INFO', '宠物 DeepSeek 余额桥接已就绪（仅本机访问）')
    } catch (error) {
      this.log('WARN', `宠物余额桥接启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
    await this.refreshEnvironment()
    this.snapshot.account = await this.accountService.refresh()
    if (this.snapshot.account.status === 'signed_in') await this.refreshFavorites()
    await Promise.all([this.refreshSkins(), this.refreshPets()])
    void this.refreshDiscovery()
    if (this.config.settings.storageSetupCompleted) this.beginOnlinePreparation()
  }

  getSnapshot(): LauncherSnapshot {
    return structuredClone(this.snapshot)
  }

  isDynamicDesktopActive(): boolean {
    return this.dynamicWallpaper?.isRunning() === true
  }

  isDesktopPetActive(): boolean {
    return this.desktopPet?.isRunning() === true
  }

  beginDesktopPetDrag(senderId: number, position: unknown): void {
    this.desktopPet?.beginDrag(senderId, position)
  }

  moveDesktopPetDrag(senderId: number, position: unknown): void {
    this.desktopPet?.moveDrag(senderId, position)
  }

  async endDesktopPetDrag(senderId: number, position: unknown): Promise<void> {
    await this.desktopPet?.endDrag(senderId, position)
  }

  async desktopPetDeepSeekBalance(senderId: number) {
    return this.desktopPet?.deepSeekBalance(senderId)
  }

  isDesktopExperienceActive(): boolean {
    return this.isDynamicDesktopActive() || this.isDesktopPetActive()
  }

  async dispose(): Promise<void> {
    await this.dynamicWallpaper?.dispose()
    await this.desktopPet?.dispose()
    await this.petBalanceBridge?.dispose()
  }

  async refreshEnvironment(): Promise<LauncherSnapshot> {
    this.snapshot.environment = this.checkingEnvironment()
    this.emit()
    const paths = launcherDataPaths()
    const runtime = await resolveRuntime(paths.runtime, this.config.activeVersion)
    const dshPackage = path.join(path.dirname(path.dirname(runtime.dsh)), 'package.json')
    const dshVersion = await readPackageVersion(dshPackage)
    const nodeReady = await isExecutable(runtime.node)
    const pnpmReady = await isExecutable(runtime.pnpm)
    const packageManagerRelease = this.runtimeModules.find((module) => module.id === 'package-manager')
    this.snapshot.environment = [
      {
        id: 'node',
        label: '内置 Node.js',
        version: nodeReady ? '24.16.0' : undefined,
        status: nodeReady ? 'ready' : 'missing',
        detail: nodeReady ? '独立运行时可用，不修改系统环境' : '内置 Node.js 缺失'
      },
      {
        id: 'harness',
        label: 'Harness 核心',
        version: dshVersion,
        status: dshVersion ? 'ready' : 'missing',
        detail: dshVersion ? `${runtime.source === 'bundled' ? '整合包内置' : '在线安装'}版本` : '核心文件缺失，可执行快速修复'
      },
      {
        id: 'pnpm',
        label: '插件包管理器',
        version: pnpmReady ? '11.22.0' : packageManagerRelease?.version,
        status: pnpmReady || packageManagerRelease ? 'ready' : 'warning',
        detail: pnpmReady
          ? '用于安装和更新 Harness 插件'
          : packageManagerRelease
            ? '签名模块已就绪；首次安装插件时自动获取，不阻塞 Harness 启动'
            : '签名目录暂未提供该按需组件；不影响 Harness 核心启动'
      },
      {
        id: 'network',
        label: '更新网络',
        status: this.snapshot.sources.some((source) => source.status === 'available') ? 'ready' : 'warning',
        detail: this.distributionMode === 'offline' ? '离线时仍可启动整合包内置版本' : '首次安装需要连接 npmmirror 或 npm 官方源'
      }
    ]
    if (dshVersion) {
      this.snapshot.activeHarnessVersion = dshVersion
      this.snapshot.versions = await this.discoverVersions(dshVersion)
    }
    this.emit()
    return this.getSnapshot()
  }

  async checkSources(): Promise<LauncherSnapshot> {
    this.snapshot.sources = this.config.settings.sources.map((source) => this.initialSourceHealth(source, 'checking'))
    this.emit()
    const checked = await Promise.all(this.config.settings.sources.map((source) => this.checkSource(source)))
    this.snapshot.sources = checked
    const catalogSynced = await this.syncOnlineCatalog()
    if (!catalogSynced && this.snapshot.runtimeUpdates.status !== 'installing' && this.snapshot.runtimeUpdates.status !== 'restarting') {
      if (this.lastVerifiedCatalogAt) {
        await this.detectRuntimeUpdates()
        this.snapshot.runtimeUpdates.message = `本次联网刷新未取得新目录；继续使用 ${new Date(this.lastVerifiedCatalogAt).toLocaleString('zh-CN')} 已验签目录，当前版本不受影响`
      } else {
        this.snapshot.runtimeUpdates = {
          status: 'failed',
          items: [],
          modules: this.snapshot.runtimeUpdates.modules,
          checkedAt: new Date().toISOString(),
          message: '本次未取得通过签名校验的模块目录；已保留内置目录与当前版本'
        }
      }
    }
    const network = this.snapshot.environment.find((item) => item.id === 'network')
    if (network) {
      network.status = checked.some((source) => source.status === 'available' || source.status === 'slow') ? 'ready' : 'warning'
      network.detail = network.status === 'ready'
        ? '至少一个在线源可用'
        : this.distributionMode === 'offline' ? '在线源暂不可用，内置版本仍可启动' : '在线源暂不可用，轻量版无法完成首次安装'
    }
    this.emit()
    return this.getSnapshot()
  }

  async startHarness(): Promise<LauncherSnapshot> {
    if (this.startHarnessPromise) return this.startHarnessPromise
    const pending = this.startHarnessOnce()
    this.startHarnessPromise = pending
    try {
      return await pending
    } finally {
      if (this.startHarnessPromise === pending) this.startHarnessPromise = undefined
    }
  }

  private async startHarnessOnce(): Promise<LauncherSnapshot> {
    if (this.service && this.snapshot.runStatus !== 'error') {
      this.updateLaunchProgress('ready', 100, 'Harness 已在运行')
      return this.getSnapshot()
    }
    const browserCycle = this.browserHandoff.begin()
    this.snapshot.runStatus = 'starting'
    this.snapshot.serviceUrl = undefined
    this.updateLaunchProgress('preparing', 6, '正在检查 Harness 运行环境')
    try {
      const paths = launcherDataPaths()
      let runtime = await resolveRuntime(paths.runtime, this.config.activeVersion)
      if (!(await isExecutable(runtime.dsh))) {
        if (this.distributionMode === 'online') {
          this.updateLaunchProgress('preparing', 12, '首次启动，正在获取 Harness 核心')
          this.log('INFO', '在线轻量版正在首次获取 Harness 核心')
          await this.installHarness(this.config.activeVersion)
          runtime = await resolveRuntime(paths.runtime, this.config.activeVersion)
        }
        if (!(await isExecutable(runtime.dsh))) {
          this.snapshot.runStatus = 'error'
          this.updateLaunchProgress('failed', 18, '未找到 Harness 核心，请先运行快速修复')
          this.log('ERROR', '未找到 Harness 核心，请检查网络后执行快速修复')
          this.emit()
          return this.getSnapshot()
        }
      }
      this.updateLaunchProgress('preparing', 28, '运行环境已就绪，正在准备工作区')
      await mkdir(paths.dshHome, { recursive: true })
      await mkdir(this.config.settings.workspace, { recursive: true })
      this.updateLaunchProgress('preparing', 40, '正在加载皮肤、宠物与外观配置')
      await this.ensureSkinRuntime(runtime)
      const noBrowserPatch = await prepareHarnessNoBrowserPatch(paths.dshHome)
      this.updateLaunchProgress('starting', 58, '正在同步模型配置与本机密钥')
      this.log('INFO', `正在启动 Harness，工作区：${this.config.settings.workspace}`)
      this.emit()
      const modelEnvironment = await this.modelStore.environment()
      this.updateLaunchProgress('starting', 70, '正在启动 Harness 本地服务')
      await assertHarnessPortAvailable(this.config.settings.port)
      const child = spawnNode(runtime, [runtime.dsh, 'web', '--patch', noBrowserPatch, '--port', String(this.config.settings.port), '--no-open'], {
        cwd: this.config.settings.workspace,
        dshHome: paths.dshHome,
        env: {
          ...modelEnvironment,
          ...this.petBalanceBridge.environment(),
          DEEPBLUE_DSH_SKIN_CONFIG: paths.skinConfig,
          DEEPBLUE_DSH_PET_CONFIG: paths.petConfig
        }
      })
      this.service = child
      this.updateLaunchProgress('waiting', 76, `服务已启动，等待端口 ${this.config.settings.port} 就绪`)
      child.stdout.on('data', (chunk: Buffer) => this.consumeProcessOutput(chunk.toString(), 'INFO', browserCycle))
      child.stderr.on('data', (chunk: Buffer) => this.consumeProcessOutput(chunk.toString(), 'WARN', browserCycle))
      child.on('error', (error) => {
        if (this.service !== child) return
        this.snapshot.runStatus = 'error'
        this.updateLaunchProgress('failed', this.snapshot.launchProgress.progress, `启动失败：${error.message}`)
        this.log('ERROR', `启动失败：${error.message}`)
        this.service = undefined
        this.emit()
      })
      child.on('exit', (code, signal) => {
        if (this.service !== child) return
        const expected = this.snapshot.runStatus === 'stopping'
        this.service = undefined
        this.snapshot.runStatus = expected || code === 0 ? 'stopped' : 'error'
        this.snapshot.launchProgress = expected || code === 0
          ? { status: 'idle', progress: 0, message: 'Harness 已停止' }
          : { status: 'failed', progress: this.snapshot.launchProgress.progress, message: `Harness 异常退出（${signal || `code ${code ?? 'unknown'}`}）` }
        this.snapshot.serviceUrl = undefined
        this.log(expected ? 'INFO' : code === 0 ? 'INFO' : 'ERROR', `Harness 已退出（${signal || `code ${code ?? 'unknown'}`}）`)
        this.emit()
      })
      void this.waitForServer(browserCycle)
      return this.getSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.snapshot.runStatus = 'error'
      this.service = undefined
      this.updateLaunchProgress('failed', this.snapshot.launchProgress.progress, `启动失败：${message}`)
      this.log('ERROR', `Harness 启动准备失败：${message}`)
      this.emit()
      return this.getSnapshot()
    }
  }

  async stopHarness(): Promise<LauncherSnapshot> {
    if (!this.service) return this.getSnapshot()
    const service = this.service
    this.snapshot.runStatus = 'stopping'
    this.log('INFO', '正在停止 Harness…')
    this.emit()
    const stopped = new Promise<void>((resolve) => {
      if (service.exitCode !== null) resolve()
      else service.once('exit', () => resolve())
    })
    const pid = service.pid
    if (process.platform === 'win32' && pid) {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, env: sanitizedProcessEnvironment() })
      await new Promise<void>((resolve) => killer.once('exit', () => resolve()))
    } else {
      service.kill('SIGTERM')
    }
    await Promise.race([stopped, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
    return this.getSnapshot()
  }

  async restartHarness(): Promise<LauncherSnapshot> {
    const running = Boolean(this.service) || this.snapshot.runStatus === 'running' || this.snapshot.runStatus === 'starting'
    if (running) await this.stopHarness()
    this.log('INFO', running ? '插件变更完成，正在重启 Harness' : '插件变更完成，正在启动 Harness')
    return this.startHarness()
  }

  async installHarness(version = this.snapshot.latestHarnessVersion): Promise<LauncherSnapshot> {
    if (this.snapshot.tasks.some((task) => task.status === 'running' && task.id.startsWith('install-'))) {
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        if (!this.snapshot.tasks.some((task) => task.status === 'running' && task.id.startsWith('install-'))) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return this.getSnapshot()
    }
    const task = this.addTask(`install-${Date.now()}`, `安装 Harness ${version}`, '准备独立版本目录')
    this.log('INFO', `开始安装 Harness ${version}`)
    this.emit()
    try {
      if (this.config.settings.backupBeforeUpdate) await this.backupUserData()
      const modularRelease = this.runtimeModules.find((module) => module.id === 'harness-core' && module.version === version)
      if (modularRelease) {
        const plan = runtimeModulePlan(modularRelease, this.runtimeModules, process.platform, process.arch)
        task.steps = plan.map(({ release, bytes }) => ({
          id: release.id,
          label: RUNTIME_MODULE_LABELS[release.id] || release.id,
          status: 'queued',
          phase: 'queued',
          progress: 0,
          receivedBytes: 0,
          totalBytes: bytes
        }))
        task.totalBytes = task.steps.reduce((sum, step) => sum + step.totalBytes, 0)
        task.receivedBytes = 0
        task.progress = 0
        task.detail = `准备 ${task.steps.length} 个签名模块`
        this.emit()
        const installed = await this.moduleStore.install(
          modularRelease,
          this.runtimeModules,
          process.platform,
          process.arch,
          (progress) => this.updateModuleTask(task, progress)
        )
        this.config.activeVersion = version
        await writeConfig(this.config)
        for (const step of task.steps) {
          step.status = 'completed'
          step.phase = 'completed'
          step.progress = 100
          step.receivedBytes = step.totalBytes
        }
        task.receivedBytes = task.totalBytes
        task.progress = 100
        task.detail = `模块安装完成：${installed.version}`
        this.log('INFO', `Harness ${version} 已从签名模块包安装`)
        await this.refreshEnvironment()
        task.status = 'completed'
        this.emit()
        return this.getSnapshot()
      }
      const paths = launcherDataPaths()
      const target = await ensureRuntimeDirectory(paths.runtime, version)
      const current = await this.ensurePackageManager()
      let installed = false
      let lastFailure = '没有可用的软件源'
      const registries = this.registryUrls()
      for (const [index, registry] of registries.entries()) {
        task.detail = `从 ${registry} 获取软件包${index > 0 ? '（备用源）' : ''}`
        task.progress = 12 + index * 4
        this.log('INFO', task.detail)
        this.emit()
        const child = spawnNode(current, [
          current.pnpm,
          ...PNPM_ALLOWED_BUILDS.map((packageName) => `--allow-build=${packageName}`),
          'add',
          '--dir',
          target,
          '--prod',
          '--config.node-linker=hoisted',
          '--fetch-retries=0',
          '--fetch-timeout=15000',
          `--registry=${registry}`,
          `@deepseek-ai/dsh@${version}`,
          'pnpm@11.22.0'
        ], {
          cwd: target,
          dshHome: paths.dshHome
        })
        child.stdout.on('data', (chunk: Buffer) => {
          task.progress = Math.min(88, task.progress + 2)
          this.consumeProcessOutput(chunk.toString(), 'INFO')
        })
        child.stderr.on('data', (chunk: Buffer) => this.consumeProcessOutput(chunk.toString(), 'WARN'))
        let spawnFailure: Error | undefined
        const code = await new Promise<number | null>((resolve) => {
          child.once('error', (error) => {
            spawnFailure = error
            resolve(null)
          })
          child.once('exit', resolve)
        })
        if (code === 0) {
          installed = true
          break
        }
        lastFailure = spawnFailure?.message || `包管理器退出码 ${code ?? 'unknown'}`
        this.log('WARN', `${registry} 安装失败，将尝试下一个源：${lastFailure}`)
      }
      if (!installed) throw new Error(lastFailure)
      this.config.activeVersion = version
      await writeConfig(this.config)
      task.progress = 100
      task.detail = '安装完成并已切换为当前版本'
      this.log('INFO', `Harness ${version} 安装完成`)
      await this.refreshEnvironment()
      task.status = 'completed'
      this.emit()
    } catch (error) {
      task.status = 'failed'
      task.detail = error instanceof Error ? error.message : String(error)
      const activeStep = task.steps?.find((step) => !['completed', 'queued'].includes(step.status))
      if (activeStep) {
        activeStep.status = 'failed'
        activeStep.message = task.detail
      }
      this.log('ERROR', `安装失败：${task.detail}`)
      this.emit()
    }
    return this.getSnapshot()
  }

  async applyRuntimeUpdates(): Promise<LauncherSnapshot> {
    if (this.snapshot.runtimeUpdates.status === 'installing' || this.snapshot.runtimeUpdates.status === 'restarting') return this.getSnapshot()
    const requested = [...this.snapshot.runtimeUpdates.items]
    if (!requested.length) return this.getSnapshot()
    const requestedIds = new Set(requested.map((item) => item.id))
    const releases = [...new Map(requested.flatMap((item) => {
      const target = this.runtimeModules.find((release) => release.id === item.id)
      return target ? runtimeModulePlan(target, this.runtimeModules, process.platform, process.arch) : []
    }).filter(({ release }) => requestedIds.has(release.id)).map(({ release }) => [release.id, release])).values()]
    if (releases.length !== requested.length) {
      this.snapshot.runtimeUpdates = { ...this.snapshot.runtimeUpdates, status: 'failed', message: '签名目录已变化，请重新检查更新' }
      this.emit()
      return this.getSnapshot()
    }

    const task = this.addTask(`runtime-update-${Date.now()}`, '更新启动器功能模块', `准备更新 ${requested.length} 个模块`)
    task.steps = requested.map((item) => ({
      id: item.id,
      label: item.label,
      status: 'queued',
      phase: 'queued',
      progress: 0,
      receivedBytes: 0,
      totalBytes: item.size
    }))
    task.totalBytes = requested.reduce((sum, item) => sum + item.size, 0)
    task.receivedBytes = 0
    task.progress = 0
    this.snapshot.runtimeUpdates = {
      ...this.snapshot.runtimeUpdates,
      status: 'installing',
      items: requested,
      taskId: task.id,
      message: '正在下载并校验签名模块，请保持启动器运行'
    }
    this.log('INFO', `用户确认更新 ${requested.map((item) => `${item.label} ${item.nextVersion}`).join('、')}`)
    this.emit()

    const activated: RuntimeModuleId[] = []
    const previousActiveHarnessVersion = this.config.activeVersion
    try {
      if (this.service && (requestedIds.has('harness-core') || requestedIds.has('node-runtime'))) await this.stopHarness()
      if (this.config.settings.backupBeforeUpdate && requestedIds.has('harness-core')) await this.backupUserData()
      for (const release of releases) {
        await this.moduleStore.install(
          release,
          this.runtimeModules,
          process.platform,
          process.arch,
          (progress) => this.updateModuleTask(task, progress)
        )
        activated.push(release.id)
        if (release.id === 'harness-core') this.config.activeVersion = release.version
      }
      await writeConfig(this.config)
      for (const step of task.steps) {
        step.status = 'completed'
        step.phase = 'completed'
        step.progress = 100
        step.receivedBytes = step.totalBytes
      }
      task.status = 'completed'
      task.progress = 100
      task.receivedBytes = task.totalBytes
      await this.refreshInstalledPlugins()
      await this.refreshEnvironment()
      const checkedAt = new Date().toISOString()
      const updatedModules = this.snapshot.runtimeUpdates.modules.map((item) => requestedIds.has(item.id)
        ? { ...item, currentVersion: item.nextVersion, disposition: 'current' as const, message: '本轮更新已安装并通过校验' }
        : item)
      const requiresRelaunch = [...requestedIds].some((id) => !['launcher-ui', 'package-manager'].includes(id))
      const launcherUiRelease = releases.find((release) => release.id === 'launcher-ui')
      if (!requiresRelaunch) {
        if (launcherUiRelease) {
          const root = await this.moduleStore.activeRoot('launcher-ui')
          const entry = root && path.join(root, 'renderer', 'index.html')
          if (!entry || !await this.pathExists(entry)) throw new Error('启动器界面模块安装完成但入口文件不可用')
          this.snapshot.launcherUiVersion = launcherUiRelease.version
          this.snapshot.launcherUiSource = 'updated'
          task.detail = '变化模块已启用；界面将在本窗口自动刷新'
          this.snapshot.runtimeUpdates = { status: 'idle', items: [], modules: updatedModules, checkedAt, message: '热更新完成：只替换了变化模块，无需重新下载安装器' }
          this.log('INFO', `启动器 UI ${launcherUiRelease.version} 已热更新，正在刷新当前窗口`)
          this.emit()
          setTimeout(() => { void this.window.loadFile(entry) }, 450)
          return this.getSnapshot()
        }
        task.detail = '变化模块已启用，无需重启启动器'
        this.snapshot.runtimeUpdates = { status: 'idle', items: [], modules: updatedModules, checkedAt, message: '热更新完成：只替换了变化模块，无需重启启动器' }
        this.log('INFO', '模块热更新完成，无需重启启动器')
        this.emit()
        return this.getSnapshot()
      }
      task.detail = '运行时模块已安装，正在安全重启启动器'
      this.snapshot.runtimeUpdates = {
        status: 'restarting',
        items: requested,
        modules: updatedModules,
        taskId: task.id,
        checkedAt,
        message: '运行时更新安装完成，启动器即将自动重启'
      }
      this.log('INFO', '模块更新安装完成，准备重启启动器')
      this.emit()
      if (app.isPackaged) {
        setTimeout(() => {
          app.relaunch()
          app.exit(0)
        }, 1_200)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.config.activeVersion = previousActiveHarnessVersion
      let rollbackFailure = ''
      for (const moduleId of activated.reverse()) {
        try {
          const versions = await this.moduleStore.versions(moduleId)
          if (versions.previous) await this.moduleStore.rollback(moduleId)
        } catch (rollbackError) {
          rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          this.log('ERROR', `${RUNTIME_MODULE_LABELS[moduleId]} 自动回滚失败：${rollbackFailure}`)
        }
      }
      task.status = 'failed'
      task.detail = rollbackFailure ? `${message}；部分模块回滚失败，请执行快速修复` : `${message}；已恢复更新前模块`
      const activeStep = task.steps?.find((step) => !['completed', 'queued'].includes(step.status))
      if (activeStep) {
        activeStep.status = 'failed'
        activeStep.message = message
      }
      this.snapshot.runtimeUpdates = { ...this.snapshot.runtimeUpdates, status: 'failed', items: requested, taskId: task.id, message: task.detail }
      this.log('ERROR', `模块更新失败：${task.detail}`)
      this.emit()
    }
    return this.getSnapshot()
  }

  async rollbackHarness(version: string): Promise<LauncherSnapshot> {
    const available = this.snapshot.versions.find((entry) => entry.version === version && entry.installed)
    if (!available) {
      this.log('ERROR', `无法回滚：版本 ${version} 未安装`)
      return this.getSnapshot()
    }
    if (this.service) await this.stopHarness()
    const moduleVersions = await this.moduleStore.versions('harness-core')
    if (moduleVersions.installed.includes(version) && moduleVersions.active !== version) {
      if (moduleVersions.previous !== version) {
        this.log('ERROR', `模块版当前只允许回滚到上一版本：${moduleVersions.previous || '无'}`)
        return this.getSnapshot()
      }
      await this.moduleStore.rollback('harness-core')
    }
    this.config.activeVersion = version
    await writeConfig(this.config)
    this.log('INFO', `已切换到 Harness ${version}`)
    await this.refreshEnvironment()
    return this.getSnapshot()
  }

  async downloadLauncherUpdate(): Promise<LauncherSnapshot> {
    const update = this.snapshot.launcherUpdate
    if (!update) return this.getSnapshot()
    const task = this.addTask(`launcher-${Date.now()}`, `下载启动器 ${update.version}`, '准备下载签名清单指定的整合包')
    this.emit()
    const fileName = `deepblue-launcher-kernel-${update.version}-${Date.now()}.exe`
    const target = path.join(app.getPath('temp'), fileName)
    const temporary = `${target}.download`
    try {
      const response = await fetch(update.artifact.url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok || !response.body) throw new Error(`下载返回 HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || update.artifact.size
      const output = createWriteStream(temporary)
      const hasher = createHash('sha256')
      let received = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hasher.update(chunk)
        received += chunk.byteLength
        if (!output.write(chunk)) await once(output, 'drain')
        task.progress = total ? Math.min(98, Math.round((received / total) * 100)) : Math.min(98, task.progress + 1)
        task.detail = `${(received / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`
        this.emit()
      }
      output.end()
      await once(output, 'finish')
      const digest = hasher.digest('hex')
      if (digest.toLowerCase() !== update.artifact.sha256.toLowerCase()) throw new Error('SHA-256 完整性校验失败')
      await rm(target, { force: true })
      await rename(temporary, target)
      task.progress = 100
      task.status = 'completed'
      const installRoot = installedLauncherRoot(process.execPath)
      if (!installRoot) {
        task.detail = `安装器已保存到 ${target}；当前为开发或便携运行方式，请手动安装`
        this.log('WARN', task.detail)
        shell.showItemInFolder(target)
      } else {
        task.detail = '内核安装器已校验，正在自动安装并重启到新版本'
        this.log('INFO', `${task.detail}：${update.version}`)
        if (this.service) await this.stopHarness()
        const installer = spawn(target, silentLauncherUpdateArgs(installRoot), {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        installer.unref()
        this.emit()
        setTimeout(() => app.exit(0), 700)
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      task.status = 'failed'
      task.detail = error instanceof Error ? error.message : String(error)
      this.log('ERROR', `启动器更新下载失败：${task.detail}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async repair(): Promise<LauncherSnapshot> {
    const task = this.addTask(`repair-${Date.now()}`, '快速修复运行环境', '重新核对内置组件')
    this.emit()
    await this.refreshEnvironment()
    const missing = coreRuntimeMissing(this.snapshot.environment)
    if (missing) {
      task.detail = '检测到核心缺失，正在重新安装'
      task.progress = 20
      this.emit()
      await this.installHarness(this.config.activeVersion)
      // A concurrent first-run install marks its task completed only after its own
      // environment refresh. Refresh once more here so repair never evaluates a
      // stale pre-install snapshot.
      await this.refreshEnvironment()
      const repaired = !coreRuntimeMissing(this.snapshot.environment)
      task.status = repaired ? 'completed' : 'failed'
      task.progress = repaired ? 100 : task.progress
      task.detail = repaired ? '运行环境已恢复' : '自动修复未能恢复全部组件'
      this.emit()
      return this.getSnapshot()
    }
    task.progress = 100
    task.status = 'completed'
    task.detail = '环境完整，无需修改'
    this.log('INFO', '快速修复完成：环境完整')
    this.emit()
    return this.getSnapshot()
  }

  async chooseWorkspace(): Promise<LauncherSnapshot> {
    const result = await dialog.showOpenDialog(this.window, {
      title: '选择 DeepSeek Harness 工作区',
      defaultPath: this.config.settings.workspace,
      properties: ['openDirectory', 'createDirectory']
    })
    const selected = result.filePaths[0]
    if (!result.canceled && selected) {
      this.config.settings.workspace = selected
      const now = new Date().toISOString()
      this.config.workspaces = [
        { path: selected, name: path.basename(selected), lastOpenedAt: now, pinned: false },
        ...this.config.workspaces.filter((entry) => entry.path !== selected)
      ].slice(0, 12)
      await writeConfig(this.config)
      this.snapshot.settings = this.config.settings
      this.snapshot.workspaces = this.config.workspaces
      this.log('INFO', `工作区已切换：${selected}`)
      this.emit()
    }
    return this.getSnapshot()
  }

  async confirmStorageSetup(): Promise<LauncherSnapshot> {
    this.config.settings.storageSetupCompleted = true
    await writeConfig(this.config)
    this.snapshot.settings = this.config.settings
    this.snapshot.installation = await this.installationState()
    try {
      await this.createShortcuts(false)
    } catch (error) {
      this.log('WARN', `快捷方式暂未创建，可稍后在设置中修复：${error instanceof Error ? error.message : String(error)}`)
    }
    this.log('INFO', `运行资源将保存在：${launcherDataPaths().root}`)
    this.emit()
    this.beginOnlinePreparation()
    return this.getSnapshot()
  }

  async chooseStorageRoot(): Promise<LauncherSnapshot> {
    if (this.service || this.snapshot.runStatus === 'starting' || this.snapshot.runStatus === 'running') {
      throw new Error('请先停止 Harness，再更改运行资源位置')
    }
    if (this.snapshot.tasks.some((task) => task.status === 'running')) {
      throw new Error('请等待当前下载或安装任务完成，再更改运行资源位置')
    }
    const currentRoot = launcherDataPaths().root
    const result = await dialog.showOpenDialog(this.window, {
      title: '选择运行资源的上级文件夹',
      defaultPath: path.dirname(currentRoot),
      buttonLabel: '存放在这里',
      properties: ['openDirectory', 'createDirectory']
    })
    const parent = result.filePaths[0]
    if (result.canceled || !parent) return this.getSnapshot()
    const resolvedParent = path.resolve(parent)
    if (resolvedParent === path.parse(resolvedParent).root) throw new Error('不要直接选择磁盘根目录，请选择或新建一个文件夹')
    const targetRoot = path.join(resolvedParent, 'DeepBlueHarnessData')
    if (path.resolve(targetRoot) === path.resolve(currentRoot)) return this.confirmStorageSetup()
    const nestedRelative = path.relative(currentRoot, targetRoot)
    if (nestedRelative && !nestedRelative.startsWith('..') && !path.isAbsolute(nestedRelative)) {
      throw new Error('新位置不能放在当前运行资源目录内部，请选择其他磁盘或同级文件夹')
    }

    const existing = await readdir(targetRoot).catch(() => [] as string[])
    if (existing.length) throw new Error('目标位置已有 DeepBlueHarnessData，请选择其他文件夹，避免覆盖现有资料')
    if (!existing.length) await rm(targetRoot, { recursive: true, force: true })

    const task = this.addTask(`storage-${Date.now()}`, '迁移运行资源', '准备安全副本；原位置不会自动删除')
    const stagingRoot = `${targetRoot}.migrating-${Date.now()}`
    const managedEntries = ['runtime', 'harness-data', 'backups', 'logs', 'skins', 'pets', 'model-secrets.json']
    try {
      await mkdir(stagingRoot, { recursive: true })
      for (const [index, name] of managedEntries.entries()) {
        const source = path.join(currentRoot, name)
        if (await this.pathExists(source)) {
          const destination = path.join(stagingRoot, name)
          await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
          if (!await this.pathExists(destination)) throw new Error(`${name} 复制后校验失败`)
        }
        task.progress = Math.round((index + 1) / (managedEntries.length + 1) * 90)
        task.detail = `正在迁移 ${name}`
        this.emit()
      }
      await writeFile(path.join(stagingRoot, '.deepblue-storage.json'), `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), previousRoot: currentRoot }, null, 2)}\n`, 'utf8')
      await rename(stagingRoot, targetRoot)
      this.config.settings.storageRoot = targetRoot
      this.config.settings.storageSetupCompleted = true
      await writeConfig(this.config)
      setLauncherStorageRoot(targetRoot)
      this.moduleStore = new RuntimeModuleStore(launcherDataPaths().runtime)
      this.snapshot.settings = this.config.settings
      this.snapshot.installation = await this.installationState()
      task.progress = 100
      task.status = 'completed'
      task.detail = '迁移完成；原位置保留为安全副本'
      this.log('INFO', `运行资源位置已切换：${targetRoot}`)
      await this.refreshEnvironment()
      this.beginOnlinePreparation()
      return this.getSnapshot()
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      task.status = 'failed'
      task.detail = error instanceof Error ? error.message : String(error)
      this.log('ERROR', `迁移运行资源失败：${task.detail}`)
      this.emit()
      throw error
    }
  }

  async createShortcuts(report = true): Promise<LauncherSnapshot> {
    if (!app.isPackaged) {
      if (report) throw new Error('快捷方式修复只在正式安装版中可用')
      return this.getSnapshot()
    }
    const shortcuts = this.shortcutPaths()
    await mkdir(path.dirname(shortcuts.startMenu), { recursive: true })
    const options = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      icon: process.execPath,
      iconIndex: 0,
      description: '深蓝 DeepSeekHarness 启动器'
    }
    const desktopCreated = shell.writeShortcutLink(shortcuts.desktop, 'create', options)
    const startMenuCreated = shell.writeShortcutLink(shortcuts.startMenu, 'create', options)
    if (!desktopCreated || !startMenuCreated) throw new Error('快捷方式创建失败，请检查桌面和开始菜单目录权限')
    this.snapshot.installation = await this.installationState()
    this.log('INFO', '桌面与开始菜单快捷方式已就绪')
    this.emit()
    return this.getSnapshot()
  }

  async saveSettings(patch: Partial<LauncherSettings>): Promise<LauncherSnapshot> {
    const {
      storageRoot: _storageRoot,
      storageSetupCompleted: _storageSetupCompleted,
      skinCatalogUrl: _skinCatalogUrl,
      petCatalogUrl: _petCatalogUrl,
      ...safePatch
    } = patch
    const nextPort = safePatch.port === undefined ? this.config.settings.port : validateHarnessPort(safePatch.port)
    const portChanged = nextPort !== this.config.settings.port
    if (portChanged) await assertHarnessPortAvailable(nextPort)
    const shouldRestart = portChanged && Boolean(this.service) && (this.snapshot.runStatus === 'running' || this.snapshot.runStatus === 'starting')
    if (shouldRestart) await this.stopHarness()
    this.config.settings = {
      ...this.config.settings,
      ...safePatch,
      port: nextPort,
      skinCatalogUrl: FIXED_SKIN_CATALOG_URL,
      petCatalogUrl: FIXED_PET_CATALOG_URL
    }
    await writeConfig(this.config)
    this.snapshot.settings = this.config.settings
    if (safePatch.sources) this.snapshot.sources = safePatch.sources.map((source) => this.initialSourceHealth(source))
    this.log('INFO', portChanged ? `启动器设置已保存，Harness 端口改为 ${nextPort}` : '启动器设置已保存')
    this.emit()
    if (shouldRestart) {
      this.log('INFO', '端口已更改，正在按新端口重启 Harness')
      return this.startHarness()
    }
    return this.getSnapshot()
  }

  async pluginAction(action: 'install' | 'update' | 'remove', packageSpec: string): Promise<LauncherSnapshot> {
    if (this.pluginActionPromise) throw new Error('已有插件操作正在进行，请在安装进度窗口查看')
    const operation = this.performPluginAction(action, packageSpec)
    this.pluginActionPromise = operation
    try {
      return await operation
    } finally {
      this.pluginActionPromise = undefined
    }
  }

  async refreshDiscovery(): Promise<LauncherSnapshot> {
    const previous = this.snapshot.discovery
    this.snapshot.discovery = loadingDiscovery(previous)
    this.emit()
    this.snapshot.discovery = await fetchDiscovery(previous)
    this.log(this.snapshot.discovery.status === 'ready' ? 'INFO' : 'WARN', this.snapshot.discovery.status === 'ready'
      ? `在线目录已更新：${this.snapshot.discovery.news.length} 条新闻、${this.snapshot.discovery.games.length} 款游戏、${this.snapshot.discovery.tools.length} 个工具、${this.snapshot.discovery.extensions.length} 个扩展、${this.snapshot.discovery.careers.length} 个职业`
      : this.snapshot.discovery.message || '发现目录暂不可用')
    this.emit()
    return this.getSnapshot()
  }

  async newsDetail(id: string) {
    return fetchNewsDetail(id)
  }

  async accountLogin(): Promise<LauncherSnapshot> {
    this.snapshot.account = await this.accountService.signIn(this.window)
    if (this.snapshot.account.status === 'signed_in') await this.refreshFavorites()
    else this.snapshot.favorites = { status: 'signed_out', resourceIds: [] }
    this.log(this.snapshot.account.status === 'signed_in' ? 'INFO' : 'WARN', this.snapshot.account.status === 'signed_in'
      ? `AI历史书账号已登录：${this.snapshot.account.user?.name || '用户'}`
      : this.snapshot.account.message || '账号登录未完成')
    this.emit()
    return this.getSnapshot()
  }

  async accountLogout(): Promise<LauncherSnapshot> {
    this.snapshot.account = await this.accountService.signOut()
    this.snapshot.favorites = { status: 'signed_out', resourceIds: [] }
    this.log('INFO', 'AI历史书账号已退出')
    this.emit()
    return this.getSnapshot()
  }

  async refreshFavorites(): Promise<LauncherSnapshot> {
    const ownerId = this.snapshot.account.user?.id
    if (this.snapshot.account.status !== 'signed_in' || !ownerId) {
      this.snapshot.favorites = { status: 'signed_out', resourceIds: [] }
      this.emit()
      return this.getSnapshot()
    }
    this.snapshot.favorites = { status: 'loading', resourceIds: [], ownerId }
    this.emit()
    try {
      const resourceIds = await this.accountService.favoriteIds()
      if (this.snapshot.account.status === 'signed_in' && this.snapshot.account.user?.id === ownerId) {
        this.snapshot.favorites = { status: 'ready', resourceIds, ownerId, updatedAt: new Date().toISOString() }
      }
    } catch (error) {
      if (this.snapshot.account.status === 'signed_in' && this.snapshot.account.user?.id === ownerId) {
        this.snapshot.favorites = { status: 'unavailable', resourceIds: [], ownerId, message: error instanceof Error ? error.message : 'AI历史书收藏同步失败' }
      } else {
        this.snapshot.favorites = { status: 'signed_out', resourceIds: [] }
      }
    }
    this.emit()
    return this.getSnapshot()
  }

  async toggleResourceFavorite(id: string): Promise<LauncherSnapshot> {
    const item = this.catalogResource(id)
    if (!item) throw new Error('没有找到这项在线资源，请刷新 AI历史书目录后重试')
    if (this.snapshot.account.status !== 'signed_in') {
      this.snapshot.account = await this.accountService.signIn(this.window)
      if (this.snapshot.account.status !== 'signed_in') {
        this.snapshot.favorites = { status: 'signed_out', resourceIds: [] }
        this.emit()
        return this.getSnapshot()
      }
      await this.refreshFavorites()
    }
    const ownerId = this.snapshot.account.user?.id
    if (!ownerId) return this.getSnapshot()
    const favorited = await this.accountService.toggleFavorite(id)
    if (this.snapshot.account.status === 'signed_in' && this.snapshot.account.user?.id === ownerId) {
      const current = new Set(this.snapshot.favorites.resourceIds)
      if (favorited) current.add(id); else current.delete(id)
      this.snapshot.favorites = { status: 'ready', resourceIds: [...current], ownerId, updatedAt: new Date().toISOString() }
      this.log('INFO', favorited ? `${item.title} 已收藏并同步到 AI历史书账号` : `${item.title} 已从 AI历史书账号收藏中移除`)
      this.emit()
    }
    return this.getSnapshot()
  }

  async resourceDetail(id: string) {
    return fetchResourceDetail(id)
  }

  async resourceEngagement(id: string) {
    const item = this.catalogResource(id) || await fetchResourceDetail(id)
    return this.accountService.resourceEngagement(item)
  }

  async commentResource(id: string, body: string) {
    const item = this.catalogResource(id) || await fetchResourceDetail(id)
    return this.accountService.commentResource(item, body)
  }

  async communityRequest(request: LauncherCommunityRequest) {
    return this.accountService.communityRequest(request)
  }

  async queueResource(id: string): Promise<LauncherSnapshot> {
    const item = this.catalogResource(id)
    if (!item) throw new Error('没有找到这项在线资源，请刷新目录后重试')
    const current = this.snapshot.resourceLibrary.find((entry) => entry.id === id)
    if (current) {
      if (current.status === 'installed') this.log('INFO', `${item.title} 已在 DSH 能力库中`)
      return this.getSnapshot()
    }
    const queuedEntry: LauncherLibraryEntry = {
      id: item.id,
      type: item.type,
      title: item.title,
      repositoryUrl: item.repositoryUrl,
      sourceUrl: item.sourceUrl,
      status: 'queued',
      addedAt: new Date().toISOString()
    }
    this.snapshot.resourceLibrary = [queuedEntry, ...this.snapshot.resourceLibrary].slice(0, 500)
    await this.persistResourceLibrary()
    this.log('INFO', `${item.title} 已加入能力安装列表`)
    this.emit()
    return this.getSnapshot()
  }

  async installLibraryResource(id: string): Promise<LauncherSnapshot> {
    const entry = this.snapshot.resourceLibrary.find((item) => item.id === id)
    if (!entry) throw new Error('请先把资源加入安装列表')
    try {
      const item = await fetchResourceDetail(id)
      const safeId = item.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
      if (!safeId) throw new Error('资源编号无法创建安全目录')
      const paths = launcherDataPaths()
      let target: string
      if (item.type === 'skill') {
        if (!item.skillContent?.trim()) throw new Error('这项 Skill 暂未提供可安装正文')
        target = path.join(paths.dshHome, 'skills', safeId)
        await mkdir(target, { recursive: true })
        const body = item.skillContent.replace(/^---\s*[\s\S]*?\s*---\s*/u, '').trim()
        const description = (item.summary || item.firstStep).replace(/[\r\n]+/g, ' ').slice(0, 300).replaceAll('"', '\\"')
        const skill = `---\nname: ${safeId}\ndescription: "${description}"\ndisable-model-invocation: true\nuser-invocable: true\nmetadata:\n  source: AI历史书\n  resource-id: ${item.id}\n---\n\n${body}\n`
        await writeFile(path.join(target, 'SKILL.md'), skill, 'utf8')
      } else {
        target = path.join(paths.dshHome, 'library', 'ailishishu', safeId)
        await mkdir(target, { recursive: true })
        const content = item.type === 'prompt' ? item.promptText
          : item.type === 'workflow' ? JSON.stringify(item.workflowBlueprint ?? {}, null, 2)
            : item.longDescription || item.summary
        await writeFile(path.join(target, item.type === 'workflow' ? 'workflow.json' : 'content.md'), `${content || item.summary}\n`, 'utf8')
        await writeFile(path.join(target, 'resource.json'), `${JSON.stringify({
          schemaVersion: 1,
          id: item.id,
          type: item.type,
          title: item.title,
          summary: item.summary,
          repositoryUrl: item.repositoryUrl,
          sourceUrl: item.sourceUrl,
          canonicalUrl: item.canonicalUrl,
          installedAt: new Date().toISOString()
        }, null, 2)}\n`, 'utf8')
      }
      this.snapshot.resourceLibrary = this.snapshot.resourceLibrary.map((item) => item.id === id ? {
        ...item,
        status: 'installed',
        installedAt: new Date().toISOString(),
        installedPath: target,
        message: item.type === 'skill' ? '已安装到 DSH Skill 目录；重启 Harness 后可调用。' : '已写入 DSH 受控能力库。'
      } : item)
      await this.persistResourceLibrary()
      this.log('INFO', `${entry.title} 已安装到 DSH ${entry.type === 'skill' ? 'Skill 目录' : '能力库'}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.snapshot.resourceLibrary = this.snapshot.resourceLibrary.map((item) => item.id === id ? { ...item, status: 'failed', message } : item)
      await this.persistResourceLibrary()
      this.log('ERROR', `${entry.title} 安装失败：${message}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async removeLibraryResource(id: string): Promise<LauncherSnapshot> {
    const entry = this.snapshot.resourceLibrary.find((item) => item.id === id)
    if (!entry) return this.getSnapshot()
    if (entry.installedPath) {
      const paths = launcherDataPaths()
      const root = entry.type === 'skill' ? path.join(paths.dshHome, 'skills') : path.join(paths.dshHome, 'library', 'ailishishu')
      const resolved = path.resolve(entry.installedPath)
      if (resolved.startsWith(`${path.resolve(root)}${path.sep}`)) await rm(resolved, { recursive: true, force: true })
    }
    this.snapshot.resourceLibrary = this.snapshot.resourceLibrary.filter((item) => item.id !== id)
    await this.persistResourceLibrary()
    this.log('INFO', `${entry.title} 已从能力安装列表移除`)
    this.emit()
    return this.getSnapshot()
  }

  copyText(value: string): void {
    const normalized = typeof value === 'string' ? value.slice(0, 200_000) : ''
    if (!normalized.trim()) throw new Error('没有可复制的内容')
    clipboard.writeText(normalized)
  }

  private catalogResource(id: string): LauncherResourceItem | undefined {
    const discovery = this.snapshot.discovery
    return [...discovery.prompts, ...discovery.skills, ...discovery.workflows, ...discovery.knowledgeBases, ...discovery.tools, ...discovery.agents]
      .find((item) => item.id === id)
  }

  private async persistResourceLibrary(): Promise<void> {
    this.config.resourceLibrary = structuredClone(this.snapshot.resourceLibrary)
    await writeConfig(this.config)
  }

  async playGame(slug: string): Promise<LauncherSnapshot> {
    const game = this.snapshot.discovery.games.find((item) => item.slug === slug)
    if (!game) throw new Error('没有找到这款游戏，请刷新目录后重试')
    if (game.mode === 'source_only' || game.mode === 'official_landmark') throw new Error('这是一项项目资料，请在启动器详情中阅读')
    if (game.loginRequired && this.snapshot.account.status !== 'signed_in') {
      this.snapshot.account = await this.accountService.signIn(this.window)
      this.emit()
      if (this.snapshot.account.status !== 'signed_in') return this.getSnapshot()
    }
    await openContentWindow(this.window, game.url, game.title)
    return this.getSnapshot()
  }

  async saveModelProvider(draft: ModelProviderDraft): Promise<LauncherSnapshot> {
    this.snapshot.modelHub = await this.modelStore.saveProvider(draft)
    this.log('INFO', this.snapshot.modelHub.message || `${draft.name} 已保存`)
    this.emit()
    return this.getSnapshot()
  }

  async removeModelProvider(providerId: string): Promise<LauncherSnapshot> {
    this.snapshot.modelHub = await this.modelStore.removeProvider(providerId)
    this.log('INFO', this.snapshot.modelHub.message || '模型提供方已移除')
    this.emit()
    return this.getSnapshot()
  }

  async setActiveModel(provider: string, model: string): Promise<LauncherSnapshot> {
    this.snapshot.modelHub = await this.modelStore.setActive(provider, model)
    this.log('INFO', this.snapshot.modelHub.message || `已切换模型：${provider}/${model}`)
    this.emit()
    return this.getSnapshot()
  }

  async refreshModelUsage(): Promise<LauncherSnapshot> {
    this.snapshot.modelHub = await this.modelStore.refreshUsage()
    this.emit()
    return this.getSnapshot()
  }

  async testMultimodal(request: MultimodalTestRequest): Promise<MultimodalTestResult> {
    const result = await this.modelStore.testMultimodal(request)
    this.log(result.status === 'success' ? 'INFO' : 'WARN', `多模态实测：${request.provider}/${request.model} · ${result.status} · ${result.latencyMs}ms`)
    this.emit()
    return result
  }

  async refreshSkins(): Promise<LauncherSnapshot> {
    this.snapshot.skins = { ...this.snapshot.skins, status: 'loading' }
    this.emit()
    this.replaceSkinState(await this.skinStore.refresh(this.config.settings.skinCatalogUrl))
    this.log(this.snapshot.skins.status === 'error' ? 'WARN' : 'INFO', this.snapshot.skins.message || `皮肤目录已加载：${this.snapshot.skins.items.length} 项`)
    this.emit()
    return this.getSnapshot()
  }

  async downloadSkin(skinId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.skins.items.find(entry => entry.id === skinId)
    if (!item || this.skinTransferBusy(skinId)) return this.getSnapshot()
    this.updateSkinTransfer(skinId, 'download', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size + (item.poster?.size || 0), message: '准备下载高清资源' })
    try {
      this.replaceSkinState(await this.skinStore.download(skinId, progress => this.updateSkinTransfer(skinId, 'download', progress)))
      this.finishSkinTransfer(skinId, 'download', '高清资源已下载，可直接预览或应用')
      this.log('INFO', `皮肤「${item.name}」已下载到本机`)
    } catch (error) {
      this.failSkinTransfer(skinId, 'download', error)
      this.log('ERROR', `皮肤下载失败：${this.snapshot.skins.transfers[skinId]?.message || '未知错误'}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async previewSkin(skinId: string): Promise<SkinPreviewResult> {
    const item = this.snapshot.skins.items.find(entry => entry.id === skinId)
    if (!item || this.skinTransferBusy(skinId)) return { snapshot: this.getSnapshot() }
    this.updateSkinTransfer(skinId, 'preview', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size + (item.poster?.size || 0), message: '准备高清预览' })
    try {
      const result = await this.skinStore.preview(skinId, progress => this.updateSkinTransfer(skinId, 'preview', progress))
      this.replaceSkinState(result.state)
      this.finishSkinTransfer(skinId, 'preview', '高清预览已就绪')
      this.emit()
      return { snapshot: this.getSnapshot(), preview: result.preview }
    } catch (error) {
      this.failSkinTransfer(skinId, 'preview', error)
      this.log('ERROR', `皮肤预览失败：${this.snapshot.skins.transfers[skinId]?.message || '未知错误'}`)
      this.emit()
      return { snapshot: this.getSnapshot() }
    }
  }

  async applySkin(skinId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.skins.items.find(entry => entry.id === skinId)
    if (!item || this.skinTransferBusy(skinId)) return this.getSnapshot()
    const task = this.addTask(`skin-${Date.now()}`, `应用皮肤「${item.name}」`, '正在校验本地缓存并按需下载原媒体')
    this.updateSkinTransfer(skinId, 'apply', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size + (item.poster?.size || 0), message: '准备下载并应用' })
    this.emit()
    try {
      task.progress = 24
      this.replaceSkinState(await this.skinStore.apply(skinId, progress => this.updateSkinTransfer(skinId, 'apply', progress)))
      task.progress = 100
      task.status = 'completed'
      task.detail = this.snapshot.runStatus === 'running' ? '皮肤已保存，重启 Harness 后生效' : '皮肤已保存，下次启动 Harness 自动生效'
      this.finishSkinTransfer(skinId, 'apply', task.detail)
      this.log('INFO', task.detail)
    } catch (error) {
      task.status = 'failed'
      task.detail = error instanceof Error ? error.message : String(error)
      this.failSkinTransfer(skinId, 'apply', error)
      this.log('ERROR', `皮肤应用失败：${task.detail}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async removeSkin(skinId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.skins.items.find(entry => entry.id === skinId)
    if (!item || this.skinTransferBusy(skinId)) return this.getSnapshot()
    this.snapshot.skins.transfers[skinId] = { operation: 'remove', status: 'removing', progress: 30, receivedBytes: 0, totalBytes: item.media.size + (item.poster?.size || 0), message: '正在删除本机高清资源' }
    this.emit()
    try {
      const wasActive = this.snapshot.skins.activeSkinId === skinId
      if (this.snapshot.skins.desktopWallpaper?.skinId === skinId) await this.dynamicWallpaper.clear()
      this.replaceSkinState(await this.skinStore.remove(skinId))
      this.finishSkinTransfer(skinId, 'remove', wasActive ? '已删除并恢复 Harness 默认皮肤' : '已从本机删除')
      this.log('INFO', `已删除皮肤「${item.name}」的本机资源`)
    } catch (error) {
      this.failSkinTransfer(skinId, 'remove', error)
      this.log('ERROR', `删除皮肤失败：${this.snapshot.skins.transfers[skinId]?.message || '未知错误'}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async applySkinToDesktop(skinId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.skins.items.find(entry => entry.id === skinId)
    if (!item || this.skinTransferBusy(skinId)) return this.getSnapshot()
    const capability = desktopWallpaperCapability(item)
    if (!capability.supported) {
      this.failSkinTransfer(skinId, 'desktop', new Error(capability.reason))
      this.log('WARN', `皮肤「${item.name}」不显示电脑桌面操作：${capability.reason}`)
      this.emit()
      return this.getSnapshot()
    }
    const desktopAssetSize = capability.asset.size
    this.updateSkinTransfer(skinId, 'desktop', { status: 'downloading', receivedBytes: 0, totalBytes: desktopAssetSize, message: '准备电脑桌面壁纸' })
    this.emit()
    try {
      const downloaded = await this.skinStore.desktopAsset(skinId, progress => this.updateSkinTransfer(skinId, 'desktop', progress))
      this.replaceSkinState(downloaded.state)
      let message: string
      if (capability.mode === 'dynamic') {
        if (downloaded.mediaKind === 'image') throw new Error('静态图片不能启动动态桌面')
        await this.dynamicWallpaper.applyDynamic(skinId, downloaded.mediaPath, downloaded.mediaKind)
        message = downloaded.mediaKind === 'video' ? '视频动态桌面已启动' : '动图动态桌面已启动'
      } else {
        const source = desktopWallpaperSource(downloaded.mediaKind, downloaded.mediaPath, downloaded.posterPath, downloaded.thumbnailPath)
        await applyWindowsDesktopWallpaper(source.sourcePath, path.join(launcherDataPaths().skins, 'desktop'))
        await this.dynamicWallpaper.recordStatic(skinId)
        message = '高清壁纸已设为电脑桌面'
      }
      this.snapshot.skins.desktopWallpaper = this.dynamicWallpaper.state()
      this.finishSkinTransfer(skinId, 'desktop', message)
      this.log('INFO', `皮肤「${item.name}」${message}`)
    } catch (error) {
      this.failSkinTransfer(skinId, 'desktop', error)
      this.log('ERROR', `设置电脑桌面失败：${this.snapshot.skins.transfers[skinId]?.message || '未知错误'}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async stopDynamicDesktop(): Promise<LauncherSnapshot> {
    await this.dynamicWallpaper.stopDynamic()
    this.snapshot.skins.desktopWallpaper = this.dynamicWallpaper.state()
    this.log('INFO', '动态桌面已停止，已恢复下方的 Windows 静态壁纸')
    this.emit()
    return this.getSnapshot()
  }

  async toggleSkinFavorite(skinId: string): Promise<LauncherSnapshot> {
    this.snapshot.skins = await this.skinStore.toggleFavorite(skinId)
    const favorite = this.snapshot.skins.favoriteSkinIds.includes(skinId)
    const item = this.snapshot.skins.items.find(entry => entry.id === skinId)
    this.log('INFO', `${favorite ? '已收藏' : '已取消收藏'}皮肤${item ? `「${item.name}」` : ''}`)
    this.emit()
    return this.getSnapshot()
  }

  async clearSkin(): Promise<LauncherSnapshot> {
    this.snapshot.skins = await this.skinStore.clear()
    this.log('INFO', this.snapshot.runStatus === 'running' ? '已恢复默认皮肤，重启 Harness 后生效' : '已恢复默认皮肤')
    this.emit()
    return this.getSnapshot()
  }

  async refreshPets(): Promise<LauncherSnapshot> {
    this.snapshot.pets = { ...this.snapshot.pets, status: 'loading' }
    this.emit()
    this.replacePetState(await this.petStore.refresh())
    this.log(this.snapshot.pets.status === 'error' ? 'WARN' : 'INFO', this.snapshot.pets.message || `宠物目录已加载：${this.snapshot.pets.items.length} 项`)
    this.emit()
    return this.getSnapshot()
  }

  async downloadPet(petId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.pets.items.find(entry => entry.id === petId)
    if (!item || item.origin === 'custom' || this.petTransferBusy(petId)) return this.getSnapshot()
    this.updatePetTransfer(petId, 'download', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size, message: '准备下载宠物资源' })
    try {
      this.replacePetState(await this.petStore.download(petId, progress => this.updatePetTransfer(petId, 'download', progress)))
      this.finishPetTransfer(petId, 'download', '宠物资源已下载，可直接预览或应用')
      this.log('INFO', `宠物「${item.name}」已下载到本机`)
    } catch (error) {
      this.failPetTransfer(petId, 'download', error)
      this.log('ERROR', `宠物下载失败：${this.snapshot.pets.transfers[petId]?.message || '未知错误'}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async previewPet(petId: string): Promise<PetPreviewResult> {
    const item = this.snapshot.pets.items.find(entry => entry.id === petId)
    if (!item || item.origin === 'custom' || this.petTransferBusy(petId)) return { snapshot: this.getSnapshot() }
    this.updatePetTransfer(petId, 'preview', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size, message: '准备宠物预览' })
    try {
      const result = await this.petStore.preview(petId, progress => this.updatePetTransfer(petId, 'preview', progress))
      this.replacePetState(result.state)
      this.finishPetTransfer(petId, 'preview', '宠物预览已就绪')
      this.emit()
      return { snapshot: this.getSnapshot(), preview: result.preview }
    } catch (error) {
      this.failPetTransfer(petId, 'preview', error)
      this.log('ERROR', `宠物预览失败：${this.snapshot.pets.transfers[petId]?.message || '未知错误'}`)
      this.emit()
      return { snapshot: this.getSnapshot() }
    }
  }

  async applyPet(petId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.pets.items.find(entry => entry.id === petId)
    if (!item || this.petTransferBusy(petId)) return this.getSnapshot()
    const task = this.addTask(`pet-${Date.now()}`, `启用宠物「${item.name}」`, '正在校验缓存并按需下载宠物资源')
    this.updatePetTransfer(petId, 'apply', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size, message: '准备下载并应用' })
    this.emit()
    try {
      task.progress = 24
      this.replacePetState(await this.petStore.apply(petId, progress => this.updatePetTransfer(petId, 'apply', progress)))
      task.progress = 100
      task.status = 'completed'
      task.detail = this.snapshot.runStatus === 'running' ? '宠物已保存，重启 Harness 后生效' : '宠物已保存，下次启动 Harness 自动出现'
      this.finishPetTransfer(petId, 'apply', task.detail)
      this.log('INFO', task.detail)
    } catch (error) {
      task.status = 'failed'
      task.detail = error instanceof Error ? error.message : String(error)
      this.failPetTransfer(petId, 'apply', error)
      this.log('ERROR', `宠物应用失败：${task.detail}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async applyPetToDesktop(petId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.pets.items.find(entry => entry.id === petId)
    if (!item || this.petTransferBusy(petId)) return this.getSnapshot()
    this.updatePetTransfer(petId, 'desktop', { status: 'downloading', receivedBytes: 0, totalBytes: item.media.size, message: '准备下载并应用到电脑桌面' })
    this.emit()
    try {
      const downloaded = await this.petStore.desktopAsset(petId, progress => this.updatePetTransfer(petId, 'desktop', progress))
      this.replacePetState(downloaded.state)
      await this.desktopPet.apply({
        petId: downloaded.item.id,
        name: downloaded.item.name,
        mediaKind: downloaded.item.mediaKind,
        packKind: downloaded.item.packKind || 'image',
        mediaPath: downloaded.mediaPath,
        behavior: downloaded.item.behavior
      })
      this.snapshot.pets.desktopPet = this.desktopPet.state()
      this.finishPetTransfer(petId, 'desktop', '电脑桌面宠物已启动，可点击互动并拖动位置')
      this.log('INFO', `宠物「${item.name}」已应用到电脑桌面`)
    } catch (error) {
      this.failPetTransfer(petId, 'desktop', error)
      this.log('ERROR', `应用电脑桌面宠物失败：${this.snapshot.pets.transfers[petId]?.message || '未知错误'}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async stopDesktopPet(): Promise<LauncherSnapshot> {
    await this.desktopPet.clear()
    this.snapshot.pets.desktopPet = undefined
    this.log('INFO', '电脑桌面宠物已停止')
    this.emit()
    return this.getSnapshot()
  }

  async removePet(petId: string): Promise<LauncherSnapshot> {
    const item = this.snapshot.pets.items.find(entry => entry.id === petId)
    if (!item || item.origin === 'custom' || this.petTransferBusy(petId)) return this.getSnapshot()
    this.snapshot.pets.transfers[petId] = { operation: 'remove', status: 'removing', progress: 30, receivedBytes: 0, totalBytes: item.media.size, message: '正在删除本机宠物资源' }
    this.emit()
    try {
      const wasActive = this.snapshot.pets.activePetId === petId
      const wasDesktop = this.snapshot.pets.desktopPet?.petId === petId
      if (wasDesktop) await this.desktopPet.clear()
      this.replacePetState(await this.petStore.remove(petId))
      this.finishPetTransfer(petId, 'remove', wasActive || wasDesktop ? '已删除并关闭正在使用的宠物' : '已从本机删除')
      this.log('INFO', `已删除宠物「${item.name}」的本机资源`)
    } catch (error) {
      this.failPetTransfer(petId, 'remove', error)
      this.log('ERROR', `删除宠物失败：${this.snapshot.pets.transfers[petId]?.message || '未知错误'}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async togglePetFavorite(petId: string): Promise<LauncherSnapshot> {
    this.replacePetState(await this.petStore.toggleFavorite(petId))
    const favorite = this.snapshot.pets.favoritePetIds.includes(petId)
    const item = this.snapshot.pets.items.find(entry => entry.id === petId)
    this.log('INFO', `${favorite ? '已收藏' : '已取消收藏'}宠物${item ? `「${item.name}」` : ''}`)
    this.emit()
    return this.getSnapshot()
  }

  async clearPet(): Promise<LauncherSnapshot> {
    this.replacePetState(await this.petStore.clear())
    this.log('INFO', this.snapshot.runStatus === 'running' ? '已关闭网页宠物，重启 Harness 后生效' : '已关闭网页宠物')
    this.emit()
    return this.getSnapshot()
  }

  async importPet(): Promise<LauncherSnapshot> {
    const result = await dialog.showOpenDialog(this.window, {
      title: '添加本地宠物图片',
      properties: ['openFile'],
      filters: [{ name: '宠物图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (result.canceled || !result.filePaths[0]) return this.getSnapshot()
    try {
      this.replacePetState(await this.petStore.importCustom(result.filePaths[0]))
      this.log('INFO', '本地宠物已添加，只保存在当前电脑')
    } catch (error) {
      this.log('ERROR', `添加本地宠物失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async removeCustomPet(petId: string): Promise<LauncherSnapshot> {
    try {
      if (this.snapshot.pets.desktopPet?.petId === petId) await this.desktopPet.clear()
      this.replacePetState(await this.petStore.removeCustom(petId))
      this.log('INFO', '已删除本地自定义宠物')
    } catch (error) {
      this.log('ERROR', `删除宠物失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.emit()
    return this.getSnapshot()
  }

  async openPath(target: string): Promise<void> {
    await shell.openPath(target)
  }

  async openExternal(url: string): Promise<void> {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  }

  private checkingEnvironment(): EnvironmentItem[] {
    return [
      { id: 'node', label: '内置 Node.js', status: 'checking', detail: '正在检查' },
      { id: 'harness', label: 'Harness 核心', status: 'checking', detail: '正在检查' },
      { id: 'pnpm', label: '插件包管理器', status: 'checking', detail: '正在检查' },
      { id: 'network', label: '更新网络', status: 'checking', detail: '正在检查' }
    ]
  }

  private initialSourceHealth(source: SourceConfig, status?: SourceHealth['status']): SourceHealth {
    return {
      ...source,
      status: status || (!source.enabled || !source.baseUrl ? 'unconfigured' : 'checking')
    }
  }

  private async checkSource(source: SourceConfig): Promise<SourceHealth> {
    if (!source.enabled || !source.baseUrl) return this.initialSourceHealth(source, 'unconfigured')
    const probe = source.kind === 'repository' && source.baseUrl.endsWith('.git') ? source.baseUrl.slice(0, -4) : source.baseUrl
    const started = performance.now()
    try {
      const response = await fetch(probe, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(5_000),
        headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' }
      })
      const latencyMs = Math.round(performance.now() - started)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { ...source, status: latencyMs > 1_500 ? 'slow' : 'available', latencyMs }
    } catch (error) {
      return { ...source, status: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
  }

  private registryUrl(): string {
    return this.config.settings.sources.find((source) => source.id === 'npmmirror' && source.enabled)?.baseUrl || 'https://registry.npmjs.org'
  }

  private registryUrls(): string[] {
    const configured = this.config.settings.sources.find((source) => source.id === 'npmmirror' && source.enabled)
    const health = this.snapshot.sources.find((source) => source.id === 'npmmirror')
    const candidates = health?.status === 'unavailable' ? [] : [configured?.baseUrl]
    return [...new Set([...candidates, 'https://registry.npmjs.org'].filter((entry): entry is string => Boolean(entry)))]
  }

  private async ensureSkinRuntime(runtime: Awaited<ReturnType<typeof resolveRuntime>>): Promise<void> {
    const paths = launcherDataPaths()
    // Must match bundled-plugins/deepblue-dsh-skin-runtime/package.json; the
    // appearance-plugin-version test fails the build when the two drift apart.
    const expectedVersion = '0.8.3'
    const installedManifest = path.join(paths.dshHome, 'profiles', 'web', 'node_modules', '@deepblue', 'dsh-skin-runtime', 'package.json')
    let hasPreviousManagedRuntime = false
    try {
      const manifest = JSON.parse(await readFile(installedManifest, 'utf8')) as { version?: string }
      if (manifest.version === expectedVersion) return
      hasPreviousManagedRuntime = Boolean(manifest.version)
    } catch {
      // The profile is initialized by the plugin command below on first launch.
    }
    const archiveCandidates = [
      path.join(process.resourcesPath, 'resources', 'plugins', `deepblue-dsh-skin-runtime-${expectedVersion}.tgz`),
      path.join(app.getAppPath(), 'resources', 'plugins', `deepblue-dsh-skin-runtime-${expectedVersion}.tgz`)
    ]
    const archive = (await Promise.all(archiveCandidates.map(async candidate => ({ candidate, ready: await isExecutable(candidate) })))).find(entry => entry.ready)?.candidate
    if (!archive) {
      this.log('WARN', '外观运行插件缺失，Harness 将使用默认皮肤且不显示宠物')
      return
    }
    await prepareAppearanceProfile(paths.dshHome, archive)
    if (hasPreviousManagedRuntime) {
      this.log('INFO', `正在原子更新皮肤与宠物运行插件 ${expectedVersion}`)
      await installAppearanceRuntimeAtomically(paths.dshHome, archive, expectedVersion)
      this.log('INFO', `皮肤与宠物运行插件已更新至 ${expectedVersion}`)
      return
    }
    const runtimeWithPackageManager = await this.ensurePackageManager(runtime)
    const shimDirectory = await this.ensurePnpmShim(paths.runtime, runtimeWithPackageManager.node, runtimeWithPackageManager.pnpm)
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    const commandPath = `${shimDirectory}${path.delimiter}${path.join(runtimeWithPackageManager.appRoot, 'node_modules', '.bin')}${path.delimiter}${sanitizedProcessEnvironment()[pathKey] || ''}`
    this.log('INFO', '正在配置皮肤与宠物运行插件')
    const profileEnvironment = await readPnpmProfileEnvironment(paths.dshHome)
    const child = spawnNode(runtimeWithPackageManager, [runtimeWithPackageManager.dsh, 'plugin', '--profile', 'web', 'add', archive, '--offline'], {
      cwd: this.config.settings.workspace,
      dshHome: paths.dshHome,
      env: { npm_config_registry: this.registryUrl(), ...profileEnvironment, [pathKey]: commandPath }
    })
    child.stdout.on('data', (chunk: Buffer) => this.consumeProcessOutput(chunk.toString(), 'INFO'))
    child.stderr.on('data', (chunk: Buffer) => this.consumeProcessOutput(chunk.toString(), 'WARN'))
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    if (code !== 0) this.log('WARN', `外观运行插件配置失败（退出码 ${code ?? 'unknown'}），Harness 将继续使用默认外观`)
  }

  private async ensurePackageManager(
    current?: Awaited<ReturnType<typeof resolveRuntime>>
  ): Promise<Awaited<ReturnType<typeof resolveRuntime>>> {
    const paths = launcherDataPaths()
    const runtime = current || await resolveRuntime(paths.runtime, this.config.activeVersion)
    if (await isExecutable(runtime.pnpm)) return runtime
    const release = this.runtimeModules.find((module) => module.id === 'package-manager')
    if (!release) throw new Error('签名目录暂未提供插件包管理器，请检查更新源后重试')
    this.log('INFO', `首次使用插件能力，正在获取包管理器 ${release.version}`)
    await this.moduleStore.install(release, this.runtimeModules, process.platform, process.arch)
    const resolved = await resolveRuntime(paths.runtime, this.config.activeVersion)
    if (!await isExecutable(resolved.pnpm)) throw new Error('插件包管理器安装完成但运行文件不可用')
    return resolved
  }

  private async prepareOnlineRuntime(): Promise<void> {
    await this.checkSources()
    if (this.distributionMode !== 'online') return
    const paths = launcherDataPaths()
    const runtime = await resolveRuntime(paths.runtime, this.config.activeVersion)
    if (await isExecutable(runtime.dsh)) return
    this.log('INFO', '在线轻量版首次运行，开始自动安装 Harness')
    await this.installHarness(this.config.activeVersion)
  }

  private beginOnlinePreparation(): void {
    if (this.onlinePreparationStarted) return
    this.onlinePreparationStarted = true
    void this.prepareOnlineRuntime().catch((error) => {
      this.log('ERROR', `在线运行环境准备失败：${error instanceof Error ? error.message : String(error)}`)
      this.emit()
    })
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await access(target)
      return true
    } catch {
      return false
    }
  }

  private shortcutPaths(): { desktop: string; startMenu: string } {
    const fileName = '深蓝DeepSeekHarness启动器.lnk'
    return {
      desktop: path.join(app.getPath('desktop'), fileName),
      startMenu: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '深蓝DeepSeekHarness启动器', fileName)
    }
  }

  private shortcutReady(target: string): boolean {
    if (process.platform !== 'win32') return false
    try {
      return path.resolve(shell.readShortcutLink(target).target) === path.resolve(process.execPath)
    } catch {
      return false
    }
  }

  private async installationState(): Promise<LauncherInstallationState> {
    const shortcuts = this.shortcutPaths()
    return {
      programRoot: path.dirname(process.execPath),
      storageRoot: launcherDataPaths().root,
      setupRequired: !this.config.settings.storageSetupCompleted,
      desktopShortcutReady: this.shortcutReady(shortcuts.desktop),
      startMenuShortcutReady: this.shortcutReady(shortcuts.startMenu)
    }
  }

  private async syncOnlineCatalog(): Promise<boolean> {
    const registry = this.registryUrl()
    const [npmVersion, signedCatalog] = await Promise.all([
      fetchLatestNpmVersion(registry),
      fetchSignedCatalog(this.config.settings.sources)
    ])
    if (npmVersion) {
      this.snapshot.latestHarnessVersion = npmVersion
      if (!this.snapshot.versions.some((entry) => entry.version === npmVersion)) {
        this.snapshot.versions.unshift({
          version: npmVersion,
          channel: npmVersion.includes('-') ? 'preview' : 'stable',
          installed: false,
          active: false,
          rollbackReady: false,
          notes: ['npm 软件源发现的新版本']
        })
      }
    }
    if (signedCatalog) {
      this.lastVerifiedCatalogAt = signedCatalog.generatedAt
      this.runtimeModules = mergeBundledRuntimeMirrors(signedCatalog.runtimeModules || [], this.bundledRuntimeModules)
      const matchingArtifact = signedCatalog.launcher?.artifacts.find((artifact) =>
        artifact.platform === process.platform &&
        artifact.arch === process.arch &&
        artifact.distribution === this.distributionMode
      ) || signedCatalog.launcher?.artifacts.find((artifact) =>
        artifact.platform === process.platform && artifact.arch === process.arch && !artifact.distribution
      )
      this.snapshot.launcherUpdate = undefined
      if (matchingArtifact && signedCatalog.launcher && isNewerVersion(signedCatalog.launcher.version, app.getVersion())) {
        this.snapshot.launcherUpdate = {
          version: signedCatalog.launcher.version,
          notes: signedCatalog.launcher.notes,
          artifact: matchingArtifact
        }
      }
      this.snapshot.versions = signedCatalog.harness.map((entry) => ({
        ...entry,
        active: entry.version === this.snapshot.activeHarnessVersion,
        installed: entry.installed || this.snapshot.versions.some((local) => local.version === entry.version && local.installed)
      }))
      const signedIds = new Set(signedCatalog.plugins.map(plugin => plugin.id))
      this.snapshot.plugins = [...signedCatalog.plugins, ...bundledPlugins.filter(plugin => !signedIds.has(plugin.id))]
      await this.refreshInstalledPlugins()
      this.snapshot.models = signedCatalog.models
      if (signedCatalog.modelTemplates?.length) this.snapshot.modelHub = this.modelStore.syncTemplates(signedCatalog.modelTemplates)
      await this.detectRuntimeUpdates()
      this.log('INFO', `已同步签名目录（${signedCatalog.generatedAt}，运行模块 ${this.runtimeModules.length} 个）`)
      return true
    }
    return false
  }

  private async detectRuntimeUpdates(): Promise<void> {
    if (this.snapshot.runtimeUpdates.status === 'installing' || this.snapshot.runtimeUpdates.status === 'restarting') return
    const currentVersions: Partial<Record<RuntimeModuleId, string>> = {}
    for (const release of this.runtimeModules) {
      const versions = await this.moduleStore.versions(release.id)
      if (versions.active) currentVersions[release.id] = versions.active
    }
    currentVersions['harness-core'] ||= this.snapshot.environment.find((item) => item.id === 'harness')?.version
    currentVersions['node-runtime'] ||= this.snapshot.environment.find((item) => item.id === 'node')?.version
    currentVersions['package-manager'] ||= this.snapshot.environment.find((item) => item.id === 'pnpm')?.version
    currentVersions['launcher-ui'] ||= this.snapshot.launcherUiVersion || await bundledLauncherUiVersion()
    const items = planRuntimeModuleUpdates(this.runtimeModules, currentVersions, process.platform, process.arch)
    const modules = describeRuntimeModuleUpdates(this.runtimeModules, currentVersions, process.platform, process.arch)
    const checkedAt = new Date().toISOString()
    this.snapshot.runtimeUpdates = items.length
      ? { status: 'available', items, modules, checkedAt, message: `检测到 ${items.length} 个独立模块可更新，只会下载这些变化部分` }
      : { status: 'idle', items: [], modules, checkedAt, message: '检查完成：基础内核与所有已安装模块均为最新' }
  }

  private addTask(id: string, title: string, detail: string): LauncherTask {
    const task: LauncherTask = { id, title, detail, status: 'running', progress: 4, createdAt: new Date().toISOString() }
    this.snapshot.tasks = [task, ...this.snapshot.tasks].slice(0, 20)
    return task
  }

  private updateModuleTask(task: LauncherTask, progress: RuntimeModuleInstallProgress): void {
    const step = task.steps?.find((candidate) => candidate.id === progress.moduleId)
    if (!step) return
    const phase = progress.phase
    step.phase = phase
    step.status = moduleStepStatus(phase)
    step.progress = Math.max(step.progress, moduleStepProgress(phase, progress.receivedBytes, progress.totalBytes))
    step.receivedBytes = Math.max(step.receivedBytes, Math.min(progress.receivedBytes, progress.totalBytes))
    if (progress.mirrorId === 'github' || progress.mirrorId === 'gitee' || progress.mirrorId === 'oss') step.source = progress.mirrorId
    step.message = progress.message
    if (phase === 'source-fallback' && progress.message) this.log('WARN', progress.message)
    const totalWeight = task.steps?.reduce((sum, candidate) => sum + Math.max(1, candidate.totalBytes), 0) || 1
    const completedWeight = task.steps?.reduce((sum, candidate) => sum + Math.max(1, candidate.totalBytes) * candidate.progress / 100, 0) || 0
    task.receivedBytes = task.steps?.reduce((sum, candidate) => sum + Math.min(candidate.receivedBytes, candidate.totalBytes), 0) || 0
    task.progress = Math.min(99, Math.round(completedWeight / totalWeight * 100))
    task.detail = phase === 'source-check'
      ? `正在检测 ${runtimeSourceLabel(progress.mirrorId)} · ${step.label}`
      : phase === 'source-fallback'
        ? `${runtimeSourceLabel(progress.mirrorId)} 不可用，自动切换 · ${step.label}`
        : phase === 'download'
          ? `从 ${runtimeSourceLabel(progress.mirrorId)} 下载 · ${step.label}`
          : `${step.label} · ${phase === 'verify' ? '校验' : phase === 'extract' ? '解压' : phase === 'probe' ? '可运行性检测' : '启用'}`
    this.emit()
  }

  private async backupUserData(): Promise<void> {
    const paths = launcherDataPaths()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(paths.backups, stamp)
    const staging = `${target}.next`
    try {
      await mkdir(paths.backups, { recursive: true })
      await cp(paths.dshHome, staging, {
        recursive: true,
        errorOnExist: true,
        dereference: true,
        filter: (source) => path.basename(source) !== 'node_modules'
      })
      await rename(staging, target)
      this.log('INFO', `用户数据已备份：${target}`)
      const keep = Math.max(1, Math.floor(this.config.settings.keepBackups))
      const backups = (await readdir(paths.backups, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left))
      for (const expired of backups.slice(keep)) {
        await rm(path.join(paths.backups, expired), { recursive: true, force: true })
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('ENOENT')) throw error
      this.log('INFO', '尚无用户数据，跳过备份')
    }
  }

  private async discoverVersions(activeVersion: string): Promise<HarnessVersion[]> {
    const paths = launcherDataPaths()
    const installed = new Set<string>()
    if (await hasBundledHarness()) installed.add('0.1.1-rc.2')
    const modularVersions = await this.moduleStore.versions('harness-core')
    modularVersions.installed.forEach((version) => installed.add(version))
    try {
      for (const entry of await readdir(path.join(paths.runtime, 'versions'), { withFileTypes: true })) {
        if (entry.isDirectory()) installed.add(entry.name)
      }
    } catch {
      // A fresh launcher has no downloaded version directory yet.
    }
    const known = new Map(bundledVersions.map((entry) => [entry.version, entry]))
    for (const version of installed) {
      if (!known.has(version)) {
        known.set(version, {
          version,
          channel: version.includes('-') ? 'preview' : 'stable',
          installed: true,
          active: false,
          rollbackReady: true,
          notes: ['本机已安装版本']
        })
      }
    }
    return [...known.values()]
      .map((entry) => ({
        ...entry,
        installed: installed.has(entry.version),
        active: entry.version === activeVersion,
        rollbackReady: installed.has(entry.version) && entry.version !== activeVersion
      }))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  }

  private async ensurePnpmShim(runtimeRoot: string, node: string, pnpm: string): Promise<string> {
    const directory = path.join(runtimeRoot, 'shims')
    await mkdir(directory, { recursive: true })
    if (process.platform === 'win32') {
      await writeFile(path.join(directory, 'pnpm.cmd'), `@echo off\r\n"${node}" "${pnpm}" %*\r\n`, 'utf8')
    } else {
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      const target = path.join(directory, 'pnpm')
      await writeFile(target, `#!/bin/sh\nexec ${quote(node)} ${quote(pnpm)} "$@"\n`, 'utf8')
      await chmod(target, 0o755)
    }
    return directory
  }

  private async performPluginAction(action: 'install' | 'update' | 'remove', packageSpec: string): Promise<LauncherSnapshot> {
    const paths = launcherDataPaths()
    const packageName = pluginPackageName(packageSpec)
    const catalogEntry = this.snapshot.plugins.find((item) => pluginPackageName(item.packageSpec) === packageName)
    const actionLabel = pluginActionLabel(action)
    const task = this.addTask(`plugin-${Date.now()}`, `${actionLabel}插件 ${catalogEntry?.name || packageName}`, '正在准备 web profile')
    const startedAt = new Date().toISOString()
    const wasRunning = Boolean(this.service) || this.snapshot.runStatus === 'running' || this.snapshot.runStatus === 'starting'
    const verifiablePackage = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)
    const initiallyInstalled = verifiablePackage ? await this.isPluginInstalled(packageName, false) : false
    let lastOutputAt = Date.now()

    this.snapshot.pluginOperation = {
      action,
      packageSpec,
      packageName,
      displayName: catalogEntry?.name || packageName,
      status: 'preparing',
      progress: 5,
      message: `正在准备${actionLabel}环境`,
      currentFile: 'profiles/web/package.json',
      files: ['检查 profiles/web/package.json', '准备 pnpm 插件环境'],
      taskId: task.id,
      restartRequired: false,
      startedAt
    }
    this.log('INFO', `开始${actionLabel}插件：${packageSpec}`)
    this.emit()

    try {
      const runtime = await this.ensurePackageManager()
      const shimDirectory = await this.ensurePnpmShim(paths.runtime, runtime.node, runtime.pnpm)
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
      const commandPath = `${shimDirectory}${path.delimiter}${path.join(runtime.appRoot, 'node_modules', '.bin')}${path.delimiter}${sanitizedProcessEnvironment()[pathKey] || ''}`
      this.patchPluginOperation({ status: 'resolving', progress: 18, message: '正在解析插件版本与依赖', currentFile: packageSpec })
      task.progress = 18
      task.detail = `解析 ${packageSpec}`
      this.emit()

      const args = [runtime.dsh, 'plugin', '--profile', 'web', ...pluginPnpmArguments(action, packageSpec, packageName)]
      const profileEnvironment = await readPnpmProfileEnvironment(paths.dshHome)
      const child = spawnNode(runtime, args, {
        cwd: this.config.settings.workspace,
        dshHome: paths.dshHome,
        env: { npm_config_registry: this.registryUrl(), ...profileEnvironment, [pathKey]: commandPath }
      })
      const consume = (chunk: Buffer, level: LogLine['level']): void => {
        lastOutputAt = Date.now()
        for (const line of cleanPluginOutput(chunk.toString())) {
          const current = this.snapshot.pluginOperation
          if (!current || current.startedAt !== startedAt) continue
          this.snapshot.pluginOperation = updatePluginProgress(current, line)
          task.progress = this.snapshot.pluginOperation.progress
          task.detail = this.snapshot.pluginOperation.message
        }
        this.consumeProcessOutput(chunk.toString(), level)
      }
      child.stdout.on('data', (chunk: Buffer) => consume(chunk, 'INFO'))
      child.stderr.on('data', (chunk: Buffer) => consume(chunk, 'WARN'))
      const result = await this.waitForPluginProcess(child, action, packageName, initiallyInstalled, verifiablePackage, () => lastOutputAt)
      if (result.code !== 0) throw result.error || new Error(`插件${actionLabel}失败（退出码 ${result.code ?? 'unknown'}）`)
      if (verifiablePackage && !await this.pluginActionApplied(action, packageName)) throw new Error(`插件${actionLabel}进程已结束，但 web profile 校验未通过`)

      await this.refreshInstalledPlugins()
      const finalLine = action === 'remove'
        ? `已从 profiles/web/node_modules 移除 ${packageName}`
        : `已写入 profiles/web/node_modules/${packageName}`
      const current = this.snapshot.pluginOperation!
      const files = [...current.files, finalLine].slice(-120)
      this.snapshot.pluginOperation = {
        ...current,
        status: 'completed',
        progress: 100,
        message: wasRunning ? `插件${actionLabel}完成，是否现在重启 Harness？` : `插件${actionLabel}完成，下次启动 Harness 自动生效`,
        currentFile: finalLine,
        files,
        restartRequired: wasRunning,
        completedAt: new Date().toISOString()
      }
      task.status = 'completed'
      task.progress = 100
      task.detail = this.snapshot.pluginOperation.message
      this.log('INFO', result.recovered ? `${task.detail}（已自动回收未退出的包管理器进程）` : task.detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = this.snapshot.pluginOperation || {
        status: 'failed' as const,
        progress: task.progress,
        message,
        files: [],
        restartRequired: false
      }
      this.snapshot.pluginOperation = {
        ...current,
        status: 'failed',
        message,
        restartRequired: false,
        completedAt: new Date().toISOString()
      }
      task.status = 'failed'
      task.detail = message
      this.log('ERROR', `插件${actionLabel}失败：${message}`)
      await this.refreshInstalledPlugins()
    } finally {
      this.emit()
    }
    return this.getSnapshot()
  }

  private patchPluginOperation(patch: Partial<PluginOperationState>): void {
    const current = this.snapshot.pluginOperation || { status: 'idle', progress: 0, message: '等待插件操作', files: [], restartRequired: false }
    this.snapshot.pluginOperation = { ...current, ...patch }
  }

  private async isPluginInstalled(packageName: string, requireFiles: boolean): Promise<boolean> {
    try {
      const profileRoot = path.join(launcherDataPaths().dshHome, 'profiles', 'web')
      const profile = JSON.parse(await readFile(path.join(profileRoot, 'package.json'), 'utf8')) as WebProfileManifest
      if (!Object.hasOwn(profile.dependencies || {}, packageName)) return false
      if (!requireFiles) return true
      await access(path.join(profileRoot, 'node_modules', ...packageName.split('/'), 'package.json'))
      return profileHasActivePlugin(profile, packageName, true)
    } catch {
      return false
    }
  }

  private async pluginActionApplied(action: 'install' | 'update' | 'remove', packageName: string): Promise<boolean> {
    if (action === 'remove') return !await this.isPluginInstalled(packageName, false)
    return this.isPluginInstalled(packageName, true)
  }

  private async terminatePluginProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || !child.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, env: sanitizedProcessEnvironment() })
      await Promise.race([
        new Promise<void>((resolve) => killer.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000))
      ])
      return
    }
    child.kill('SIGTERM')
  }

  private waitForPluginProcess(
    child: ChildProcessWithoutNullStreams,
    action: 'install' | 'update' | 'remove',
    packageName: string,
    initiallyInstalled: boolean,
    verifiablePackage: boolean,
    lastOutputAt: () => number
  ): Promise<{ code: number | null; error?: Error; recovered?: boolean }> {
    const startedAt = Date.now()
    return new Promise((resolve) => {
      let settled = false
      let checking = false
      const cleanup = (): void => {
        clearInterval(recoveryTimer)
        clearTimeout(hardTimeout)
      }
      const finish = (result: { code: number | null; error?: Error; recovered?: boolean }): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const recoveryTimer = setInterval(() => {
        if (settled || checking || action === 'update' || !verifiablePackage || Date.now() - startedAt < 8_000 || Date.now() - lastOutputAt() < 6_000) return
        checking = true
        void this.pluginActionApplied(action, packageName).then((applied) => {
          const expectedChange = action === 'remove' ? initiallyInstalled : !initiallyInstalled
          if (applied && expectedChange) {
            finish({ code: 0, recovered: true })
            void this.terminatePluginProcess(child)
          }
        }).finally(() => { checking = false })
      }, 1_000)
      const hardTimeoutMs = pluginOperationTimeoutMs(packageName)
      const hardTimeout = setTimeout(() => {
        const minutes = Math.round(hardTimeoutMs / 60_000)
        finish({ code: null, error: new Error(`插件操作超过 ${minutes} 分钟未结束，已自动终止；请检查网络后重试`) })
        void this.terminatePluginProcess(child)
      }, hardTimeoutMs)
      child.once('error', (error) => finish({ code: null, error }))
      child.once('exit', (code) => finish({ code }))
    })
  }

  private consumeProcessOutput(output: string, fallback: LogLine['level'], browserCycle?: number): void {
    for (const raw of output.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const level = /\berror\b|\bfatal\b/i.test(line) ? 'ERROR' : /\bwarn/i.test(line) ? 'WARN' : fallback
      this.log(level, line)
      const url = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i)?.[0]
      if (url && browserCycle !== undefined && this.snapshot.runStatus === 'starting') this.markRunning(url, browserCycle)
    }
    this.emit()
  }

  private async refreshInstalledPlugins(): Promise<void> {
    this.snapshot.plugins = await Promise.all(this.snapshot.plugins.map(async (plugin) => ({
      ...plugin,
      installed: await this.isPluginInstalled(pluginPackageName(plugin.packageSpec), true)
    })))
  }

  private replaceSkinState(next: SkinStoreState): void {
    this.snapshot.skins = {
      ...next,
      desktopWallpaper: this.dynamicWallpaper.state(),
      transfers: this.snapshot.skins.transfers
    }
  }

  private replacePetState(next: PetStoreState): void {
    this.snapshot.pets = {
      ...next,
      desktopPet: this.desktopPet.state(),
      transfers: this.snapshot.pets.transfers
    }
  }

  private petTransferBusy(petId: string): boolean {
    const status = this.snapshot.pets.transfers[petId]?.status
    return status === 'queued' || status === 'downloading' || status === 'verifying' || status === 'applying' || status === 'removing'
  }

  private updatePetTransfer(petId: string, operation: PetTransferOperation, progress: PetDownloadProgress): void {
    const previous = this.snapshot.pets.transfers[petId]
    const previousIsActive = previous?.operation === operation && (previous.status === 'queued' || previous.status === 'downloading' || previous.status === 'verifying' || previous.status === 'applying' || previous.status === 'removing')
    const previousProgress = previousIsActive ? previous.progress : 0
    const ratio = progress.totalBytes > 0 ? progress.receivedBytes / progress.totalBytes : 0
    const completedDownload = progress.status === 'completed'
    const appliesAfterDownload = operation === 'apply' || operation === 'desktop'
    const status = completedDownload && appliesAfterDownload ? 'applying' : progress.status
    const percent = progress.status === 'verifying'
      ? Math.max(previousProgress, progress.receivedBytes > 0 ? 94 : 3)
      : completedDownload
        ? appliesAfterDownload ? 97 : 100
        : Math.max(previousProgress, 2, Math.min(92, Math.round(ratio * 92)))
    const message = completedDownload && operation === 'apply'
      ? '资源已就绪，正在写入 Harness 宠物配置'
      : completedDownload && operation === 'desktop'
        ? '资源已就绪，正在启动电脑桌面宠物'
        : progress.message
    this.snapshot.pets.transfers[petId] = {
      operation,
      status,
      progress: percent,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      message
    }
    if (!previous || previous.progress !== percent || previous.status !== status || previous.message !== message) this.emit()
  }

  private finishPetTransfer(petId: string, operation: PetTransferOperation, message: string): void {
    const previous = this.snapshot.pets.transfers[petId]
    this.snapshot.pets.transfers[petId] = {
      operation,
      status: 'completed',
      progress: 100,
      receivedBytes: previous?.totalBytes || 0,
      totalBytes: previous?.totalBytes || 0,
      message
    }
  }

  private failPetTransfer(petId: string, operation: PetTransferOperation, error: unknown): void {
    const previous = this.snapshot.pets.transfers[petId]
    this.snapshot.pets.transfers[petId] = {
      operation,
      status: 'failed',
      progress: previous?.progress || 0,
      receivedBytes: previous?.receivedBytes || 0,
      totalBytes: previous?.totalBytes || 0,
      message: error instanceof Error ? error.message : String(error)
    }
  }

  private skinTransferBusy(skinId: string): boolean {
    const status = this.snapshot.skins.transfers[skinId]?.status
    return status === 'queued' || status === 'downloading' || status === 'verifying' || status === 'applying' || status === 'removing'
  }

  private updateSkinTransfer(skinId: string, operation: SkinTransferOperation, progress: SkinDownloadProgress): void {
    const previous = this.snapshot.skins.transfers[skinId]
    const previousIsActive = previous?.operation === operation && (previous.status === 'queued' || previous.status === 'downloading' || previous.status === 'verifying' || previous.status === 'applying' || previous.status === 'removing')
    const previousProgress = previousIsActive ? previous.progress : 0
    const ratio = progress.totalBytes > 0 ? progress.receivedBytes / progress.totalBytes : 0
    const completedDownload = progress.status === 'completed'
    const appliesAfterDownload = operation === 'apply' || operation === 'desktop'
    const status = completedDownload && appliesAfterDownload
      ? 'applying'
      : progress.status
    const percent = progress.status === 'verifying'
      ? Math.max(previousProgress, progress.receivedBytes > 0 ? 94 : 3)
      : completedDownload
        ? appliesAfterDownload ? 97 : 100
        : Math.max(previousProgress, 2, Math.min(92, Math.round(ratio * 92)))
    const message = completedDownload && operation === 'apply'
      ? '资源已就绪，正在写入 Harness 外观配置'
      : completedDownload && operation === 'desktop'
        ? '资源已就绪，正在应用电脑桌面'
        : progress.message
    this.snapshot.skins.transfers[skinId] = {
      operation,
      status,
      progress: percent,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      message
    }
    if (!previous || previous.progress !== percent || previous.status !== status || previous.message !== message) this.emit()
  }

  private finishSkinTransfer(skinId: string, operation: SkinTransferOperation, message: string): void {
    const previous = this.snapshot.skins.transfers[skinId]
    this.snapshot.skins.transfers[skinId] = {
      operation,
      status: 'completed',
      progress: 100,
      receivedBytes: previous?.totalBytes || 0,
      totalBytes: previous?.totalBytes || 0,
      message
    }
  }

  private failSkinTransfer(skinId: string, operation: SkinTransferOperation, error: unknown): void {
    const previous = this.snapshot.skins.transfers[skinId]
    this.snapshot.skins.transfers[skinId] = {
      operation,
      status: 'failed',
      progress: previous?.progress || 0,
      receivedBytes: previous?.receivedBytes || 0,
      totalBytes: previous?.totalBytes || 0,
      message: error instanceof Error ? error.message : String(error)
    }
  }

  private updateLaunchProgress(status: LauncherSnapshot['launchProgress']['status'], progress: number, message: string): void {
    this.snapshot.launchProgress = { status, progress: Math.max(0, Math.min(100, Math.round(progress))), message }
    this.emit()
  }

  private async waitForServer(browserCycle: number): Promise<void> {
    const url = `http://127.0.0.1:${this.config.settings.port}`
    for (let attempt = 0; attempt < 90 && this.snapshot.runStatus === 'starting'; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(750) })
        if (response.ok) {
          this.markRunning(url, browserCycle)
          return
        }
      } catch {
        // The server normally needs several seconds before accepting requests.
      }
      if (attempt % 2 === 0) this.updateLaunchProgress('waiting', Math.min(96, 76 + Math.round(attempt / 89 * 20)), `正在等待本地服务就绪 · ${attempt + 1}/90`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (this.snapshot.runStatus === 'starting') {
      this.snapshot.runStatus = 'error'
      this.updateLaunchProgress('failed', 96, `等待服务超时：${url}`)
      this.log('ERROR', `等待服务超时：${url}`)
      this.emit()
    }
  }

  private markRunning(url: string, browserCycle: number): void {
    if (this.snapshot.runStatus === 'running') return
    this.snapshot.runStatus = 'running'
    this.snapshot.serviceUrl = url
    this.snapshot.launchProgress = { status: 'ready', progress: 100, message: 'Harness 已就绪，可以开始使用' }
    this.log('INFO', `Harness 已就绪：${url}`)
    this.emit()
    void this.browserHandoff.openOnce(browserCycle, url, this.config.settings.autoOpen, (target) => shell.openExternal(target))
      .catch((error) => this.log('WARN', `自动打开 Harness 页面失败：${error instanceof Error ? error.message : String(error)}`))
  }

  private log(level: LogLine['level'], message: string): void {
    const now = new Date()
    this.snapshot.logs.push({
      id: this.nextLogId++,
      time: now.toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message
    })
    const logDirectory = launcherDataPaths().logs
    const logFile = path.join(logDirectory, `${now.toISOString().slice(0, 10)}.log`)
    void mkdir(logDirectory, { recursive: true })
      .then(() => appendFile(logFile, `[${now.toISOString()}] ${level} ${message}\n`, 'utf8'))
      .catch(() => undefined)
    if (this.snapshot.logs.length > MAX_LOG_LINES) this.snapshot.logs.splice(0, this.snapshot.logs.length - MAX_LOG_LINES)
  }

  private emit(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send('launcher:snapshot', this.getSnapshot())
  }
}
