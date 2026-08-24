import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell, Tray } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LauncherController } from './controller'
import { launcherDataPaths, readConfig, setLauncherStorageRoot } from './config'
import { selectLauncherUi, type LauncherUiSelection } from './launcher-ui'
import type { LauncherSettings, ModelProviderDraft, MultimodalTestRequest } from '../shared/types'

let mainWindow: BrowserWindow | undefined
let controller: LauncherController | undefined
let tray: Tray | undefined
let quitting = false
let launcherUi: LauncherUiSelection | undefined

protocol.registerSchemesAsPrivileged([{
  scheme: 'deepblue-skin',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}, {
  scheme: 'deepblue-pet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])

function registerSkinPreviewProtocol(): void {
  protocol.handle('deepblue-skin', (request) => {
    const url = new URL(request.url)
    const fileName = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (url.hostname !== 'cache' || !/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(fileName)) {
      return new Response('Invalid skin preview path', { status: 400 })
    }
    const root = path.resolve(launcherDataPaths().skins, 'cache')
    const target = path.resolve(root, fileName)
    if (path.dirname(target) !== root) return new Response('Invalid skin preview path', { status: 400 })
    return net.fetch(pathToFileURL(target).toString())
  })
}

function registerPetPreviewProtocol(): void {
  protocol.handle('deepblue-pet', (request) => {
    const url = new URL(request.url)
    const fileName = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (url.hostname !== 'cache' || !/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/i.test(fileName)) {
      return new Response('Invalid pet preview path', { status: 400 })
    }
    const root = path.resolve(launcherDataPaths().pets, 'cache')
    const target = path.resolve(root, fileName)
    if (path.dirname(target) !== root) return new Response('Invalid pet preview path', { status: 400 })
    return net.fetch(pathToFileURL(target).toString())
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
  const active = wallpaperActive || petActive
  if (!active) {
    tray?.destroy()
    tray = undefined
    return
  }
  if (!tray) {
    tray = new Tray(appIconPath())
    tray.on('double-click', showMainWindow)
  }
  tray.setToolTip(`深蓝 DeepSeek Harness · ${wallpaperActive && petActive ? '动态桌面与宠物运行中' : petActive ? '桌面宠物运行中' : '动态桌面运行中'}`)
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

function createWindow(ui = launcherUi): BrowserWindow {
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
    if (!quitting && controller?.isDesktopExperienceActive()) {
      event.preventDefault()
      window.hide()
      syncDesktopTray()
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(ui?.entry || path.join(__dirname, '../renderer/index.html'))
  }
  return window
}

function registerIpc(): void {
  ipcMain.handle('launcher:get-snapshot', () => controller?.getSnapshot())
  ipcMain.handle('launcher:refresh-environment', () => controller?.refreshEnvironment())
  ipcMain.handle('launcher:check-sources', () => controller?.checkSources())
  ipcMain.handle('launcher:start', () => controller?.startHarness())
  ipcMain.handle('launcher:stop', () => controller?.stopHarness())
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
  ipcMain.handle('launcher:save-settings', (_event, patch: Partial<LauncherSettings>) => controller?.saveSettings(patch))
  ipcMain.handle('launcher:plugin-action', (_event, action, packageSpec) => controller?.pluginAction(action, packageSpec))
  ipcMain.handle('launcher:refresh-discovery', () => controller?.refreshDiscovery())
  ipcMain.handle('launcher:news-detail', (_event, id: string) => controller?.newsDetail(id))
  ipcMain.handle('launcher:resource-detail', (_event, id: string) => controller?.resourceDetail(id))
  ipcMain.handle('launcher:resource-engagement', (_event, id: string) => controller?.resourceEngagement(id))
  ipcMain.handle('launcher:comment-resource', (_event, id: string, body: string) => controller?.commentResource(id, body))
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
  ipcMain.handle('window:action', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    if (action === 'close') {
      if (controller?.isDesktopExperienceActive()) {
        mainWindow.hide()
        syncDesktopTray()
      } else {
        mainWindow.close()
      }
    }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

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
    mainWindow = createWindow()
    controller = new LauncherController(mainWindow, launcherUi)
    await controller.initialize()
    syncDesktopTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !controller?.isDesktopExperienceActive()) app.quit()
})

app.on('before-quit', () => {
  quitting = true
  void controller?.dispose()
})
