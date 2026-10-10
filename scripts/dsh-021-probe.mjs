import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
const root = path.resolve(process.argv[2])
const home = path.join(root, 'probe-home')
await mkdir(home, { recursive: true })
const stub = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (body.includes('CANCEL_PROBE')) { request.on('close', () => response.end()); return }
  const base = { id: 'chatcmpl-dsh-probe', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model' }
  response.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'SYNTHETIC_PROTOCOL_OK' }, finish_reason: null }] }) + '\n\n')
  response.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n')
})
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
const stubPort = stub.address().port
await mkdir(path.join(home, 'profiles/web'), { recursive: true })
await writeFile(path.join(home, 'profiles/web/cordis.patch.yml'), `- id: agent-default-model\n  config: { provider: synthetic, model: synthetic-model }\n- id: llm-pi-ai\n  config:\n    providers:\n      synthetic:\n        api: openai-completions\n        baseURL: http://127.0.0.1:${stubPort}/v1\n        apiKeyEnv: DSH_PROBE_KEY\n        models: [{ id: synthetic-model, name: Synthetic }]\n- id: session-title-llm\n  disabled: true\n`)
if (process.argv.includes('--appearance')) {
  const pluginRoot = path.resolve(import.meta.dirname, '../bundled-plugins/deepblue-dsh-skin-runtime')
  const target = path.join(home, 'profiles/web/node_modules/@deepblue/dsh-skin-runtime')
  await mkdir(path.dirname(target), { recursive: true })
  await cp(pluginRoot, target, { recursive: true })
  await writeFile(path.join(home, 'profiles/web/package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { '@deepblue/dsh-skin-runtime': 'file:' + target.replaceAll('\\', '/') }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepblue/dsh-skin-runtime'] } } }, null, 2))
}
const env = { ...process.env, DSH_HOME: home }
for (const key of Object.keys(env)) if (/api.?key|access.?token|auth.?token|password|secret/i.test(key)) delete env[key]
env.DSH_PROBE_KEY = 'SYNTHETIC-NOT-A-REAL-KEY'
const child = spawn(process.execPath, [path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--port', '0', '--no-open'], { cwd: root, env, windowsHide: true })
let output = '', startupUrl = '', exited = false
const collect = chunk => { output += chunk.toString(); startupUrl ||= output.match(/dsh web:\s+(http:\/\/[^\s\u001b]+)/)?.[1] || '' }
child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('exit', () => { exited = true })
const report = { version: '0.2.1-alpha.2', home, checks: {} }
try {
  for (let i = 0; i < 120 && !startupUrl && !exited; i++) await new Promise(resolve => setTimeout(resolve, 250))
  if (!startupUrl) throw new Error('No authenticated startup URL; ' + output.slice(-8000).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'))
  const url = new URL(startupUrl)
  report.checks.startupToken = url.searchParams.has('token')
  report.endpoint = url.origin
  report.checks.unauthenticatedRoot = (await fetch(url.origin)).status
  const exchange = await fetch(url, { redirect: 'manual' })
  report.checks.exchangeStatus = exchange.status
  const cookie = exchange.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
  report.checks.cookieIssued = !!cookie
  report.checks.authenticatedRoot = (await fetch(url.origin, { headers: { cookie } })).status
  const rpc = async (method, args = {}) => {
    const response = await fetch(url.origin + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: url.origin }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
    const text = await response.text()
    let body; try { body = JSON.parse(text) } catch { body = { text: text.slice(0, 200) } }
    return { status: response.status, body }
  }
  for (const method of ['host.describe', 'session/list', 'session/modelCatalog', 'workspace/list']) report.checks[method] = await rpc(method, method === 'session/list' ? { _request: {} } : {})
  const sessionId = 'session-dsh-021-probe-' + randomUUID()
  report.checks.create = await rpc('session/create', { request: { sessionId, cwd: root } })
  report.sessionId = sessionId
  const { default: WebSocket } = await import(pathToFileURL(path.join(root, 'node_modules/ws/wrapper.mjs')).href)
  const socket = new WebSocket(url.origin.replace('http:', 'ws:') + '/api/remote.mux', { origin: url.origin, headers: { cookie } })
  const frames = []
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())))
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ type: 'open', streamId: 'probe-follow', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 64 } } } }))
  for (let i = 0; i < 100 && !frames.length; i++) await new Promise(resolve => setTimeout(resolve, 50))
  report.checks.followOpening = frames[0]
  report.checks.prompt = await rpc('session/prompt', { request: { sessionId, requestId: 'synthetic-prompt-' + randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Return the protocol acknowledgement.' }] } })
  for (let i = 0; i < 200 && !frames.some(frame => frame.value?.event?.type === 'turn/end'); i++) await new Promise(resolve => setTimeout(resolve, 50))
  report.checks.taskEvents = frames.filter(frame => frame.value?.type === 'event').map(frame => frame.value.event)
  report.checks.syntheticTask = frames.some(frame => frame.value?.event?.type === 'assistant/message' && JSON.stringify(frame.value.event.data).includes('SYNTHETIC_PROTOCOL_OK'))
  report.checks.cancelPrompt = await rpc('session/prompt', { request: { sessionId, requestId: 'cancel-prompt-' + randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'CANCEL_PROBE' }] } })
  await new Promise(resolve => setTimeout(resolve, 400))
  report.checks.cancel = await rpc('session/cancel', { request: { sessionId } })
  await new Promise(resolve => setTimeout(resolve, 400))
  report.checks.cancelTerminal = frames.filter(frame => frame.value?.event?.type === 'turn/end').at(-1)?.value.event
  socket.terminate()
} catch(error) { report.error = String(error.message) }
finally { child.kill(); stub.closeAllConnections(); stub.close(); await new Promise(resolve => setTimeout(resolve, 500)) }
await writeFile(path.join(root, 'protocol-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ reportFile: path.join(root, 'protocol-report.json'), error: report.error, checks: { startupToken: report.checks.startupToken, unauthenticatedRoot: report.checks.unauthenticatedRoot, exchangeStatus: report.checks.exchangeStatus, authenticatedRoot: report.checks.authenticatedRoot, syntheticTask: report.checks.syntheticTask, cancelReason: report.checks.cancelTerminal?.data.reason.kind } }, null, 2))
if (report.error) process.exitCode = 1
