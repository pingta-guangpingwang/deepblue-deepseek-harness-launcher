import type { PageId } from '../../shared/types'

export type OnlinePageRefreshTarget = 'discovery' | 'skins' | 'pets'

const DISCOVERY_PAGES = new Set<PageId>([
  'prompts',
  'skills',
  'workflows',
  'knowledge',
  'tools',
  'agents',
  'news',
  'games',
  'careers'
])

/** Returns the online data source that must be refreshed whenever a page is activated. */
export function onlinePageRefreshTarget(page: PageId): OnlinePageRefreshTarget | undefined {
  if (page === 'skins') return 'skins'
  if (page === 'pets') return 'pets'
  if (DISCOVERY_PAGES.has(page)) return 'discovery'
  return undefined
}
