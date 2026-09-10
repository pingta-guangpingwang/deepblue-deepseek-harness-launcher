import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: mocks.fork }))
import { LocalControlBridge } from './local-control'

class Peer extends EventEmitter {
  connected = true
  requests: Array<Record<string, any>> = []
  send(value: Record<string, any>, callback?: (error: null) => void): void {
    if (value.type === 'initialize') queueMicrotask(() => this.emit('message', { type: 'ready', snapshot: { supported: true, protocol: 1, version: 0, busy: false, rooms: [{ id: 'private-a' }], catalog: [] } }))
    if (value.type === 'request') this.requests.push(value)
    callback?.(null)
  }
  reply(index: number, result: Record<string, unknown>): void { this.emit('message', { type: 'result', requestId: this.requests[index]!.requestId, result }) }
}
describe('local director IPC account boundaries', () => {
  let owner: string, peer: Peer, bridge: LocalControlBridge
  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (/token|secret|password|api.?key|auth.?key/i.test(key)) vi.stubEnv(key, 'synthetic-test-environment')
    owner = 'owner-a'; peer = new Peer(); mocks.fork.mockReturnValue(peer)
    bridge = new LocalControlBridge({ storageDir: 'C:/test-control', moduleDir: 'C:/test-module', nodePath: 'node', ownerId: () => owner, descriptors: async () => [], onChange: () => {} })
  })
  afterEach(() => vi.unstubAllEnvs())
  it('clears the old snapshot before advertising a new account context', async () => {
    await bridge.initialize(); expect(bridge.snapshot().rooms).toHaveLength(1)
    owner = 'owner-b'; expect(bridge.snapshot().rooms).toHaveLength(0)
    await bridge.refreshContext(); expect(bridge.snapshot().rooms).toHaveLength(0)
  })
  it('rejects late replies from the previous account even after switching back', async () => {
    await bridge.initialize()
    const response = bridge.request('snapshot', {}, 'a'.repeat(32))
    const rejected = expect(response).rejects.toThrow('账号已切换')
    await vi.waitFor(() => expect(peer.requests).toHaveLength(1))
    owner = 'owner-b'; await bridge.refreshContext()
    owner = 'owner-a'; await bridge.refreshContext()
    peer.reply(0, { rooms: [{ id: 'stale-a' }] })
    await rejected; expect(bridge.snapshot().rooms).toHaveLength(0)
  })
  it('does not replace an in-flight waiter with a duplicate request id', async () => {
    await bridge.initialize()
    const first = bridge.request('snapshot', {}, 'b'.repeat(32))
    await vi.waitFor(() => expect(peer.requests).toHaveLength(1))
    await expect(bridge.request('snapshot', {}, 'b'.repeat(32))).rejects.toThrow('正在处理')
    peer.reply(0, { rooms: [], busy: false }); await first
    expect(peer.requests).toHaveLength(1)
  })
})
