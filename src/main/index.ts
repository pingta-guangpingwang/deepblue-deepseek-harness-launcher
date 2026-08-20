import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { LauncherController } from './controller'
import type { LauncherSettings, ModelProviderDraft, MultimodalTestRequest } from '../shared/types'

let mainWindow: BrowserWindow | undefined
let controller: LauncherController | undefined

function createWindow(): BrowserWindow {
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, 'resources/icon.png')
    : path.resolve('resources/icon.png')
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
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
  ipcMain.handle('launcher:apply-skin', (_event, skinId: string) => controller?.applySkin(skinId))
  ipcMain.handle('launcher:clear-skin', () => controller?.clearSkin())
  ipcMain.handle('launcher:refresh-pets', () => controller?.refreshPets())
  ipcMain.handle('launcher:apply-pet', (_event, petId: string) => controller?.applyPet(petId))
  ipcMain.handle('launcher:clear-pet', () => controller?.clearPet())
  ipcMain.handle('launcher:import-pet', () => controller?.importPet())
  ipcMain.handle('launcher:remove-custom-pet', (_event, petId: string) => controller?.removeCustomPet(petId))
  ipcMain.handle('window:action', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    if (action === 'close') mainWindow.close()
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
    registerIpc()
    mainWindow = createWindow()
    controller = new LauncherController(mainWindow)
    await controller.initialize()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
