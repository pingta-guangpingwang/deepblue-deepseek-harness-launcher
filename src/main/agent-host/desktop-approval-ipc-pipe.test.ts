import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopApprovalIpc } from './desktop-approval-ipc'

// 用真实 Windows 命名管道仿真 Codex 桌面 app-server，验证连接/发现/跟随/决定/
// 超大帧/版本不符/断线的真实套接字行为。仅 Windows 上运行。
const skip = process.platform !== 'win32' ? describe.skip : describe
type Json = Record<string, any>
function framed(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]) }
interface Scripted { threadA: string; threadB: string; clientId?: string; following: string[]; decisions: Json[]; discoveryResponses: string[] }
async function serve(pipe: string, script: (server: Scripted, send: (value: Json) => void) => void) {
  const state: Scripted = { threadA: randomUUID(), threadB: randomUUID(), following: [], decisions: [], discoveryResponses: [] }
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0)
    const send = (value: Json) => { if (!socket.writable) return; socket.write(framed(value)) }
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(); if (buffer.length < size + 4) return
        const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')); buffer = buffer.subarray(size + 4)
        if (message.type === 'request') {
          if (message.method === 'initialize') { state.clientId = 'mock-owner'; send({ type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, result: { clientId: 'mock-owner' } }); continue }
          if (message.method === 'thread-owner-discovery') { state.discoveryResponses.push(message.params.conversationId); send({ type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, handledByClientId: 'mock-owner' }); continue }
          if (message.method?.startsWith('thread-follower-')) state.decisions.push(message)
          script(state, send)
          continue
        }
        if (message.type === 'broadcast' && message.method === 'thread-stream-following-changed' && message.params?.following) {
          state.following.push(message.params.conversationId)
          script(state, send)
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(pipe, resolve))
  return { state, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
const snapshotFrame = (clientId: string, thread: string, version: number, pad = '') => ({
  type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'mock-owner', targetClientIds: [clientId], version,
  params: { hostId: 'local', conversationId: thread, change: { type: 'snapshot', revision: 1, conversationState: { id: thread, cwd: 'E:\\isolated', requests: [], turns: [] } } },
  ...(pad ? { __pad: pad } : {}),
})
const oversizedFrame = (clientId: string, thread: string) => ({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'mock-owner', targetClientIds: [clientId], version: 11, params: { hostId: 'local', conversationId: thread, change: { type: 'snapshot', revision: 1, conversationState: { id: thread, cwd: 'E:\\isolated', requests: [], pad: 'x'.repeat(8 * 1024 * 1024 + 2048) } } } })

skip('desktop approval pipe transport', () => {
  const servers: Array<{ close(): Promise<void> }> = []
  afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
  async function pipeClient(script: (server: Scripted, send: (value: Json) => void) => void, changed = () => {}) {
    const name = '\\\\.\\pipe\\shenlan-test-' + randomUUID()
    const served = await serve(name, script); servers.push(served)
    return { ipc: new DesktopApprovalIpc(changed, name), ...served }
  }

  it('discovers owner, follows and reads a real snapshot', async () => {
    const { ipc, state } = await pipeClient((server, send) => {
      if (server.following.length === 1) send(snapshotFrame(server.clientId!, state.threadA, 11))
    })
    const watched = await ipc.read(state.threadA)
    expect(watched.owner).toBe('mock-owner')
    expect(watched.state?.requests).toEqual([])
    expect(state.discoveryResponses).toEqual([state.threadA])
    ipc.close()
  })
  it('marks an oversized snapshot thread limited, fails fast without refollowing, and keeps the channel alive for other threads', async () => {
    const changed = vi.fn()
    const { ipc, state } = await pipeClient((server, send) => {
      if (server.following.filter(id => id === state.threadA).length === 1) send(oversizedFrame(server.clientId!, state.threadA))
      if (server.following.filter(id => id === state.threadB).length === 1) send(snapshotFrame(server.clientId!, state.threadB, 11))
    }, changed)
    await expect(ipc.read(state.threadA)).rejects.toThrow('超过安全读取限制')
    await expect(ipc.read(state.threadA)).rejects.toThrow('超过安全读取限制')
    expect(state.following.filter(id => id === state.threadA)).toHaveLength(1) // 冷却期内未重复跟随重传
    const watched = await ipc.read(state.threadB) // 通道未被超大帧杀死
    expect(watched.state?.id).toBe(state.threadB)
    expect(changed).toHaveBeenCalled()
    ipc.close()
  })
  it('rejects unreadable protocol versions without executing a decision', async () => {
    const { ipc, state } = await pipeClient((server, send) => {
      if (server.following.length === 1) send(snapshotFrame(server.clientId!, state.threadA, 10))
    })
    await expect(ipc.read(state.threadA)).rejects.toThrow('版本无法识别')
    ipc.close()
  })
  it('answers client discovery honestly and routes decisions only to the current owner', async () => {
    let discoveryAnswered: Json | undefined
    const { ipc, state } = await pipeClient((server, send) => {
      if (server.following.length === 1) send(snapshotFrame(server.clientId!, state.threadA, 11))
      if (server.following.length === 1 && server.clientId) setTimeout(() => send({ type: 'client-discovery-request', requestId: 'discovery-1' }), 10)
      for (const decision of server.decisions.splice(0)) {
        send({ type: 'response', requestId: decision.requestId, resultType: 'success', method: decision.method, result: { ok: true } })
        discoveryAnswered = decision
      }
    })
    const watched = await ipc.read(state.threadA)
    await ipc.decide(state.threadA, watched.owner, 'item/commandExecution/requestApproval', 12, true)
    expect(discoveryAnswered?.method).toBe('thread-follower-command-approval-decision')
    expect(discoveryAnswered?.params?.decision).toBe('accept')
    expect(discoveryAnswered?.targetClientId).toBe('mock-owner')
    await expect(ipc.decide(state.threadA, 'someone-else', 'item/commandExecution/requestApproval', 12, true)).rejects.toThrow('不属于当前原生会话')
    ipc.close()
  })
  it('treats an unacknowledged decision result as unconfirmed', async () => {
    const { ipc, state } = await pipeClient((server, send) => {
      if (server.following.length === 1) send(snapshotFrame(server.clientId!, state.threadA, 11))
      for (const decision of server.decisions.splice(0)) send({ type: 'response', requestId: decision.requestId, resultType: 'success', method: decision.method, result: { ok: false } })
    })
    const watched = await ipc.read(state.threadA)
    await expect(ipc.decide(state.threadA, watched.owner, 'item/fileChange/requestApproval', 5, false)).rejects.toThrow('没有确认接收')
    ipc.close()
  })
  it('clears watches and pending reads when the native peer disconnects, never auto-resending decisions', async () => {
    const changed = vi.fn()
    const sockets: net.Socket[] = []
    const name = '\\\\.\\pipe\\shenlan-test-' + randomUUID()
    const server = net.createServer(socket => {
      sockets.push(socket)
      let buffer = Buffer.alloc(0)
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE(); if (buffer.length < size + 4) return
          const message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')); buffer = buffer.subarray(size + 4)
          if (message.type === 'request' && message.method === 'initialize') socket.write(framed({ type: 'response', requestId: message.requestId, resultType: 'success', method: 'initialize', result: { clientId: 'mock-owner' } }))
          if (message.type === 'request' && message.method === 'thread-owner-discovery') socket.write(framed({ type: 'response', requestId: message.requestId, resultType: 'success', method: 'thread-owner-discovery', handledByClientId: 'mock-owner' }))
          if (message.type === 'broadcast' && message.method === 'thread-stream-following-changed' && message.params?.following) socket.destroy()
        }
      })
      socket.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(name, resolve)); servers.push({ close: () => new Promise<void>(resolve => server.close(() => resolve())) })
    const ipc = new DesktopApprovalIpc(changed, name)
    await expect(ipc.read(randomUUID())).rejects.toThrow('已断开')
    expect(changed).toHaveBeenCalled()
    ipc.close()
  })
})
