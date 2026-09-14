import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), readLegacyBinding: vi.fn(), encryptionAvailable: vi.fn(() => true), encrypt: vi.fn((value: string) => Buffer.from('mock-encrypted:' + Buffer.from(value).toString('base64'))) }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: mocks.encryptionAvailable,
  encryptString: mocks.encrypt,
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^mock-encrypted:/, ''), 'base64').toString()
} }))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), fork: mocks.fork }))
vi.mock('./legacy-bindings', async (original) => ({ ...await original<typeof import('./legacy-bindings')>(), readLegacyBinding: mocks.readLegacyBinding }))
// The local director has separate IPC/online-channel integration coverage.
// Keep these lifecycle counts scoped to native agent workers, not that reader.
vi.mock('./local-control', () => ({ LocalControlBridge: class {
  snapshot() { return { supported: true, protocol: 1, version: 0, rooms: [], catalog: [], busy: false } }
  isBusy() { return false }
  isActive() { return false }
  async connectOnline() {}
  async refreshContext() {}
  async request() { return this.snapshot() }
  stopOnline() {}
  async close() {}
} }))

import { AgentHostService, resolveAgentLaunch } from './service'
import type { AgentAdapter, AgentWorkspaceRequest } from '../../shared/agent-host'

const agentId = 'a'.repeat(32)
const deviceId = 'd'.repeat(32)
const key = 'agh_live_' + 'k'.repeat(48)
const deviceKey = 'adh_live_' + 'v'.repeat(48)
type TestBinding = { id: string; name: string; adapter: AgentAdapter; key: string; executable: string; executableArgs?: string[]; projectRoots: string[]; desiredRunning: boolean; autoStart: boolean; status: string; runtimeStatus: string; busy: boolean; message?: string; pendingCloudBind?: boolean }
type Internals = {
  saved: { enabled: boolean; manuallyPaused?: boolean; deviceName?: string; ownerUserId: string; installationId: string; deviceId: string; deviceKey: string; agents: TestBinding[]; commands: Record<string, unknown> }
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
  // Failed spy assertions can print fork options; never put inherited secrets in them.
  for (const key of Object.keys(process.env)) if (/token|secret|password|api.?key|auth.?key/i.test(key)) vi.stubEnv(key, 'synthetic-test-environment')
  mocks.fork.mockReset()
  mocks.readLegacyBinding.mockReset()
  mocks.readLegacyBinding.mockRejectedValue(new Error('no legacy binding'))
  mocks.encryptionAvailable.mockReturnValue(true)
  mocks.encrypt.mockClear()
  mocks.fork.mockImplementation(() => { const child = new FakeChild(); queueMicrotask(() => child.emit('message', { type: 'ready', protocolVersion: 1 })); return child })
})

it('association metadata can be registered while signed out without adding projects or sending cloud writes', async () => {
  const f = await fixture()
  f.setOwner(undefined)
  const before = [...f.binding.projectRoots]
  const snapshot = await f.service.action({ action: 'begin_association', adapter: 'codex' })
  const association = snapshot.associations?.find(item => item.adapter === 'codex')
  expect(association?.status).toBe('waiting')
  expect(association?.configPath).toContain('agent-associations')
  expect(f.binding.projectRoots).toEqual(before)
  expect(mocks.fork).not.toHaveBeenCalled()
  expect(f.requestMock).not.toHaveBeenCalled()
})

it('cancelling project selection returns immediately without starting a director or changing grants', async () => {
  const f = await fixture()
  const options = (f.service as unknown as { options: { chooseDirectory(): Promise<string | undefined> } }).options
  options.chooseDirectory = async () => undefined
  const before = await readFile(path.join(f.storageDir, 'host-state.enc'))
  const result = await f.service.action({ action: 'local_control', command: 'authorize_project', input: { adapter: 'codex' }, requestId: '1'.repeat(32) })
  expect(result.localControl?.lastResult).toEqual({ requestId: '1'.repeat(32), result: { cancelled: true } })
  expect(await readFile(path.join(f.storageDir, 'host-state.enc'))).toEqual(before)
  expect(mocks.fork).not.toHaveBeenCalled()
})

it('creates only a fresh managed empty project and reuses the same request without opening a picker', async () => {
  const f = await fixture()
  const options = (f.service as unknown as { options: { chooseDirectory(): Promise<string | undefined> } }).options
  options.chooseDirectory = async () => { throw new Error('Native picker must not open') }
  const input = { action: 'local_control' as const, command: 'authorize_project' as const, input: { adapter: 'codex', createEmpty: true }, requestId: '3'.repeat(32) }
  await f.service.action(input)
  const target = path.join(await realpath(f.storageDir), 'local-projects', 'codex-' + input.requestId)
  expect(await realpath(target)).toBe(target)
  const fs = await import('node:fs/promises')
  expect(await fs.readdir(target)).toEqual([])
  await f.service.action(input)
  const projects = (f.service as unknown as { saved: { localProjects: Array<{path:string}> } }).saved.localProjects
  expect(projects.filter(project => project.path === target)).toHaveLength(1)
  expect(f.service.snapshot().localCatalog?.projects.filter(project => project.path === target)).toHaveLength(1)
  await expect(f.service.action({ ...input, requestId: '../outside' })).rejects.toThrow('编号无效')
})

it('does not grant a selected project if the account changes while the dialog is open', async () => {
  const f = await fixture()
  const options = (f.service as unknown as { options: { chooseDirectory(): Promise<string | undefined> } }).options
  options.chooseDirectory = async () => { f.setOwner('owner-B'); return f.binding.projectRoots[0] }
  await expect(f.service.action({ action: 'local_control', command: 'authorize_project', input: { adapter: 'codex' }, requestId: '2'.repeat(32) })).rejects.toThrow('账号已切换')
  expect(mocks.fork).not.toHaveBeenCalled()
})

it('uses the shared execution catalog for project authorization and keeps TRAE closed', async () => {
  for (const [index, adapter] of (['qclaw', 'workbuddy', 'codebuddy'] as AgentAdapter[]).entries()) {
    const f = await fixture()
    f.binding.adapter = adapter
    await f.service.action({ action: 'local_control', command: 'authorize_project', input: { adapter }, requestId: String(index + 4).repeat(32) })
    const projects = (f.service as unknown as { saved: { localProjects: Array<{ adapter: AgentAdapter; path: string }> } }).saved.localProjects
    expect(projects.map(project => ({ adapter: project.adapter, path: path.resolve(project.path) }))).toContainEqual({ adapter, path: path.resolve(await realpath(f.binding.projectRoots[0]!)) })
  }
  const f = await fixture()
  await expect(f.service.action({ action: 'local_control', command: 'authorize_project', input: { adapter: 'trae' }, requestId: 'f'.repeat(32) })).rejects.toThrow('暂未打通')
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
  it('registers a signed-in installation once without starting agents and persists its name', async () => {
    const f = await fixture()
    Object.assign(f.internal.saved, { deviceId: '', deviceKey: '', ownerUserId: '', agents: [], enabled: false })
    f.requestMock.mockImplementation(async request => request.action === 'bootstrap' ? { ok: true, agents: [] } : request.action === 'list' ? { ok: true, devices: [] } : { ok: true, device: { id: deviceId, name: '工作电脑' }, deviceKey: request.body?.registrationKey })
    await f.service.tick()
    await f.service.tick()
    expect(f.service.snapshot()).toMatchObject({ deviceId, deviceName: '工作电脑', enabled: true, connection: 'online' })
    expect(f.requestMock.mock.calls.filter(([r]) => r.action === 'register')).toHaveLength(1)
    expect(f.internal.saved.installationId).toBe('test-installation')
    expect(mocks.fork).not.toHaveBeenCalled()
  })
  it('restores a removed device only on a new signed-in connection using a rotated key', async () => {
    const f = await fixture()
    f.internal.saved.agents = []
    f.requestMock.mockImplementation(async request => request.action === 'bootstrap' ? { ok: true, agents: [] } : request.action === 'list' ? { ok: true, devices: [] } : { ok: true, device: { id: deviceId, name: '恢复电脑' }, deviceKey: request.body?.registrationKey })
    await f.service.tick()
    expect(f.internal.saved.deviceKey).not.toBe(deviceKey)
    expect(f.internal.saved.installationId).toBe('test-installation')
    expect(f.service.snapshot().deviceId).toBe(deviceId)
    await f.service.action({ action: 'revoke_device' })
    await f.service.tick()
    expect(f.service.snapshot().deviceId).toBeUndefined()
    expect(f.requestMock.mock.calls.filter(([r]) => r.action === 'register')).toHaveLength(1)
    expect(f.internal.saved.installationId).toBe('test-installation')
  })
  it('preserves a manual pause when a removed device is registered again', async () => {
    const f = await fixture()
    f.internal.saved.manuallyPaused = true; f.internal.saved.enabled = false; f.internal.saved.agents = []
    f.requestMock.mockImplementation(async request => request.action === 'bootstrap' ? { ok: true, agents: [] } : request.action === 'list' ? { ok: true, devices: [] } : { ok: true, device: { id: deviceId, name: '暂停电脑' }, deviceKey: request.body?.registrationKey })
    await f.service.tick()
    expect(f.service.snapshot()).toMatchObject({ deviceId, deviceName: '暂停电脑', enabled: false })
    expect(mocks.fork).not.toHaveBeenCalled()
  })
  it('does not undo a manual pause and never registers on account verification failure', async () => {
    const f = await fixture()
    f.internal.saved.manuallyPaused = true; f.internal.saved.enabled = false
    f.requestMock.mockImplementation(async r => r.action === 'bootstrap' ? { ok: true, agents: [] } : { ok: true, devices: [{ id: deviceId, name: '暂停电脑' }] })
    await f.service.tick()
    expect(f.service.snapshot().enabled).toBe(false)
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(mocks.fork).not.toHaveBeenCalled()
    const g = await fixture()
    g.requestMock.mockRejectedValue(new Error('登录已过期'))
    await g.service.tick()
    expect(g.requestMock.mock.calls.every(([r]) => r.action === 'bootstrap')).toBe(true)
  })
  it('persists the signed-out transition once instead of rewriting encrypted state every tick', async () => {
    const f = await fixture()
    f.setOwner(undefined); mocks.encrypt.mockClear()
    await f.service.tick(); await f.service.tick()
    expect(mocks.encrypt).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot().connection).toBe('offline')
  })
  it('renames only the owned device and keeps its key and installation identity', async () => {
    const f = await fixture()
    f.requestMock.mockResolvedValue({ ok: true, device: { id: deviceId, name: '我的工作电脑' } })
    await f.service.action({ action: 'rename_device', name: ' 我的工作电脑 ' })
    expect(f.service.snapshot().deviceName).toBe('我的工作电脑')
    expect(f.internal.saved.deviceKey).toBe(deviceKey)
    expect(f.internal.saved.installationId).toBe('test-installation')
    await expect(f.service.action({ action: 'rename_device', name: 'a\u0000b' })).rejects.toThrow('控制字符')
    f.setOwner('owner-B')
    await expect(f.service.action({ action: 'rename_device', name: '其他账号' })).rejects.toThrow('账号')
  })
  it('fails closed for TRAE without forking a fallback or touching its saved history', async () => {
    const f = await fixture()
    const binding = f.internal.saved.agents[0]!
    Object.assign(binding, { adapter: 'trae', desiredRunning: true })
    await expect(f.internal.startAgent(binding)).rejects.toThrow('TRAE 远程交互暂不支持')
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(binding.runtimeStatus).toBe('unavailable')
    expect(binding.desiredRunning).toBe(false)
    expect(f.internal.saved.agents).toHaveLength(1)
  })
  it('rejects a new TRAE binding and marks an imported legacy instance unavailable immediately', async () => {
    const f = await fixture()
    await expect(f.service.action({ action: 'add_agent', adapter: 'trae', name: 'TRAE' })).rejects.toThrow('暂不支持')
    f.internal.saved.agents = []
    mocks.readLegacyBinding.mockResolvedValue({ adapter: 'trae', sourceFile: path.join(f.root, 'sync-service.json'), stateFile: path.join(f.root, 'sync-state.json'), key,
      executable: process.execPath, executableArgs: [], projectRoots: [path.join(f.root, 'project')], settings: { qclawStateDir: '', qclawConfigPath: '', qclawAgentId: 'main' } })
    f.requestMock.mockImplementation(async request => {
      if (request.action === 'bootstrap') return { ok: true, agents: [{ id: agentId, display_name: 'TRAE', adapter_code: 'trae', status: 'online' }] }
      if (request.action === 'resolve_legacy') return { ok: true, agentId, adapter: 'trae' }
      return { ok: true }
    })
    const snapshot = await f.service.action({ action: 'import_existing', agentId })
    expect(snapshot.agents[0]).toMatchObject({ adapter: 'trae', status: 'stopped', runtimeStatus: 'unavailable', autoStart: false })
    expect(snapshot.agents[0]?.message).toContain('暂不支持')
    expect(mocks.fork).not.toHaveBeenCalled()
  })
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
    child.emit('message', { type: 'status', instanceId: agentId, phase: 'ready', connected: true, runtimeReady: false })
    expect(f.binding.status).toBe('online')
    expect(f.binding.runtimeStatus).toBe('error')
    child.emit('message', { type: 'status', instanceId: agentId, phase: 'ready', connected: true, runtimeReady: true })
    expect(f.binding.runtimeStatus).toBe('ready')
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

  it('checks account on tick without creating bindings or treating cloud online as runtime ready', async () => {
    const f = await fixture()
    f.requestMock.mockResolvedValue({ ok: true, agents: [{ id: agentId, display_name: 'Codex', adapter_code: 'codex', status: 'online', interactionKey: 'must-not-escape' }] })
    await f.service.tick()
    expect(f.service.snapshot().accountConnection?.status).toBe('connected')
    expect(f.service.snapshot().cloudAgents).toEqual([{ id: agentId, name: 'Codex', adapter: 'codex', reportedStatus: 'online' }])
    expect(f.service.snapshot().agents[0]?.runtimeStatus).toBe('unknown')
    expect(JSON.stringify(f.service.snapshot())).not.toContain('must-not-escape')
    await f.service.tick()
    expect(f.requestMock.mock.calls.filter(([request]) => request.action === 'bootstrap')).toHaveLength(1)
    expect(mocks.fork).not.toHaveBeenCalled()
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
    expect(f.requestMock.mock.calls.filter(([request]) => request.action !== 'bootstrap')).toHaveLength(1)
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
    expect(f.requestMock.mock.calls.filter(([request]) => request.action !== 'bootstrap').every(([request]) => request.action === 'bind')).toBe(true)
  })

  it('confirms an ambiguous bind by heartbeat but never silently rebinds after a later web-side unbind', async () => {
    const f = await fixture()
    f.binding.pendingCloudBind = true
    await f.service.tick()
    expect(f.binding.pendingCloudBind).toBe(false)
    f.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, boundAgentIds: [], commands: [], leaseSeconds: 60 })))
    await f.service.tick()
    expect(f.binding.desiredRunning).toBe(false)
    expect(f.requestMock.mock.calls.filter(([request]) => request.action !== 'bootstrap')).toHaveLength(0)
    await expect(f.service.action({ action: 'start', agentId })).rejects.toThrow('尚未授权')
  })
})

describe('Windows npm shim resolution', () => {
  it('upgrades an existing agent once and persists native project scope across reloads', async () => {
    const f = await fixture()
    const before = [...f.binding.projectRoots]
    await f.service.action({ action: 'authorize_agent', agentId })
    expect(f.service.snapshot().agents[0]?.projectScope).toBe('all_native')
    expect(f.binding.projectRoots).toEqual(before)
    await f.service.action({ action: 'authorize_agent', agentId })
    expect(f.requestMock).not.toHaveBeenCalled()
    const persisted = JSON.parse(Buffer.from((await readFile(path.join(f.storageDir, 'host-state.enc'))).toString().replace('mock-encrypted:', ''), 'base64').toString())
    expect(persisted.agents[0].projectScope).toBe('all_native')
    await f.service.action({ action: 'start', agentId })
    const child = [...f.internal.children.values()][0]!
    const start = child.send.mock.calls.find(call => call[0].type === 'start')![0]
    expect(start.authorizedNativeProjects).toBe(true)
    expect((start.config as { projectDiscovery: { roots: string[] } }).projectDiscovery.roots).toEqual([])
    await expect(f.service.action({ action: 'add_project', agentId })).rejects.toThrow('无需逐个添加')
  })
  it('supports the official Claude native executable without shell-running its npm shim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-claude-native-')); roots.push(root)
    const packageRoot = path.join(root, 'node_modules/@anthropic-ai/claude-code'); await mkdir(path.join(packageRoot, 'bin'), { recursive: true })
    await writeFile(path.join(root, 'claude.cmd'), 'not executed'); await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'bin/claude.exe' } })); await writeFile(path.join(packageRoot, 'bin/claude.exe'), 'not executed')
    vi.stubEnv('Path', root); vi.stubEnv('PATH', root)
    expect(await resolveAgentLaunch('claude-code', process.execPath)).toEqual({ executable: await realpath(path.join(packageRoot, 'bin/claude.exe')), args: [] })
  })
  it('resumes a new local conversation using its own native ID and blocks an unconfirmed continuation', async () => {
    const f = await fixture()
    const cli = path.join(f.root, 'AppData/Local/OpenAI/Codex/bin', 'a'.repeat(16)); await mkdir(cli, { recursive: true }); await writeFile(path.join(cli, 'codex.exe'), 'not executed')
    vi.stubEnv('USERPROFILE', await realpath(f.root))
    const internal = f.service as unknown as { state: { localCatalog: import('../../shared/agent-host').LocalCatalog }; localChildren: Map<string, FakeChild> }
    internal.state.localCatalog = { scannedAt: '', errors: [], projects: [{ id: 'project', adapter: 'codex', name: 'synthetic', path: f.binding.projectRoots[0]!, lastActivityAt: '' }], sessions: [] }
    const conversationId = '4'.repeat(32), nativeId = '33333333-3333-4333-8333-333333333333'
    const input = { action: 'send_local' as const, projectId: 'project', conversationId, instruction: 'remember', requestId: '00000000-0000-4000-8000-000000000001' }
    await f.service.action(input)
    const first = [...internal.localChildren.values()][0]!
    expect(first.send.mock.calls[0]![0].resumeSessionId).toBe('')
    first.emit('message', { type: 'result', result: { exitCode: 0, sessionId: nativeId, finalReply: 'remembered' } }); first.exit(0)
    await f.service.action({ ...input, instruction: 'recall', requestId: '00000000-0000-4000-8000-000000000002' })
    const second = [...internal.localChildren.values()][0]!
    expect(second.send.mock.calls[0]![0].resumeSessionId).toBe(nativeId)
    second.exit(1)
    expect(f.service.snapshot().localTasks?.at(-1)?.status).toBe('unconfirmed')
    await expect(f.service.action({ ...input, requestId: '00000000-0000-4000-8000-000000000003' })).rejects.toThrow('结果未确认')
  })
  it('resolves Cursor under a redirected LocalAppData root without accepting escaping payloads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-cursor-root-')); roots.push(root)
    const actual = path.join(root, 'actual'); const redirected = path.join(root, 'redirected')
    const version = path.join(actual, 'cursor-agent', 'versions', '2026.09.08-6caf4ff')
    await mkdir(version, { recursive: true })
    await writeFile(path.join(version, 'node.exe'), 'not executed')
    await writeFile(path.join(version, 'index.js'), '// not executed')
    await symlink(actual, redirected, 'junction')
    vi.stubEnv('LOCALAPPDATA', redirected)
    expect(await resolveAgentLaunch('cursor', process.execPath)).toEqual({ executable: await realpath(path.join(version, 'node.exe')), args: [await realpath(path.join(version, 'index.js'))] })
    await rm(path.join(version, 'index.js'))
    expect(await resolveAgentLaunch('cursor', process.execPath)).toBeUndefined()
  })
  it('resolves only the fixed official package bin to managed Node without executing cmd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-agent-shim-')); roots.push(root)
    const packageRoot = path.join(root, 'node_modules', '@openai', 'codex')
    await mkdir(path.join(packageRoot, 'bin'), { recursive: true })
    await writeFile(path.join(root, 'codex.cmd'), 'not executed')
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }))
    await writeFile(path.join(packageRoot, 'bin', 'codex.js'), '// not executed')
    vi.stubEnv('Path', root); vi.stubEnv('PATH', root); vi.stubEnv('USERPROFILE', root)
    const resolved = await resolveAgentLaunch('codex', process.execPath)
    expect(resolved?.executable).toBe(process.execPath)
    expect(resolved?.args).toEqual([await realpath(path.join(packageRoot, 'bin', 'codex.js'))])
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: '../../../outside.js' } }))
    await writeFile(path.join(root, 'outside.js'), '// not executed')
    expect(await resolveAgentLaunch('codex', process.execPath)).toBeUndefined()
  })
})
