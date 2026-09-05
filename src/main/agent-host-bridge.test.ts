import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHostBridge } from './agent-host-bridge'
import type { RuntimeModuleStore } from './runtime-modules'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(activeWorks: boolean, previousWorks?: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-host-bridge-test-'))
  roots.push(root)
  async function module(name: string, works: boolean) {
    const dir = path.join(root, name)
    await mkdir(dir)
    await writeFile(path.join(dir, 'host-service.cjs'), `
      exports.AGENT_HOST_PROTOCOL = 1;
      exports.AgentHostService = class {
        async initialize() { ${works ? '' : 'throw new Error("broken test module");'} }
        async dispose() {}
        snapshot() { return { supported: true, deviceName: ${JSON.stringify(name)} }; }
        isBusy() { return false; }
      };
    `)
    return dir
  }
  const bundled = await module('bundled', true)
  let active: string | undefined = await module('active', activeWorks)
  const previous = previousWorks === undefined ? undefined : await module('previous', previousWorks)
  const store = {
    activeRoot: vi.fn(async () => active),
    versions: vi.fn(async () => ({ previous })),
    rollback: vi.fn(async () => { active = previous }),
    deactivate: vi.fn(async () => { active = undefined })
  }
  const bridge = new AgentHostBridge(store as unknown as RuntimeModuleStore, {
    storageDir: root, nodePath: process.execPath, launcherVersion: 'qa',
    ownerId: () => undefined, request: async () => ({}),
    chooseDirectory: async () => undefined, onChange: () => {}
  }, bundled)
  return { bridge, store }
}

it('loads a valid active host without changing the installed module pointer', async () => {
  const { bridge, store } = await fixture(true)
  await bridge.initialize()
  expect(bridge.snapshot().deviceName).toBe('active')
  expect(store.rollback).not.toHaveBeenCalled()
  expect(store.deactivate).not.toHaveBeenCalled()
})

it('recovers a broken active module using the previous downloaded version', async () => {
  const { bridge, store } = await fixture(false, true)
  await bridge.initialize()
  expect(bridge.snapshot().deviceName).toBe('previous')
  expect(store.deactivate).not.toHaveBeenCalled()
})

it('uses the bundled baseline when both downloaded host versions are broken', async () => {
  const { bridge, store } = await fixture(false, false)
  await bridge.initialize()
  expect(bridge.snapshot().deviceName).toBe('bundled')
  expect(store.deactivate).toHaveBeenCalledWith('agent-host')
})

it('leaves hot-update failure rollback to the controller transaction', async () => {
  const { bridge, store } = await fixture(false, true)
  await expect(bridge.initialize(false)).rejects.toThrow('broken test module')
  expect(store.rollback).not.toHaveBeenCalled()
  expect(store.deactivate).not.toHaveBeenCalled()
})
