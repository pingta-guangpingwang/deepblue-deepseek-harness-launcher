import net from 'node:net'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { discoverNativePipe, nativeCall, NativeDeliveryError, unwrapNativeResult } from './native-desktop'
import { desktopRelayDirectory, desktopRelayRequest, type RelayConfig, type RelayReply } from './desktop-relay'
import { readNativeSnapshot } from './native-rollout'

const directory = desktopRelayDirectory()
const uuid = /^[a-f0-9-]{36}$/i
let nativePipe: string | undefined
let config: RelayConfig
let server: net.Server | undefined
let readiness: { at: number; ready: boolean } | undefined
async function ready(): Promise<boolean> {
  if (readiness && Date.now() - readiness.at < 5000) return readiness.ready
  try {
    nativePipe = await discoverNativePipe(Number(process.env.SHENLAN_DESKTOP_PARENT) || process.ppid)
    if (!nativePipe) throw new Error('missing pipe')
    const result = await nativeCall(nativePipe, config.executor, 'list_projects', {}, 8000) as { success?: boolean }
    readiness = { at: Date.now(), ready: result.success === true }
  } catch { readiness = { at: Date.now(), ready: false } }
  return readiness.ready
}
async function handle(input: Record<string, unknown>): Promise<RelayReply> {
  const token = Buffer.from(typeof input.token === 'string' ? input.token : '')
  const expected = Buffer.from(config.token)
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) return { ok: false, error: '本机桥接身份验证失败' }
  if (input.action === 'status') return { ok: true, ready: await ready() }
  if (!['send', 'read'].includes(String(input.action)) || !uuid.test(String(input.targetThreadId || ''))) return { ok: false, error: '不支持的桥接请求' }
  if (!(await ready())) return { ok: false, status: 'failed', error: 'Codex 桌面连接不可用，请重新启动 Codex' }
  const target = String(input.targetThreadId)
  if (input.action === 'read') {
    return { ok: true, result: await readNativeSnapshot(target) }
  }
  if (target === config.executor) return { ok: false, status: 'failed', error: '不能发送给桥接自身的执行上下文；请选择其他原对话' }
  if (!uuid.test(String(input.requestId || '')) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 24000) return { ok: false, status: 'failed', error: '消息或请求编号无效' }
  const fingerprint = createHash('sha256').update(JSON.stringify([target, input.message, input.model || ''])).digest('hex')
  const requestFile = path.join(directory, 'requests', `${input.requestId}.json`)
  const record = { fingerprint, baselineTurnId: uuid.test(String(input.baselineTurnId || '')) ? String(input.baselineTurnId) : undefined, status: 'unconfirmed', error: '此请求已经交给桌面或正在交付，禁止自动重复执行' }
  try {
    const file = await open(requestFile, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const previous = JSON.parse(await readFile(requestFile, 'utf8'))
    if (previous.fingerprint !== fingerprint) return { ok: false, status: 'failed', error: '请求编号已用于不同消息' }
    return { ok: previous.status === 'delivered', status: previous.status, baselineTurnId: previous.baselineTurnId, error: previous.error }
  }
  let reply: RelayReply
  try {
    const args: Record<string, unknown> = { threadId: target, prompt: input.message }
    if (typeof input.model === 'string' && input.model) args.model = input.model
    const result = await nativeCall(nativePipe!, config.executor, 'send_message_to_thread', args) as { success?: boolean }
    reply = result.success === true ? { ok: true, status: 'delivered' } : { ok: false, status: 'unconfirmed', error: '桌面未返回明确送达确认，请检查原对话' }
  } catch (error) {
    reply = { ok: false, status: error instanceof NativeDeliveryError && !error.uncertain ? 'failed' : 'unconfirmed', error: error instanceof Error ? error.message : '桌面发送结果未确认' }
  }
  const next = requestFile + '.next'
  await writeFile(next, JSON.stringify({ ...record, ...reply }), { mode: 0o600 }); await rename(next, requestFile)
  return { ...reply, baselineTurnId: record.baselineTurnId }
}
async function start(): Promise<void> {
  await mkdir(path.join(directory, 'requests'), { recursive: true, mode: 0o700 })
  const settings = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'))
  if (!uuid.test(settings.executor || '')) throw new Error('missing executor')
  config = { executor: settings.executor, token: randomBytes(32).toString('hex'), endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\shenlan-codex-${randomBytes(16).toString('hex')}` : path.join(directory, 'relay.sock') }
  // Reuse a live companion. Never steal the address from another Desktop instance.
  if (await desktopRelayRequest({ action: 'status' }, directory, 10000).then(reply => reply.ready).catch(() => false)) return
  server = net.createServer(socket => {
    let buffer: Buffer = Buffer.alloc(0); let accepted = false
    socket.setTimeout(25000, () => socket.destroy()); socket.on('error', () => {})
    socket.on('data', chunk => {
      if (accepted) return
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 128 * 1024) { socket.destroy(); return }
      const end = buffer.indexOf(10); if (end < 0) return
      accepted = true
      void (async () => {
        let reply: RelayReply
        try { reply = await handle(JSON.parse(buffer.subarray(0, end).toString('utf8'))) }
        catch { reply = { ok: false, status: 'unconfirmed', error: '桥接处理失败，请检查原对话，勿重复发送' } }
        if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n')
      })()
    })
  })
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(config.endpoint, resolve) })
  const next = path.join(directory, `connection-${process.pid}.next`)
  await writeFile(next, JSON.stringify(config), { mode: 0o600 }); await rename(next, path.join(directory, 'connection.json'))
}

// Standard MCP stdio lifecycle. Only an informational tool is exposed to the
// model; the launcher uses the authenticated, local-only companion endpoint.
const startup = start()
startup.catch(() => { process.stderr.write('深蓝桌面桥接启动失败，请检查本机配置\n') })
if (process.argv.includes('--background') && process.env.SHENLAN_DESKTOP_PARENT) {
  const parent = Number(process.env.SHENLAN_DESKTOP_PARENT)
  setInterval(() => { try { process.kill(parent, 0) } catch { server?.close(); process.exit(0) } }, 5000).unref()
}
if (!process.argv.includes('--background')) {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => { void (async () => {
    if (Buffer.byteLength(line) > 128 * 1024) return
    let req: { id?: number | string; method?: string }
    try { req = JSON.parse(line) } catch { return }
    if (req.id === undefined) return
    let result: unknown
    if (req.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shenlan-desktop-relay', version: '1.0.0' } }
    else if (req.method === 'tools/list') result = { tools: [{ name: 'shenlan_relay_status', description: '检查深蓝启动器到 Codex 桌面原对话的本机桥接状态', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
    else if (req.method === 'tools/call') { await startup.catch(() => {}); result = { content: [{ type: 'text', text: JSON.stringify({ ready: await desktopRelayRequest({ action: 'status' }).then(r => r.ready).catch(() => false) }) }] } }
    else if (req.method === 'ping') result = {}
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
  })().catch(() => {}) })
  lines.on('close', () => { server?.close(); process.exit(0) })
}
