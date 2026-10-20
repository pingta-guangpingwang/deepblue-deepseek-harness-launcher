import { vi, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const context = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => context.root } }))
import { readConfig } from './config'
it('new kernel cannot inherit the old default URL through a saved source ID', async () => {
  context.root = await mkdtemp(path.join(tmpdir(), 'dsh-channel-'))
  try {
    await writeFile(path.join(context.root, 'launcher.json'), JSON.stringify({ activeVersion: '0.1.1-rc.2', settings: { sources: [{ id: 'runtime-v2', enabled: true, kind: 'manifest', baseUrl: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json' }] } }))
    const config = await readConfig()
    expect(config.settings.sources.find(source => source.id === 'runtime-v2-dsh021rc')?.baseUrl).toContain('/release-v2/dsh021rc/')
    expect(config.settings.sources.some(source => source.id === 'runtime-v2')).toBe(false)
  } finally { await rm(context.root, { recursive: true, force: true }) }
})

it('migrates only the previous official channel and retains a disabled/custom source choice', async () => {
  context.root = await mkdtemp(path.join(tmpdir(), 'dsh-rc-channel-'))
  try {
    const old = { id: 'runtime-v2-dsh02', enabled: false, kind: 'manifest', baseUrl: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/dsh02/launcher-manifest.json' }
    await writeFile(path.join(context.root, 'launcher.json'), JSON.stringify({ settings: { sources: [old] } }))
    let config = await readConfig()
    expect(config.settings.sources.find(source => source.id === 'runtime-v2-dsh021rc')).toMatchObject({ enabled: false, baseUrl: expect.stringContaining('/dsh021rc/') })
    expect(config.settings.sources.some(source => source.id === old.id)).toBe(false)
    await writeFile(path.join(context.root, 'launcher.json'), JSON.stringify({ settings: { sources: [{ ...old, baseUrl: 'https://custom.example/catalog.json' }] } }))
    config = await readConfig()
    expect(config.settings.sources.find(source => source.id === 'runtime-v2-dsh021rc')?.baseUrl).toBe('https://custom.example/catalog.json')
  } finally { await rm(context.root, { recursive: true, force: true }) }
})
