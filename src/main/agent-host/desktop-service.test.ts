import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../shared/agent-host'
const mock = vi.hoisted(() => ({ relay: vi.fn(), fork: vi.fn(() => { throw new Error('Desktop send must not spawn CLI') }) }))
vi.mock('./desktop-relay', () => ({ desktopRelayRequest: mock.relay }))
vi.mock('./native-approvals', () => ({ NativeApprovals: class { isBusy() { return false } close() {} async read(context: { sessionId: string }) { return { sessionId: context.sessionId, status: 'ready', requests: [] } } } }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: mock.fork }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }))
import { AgentHostService } from './service'
const roots: string[] = []
afterEach(async () => { mock.relay.mockReset(); mock.fork.mockClear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-service-')); roots.push(root)
  const project = path.join(root, 'project'); await mkdir(project)
  const options = { storageDir: path.join(root, 'state'), moduleDir: root, nodePath: process.execPath, launcherVersion: 'test', ownerId: () => undefined, request: async () => ({}), chooseDirectory: async () => undefined, onChange: () => {} }
  const service = new AgentHostService(options); await service.initialize()
  const internal = service as unknown as { state: AgentHostSnapshot; refreshDesktopTasks(id: string): Promise<void> }
  const target = randomUUID()
  internal.state.localCatalog = { scannedAt: new Date().toISOString(), projects: [{ id: 'project', adapter: 'codex', name: 'test', path: project, lastActivityAt: '' }], sessions: [{ id: 'session', projectId: 'project', adapter: 'codex', runtimeSessionId: target, title: 'test', status: 'native_owned', lastActivityAt: '' }], errors: [] }
  const action = { action: 'send_local' as const, projectId: 'project', sessionId: 'session', instruction: 'hello', requestId: randomUUID() }
  return { service, internal, action, target, project, options }
}
describe('desktop service routing and recovery', () => {
  it('distinguishes new injected input from old identical text and keeps its matched turn', async () => {
    const f = await fixture()
    const old = { id: 'old-message', type: 'userMessage', content: [{ text: 'hello' }] }
    mock.relay.mockResolvedValueOnce({ ok: true, ready: true }).mockResolvedValueOnce({ ok: true, result: { thread: { id: f.target, cwd: f.project }, turns: [{ id: 'active', items: [old] }] } }).mockResolvedValueOnce({ ok: true, status: 'delivered' })
    await f.service.action(f.action)
    mock.relay.mockResolvedValueOnce({ ok: true, result: { turns: [{ id: 'active', status: 'completed', items: [old] }] } })
    await f.internal.refreshDesktopTasks('session')
    expect(f.service.snapshot().localTasks?.[0]?.status).toBe('delivered')
    mock.relay.mockResolvedValueOnce({ ok: true, result: { turns: [{ id: 'active', status: 'inProgress', items: [{ ...old, id: 'new-message' }] }] } })
    await f.internal.refreshDesktopTasks('session')
    expect(f.service.snapshot().localTasks?.[0]?.status).toBe('running')
    mock.relay.mockResolvedValueOnce({ ok: true, result: { turns: [{ id: 'active', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'OK' }] }] } })
    await f.internal.refreshDesktopTasks('session')
    expect(f.service.snapshot().localTasks?.[0]?.reply).toBe('OK')
    await f.service.dispose()
  })
  it('delivers to the same session, persists, and completes only on matched native turn', async () => {
    const f = await fixture()
    mock.relay.mockResolvedValueOnce({ ok: true, ready: true }).mockResolvedValueOnce({ ok: true, result: { thread: { id: f.target, cwd: f.project }, turns: [{ id: 'before' }] } }).mockResolvedValueOnce({ ok: true, status: 'delivered' })
    const sent = await f.service.action(f.action)
    expect(sent.localTasks?.[0]?.status).toBe('delivered'); expect(mock.fork).not.toHaveBeenCalled()
    const restored = new AgentHostService(f.options); await restored.initialize()
    expect(restored.snapshot().localTasks?.[0]?.requestId).toBe(f.action.requestId)
    mock.relay.mockResolvedValueOnce({ ok: true, result: { turns: [{ id: 'new', status: 'completed', items: [{ type: 'userMessage', content: [{ text: 'hello' }] }, { type: 'agentMessage', phase: 'final_answer', text: 'OK' }] }] } })
    await f.internal.refreshDesktopTasks('session')
    expect(f.service.snapshot().localTasks?.[0]?.reply).toBe('OK')
    await restored.dispose(); await f.service.dispose()
  })
  it('keeps uncertain sends and never retries the same request', async () => {
    const f = await fixture()
    mock.relay.mockResolvedValueOnce({ ok: true, ready: true }).mockResolvedValueOnce({ ok: true, result: { thread: { id: f.target, cwd: f.project } } }).mockRejectedValueOnce(new Error('delivery unconfirmed'))
    expect((await f.service.action(f.action)).localTasks?.[0]?.status).toBe('unconfirmed')
    await f.service.action(f.action)
    expect(mock.relay).toHaveBeenCalledTimes(3); expect(mock.fork).not.toHaveBeenCalled(); await f.service.dispose()
  })
  it('rejects a stale project mapping before sending or creating a task', async () => {
    const f = await fixture()
    mock.relay.mockResolvedValueOnce({ ok: true, ready: true }).mockResolvedValueOnce({ ok: true, result: { thread: { id: f.target, cwd: os.tmpdir() } } })
    await expect(f.service.action(f.action)).rejects.toThrow('映射未通过校验')
    expect(f.service.snapshot().localTasks).toBeUndefined(); expect(mock.fork).not.toHaveBeenCalled(); await f.service.dispose()
  })
})
