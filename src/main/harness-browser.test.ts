import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessBrowserHandoff, prepareHarnessNoBrowserPatch } from './harness-browser'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Harness browser ownership', () => {
  it('writes a final profile overlay that disables the Harness opener', async () => {
    const dshHome = await mkdtemp(path.join(os.tmpdir(), 'deepblue-no-browser-'))
    temporaryDirectories.push(dshHome)

    const patchPath = await prepareHarnessNoBrowserPatch(dshHome)
    const patch = await readFile(patchPath, 'utf8')
    const parsed = loadOverlayPatches('deepblue-test', patchPath) as Array<{ id?: string, config?: Record<string, unknown> }>

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('web-runtime')
    expect(parsed[0]?.config).toMatchObject({ openBrowser: false, printUrl: true, surfaceContext: true })
    expect(patch).toContain('- id: web-runtime')
    expect(patch).toContain("name: '@deepseek-ai/dsh-web-app'")
    expect(patch).toContain('openBrowser: false')
    expect(patch).toContain('printUrl: true')
    expect(patch).toContain('surfaceContext: true')
    expect(patch).toContain('trustedHosts: !!js ctx.webStartup.trustedHosts')
  })

  it('coalesces concurrent readiness signals into one operating-system handoff', async () => {
    const handoff = new HarnessBrowserHandoff()
    const cycle = handoff.begin()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const opener = vi.fn(async () => pending)

    const first = handoff.openOnce(cycle, 'http://127.0.0.1:3080', true, opener)
    const second = handoff.openOnce(cycle, 'http://127.0.0.1:3080', true, opener)
    expect(opener).toHaveBeenCalledTimes(1)
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([true, false])
  })

  it('rejects stale cycles and leaves automatic opening disabled when requested', async () => {
    const handoff = new HarnessBrowserHandoff()
    const staleCycle = handoff.begin()
    const currentCycle = handoff.begin()
    const opener = vi.fn(async () => undefined)

    await expect(handoff.openOnce(staleCycle, 'http://127.0.0.1:3080', true, opener)).resolves.toBe(false)
    await expect(handoff.openOnce(currentCycle, 'http://127.0.0.1:3080', false, opener)).resolves.toBe(false)
    expect(opener).not.toHaveBeenCalled()
  })
})
