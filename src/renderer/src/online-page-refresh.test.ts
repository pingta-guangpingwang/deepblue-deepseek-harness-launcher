import { describe, expect, it } from 'vitest'
import type { PageId } from '../../shared/types'
import { onlinePageRefreshTarget } from './online-page-refresh'

describe('online page refresh policy', () => {
  it('refreshes every website-backed directory when its tab is activated', () => {
    const discoveryPages: PageId[] = ['prompts', 'skills', 'workflows', 'knowledge', 'tools', 'agents', 'news', 'games', 'careers']
    for (const page of discoveryPages) expect(onlinePageRefreshTarget(page)).toBe('discovery')
    expect(onlinePageRefreshTarget('skins')).toBe('skins')
    expect(onlinePageRefreshTarget('pets')).toBe('pets')
  })

  it('does not request the network for local-only pages', () => {
    const localPages: PageId[] = ['home', 'versions', 'library', 'models', 'workspaces', 'diagnostics', 'settings']
    for (const page of localPages) expect(onlinePageRefreshTarget(page)).toBeUndefined()
  })
})
