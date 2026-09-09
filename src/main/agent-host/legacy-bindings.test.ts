import { describe, it, expect } from 'vitest'
import { legacyStateMayHandoff, LEGACY_ADAPTERS } from './legacy-bindings'
import { prepareLegacyHandoff, type LegacyBindingConfig } from './legacy-bindings'
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
describe('legacy connector handoff', () => {
  it('covers the six existing cloud adapter families', () => expect(LEGACY_ADAPTERS).toEqual(['codex', 'claude-code', 'qclaw', 'workbuddy', 'codebuddy', 'trae']))
  it('refuses to stop a preparing or running task', () => {
    expect(legacyStateMayHandoff({ pendingCommands: [{ _localStatus: 'running' }] })).toBe(false)
    expect(legacyStateMayHandoff({ pendingCommands: [{ _localStatus: 'preparing' }] })).toBe(false)
  })
  it('retains queued refreshes and final replies for the new host instead of dropping them', () => {
    const state = { pendingCommands: [{ _localStatus: 'final_pending' }, { _localStatus: 'pending' }] }
    expect(legacyStateMayHandoff(state)).toBe(true)
    expect(state.pendingCommands).toHaveLength(2)
  })
})

describe('legacy handoff receipt verification', () => {
  const withState = async (run: (legacy: Omit<LegacyBindingConfig, 'key'>, destination: string, root: string) => Promise<void>) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'legacy-handoff-test-'))
    try {
      const legacy = { adapter: 'qclaw', sourceFile: path.join(root, 'sync-service.json'), stateFile: path.join(root, 'sync-state.json'), executable: process.execPath, executableArgs: [], projectRoots: [root], settings: { qclawStateDir: '', qclawConfigPath: '', qclawAgentId: 'main' } } as Omit<LegacyBindingConfig, 'key'>
      await writeFile(legacy.stateFile, JSON.stringify({ pendingCommands: [{ id: 'keep', _localStatus: 'final_pending', _localFinal: { reply: '保留回复' } }] }))
      await writeFile(path.join(root, 'sync-service.lock'), JSON.stringify({ pid: process.pid }))
      await run(legacy, path.join(root, 'new-state.json'), root)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  it('does not signal a live process without a supported handoff', async () => withState(async (legacy, destination) => {
    await expect(prepareLegacyHandoff(legacy, destination)).rejects.toThrow('不会强制终止')
    await expect(access(destination)).rejects.toThrow()
  }))
  it('never overwrites advanced new state when an old service is still live', async () => withState(async (legacy, destination) => {
    await writeFile(destination, 'advanced')
    await expect(prepareLegacyHandoff(legacy, destination)).rejects.toThrow('同时存在')
    expect(await readFile(destination, 'utf8')).toBe('advanced')
  }))
  it('reuses migrated state after the stopped legacy directory is archived', async () => withState(async (legacy, destination, root) => {
    await writeFile(destination, 'advanced')
    await rm(legacy.stateFile)
    await rm(path.join(root, 'sync-service.lock'))
    await expect(prepareLegacyHandoff(legacy, destination)).resolves.toBeUndefined()
    expect(await readFile(destination, 'utf8')).toBe('advanced')
  }))
  it('rejects a changed state snapshot after acknowledgement', async () => withState(async (legacy, destination) => {
    await expect(prepareLegacyHandoff(legacy, destination, async () => ({ sha256: '0'.repeat(64) }))).rejects.toThrow('不一致')
    await expect(access(destination)).rejects.toThrow()
  }))
  it('copies only the acknowledged snapshot with its final reply intact', async () => withState(async (legacy, destination, root) => {
    await prepareLegacyHandoff(legacy, destination, async pid => {
      expect(pid).toBe(process.pid)
      await writeFile(path.join(root, 'sync-service.handed-off.json'), '{"version":1}')
      return { sha256: createHash('sha256').update(await readFile(legacy.stateFile)).digest('hex') }
    })
    expect(JSON.parse(await readFile(destination, 'utf8')).pendingCommands[0]._localFinal.reply).toBe('保留回复')
  }))
})
