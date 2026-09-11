import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { LocalCatalog } from '../../shared/agent-host'

// Installed Codex versions share models_cache.json. Do not let a shorter cache
// remove models already observed during this launcher session.
export function mergeLocalModels(previous: NonNullable<LocalCatalog['models']>, latest: NonNullable<LocalCatalog['models']>): NonNullable<LocalCatalog['models']> {
  return [...new Map([...previous, ...latest].map(model => [model.adapter + ':' + model.id, model])).values()]
}
export function sameLocalPath(left: string, right: string): boolean {
  if (!left || !right) return false
  return process.platform === 'win32' ? path.toNamespacedPath(left).toLowerCase() === path.toNamespacedPath(right).toLowerCase() : left === right
}

export function parseLocalModels(cache: unknown): NonNullable<LocalCatalog['models']> {
  const rows = (cache as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> })?.models
  const models = new Map<string, NonNullable<LocalCatalog['models']>[number]>()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row.slug !== 'string' || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(row.slug) || row.visibility === 'hide') continue
    models.set(row.slug, { id: row.slug, name: row.display_name || row.slug, adapter: 'codex' })
  }
  return [...models.values()]
}

export async function readLocalModels(runtimeHome?: string): Promise<NonNullable<LocalCatalog['models']>> {
  const home = runtimeHome || process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex')
  return parseLocalModels(JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8')))
}
