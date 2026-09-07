import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { nativeCall, nativePipeFromParent, NativeDeliveryError, unwrapNativeResult, splitWindowsArgs } from './native-desktop'
import { parseNativeTurn, parseNativeSnapshot } from './native-rollout'
import { parseLocalModels, mergeLocalModels, sameLocalPath } from './local-models'

const executor = '11111111-1111-4111-8111-111111111111'
describe('Codex desktop native transport', () => {
  it('keeps a currently observed native model when another CLI overwrites the shared cache', () => {
    const current = parseLocalModels({ models: [{ slug: 'gpt-6-astra' }] })
    const cache = parseLocalModels({ models: [{ slug: 'gpt-5.6-sol' }] })
    expect(mergeLocalModels(current, cache).map(m => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
  })
  it('matches Windows native namespace paths without accepting a different project', () => {
    if (process.platform === 'win32') expect(sameLocalPath('\\\\?\\E:\\work\\project', 'E:\\work\\project')).toBe(true)
    expect(sameLocalPath('E:\\work\\project', 'E:\\work\\different')).toBe(false)
  })
  it('keeps every visible native model, including new models, without hidden internal models', () => {
    expect(parseLocalModels({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }, { slug: 'gpt-reserve', visibility: 'hide' }, { slug: 'gpt-6-astra', visibility: 'list' }] }).map(model => model.id)).toEqual(['gpt-6-astra'])
  })
  it('requires explicit native completion and supports messages inserted into the current turn', () => {
    const rows = [{ type: 'turn_context', payload: { turn_id: executor } }, { type: 'event_msg', payload: { type: 'item_completed', turn_id: executor, item: { id: 'injected', type: 'FunctionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: '<codex_delegation><input>hello</input></codex_delegation>' } } }]
    const text = rows.map(row => JSON.stringify(row)).join('\n')
    expect(parseNativeSnapshot(text)[0]).toMatchObject({ id: executor, status: 'inProgress', items: [{ id: 'injected' }] })
    expect(parseNativeSnapshot(text + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: executor } }))[0]?.status).toBe('completed')
  })
  it('recovers delegated input and final reply only from the exact native turn', () => {
    const input = { timestamp: '2026-09-07T00:00:01Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: executor, item: { id: 'input', type: 'FunctionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: '<codex_delegation>\n<source_thread_id>x</source_thread_id>\n<input>hello</input>\n</codex_delegation>' } } }
    const final = { type: 'event_msg', payload: { type: 'item_completed', turn_id: executor, item: { id: 'answer', type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'OK' }] } } }
    expect(parseNativeTurn([input, final].map(row => JSON.stringify(row)).join('\n'), executor)).toEqual([{ id: 'input', type: 'userMessage', source: 'desktop-relay', content: [{ type: 'text', text: 'hello' }] }, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'OK' }])
    expect(parseNativeTurn([input, final].map(row => JSON.stringify(row)).join('\n'), 'other')).toEqual([])
  })
  it('decodes Windows arguments without executing shell input', () => {
    expect(splitWindowsArgs('"C:\\Program Files\\codex.exe" app-server')).toEqual(['C:\\Program Files\\codex.exe', 'app-server'])
    expect(splitWindowsArgs('"unterminated')).toEqual([])
  })
  it('accepts the actual Desktop global-config-first invocation', () => {
    const config = 'mcp_servers.codex_app={"env"={"CODEX_APP_TOOLS_PIPE_PATH"="\\\\\\\\.\\\\pipe\\\\example"}}'
    const quoted = '"' + config.replace(/(\\*)"/g, '$1$1\\"') + '"'
    expect(nativePipeFromParent(`C:\\codex.exe -c ${quoted} app-server`)).toBe('\\\\.\\pipe\\example')
    expect(nativePipeFromParent(`C:\\other.exe -c ${quoted} app-server`)).toBeUndefined()
    expect(nativePipeFromParent(`C:\\codex.exe exec -c ${quoted} app-server`)).toBeUndefined()
    expect(nativePipeFromParent(`C:\\codex.exe -c ${quoted.replace('codex_app', 'unrelated')} app-server`)).toBeUndefined()
  })
  it('decodes current contentItems and older MCP content', () => {
    expect(unwrapNativeResult({ success: true, contentItems: [{ type: 'inputText', text: '{"turns":[]}' }] })).toEqual({ turns: [] })
    expect(unwrapNativeResult({ content: [{ type: 'text', text: '{"thread":{}}' }] })).toEqual({ thread: {} })
  })
  it('delivers one correctly framed native call, never thread/resume', async () => {
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\shenlan-test-${randomUUID()}` : `/tmp/shenlan-${randomUUID()}.sock`
    let calls = 0
    const server = net.createServer(socket => socket.once('data', bytes => {
      calls++
      const request = JSON.parse(bytes.subarray(4).toString())
      expect(bytes.readUInt32LE(0)).toBe(bytes.length - 4)
      expect(request.method).toBe('tools/call')
      expect(request.params.tool).toBe('send_message_to_thread')
      const payload = Buffer.from(JSON.stringify({ id: 1, result: { success: true } }))
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length)
      socket.end(Buffer.concat([header, payload]))
    }))
    await new Promise<void>(resolve => server.listen(endpoint, resolve))
    try { expect(await nativeCall(endpoint, executor, 'send_message_to_thread', { threadId: executor, prompt: 'test' })).toEqual({ success: true }); expect(calls).toBe(1) }
    finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('marks disconnected-after-write as uncertain without retrying', async () => {
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\shenlan-test-${randomUUID()}` : `/tmp/shenlan-${randomUUID()}.sock`
    let calls = 0
    const server = net.createServer(socket => socket.once('data', () => { calls++; socket.destroy() }))
    await new Promise<void>(resolve => server.listen(endpoint, resolve))
    try { await expect(nativeCall(endpoint, executor, 'send_message_to_thread', {})).rejects.toMatchObject({ uncertain: true }); expect(calls).toBe(1) }
    finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('does not claim delivery when connection cannot be established', async () => {
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\absent-${randomUUID()}` : `/tmp/absent-${randomUUID()}.sock`
    await expect(nativeCall(endpoint, executor, 'send_message_to_thread', {})).rejects.toMatchObject({ uncertain: false })
    expect(new NativeDeliveryError('x').uncertain).toBe(false)
  })
})
