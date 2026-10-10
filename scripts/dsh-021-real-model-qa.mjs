// Bounded real-provider acceptance. Keys are read locally, never logged or reported.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import YAML from 'yaml'
import { mergeHarnessProfileModelSettings, parseHarnessModelSettings } from '../src/main/model-settings.ts'
import { publishDshProcessAuth, clearDshProcessAuth, restrictDshPrivateDirectory } from '../src/main/dsh-process-auth.ts'
import { runDshTask, readDshSessionHistory } from '../vendor/agent-connector/src/dsh-runner.mjs'

const runtime = path.resolve(process.argv[2] || '')
const original = 'C:/Users/Administrator/AppData/Roaming/deepseek-harness-launcher/harness-data'
assert.ok(runtime.includes('dsh-0.2.1-alpha.2-runtime') || runtime.includes('cold-install'))
const output = path.resolve(import.meta.dirname, '../output/dsh-real-model-' + randomUUID())
const home = path.join(output, 'harness-data-v2'), workspace = path.join(output, 'workspace')
await mkdir(home, { recursive: true, mode: 0o700 })
await restrictDshPrivateDirectory(home)
await mkdir(workspace)
const source = await readFile(path.join(original, 'settings.yaml'), 'utf8')
const credentials = await readFile(path.join(original, '.credentials.yaml'), 'utf8')
const refs = YAML.parse(credentials)?.refs || {}
const secretValues = Object.values(refs).filter(value => typeof value === 'string')
const settings = YAML.parse(source)
const active = settings?.['agent-default-model']
assert.deepEqual(active, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
const snapshot = parseHarnessModelSettings(source, [{ id: 'deepseek-official', name: 'DeepSeek', api: 'deepseek', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', custom: false, models: [{ id: active.model, name: active.model }] }], active)
assert.ok(snapshot.providers.length === 1 && snapshot.providers[0].baseURL === 'https://api.deepseek.com')
const rows = YAML.parse(mergeHarnessProfileModelSettings('[]\n', active, snapshot.providers))
rows.push({ id: 'session-title-llm', disabled: true })
const patch = YAML.stringify(rows)
await mkdir(path.join(home, 'profiles/web'), { recursive: true, mode: 0o700 })
await writeFile(path.join(home, 'profiles/web/cordis.patch.yml'), patch)
await writeFile(path.join(home, '.credentials.yaml'), credentials, { mode: 0o600 })
const originalHash = createHash('sha256').update(source).update(credentials).digest('hex')
const env = { ...process.env, DSH_HOME: home }
for (const key of Object.keys(env)) if (/api.?key|access.?token|auth.?token|password|secret/i.test(key)) delete env[key]
const child = spawn(process.execPath, [path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--port', '0', '--no-open'], { cwd: runtime, env, windowsHide: true })
let startup = '', processOutput = '', exited = false
const collect = bytes => { processOutput += bytes.toString(); startup ||= processOutput.match(/dsh web:\s+(http:\/\/[^\s\u001b]+)/)?.[1] || '' }
child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('exit', () => { exited = true })
const report = { passed: false, synthetic: false, provider: 'deepseek-official', model: active.model, version: '0.2.1-alpha.2', output, requestBudget: 'one short read-only user turn; title generation disabled', checks: {} }
let token = ''
try {
  for (let i = 0; i < 160 && !startup && !exited; i++) await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(startup, 'DSH authenticated startup URL absent')
  const url = new URL(startup); token = url.searchParams.get('token') || ''
  await publishDshProcessAuth(home, { version: report.version, pid: child.pid, cwd: runtime, url: startup })
  const dshHost = { endpoint: url.origin, expectedVersion: report.version, expectedCwd: runtime, authFile: path.join(home, 'launcher/process-auth.json'), authRoot: home }
  const result = await runDshTask({ dshHost, project: { path: workspace }, instruction: 'Do not call any tools or inspect files. Reply with exactly DSH_REAL_021_OK and no other text.', runtimeRequestId: 'real-021-' + randomUUID(), sandbox: 'read-only', managedPermissions: true, onApproval: async () => ({ approved: false }) }, { timeoutMs: 120000, pollIntervalMs: 100 })
  report.checks.exitCode = result.exitCode
  report.checks.reply = result.finalReply
  report.checks.sessionId = result.sessionId
  const history = await readDshSessionHistory({ dshHost }, { path: workspace }, { runtimeSessionId: result.sessionId })
  report.checks.historyContainsMarker = history.some(item => item.role === 'assistant' && item.text.includes('DSH_REAL_021_OK'))
  assert.equal(result.exitCode, 0)
  assert.equal(result.finalReply.trim(), 'DSH_REAL_021_OK')
  assert.equal(report.checks.historyContainsMarker, true)
  report.passed = true
} catch (error) {
  // Do not persist arbitrary provider error text which might quote credentials.
  report.error = error instanceof assert.AssertionError ? String(error.message).slice(0, 200) : 'Real model request failed; inspect private runtime locally'
  if (!startup) {
    let diagnostic = processOutput.slice(-1800).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
    for (const secret of secretValues) diagnostic = diagnostic.replaceAll(secret, '[redacted]')
    report.startupDiagnostic = diagnostic
  }
  process.exitCode = 1
} finally {
  child.kill(); clearDshProcessAuth(home, child.pid)
  await new Promise(resolve => setTimeout(resolve, 500))
  await rm(path.join(home, '.credentials.yaml'), { force: true })
  report.checks.testCredentialCopyRemoved = true
  const after = createHash('sha256').update(await readFile(path.join(original, 'settings.yaml'))).update(await readFile(path.join(original, '.credentials.yaml'))).digest('hex')
  report.checks.originalConfigUnchanged = originalHash === after
  assert.equal(report.checks.originalConfigUnchanged, true)
  const serialized = JSON.stringify(report, null, 2)
  assert.ok(!token || !serialized.includes(token))
  assert.ok(secretValues.every(secret => !serialized.includes(secret)))
  await writeFile(path.join(output, 'report.json'), serialized + '\n')
  console.log(JSON.stringify(report, null, 2))
}
