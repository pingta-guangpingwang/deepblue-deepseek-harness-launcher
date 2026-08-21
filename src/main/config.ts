import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LauncherLibraryEntry, LauncherSettings, ModelProviderDraft, SourceConfig, WorkspaceEntry } from '../shared/types'

const defaultSources: SourceConfig[] = [
  {
    id: 'gitee',
    name: 'Gitee',
    baseUrl: 'https://gitee.com/wanggp123/deepseek-harness.git',
    enabled: true,
    kind: 'repository'
  },
  {
    id: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com/pingta-guangpingwang/deepseek-harness.git',
    enabled: true,
    kind: 'repository'
  },
  {
    id: 'runtime-v2',
    name: '运行时模块目录',
    baseUrl: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json',
    enabled: true,
    kind: 'manifest'
  },
  {
    id: 'npmmirror',
    name: 'npmmirror',
    baseUrl: 'https://registry.npmmirror.com',
    enabled: true,
    kind: 'registry'
  }
]

export const FIXED_SKIN_CATALOG_URL = 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/catalog.json'
export const FIXED_PET_CATALOG_URL = 'https://gitee.com/wanggp123/deepseek-harness-pets/raw/master/catalog.json'

export interface PersistedConfig {
  settings: LauncherSettings
  activeVersion: string
  workspaces: WorkspaceEntry[]
  resourceLibrary: LauncherLibraryEntry[]
  modelRouting: {
    active: { provider: string; model: string }
    providers: Array<Omit<ModelProviderDraft, 'apiKey'> & { apiKeyEnv?: string }>
    credentialSyncVersion?: 1
  }
}

let configuredStorageRoot: string | undefined

function normalizedStorageRoot(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || !path.isAbsolute(value)) return fallback
  const resolved = path.resolve(value)
  return resolved === path.parse(resolved).root ? fallback : resolved
}

export function setLauncherStorageRoot(value: string): void {
  configuredStorageRoot = normalizedStorageRoot(value, app.getPath('userData'))
}

function defaults(): PersistedConfig {
  const defaultStorageRoot = app.getPath('userData')
  return {
    settings: {
      workspace: app.getPath('documents'),
      storageRoot: defaultStorageRoot,
      storageSetupCompleted: false,
      port: 3080,
      autoOpen: true,
      theme: 'light',
      channel: 'stable',
      backupBeforeUpdate: true,
      keepBackups: 3,
      installMode: 'package',
      skinCatalogUrl: FIXED_SKIN_CATALOG_URL,
      petCatalogUrl: FIXED_PET_CATALOG_URL,
      sources: defaultSources
    },
    activeVersion: '0.1.0-rc.8',
    workspaces: [],
    resourceLibrary: [],
    modelRouting: {
      active: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      providers: [{
        id: 'deepseek-official',
        name: 'DeepSeek 官方',
        api: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
        ],
        docsUrl: 'https://api-docs.deepseek.com/',
        custom: false
      }]
    }
  }
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'launcher.json')
}

export async function readConfig(): Promise<PersistedConfig> {
  const fallback = defaults()
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<PersistedConfig>
    const { favoriteResourceIds: _legacyLocalFavorites, ...savedSettings } = (parsed.settings || {}) as Partial<LauncherSettings> & { favoriteResourceIds?: unknown }
    const storageRoot = normalizedStorageRoot(savedSettings.storageRoot, fallback.settings.storageRoot)
    const storageSetupCompleted = typeof savedSettings.storageSetupCompleted === 'boolean'
      ? savedSettings.storageSetupCompleted
      : Boolean(parsed.settings)
    return {
      settings: {
        ...fallback.settings,
        ...savedSettings,
        storageRoot,
        storageSetupCompleted,
        skinCatalogUrl: FIXED_SKIN_CATALOG_URL,
        petCatalogUrl: FIXED_PET_CATALOG_URL,
        sources: fallback.settings.sources.map((defaultSource) => {
          const saved = parsed.settings?.sources?.find((source) => source.id === defaultSource.id)
          if (!saved) return defaultSource
          if ((saved.id === 'gitee' || saved.id === 'runtime-v2') && !saved.baseUrl.trim()) return defaultSource
          return { ...defaultSource, ...saved }
        })
      },
      activeVersion: parsed.activeVersion || fallback.activeVersion,
      workspaces: parsed.workspaces || fallback.workspaces,
      resourceLibrary: Array.isArray(parsed.resourceLibrary)
        ? parsed.resourceLibrary.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.title === 'string').slice(0, 500)
        : fallback.resourceLibrary,
      modelRouting: {
        active: parsed.modelRouting?.active || fallback.modelRouting.active,
        providers: Array.isArray(parsed.modelRouting?.providers) && parsed.modelRouting.providers.length
          ? parsed.modelRouting.providers
          : fallback.modelRouting.providers,
        credentialSyncVersion: parsed.modelRouting?.credentialSyncVersion === 1 ? 1 : undefined
      }
    }
  } catch {
    return fallback
  }
}

export async function writeConfig(config: PersistedConfig): Promise<void> {
  const target = configPath()
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.next`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

export function launcherDataPaths(): { root: string; runtime: string; dshHome: string; backups: string; logs: string; skins: string; skinConfig: string; pets: string; petConfig: string } {
  const root = configuredStorageRoot || app.getPath('userData')
  return {
    root,
    runtime: path.join(root, 'runtime'),
    dshHome: path.join(root, 'harness-data'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    skins: path.join(root, 'skins'),
    skinConfig: path.join(root, 'skins', 'active.json'),
    pets: path.join(root, 'pets'),
    petConfig: path.join(root, 'pets', 'active.json')
  }
}
