import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../renderer/src/App.tsx', import.meta.url), 'utf8')
const communitySource = readFileSync(new URL('../renderer/src/CommunityPage.tsx', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('launcher information architecture', () => {
  it('keeps the native community visible near Home', () => {
    const runGroup = appSource.slice(appSource.indexOf("{ label: '运行'"), appSource.indexOf("{ label: '发现'"))
    const ids = [...runGroup.matchAll(/id: '([^']+)'/g)].map((match) => match[1])
    expect(ids).toEqual(['home', 'agent-workspace', 'community'])
    expect(appSource).toContain("{page === 'community' && <CommunityPage")
  })

  it('keeps only news, games and More in discovery and moves models to management', () => {
    const navigationSource = appSource.slice(appSource.indexOf('const navigation'), appSource.indexOf('const pageTitles'))
    expect(navigationSource).not.toContain("label: '能力库'")
    for (const id of ['prompts', 'skills', 'tools', 'library', 'careers', 'ecosystem']) expect(navigationSource).not.toContain(`id: '${id}'`)
    for (const id of ['news', 'games', 'more', 'models', 'agent-workspace', 'skins', 'pets']) expect(navigationSource).toContain(`id: '${id}'`)
    expect(appSource).toContain('function MorePage()')
    expect(appSource).toContain('https://ailishishu.com${route}')
    expect(appSource).not.toContain("{page === 'tools' &&")
  })

  it('fails closed when an old launcher does not expose the community IPC bridge', () => {
    expect(communitySource).not.toContain('function demoRequest')
    expect(communitySource).not.toContain('return demoRequest(payload)')
    expect(communitySource).toContain("throw new Error('社区功能需要新版基础内核，请升级启动器')")
  })

  it('keeps production single-instance protection while isolating packaged release QA', () => {
    expect(mainSource).toContain("process.env.DSH_LAUNCHER_ALLOW_PARALLEL === '1'")
    expect(mainSource).toContain(': app.requestSingleInstanceLock()')
    expect(mainSource).toContain("process.env.DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION === '1'")
    expect(mainSource).toContain('app.disableHardwareAcceleration()')
  })
})
