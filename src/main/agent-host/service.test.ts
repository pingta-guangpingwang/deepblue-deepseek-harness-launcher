import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), encryptionAvailable: vi.fn(() => true), encrypt: vi.fn((value: string) => Buffer.from('mock-encrypted:' + Buffer.from(value).toString('base64'))) }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: mocks.encryptionAvailable,
  encryptString: mocks.encrypt,
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^mock-encrypted:/, ''), 'base64').toString()
} }))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), fork: mocks.fork }))

import { AgentHostService, resolveAgentLaunch } from './service'
import type { AgentWorkspaceRequest } from '../../shared/agent-host'

const agentId = 'a'.repeat(32)
const deviceId = 'd'.repeat(32)
const key = 'agh_live_' + 'k'.repeat(48)
const deviceKey = 'adh_live_' + 'v'.repeat(48)
type TestBinding = { id: string; name: string; adapter: 'codex'; key: string; executable: string; executableArgs?: string[]; projectRoots: string[]; desiredRunning: boolean; autoStart: boolean; status: string; runtimeStatus: string; busy: boolean; message?: string; pendingCloudBind?: boolean }
type Internals = {
  saved: { enabled: boolean; ownerUserId: string; installationId: string; deviceId: string; deviceKey: string; agents: TestBinding[]; commands: Record<string, unknown> }
  children: Map<string, FakeChild>
  starting: Map<string, Promise<void>>
  leaseValidUntil: number
  boundAgentIds: Set<string>
  timer?: ReturnType<typeof setTimeout>
  startAgent: (binding: TestBinding) => Promise<void>
  executeCommand: (command: unknown) => Promise<void>
  persist: () => Promise<void>
  disposed: boolean
}
class FakeChild extends EventEmitter {
  pid: number | undefined = 10101
  connected = true
  exitCode: number | null = null
  stdout = { resume: vi.fn() }
  stderr = { resume: vi.fn() }
  autoStatus = true
  autoStop = true
  send = vi.fn((message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
    callback?.(null)
    if (message.type === 'start' && this.autoStatus) queueMicrotask(() => this.emit('message', { type: 'status', instanceId: message.instanceId, phase: 'ready', connected: true, runningTasks: 0, runtimeReady: null }))
    if (message.type === 'stop' && this.autoStop) queueMicrotask(() => this.exit(0))
    return true
  })
  exit(code: number): void { if (this.exitCode !== null) return; this.connected = false; this.exitCode = code; this.emit('exit', code) }
}

let roots: string[] = []
let services: AgentHostService[] = []
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-agent-host-'))
  roots.push(root)
  const storageDir = path.join(root, 'storage')
  const moduleDir = path.join(root, 'module')
  const project = path.join(root, 'project')
  await Promise.all([storageDir, path.join(moduleDir, 'connector'), project].map((value) => mkdir(value, { recursive: true })))
  await writeFile(path.join(moduleDir, 'connector', 'host-child.mjs'), '// mock-only test entry')
  const binding: TestBinding = { id: agentId, name: '测试智能体', adapter: 'codex', key, executable: 'fake-codex.exe', executableArgs: ['private-local-entry.js'], projectRoots: [project], autoStart: false, desiredRunning: false, status: 'stopped', runtimeStatus: 'unknown', busy: false }
  const state = { version: 1, installationId: 'test-installation', ownerUserId: 'owner-A', deviceId, deviceKey, enabled: true, agents: [binding], commands: {} }
  await writeFile(path.join(storageDir, 'host-state.enc'), mocks.encrypt(JSON.stringify(state)))
  let owner: string | undefined = 'owner-A'
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'))
    return new Response(JSON.stringify(body.action === 'heartbeat' ? { ok: true, commands: [], boundAgentIds: [agentId], leaseSeconds: 60 } : { ok: true }), { status: 200 })
  })
  const requestMock = vi.fn(async (_request: AgentWorkspaceRequest): Promise<Record<string, unknown>> => ({ ok: true }))
  const service = new AgentHostService({ storageDir, moduleDir, nodePath: process.execPath, launcherVersion: 'test', ownerId: () => owner, request: requestMock, chooseDirectory: async () => project, onChange: vi.fn(), fetch: fetchMock as typeof fetch })
  services.push(service)
  await service.initialize()
  const internal = service as unknown as Internals
  if (internal.timer) clearTimeout(internal.timer)
  return { service, internal, binding: internal.saved.agents[0]!, root, storageDir, fetchMock, requestMock, setOwner: (value: string | undefined) => { owner = value } }
}
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 300; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)) }
  throw new Error('mock test condition did not settle')
}
beforeEach(() => {
  mocks.fork.mockReset()
  mocks.encryptionAvailable.mockReturnValue(true)
  mocks.encrypt.mockClear()
  mocks.fork.mockImplementation(() => { const child = new FakeChild(); queueMicrotask(() => child.emit('message', { type: 'ready', protocolVersion: 1 })); return child })
})
afterEach(async () => {
  vi.useRealTimers()
  for (const service of services) {
    const internal = service as unknown as Internals
    if (internal.timer) clearTimeout(internal.timer)
    for (const child of internal.children.values()) child.exit(0)
    for (const agent of internal.saved.agents) agent.busy = false
    await service.dispose().catch(() => {})
  }
  services = []
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
  vi.unstubAllEnvs()
})

describe('AgentHostService local authorization and child protocol', () => {
  it('never exposes keys, executable arguments, or another account bindings in snapshots', async () => {
    const f = await fixture()
    const serialized = JSON.stringify(f.service.snapshot())
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain(deviceKey)
    expect(serialized).not.toContain('private-local-entry')
    f.setOwner('owner-B')
    expect(f.service.snapshot()).toMatchObject({ enabled: false, agents: [] })
  })

  it('claims a device lease before forking and waits for the v1 ready plus connected status', async () => {
    const f = await fixture()
    const child = new FakeChild(); child.autoStatus = false
    mocks.fork.mockReturnValue(child)
    let resolved = false
    const starting = f.internal.startAgent(f.binding).then(() => { resolved = true })
    await until(() => mocks.fork.mock.calls.length === 1)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(child.send).not.toHaveBeenCalled()
    child.emit('message', { type: 'ready', protocolVersion: 1 })
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', config: expect.objectContaining({ runtimeExecutableArgs: ['private-local-entry.js'] }) }), expect.any(Function))
    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('message', { type: 'status', instanceId: agentId, phase: 'ready', connected: true, runtimeReady: null })
    await starting
    expect(f.binding.runtimeStatus).toBe('unknown')
    const forkOptions = mocks.fork.mock.calls[0]![2]
    expect(JSON.stringify(mocks.fork.mock.calls[0]!.slice(0, 2))).not.toContain(key)
    expect(forkOptions.env.SHENLAN_AGENT_INTERACTION_KEY).toBeUndefined()
  })

  it('rejects unavailable/fenced leases without launching a local agent', async () => {
    const f = await fixture()
    f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'device_lease_active' }), { status: 409 }))
    await expect(f.internal.startAgent(f.binding)).rejects.toThrow('device_lease_active')
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(f.internal.leaseValidUntil).toBe(0)
  })

  it('drains existing children on lease fencing and blocks locally starting web-unbound agents', async () => {
    const f = await fixture()
    await f.internal.startAgent(f.binding)
    const child = f.internal.children.get(agentId)!
    f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'device_lease_active' }), { status: 409 }))
    await f.service.tick()
    expect(child.send).toHaveBeenCalledWith({ type: 'stop' }, expect.any(Function))
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, boundAgentIds: [], commands: [] })))
    await expect(f.internal.startAgent(f.binding)).rejects.toThrow('尚未授权')
    expect(mocks.fork).toHaveBeenCalledTimes(1)
  })

  it('ignores an in-flight lease response after owner changes and does not execute its commands', async () => {
    const f = await fixture()
    let release!: (value: Response) => void
    f.fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve }))
    const checking = f.service.tick()
    await until(() => !!release)
    f.setOwner('owner-B')
    release(new Response(JSON.stringify({ ok: true, boundAgentIds: [agentId], commands: [{ id: 'c'.repeat(32), agentId, command: 'start' }] })))
    await checking
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(f.internal.leaseValidUntil).toBe(0)
    expect(f.internal.saved.commands).toEqual({})
  })

  it('drains revoked devices before persisting, even if the disk fails', async () => {
    const f = await fixture()
    await f.internal.startAgent(f.binding)
    const child = f.internal.children.get(agentId)!
    f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'device_revoked' }), { status: 403 }))
    vi.spyOn(f.internal, 'persist').mockRejectedValueOnce(new Error('disk unavailable'))
    await f.service.tick()
    expect(child.send).toHaveBeenCalledWith({ type: 'stop' }, expect.any(Function))
    expect(f.internal.saved.enabled).toBe(false)
    expect(f.internal.leaseValidUntil).toBe(0)
  })

  it('cleans spawn failure state so explicit retry can create a fresh child', async () => {
    const f = await fixture()
    const broken = new FakeChild(); broken.pid = undefined; broken.connected = false
    mocks.fork.mockImplementationOnce(() => { queueMicrotask(() => broken.emit('error', new Error('spawn ENOENT'))); return broken })
    await expect(f.internal.startAgent(f.binding)).rejects.toThrow('spawn ENOENT')
    expect(f.internal.children.has(agentId)).toBe(false)
    expect(f.binding.desiredRunning).toBe(false)
    expect(broken.listenerCount('message')).toBe(1)
    await f.internal.startAgent(f.binding)
    expect(f.binding.status).toBe('online')
    expect(mocks.fork).toHaveBeenCalledTimes(2)
  })

  it('rejects busy hot reload disposal without marking the service disposed or cancelling the task', async () => {
    const f = await fixture()
    await f.internal.startAgent(f.binding)
    const child = f.internal.children.get(agentId)!
    f.binding.busy = true
    await expect(f.service.dispose()).rejects.toThrow('任务')
    expect(f.internal.disposed).toBe(false)
    expect(child.send.mock.calls.some(([message]) => message.type === 'stop')).toBe(false)
  })

  it('deduplicates durable commands and persists intent before any child side effect', async () => {
    const f = await fixture()
    await f.service.tick()
    const command = { id: 'c'.repeat(32), agentId, command: 'start', expiresAt: new Date(Date.now() + 120000).toISOString() }
    const stored: unknown[] = []
    mocks.fork.mockImplementation(() => {
      stored.push(structuredClone(f.internal.saved.commands[command.id]))
      const child = new FakeChild(); queueMicrotask(() => child.emit('message', { type: 'ready', protocolVersion: 1 })); return child
    })
    await f.internal.executeCommand(command)
    await f.internal.executeCommand(command)
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    expect(stored[0]).toMatchObject({ state: 'running' })
    const encrypted = (await readFile(path.join(f.storageDir, 'host-state.enc'))).toString()
    expect(encrypted).not.toContain(key)
    expect(f.fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).action === 'ack')).toHaveLength(2)
  })

  it('keeps the last encrypted state and permits retry after an encryption/save error', async () => {
    const f = await fixture()
    const stateFile = path.join(f.storageDir, 'host-state.enc')
    const previous = await readFile(stateFile)
    mocks.encrypt.mockImplementationOnce(() => { throw new Error('simulated encryption failure') })
    await expect(f.internal.persist()).rejects.toThrow('simulated encryption failure')
    expect(await readFile(stateFile)).toEqual(previous)
    await expect(f.internal.persist()).resolves.toBeUndefined()
    expect((await readFile(stateFile)).toString()).not.toContain(deviceKey)
  })

  it('recovers a corrupt primary without replacing the valid encrypted backup with corrupt bytes', async () => {
    const f = await fixture()
    const stateFile = path.join(f.storageDir, 'host-state.enc')
    const lastGood = await readFile(stateFile + '.bak')
    await writeFile(stateFile, 'corrupt-primary')
    await f.service.initialize()
    if (f.internal.timer) clearTimeout(f.internal.timer)
    expect(f.service.snapshot().deviceId).toBe(deviceId)
    expect(await readFile(stateFile + '.bak')).toEqual(lastGood)
    expect((await readFile(stateFile)).toString()).not.toContain('corrupt-primary')
    expect((await readFile(stateFile)).toString()).not.toContain(deviceKey)
  })

  it('pauses remote control immediately on sign-out while draining a busy task without forced termination', async () => {
    const f = await fixture()
    await f.internal.startAgent(f.binding)
    const child = f.internal.children.get(agentId)!
    child.autoStop = false
    f.binding.busy = true
    await f.service.suspendForSignOut()
    expect(f.internal.saved.enabled).toBe(false)
    expect(f.internal.leaseValidUntil).toBe(0)
    expect(child.send).toHaveBeenCalledWith({ type: 'stop' }, expect.any(Function))
    expect(child.exitCode).toBeNull()
    expect(f.service.snapshot().enabled).toBe(false)
    await expect(f.internal.startAgent(f.binding)).rejects.toThrow('暂停')
  })

  it('persists registration credentials before HTTP and reuses them after a lost response and cold recovery', async () => {
    const f = await fixture()
    Object.assign(f.internal.saved, { ownerUserId: '', deviceId: '', deviceKey: '', enabled: false, agents: [] })
    let firstKey = ''
    let installation = ''
    f.requestMock.mockImplementationOnce(async (request) => {
      firstKey = String(request.body?.registrationKey)
      installation = String(request.body?.installationId)
      expect(firstKey).toMatch(/^adh_live_[A-Za-z0-9_-]{43}$/)
      const bytes = await readFile(path.join(f.storageDir, 'host-state.enc'))
      const stored = JSON.parse(Buffer.from(bytes.toString().replace(/^mock-encrypted:/, ''), 'base64').toString())
      expect(stored.deviceKey).toBe(firstKey)
      expect(bytes.toString()).not.toContain(firstKey)
      throw new Error('server committed but response was lost')
    })
    await expect(f.service.action({ action: 'bind_device' })).rejects.toThrow('response was lost')
    await f.service.initialize()
    if (f.internal.timer) clearTimeout(f.internal.timer)
    f.requestMock.mockImplementationOnce(async (request) => {
      expect(request.body?.registrationKey).toBe(firstKey)
      expect(request.body?.installationId).toBe(installation)
      return { ok: true, device: { id: deviceId }, deviceKey: firstKey, replayed: true }
    })
    const result = await f.service.action({ action: 'bind_device' })
    expect(result.deviceId).toBe(deviceId)
    expect(result.enabled).toBe(true)
    expect(JSON.stringify(result)).not.toContain(firstKey)
  })

  it('retains a pending cloud binding and only retries the same instance after an explicit local start', async () => {
    const f = await fixture()
    let cloudBound = false
    f.binding.pendingCloudBind = true
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, boundAgentIds: cloudBound ? [agentId] : [], commands: [], leaseSeconds: 60 })))
    f.requestMock.mockRejectedValueOnce(new Error('binding network timeout'))
    await expect(f.service.action({ action: 'start', agentId })).rejects.toThrow('实例已保留')
    expect(f.internal.saved.agents).toHaveLength(1)
    expect(f.binding.pendingCloudBind).toBe(true)
    await f.service.tick()
    expect(f.requestMock).toHaveBeenCalledTimes(1)
    expect(mocks.fork).not.toHaveBeenCalled()
    f.requestMock.mockImplementationOnce(async (request) => {
      expect(request).toMatchObject({ action: 'bind', body: { agentId, deviceId } })
      cloudBound = true
      return { ok: true }
    })
    await f.service.action({ action: 'start', agentId })
    expect(f.internal.saved.agents).toHaveLength(1)
    expect(f.binding.pendingCloudBind).toBe(false)
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    expect(f.requestMock.mock.calls.every(([request]) => request.action === 'bind')).toBe(true)
  })

  it('confirms an ambiguous bind by heartbeat but never silently rebinds after a later web-side unbind', async () => {
    const f = await fixture()
    f.binding.pendingCloudBind = true
    await f.service.tick()
    expect(f.binding.pendingCloudBind).toBe(false)
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, boundAgentIds: [], commands: [], leaseSeconds: 60 })))
    await f.service.tick()
    expect(f.binding.desiredRunning).toBe(false)
    expect(f.requestMock).not.toHaveBeenCalled()
    await expect(f.service.action({ action: 'start', agentId })).rejects.toThrow('尚未授权')
  })
})

describe('Windows npm shim resolution', () => {
  it('resolves only the fixed official package bin to managed Node without executing cmd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-agent-shim-')); roots.push(root)
    const packageRoot = path.join(root, 'node_modules', '@openai', 'codex')
    await mkdir(path.join(packageRoot, 'bin'), { recursive: true })
    await writeFile(path.join(root, 'codex.cmd'), 'not executed')
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }))
    await writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// not executed')
    vi.stubEnv('Path', root); vi.stubEnv('PATH', root)
    const resolved = await resolveAgentLaunch('codex', process.execPath)
    expect(resolved?.executable).toBe(process.execPath)
    expect(resolved?.args).toEqual([await realpath(path.join(packageRoot, 'bin', 'codex.js'))])
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: '../../../outside.js' } }))
    await writeFile(path.join(root, 'outside.js'), '// not executed')
    expect(await resolveAgentLaunch('codex', process.execPath)).toBeUndefined()
  })
})
