import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => { throw Error('test must pass its isolated profile') } } }))
import { resolveBuiltinDshHost } from './dsh-launcher'

it('resolves only the owning launcher configuration and never returns credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-profile-test-'))
  try {
    const storageDir = path.join(root, 'agent-host')
    await mkdir(storageDir); await mkdir(path.join(root, 'harness-data'))
    const config = { activeVersion: '0.1.1-rc.2', settings: { storageRoot: root, workspace: root, port: 3080 }, modelRouting: { ignoredSecret: 'TEST-ONLY-NOT-A-REAL-KEY' } }
    const save = () => writeFile(path.join(root, 'launcher.json'), JSON.stringify(config))
    await save()
    const result = await resolveBuiltinDshHost(storageDir, root)
    expect(result.endpoint).toBe('http://127.0.0.1:3080')
    expect(JSON.stringify(result)).not.toContain('TEST-ONLY')
    config.settings.port = 80; await save(); await expect(resolveBuiltinDshHost(storageDir, root)).rejects.toThrow('端口')
    config.settings.port = 3080; config.activeVersion = '0.1.2'; await save(); await expect(resolveBuiltinDshHost(storageDir, root)).rejects.toThrow('版本')
    config.activeVersion = '0.1.1-rc.2'; config.settings.storageRoot = path.dirname(root); await save(); await expect(resolveBuiltinDshHost(storageDir, root)).rejects.toThrow('同一')
  } finally { await rm(root, { recursive: true, force: true }) }
})
