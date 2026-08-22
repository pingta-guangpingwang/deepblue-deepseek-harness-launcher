import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherApi, LauncherSettings, LauncherSnapshot } from '../shared/types'

const api: LauncherApi = {
  getSnapshot: () => ipcRenderer.invoke('launcher:get-snapshot'),
  refreshEnvironment: () => ipcRenderer.invoke('launcher:refresh-environment'),
  checkSources: () => ipcRenderer.invoke('launcher:check-sources'),
  startHarness: () => ipcRenderer.invoke('launcher:start'),
  stopHarness: () => ipcRenderer.invoke('launcher:stop'),
  installHarness: (version?: string) => ipcRenderer.invoke('launcher:install', version),
  applyRuntimeUpdates: () => ipcRenderer.invoke('launcher:apply-runtime-updates'),
  downloadLauncherUpdate: () => ipcRenderer.invoke('launcher:download-update'),
  rollbackHarness: (version: string) => ipcRenderer.invoke('launcher:rollback', version),
  repair: () => ipcRenderer.invoke('launcher:repair'),
  chooseWorkspace: () => ipcRenderer.invoke('launcher:choose-workspace'),
  confirmStorageSetup: () => ipcRenderer.invoke('launcher:confirm-storage-setup'),
  chooseStorageRoot: () => ipcRenderer.invoke('launcher:choose-storage-root'),
  createShortcuts: () => ipcRenderer.invoke('launcher:create-shortcuts'),
  openPath: (path: string) => ipcRenderer.invoke('launcher:open-path', path),
  openExternal: (url: string) => ipcRenderer.invoke('launcher:open-external', url),
  saveSettings: (patch: Partial<LauncherSettings>) => ipcRenderer.invoke('launcher:save-settings', patch),
  pluginAction: (action, packageSpec) => ipcRenderer.invoke('launcher:plugin-action', action, packageSpec),
  refreshDiscovery: () => ipcRenderer.invoke('launcher:refresh-discovery'),
  newsDetail: (id) => ipcRenderer.invoke('launcher:news-detail', id),
  resourceDetail: (id) => ipcRenderer.invoke('launcher:resource-detail', id),
  resourceEngagement: (id) => ipcRenderer.invoke('launcher:resource-engagement', id),
  commentResource: (id, body) => ipcRenderer.invoke('launcher:comment-resource', id, body),
  queueResource: (id) => ipcRenderer.invoke('launcher:queue-resource', id),
  installLibraryResource: (id) => ipcRenderer.invoke('launcher:install-library-resource', id),
  removeLibraryResource: (id) => ipcRenderer.invoke('launcher:remove-library-resource', id),
  copyText: (value) => ipcRenderer.invoke('launcher:copy-text', value),
  accountLogin: () => ipcRenderer.invoke('launcher:account-login'),
  accountLogout: () => ipcRenderer.invoke('launcher:account-logout'),
  refreshFavorites: () => ipcRenderer.invoke('launcher:refresh-favorites'),
  toggleResourceFavorite: (id) => ipcRenderer.invoke('launcher:toggle-resource-favorite', id),
  playGame: (slug) => ipcRenderer.invoke('launcher:play-game', slug),
  saveModelProvider: (draft) => ipcRenderer.invoke('launcher:save-model-provider', draft),
  removeModelProvider: (providerId) => ipcRenderer.invoke('launcher:remove-model-provider', providerId),
  setActiveModel: (provider, model) => ipcRenderer.invoke('launcher:set-active-model', provider, model),
  refreshModelUsage: () => ipcRenderer.invoke('launcher:refresh-model-usage'),
  testMultimodal: (request) => ipcRenderer.invoke('launcher:test-multimodal', request),
  refreshSkins: () => ipcRenderer.invoke('launcher:refresh-skins'),
  applySkin: (skinId) => ipcRenderer.invoke('launcher:apply-skin', skinId),
  toggleSkinFavorite: (skinId) => ipcRenderer.invoke('launcher:toggle-skin-favorite', skinId),
  clearSkin: () => ipcRenderer.invoke('launcher:clear-skin'),
  refreshPets: () => ipcRenderer.invoke('launcher:refresh-pets'),
  applyPet: (petId) => ipcRenderer.invoke('launcher:apply-pet', petId),
  clearPet: () => ipcRenderer.invoke('launcher:clear-pet'),
  importPet: () => ipcRenderer.invoke('launcher:import-pet'),
  removeCustomPet: (petId) => ipcRenderer.invoke('launcher:remove-custom-pet', petId),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  onSnapshot: (listener: (snapshot: LauncherSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: LauncherSnapshot): void => listener(snapshot)
    ipcRenderer.on('launcher:snapshot', wrapped)
    return () => ipcRenderer.removeListener('launcher:snapshot', wrapped)
  }
}

contextBridge.exposeInMainWorld('launcher', api)
