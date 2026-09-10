import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, Tray } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { LauncherController } from './controller'
import { launcherDataPaths, readConfig, setLauncherStorageRoot } from './config'
import { selectLauncherUi, type LauncherUiSelection } from './launcher-ui'
import type { LauncherSettings, ModelProviderDraft, MultimodalTestRequest } from '../shared/types'
import { ConversationWindows } from './conversation-windows'
import type { ConversationTarget } from '../shared/conversation'

let mainWindow: BrowserWindow | undefined
let controller: LauncherController | undefined
let tray: Tray | undefined
let quitting = false
let launcherUi: LauncherUiSelection | undefined
let viewOwner: string | undefined
const conversationWindows = new ConversationWindows((target) => createConversationWindow(target), () => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !controller?.isDesktopExperienceActive()) mainWindow.close() })
const currentOwner = (): string => controller?.getSnapshot()?.account?.user?.id || ''

if (process.env.DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration()
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'deepblue-skin',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}, {
  scheme: 'deepblue-pet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}])

function registerSkinPreviewProtocol(): void {
  protocol.handle('deepblue-skin', async (request) => {
    const url = new URL(request.url)
    const fileName = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (url.hostname !== 'cache' || !/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(fileName)) {
      return new Response('Invalid skin preview path', { status: 400 })
    }
    const root = path.resolve(launcherDataPaths().skins, 'cache')
    const target = path.resolve(root, fileName)
    if (path.dirname(target) !== root) return new Response('Invalid skin preview path', { status: 400 })
    return localAssetResponse(request, target)
  })
}

function localAssetMime(filename: string): string {
  const extension = path.extname(filename).toLowerCase()
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.txt': 'text/plain; charset=utf-8'
  } as Record<string, string>)[extension] || 'application/octet-stream'
}

async function localAssetResponse(request: Request, filename: string): Promise<Response> {
  let bytes: Buffer
  try {
    bytes = await readFile(path.toNamespacedPath(filename))
  } catch {
    return new Response('Local asset not found', { status: 404 })
  }
  const headers = new Headers({
    'content-type': localAssetMime(filename),
    'content-length': String(bytes.length),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable'
  })
  // Launcher UI is loaded from file:// while previews use a locked custom
  // protocol. Explicit CORS is required before Canvas can inspect sprite alpha.
  headers.set('access-control-allow-origin', '*')
  headers.set('cross-origin-resource-policy', 'cross-origin')
  const range = request.headers.get('range')
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } })
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } })
    const partial = bytes.subarray(start, end + 1)
    headers.set('content-range', `bytes ${start}-${end}/${bytes.length}`)
    headers.set('content-length', String(partial.length))
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(partial).buffer, { status: 206, headers })
  }
  return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes).buffer, { status: 200, headers })
}

function registerPetPreviewProtocol(): void {
  protocol.handle('deepblue-pet', async (request) => {
    const url = new URL(request.url)
    const fileName = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (url.hostname !== 'cache' || !/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/i.test(fileName)) {
      return new Response('Invalid pet preview path', { status: 400 })
    }
    const root = path.resolve(launcherDataPaths().pets, 'cache')
    const target = path.resolve(root, fileName)
    if (path.dirname(target) !== root) return new Response('Invalid pet preview path', { status: 400 })
    return localAssetResponse(request, target)
  })
}

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources/icon.png')
    : path.resolve('resources/icon.png')
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function syncDesktopTray(): void {
  const wallpaperActive = controller?.isDynamicDesktopActive() === true
  const petActive = controller?.isDesktopPetActive() === true
  const hostActive = controller?.isAgentHostActive() === true
  const active = wallpaperActive || petActive || hostActive
  if (!active) {
    tray?.destroy()
    tray = undefined
    return
  }
  if (!tray) {
    tray = new Tray(appIconPath())
    tray.on('double-click', showMainWindow)
  }
  tray.setToolTip(`深蓝 DeepSeek Harness · ${hostActive ? '智能体托管运行中' : wallpaperActive && petActive ? '动态桌面与宠物运行中' : petActive ? '桌面宠物运行中' : '动态桌面运行中'}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开启动器', click: showMainWindow },
    ...(wallpaperActive ? [{
      label: '停止动态桌面',
      click: () => {
        void controller?.stopDynamicDesktop().then(() => {
          syncDesktopTray()
          showMainWindow()
        })
      }
    }] : []),
    ...(petActive ? [{
      label: '停止桌面宠物',
      click: () => {
        void controller?.stopDesktopPet().then(() => {
          syncDesktopTray()
          showMainWindow()
        })
      }
    }] : []),
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ]))
}

function loadWindowContents(window: BrowserWindow, ui = launcherUi): void {
  setImmediate(() => {
    if (window.isDestroyed()) return
    if (process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(ui?.entry || path.join(__dirname, '../renderer/index.html'))
    }
  })
}

function createWindow(ui = launcherUi, loadContents = true): BrowserWindow {
  const icon = appIconPath()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 17 },
    backgroundColor: '#f7f8fa',
    icon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!quitting && (controller?.isDesktopExperienceActive() || conversationWindows.size > 0)) {
      event.preventDefault()
      window.hide()
      syncDesktopTray()
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (loadContents) loadWindowContents(window, ui)
  return window
}

function createConversationWindow(target: ConversationTarget): BrowserWindow {
  const window = new BrowserWindow({ width: 980, height: 820, minWidth: 480, minHeight: 500, show: false, frame: false, title: target.title,
    backgroundColor: '#f7f8fa', icon: appIconPath(), webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { event.preventDefault(); window.setFullScreen(!window.isFullScreen()) }
    if (input.type === 'keyDown' && input.key === 'Escape' && window.isFullScreen()) { event.preventDefault(); window.setFullScreen(false) }
  })
  setImmediate(() => {
    if (window.isDestroyed()) return
    if (process.env.ELECTRON_RENDERER_URL) { const url = new URL(process.env.ELECTRON_RENDERER_URL); url.searchParams.set('conversation', '1'); void window.loadURL(url.href) }
    else void window.loadFile(launcherUi?.entry || path.join(__dirname, '../renderer/index.html'), { query: { conversation: '1' } })
  })
  return window
}

function registerIpc(): void {
  const requireLauncherSender = (event: Electron.IpcMainInvokeEvent): void => {
    const owned = mainWindow && event.sender.id === mainWindow.webContents.id || conversationWindows.context(event.sender.id, currentOwner())
    if (!owned || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许启动器受信任主界面或独立会话窗口调用工作台')
  }
  ipcMain.handle('launcher:open-conversation', (event, target) => { requireLauncherSender(event); return conversationWindows.open(target, currentOwner()) })
  ipcMain.handle('launcher:conversation-context', event => { requireLauncherSender(event); return conversationWindows.context(event.sender.id, currentOwner()) || null })
  ipcMain.handle('launcher:focus-main', event => { requireLauncherSender(event); mainWindow?.show(); mainWindow?.focus() })
  ipcMain.handle('launcher:agent-host-state', (event) => { requireLauncherSender(event); return controller?.agentHostState() })
  ipcMain.handle('launcher:agent-host-action', async (event, action) => { requireLauncherSender(event); const state = await controller?.agentHostAction(action); syncDesktopTray(); return state })
  ipcMain.handle('launcher:agent-workspace-request', (event, request) => { requireLauncherSender(event); return controller?.agentWorkspaceRequest(request) })
  ipcMain.on('desktop-pet:drag-start', (event, position: unknown) => controller?.beginDesktopPetDrag(event.sender.id, position))
  ipcMain.on('desktop-pet:drag-move', (event, position: unknown) => controller?.moveDesktopPetDrag(event.sender.id, position))
  ipcMain.handle('desktop-pet:drag-end', (event, position: unknown) => controller?.endDesktopPetDrag(event.sender.id, position))
  ipcMain.handle('desktop-pet:deepseek-balance', (event) => controller?.desktopPetDeepSeekBalance(event.sender.id))
  ipcMain.handle('launcher:get-snapshot', event => { requireLauncherSender(event); return controller?.getSnapshot() })
  ipcMain.handle('launcher:refresh-environment', () => controller?.refreshEnvironment())
  ipcMain.handle('launcher:check-sources', () => controller?.checkSources())
  ipcMain.handle('launcher:start', () => controller?.startHarness())
  ipcMain.handle('launcher:stop', () => controller?.stopHarness())
  ipcMain.handle('launcher:restart', () => controller?.restartHarness())
  ipcMain.handle('launcher:install', (_event, version?: string) => controller?.installHarness(version))
  ipcMain.handle('launcher:apply-runtime-updates', () => controller?.applyRuntimeUpdates())
  ipcMain.handle('launcher:download-update', () => controller?.downloadLauncherUpdate())
  ipcMain.handle('launcher:rollback', (_event, version: string) => controller?.rollbackHarness(version))
  ipcMain.handle('launcher:repair', () => controller?.repair())
  ipcMain.handle('launcher:choose-workspace', () => controller?.chooseWorkspace())
  ipcMain.handle('launcher:confirm-storage-setup', () => controller?.confirmStorageSetup())
  ipcMain.handle('launcher:choose-storage-root', () => controller?.chooseStorageRoot())
  ipcMain.handle('launcher:create-shortcuts', () => controller?.createShortcuts())
  ipcMain.handle('launcher:open-path', (_event, target: string) => controller?.openPath(target))
  ipcMain.handle('launcher:open-external', (_event, url: string) => controller?.openExternal(url))
  ipcMain.handle('launcher:save-settings', (event, patch: Partial<LauncherSettings>) => { requireLauncherSender(event); return controller?.saveSettings(patch) })
  ipcMain.handle('launcher:plugin-action', (_event, action, packageSpec) => controller?.pluginAction(action, packageSpec))
  ipcMain.handle('launcher:refresh-discovery', () => controller?.refreshDiscovery())
  ipcMain.handle('launcher:news-detail', (_event, id: string) => controller?.newsDetail(id))
  ipcMain.handle('launcher:resource-detail', (_event, id: string) => controller?.resourceDetail(id))
  ipcMain.handle('launcher:resource-engagement', (_event, id: string) => controller?.resourceEngagement(id))
  ipcMain.handle('launcher:comment-resource', (_event, id: string, body: string) => controller?.commentResource(id, body))
  ipcMain.handle('launcher:community-request', (_event, request) => controller?.communityRequest(request))
  ipcMain.handle('launcher:queue-resource', (_event, id: string) => controller?.queueResource(id))
  ipcMain.handle('launcher:install-library-resource', (_event, id: string) => controller?.installLibraryResource(id))
  ipcMain.handle('launcher:remove-library-resource', (_event, id: string) => controller?.removeLibraryResource(id))
  ipcMain.handle('launcher:copy-text', (_event, value: string) => controller?.copyText(value))
  ipcMain.handle('launcher:account-login', () => controller?.accountLogin())
  ipcMain.handle('launcher:account-logout', () => controller?.accountLogout())
  ipcMain.handle('launcher:refresh-favorites', () => controller?.refreshFavorites())
  ipcMain.handle('launcher:toggle-resource-favorite', (_event, id: string) => controller?.toggleResourceFavorite(id))
  ipcMain.handle('launcher:play-game', (_event, slug: string) => controller?.playGame(slug))
  ipcMain.handle('launcher:save-model-provider', (_event, draft: ModelProviderDraft) => controller?.saveModelProvider(draft))
  ipcMain.handle('launcher:remove-model-provider', (_event, providerId: string) => controller?.removeModelProvider(providerId))
  ipcMain.handle('launcher:set-active-model', (_event, provider: string, model: string) => controller?.setActiveModel(provider, model))
  ipcMain.handle('launcher:refresh-model-usage', () => controller?.refreshModelUsage())
  ipcMain.handle('launcher:test-multimodal', (_event, request: MultimodalTestRequest) => controller?.testMultimodal(request))
  ipcMain.handle('launcher:refresh-skins', () => controller?.refreshSkins())
  ipcMain.handle('launcher:download-skin', (_event, skinId: string) => controller?.downloadSkin(skinId))
  ipcMain.handle('launcher:preview-skin', (_event, skinId: string) => controller?.previewSkin(skinId))
  ipcMain.handle('launcher:apply-skin', (_event, skinId: string) => controller?.applySkin(skinId))
  ipcMain.handle('launcher:apply-skin-to-desktop', async (_event, skinId: string) => {
    const snapshot = await controller?.applySkinToDesktop(skinId)
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('launcher:stop-dynamic-desktop', async () => {
    const snapshot = await controller?.stopDynamicDesktop()
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('launcher:remove-skin', async (_event, skinId: string) => {
    const snapshot = await controller?.removeSkin(skinId)
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('launcher:toggle-skin-favorite', (_event, skinId: string) => controller?.toggleSkinFavorite(skinId))
  ipcMain.handle('launcher:clear-skin', () => controller?.clearSkin())
  ipcMain.handle('launcher:refresh-pets', () => controller?.refreshPets())
  ipcMain.handle('launcher:download-pet', (_event, petId: string) => controller?.downloadPet(petId))
  ipcMain.handle('launcher:preview-pet', (_event, petId: string) => controller?.previewPet(petId))
  ipcMain.handle('launcher:apply-pet', (_event, petId: string) => controller?.applyPet(petId))
  ipcMain.handle('launcher:apply-pet-to-desktop', async (_event, petId: string) => {
    const snapshot = await controller?.applyPetToDesktop(petId)
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('launcher:stop-desktop-pet', async () => {
    const snapshot = await controller?.stopDesktopPet()
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('launcher:remove-pet', async (_event, petId: string) => {
    const snapshot = await controller?.removePet(petId)
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('launcher:toggle-pet-favorite', (_event, petId: string) => controller?.togglePetFavorite(petId))
  ipcMain.handle('launcher:clear-pet', () => controller?.clearPet())
  ipcMain.handle('launcher:import-pet', () => controller?.importPet())
  ipcMain.handle('launcher:remove-custom-pet', async (_event, petId: string) => {
    const snapshot = await controller?.removeCustomPet(petId)
    syncDesktopTray()
    return snapshot
  })
  ipcMain.handle('window:action', (event, action: 'minimize' | 'maximize' | 'close' | 'fullscreen') => {
    requireLauncherSender(event)
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target) return
    if (action === 'minimize') target.minimize()
    if (action === 'maximize') target.isMaximized() ? target.unmaximize() : target.maximize()
    if (action === 'fullscreen') target.setFullScreen(!target.isFullScreen())
    if (action === 'close') {
      if (target === mainWindow && controller?.isDesktopExperienceActive()) {
        target.hide()
        syncDesktopTray()
      } else {
        target.close()
      }
    }
  })
}

// Packaged release QA uses an isolated profile while a user's installed launcher
// may legitimately be running. Keep production single-instance behaviour, but
// let the isolated gate opt out so an unrelated stale process cannot invalidate
// the cold-start result.
const hasSingleInstanceLock = process.env.DSH_LAUNCHER_ALLOW_PARALLEL === '1'
  ? true
  : app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('org.deepseek-harness.launcher')
    const startupConfig = await readConfig()
    setLauncherStorageRoot(startupConfig.settings.storageRoot)
    launcherUi = await selectLauncherUi(
      launcherDataPaths().runtime,
      path.join(__dirname, '../renderer/index.html')
    )
    registerSkinPreviewProtocol()
    registerPetPreviewProtocol()
    registerIpc()
    // Keep the renderer hidden and unloaded until initialize() has created a
    // complete snapshot. Existing content-addressed UI modules can execute
    // immediately from disk and must never observe an undefined controller state.
    mainWindow = createWindow(launcherUi, false)
    controller = new LauncherController(mainWindow, launcherUi, (channel, payload) => {
      if (channel === 'launcher:snapshot') { const owner = currentOwner(); if (viewOwner !== undefined && viewOwner !== owner) conversationWindows.closeAll(); viewOwner = owner }
      conversationWindows.broadcast(channel, payload)
    })
    await controller.initialize()
    loadWindowContents(mainWindow, launcherUi)
    syncDesktopTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !controller?.isDesktopExperienceActive()) app.quit()
})

app.on('before-quit', (event) => {
  if (controller?.isAgentHostBusy()) {
    const choice = dialog.showMessageBoxSync({ type: 'warning', title: '智能体任务仍在运行', message: '退出启动器会中断本机智能体任务。', detail: '选择继续后台运行，可以关闭主窗口并保留远程连接。', buttons: ['继续后台运行', '退出并中断任务'], defaultId: 0, cancelId: 0 })
    if (choice === 0) { event.preventDefault(); quitting = false; mainWindow?.hide(); syncDesktopTray(); return }
  }
  quitting = true
  void controller?.dispose().catch(() => {})
})
