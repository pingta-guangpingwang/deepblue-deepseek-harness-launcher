import { app } from 'electron'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { RuntimeModuleStore } from './runtime-modules'

export interface LauncherUiSelection {
  entry: string
  version: string
  source: 'bundled' | 'updated'
}

interface LauncherUiMetadata {
  schemaVersion: 1
  version: string
  sha256: string
  files: number
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export async function validateLauncherUiRoot(root: string): Promise<string | undefined> {
  const entry = path.resolve(root, 'renderer', 'index.html')
  if (path.relative(path.resolve(root), entry).startsWith('..') || !await exists(entry)) return undefined
  const html = await readFile(entry, 'utf8')
  if (html.length < 100 || html.length > 128 * 1024 || !html.includes('<div id="root"></div>')) return undefined
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)(?:[?#][^"]*)?"/gu)].map((match) => match[1]!)
  if (!assets.length) return undefined
  for (const relative of assets) {
    if (!/^[0-9A-Za-z._/-]+$/u.test(relative) || relative.split('/').includes('..')) return undefined
    const target = path.resolve(root, 'renderer', ...relative.split('/'))
    if (!target.startsWith(`${path.resolve(root, 'renderer')}${path.sep}`) || !await exists(target)) return undefined
  }
  return entry
}

async function bundledVersion(): Promise<string> {
  const candidates = [
    path.join(process.resourcesPath, 'resources', 'launcher-ui-version.json'),
    path.join(app.getAppPath(), 'resources', 'launcher-ui-version.json'),
    path.resolve('build-cache', 'generated', 'launcher-ui-version.json')
  ]
  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(await readFile(candidate, 'utf8')) as LauncherUiMetadata
      if (metadata.schemaVersion === 1 && /^ui-[a-f0-9]{16}$/u.test(metadata.version) && /^[a-f0-9]{64}$/u.test(metadata.sha256)) return metadata.version
    } catch {
      // Try the next packaged/development location.
    }
  }
  return app.getVersion()
}

export async function selectLauncherUi(runtimeRoot: string, bundledEntry: string): Promise<LauncherUiSelection> {
  const fallback: LauncherUiSelection = { entry: bundledEntry, version: await bundledVersion(), source: 'bundled' }
  const store = new RuntimeModuleStore(runtimeRoot)
  const active = await store.versions('launcher-ui')
  if (!active.active) return fallback
  const activeRoot = await store.activeRoot('launcher-ui')
  if (activeRoot) {
    const entry = await validateLauncherUiRoot(activeRoot)
    if (entry) return { entry, version: active.active, source: 'updated' }
  }
  if (active.previous) {
    try {
      const previousRoot = await store.rollback('launcher-ui')
      const entry = await validateLauncherUiRoot(previousRoot)
      if (entry) return { entry, version: active.previous, source: 'updated' }
    } catch {
      // Fall through to the UI bundled with the stable kernel.
    }
  }
  return fallback
}

export async function bundledLauncherUiVersion(): Promise<string> {
  return bundledVersion()
}
