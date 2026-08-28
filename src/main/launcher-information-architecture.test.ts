import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../renderer/src/App.tsx', import.meta.url), 'utf8')

describe('launcher information architecture', () => {
  it('keeps the native community visible near Home', () => {
    expect(appSource).toContain("{ label: '运行', items: [{ id: 'home', label: '首页', icon: Home }, { id: 'community', label: '兴趣社区', icon: MessageCircle }]")
    expect(appSource).toContain("{page === 'community' && <CommunityPage")
  })

  it('nests DSH web plugins under AI tools instead of the sidebar', () => {
    const navigationSource = appSource.slice(appSource.indexOf('const navigation'), appSource.indexOf('const pageTitles'))
    expect(navigationSource).not.toContain("id: 'ecosystem'")
    expect(appSource).toContain('aria-label="AI 工具内容切换"')
    expect(appSource).toContain('<strong>DSH 生态</strong><small>Web profile 插件</small>')
    expect(appSource).toContain("section === 'ecosystem'")
  })
})
