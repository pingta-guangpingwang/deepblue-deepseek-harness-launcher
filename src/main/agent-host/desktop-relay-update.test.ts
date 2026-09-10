import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { updateExistingDesktopRelay } from './desktop-relay-update'
it('updates recognized helper code only, preserving settings and refusing custom code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relay-update-test-')), moduleDir = path.join(root, 'module'), directory = path.join(root, 'relay')
  try {
    await mkdir(moduleDir); await mkdir(directory)
    const old = 'synthetic older code', settings = JSON.stringify({ executor: '11111111-1111-4111-8111-111111111111' })
    await writeFile(path.join(moduleDir, 'native-companion.mjs'), 'synthetic newer code'); await writeFile(path.join(directory, 'companion.mjs'), old); await writeFile(path.join(directory, 'settings.json'), settings)
    expect(await updateExistingDesktopRelay(moduleDir, directory)).toBe('custom')
    const recognized = new Set([createHash('sha256').update(old).digest('hex')])
    expect(await updateExistingDesktopRelay(moduleDir, directory, recognized)).toBe('updated')
    expect(await readFile(path.join(directory, 'settings.json'), 'utf8')).toBe(settings)
    expect(await updateExistingDesktopRelay(moduleDir, directory, recognized)).toBe('current')
  } finally { if (!path.basename(root).startsWith('relay-update-test-')) throw new Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }) }
})
