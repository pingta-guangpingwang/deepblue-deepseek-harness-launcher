import { _electron as electron } from 'playwright'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'

const executablePath = process.env.QA_LAUNCHER_EXE
const apiKey = process.env.DEEPSEEK_API_KEY
const userData = process.env.QA_LAUNCHER_DATA
if (!executablePath || !apiKey || !userData) {
  throw new Error('QA_LAUNCHER_EXE, QA_LAUNCHER_DATA and DEEPSEEK_API_KEY are required')
}

const baseUrl = 'http://127.0.0.1:3080'
const settingsPath = path.join(userData, 'harness-data', 'settings.yaml')
const credentialsPath = path.join(userData, 'harness-data', '.credentials.yaml')
const encryptedMirrorPath = path.join(userData, 'model-secrets.json')
let rpcCounter = 0

async function rpc(method, payload) {
  const rpcId = `launcher-sync-${Date.now()}-${++rpcCounter}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body?.result?.ok) throw new Error(`${method}: ${body?.result?.error?.code || 'unknown_error'}`)
  return body.result.value
}

async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

function containsAssistantMarker(history, marker) {
  return history.events?.some(({ event }) => event?.type === 'assistant/message'
    && event.data?.message?.content?.some(block => block?.type === 'text' && block.text?.includes(marker)))
}

const app = await electron.launch({ executablePath, env: { ...process.env } })
let restored = false
try {
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  await page.getByRole('button', { name: '启动 DeepSeek Harness' }).click()
  await waitFor(async () => (await fetch(baseUrl)).ok, 'Harness readiness', 90_000)

  const described = await rpc('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] })
  const deepseekCredential = described.credentials?.DEEPSEEK_API_KEY
  if (!deepseekCredential?.configured || deepseekCredential.source !== 'file' || deepseekCredential.writable !== true) {
    throw new Error(`credential source is not shared writable file: ${JSON.stringify(deepseekCredential)}`)
  }

  await page.getByRole('button', { name: '模型连接' }).click()
  const switcher = page.locator('.model-switcher select')
  await switcher.waitFor({ state: 'visible' })
  await switcher.selectOption('deepseek-official::deepseek-v4-pro')
  await waitFor(async () => /agent-default-model:[\s\S]*model:\s*deepseek-v4-pro/.test(await readFile(settingsPath, 'utf8')), 'launcher to Harness model sync')

  const flashOption = switcher.locator('option[value="deepseek-official::deepseek-v4-flash"]')
  await rpc('settings.update', {
    ns: 'llm-deepseek',
    patch: { models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash · Web Sync QA' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ] },
  })
  await waitFor(async () => (await flashOption.textContent())?.includes('Web Sync QA'), 'Harness web provider settings to launcher sync')
  await rpc('settings.update', {
    ns: 'llm-deepseek',
    patch: { models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ] },
  })
  await waitFor(async () => !(await flashOption.textContent())?.includes('Web Sync QA'), 'Harness web provider settings restoration')
  await switcher.selectOption('deepseek-official::deepseek-v4-flash')
  await waitFor(async () => /agent-default-model:[\s\S]*model:\s*deepseek-v4-flash/.test(await readFile(settingsPath, 'utf8')), 'launcher default model restoration')

  const beforeMirror = (await stat(encryptedMirrorPath)).mtimeMs
  await rpc('credentials.set', { ref: 'DEEPSEEK_API_KEY', value: `sk-live-sync-probe-${Date.now()}` })
  await waitFor(async () => (await stat(encryptedMirrorPath)).mtimeMs > beforeMirror, 'web key to encrypted launcher mirror')
  const probeMirror = (await stat(encryptedMirrorPath)).mtimeMs
  await rpc('credentials.set', { ref: 'DEEPSEEK_API_KEY', value: apiKey })
  restored = true
  await waitFor(async () => (await stat(encryptedMirrorPath)).mtimeMs > probeMirror, 'real key restoration to encrypted mirror')
  const shared = parse(await readFile(credentialsPath, 'utf8')) || {}
  if (shared.DEEPSEEK_API_KEY !== apiKey) throw new Error('restored shared key does not match the private source')

  const marker = 'HARNESS_SYNC_OK'
  const created = await rpc('session.create', {})
  await rpc('session.prompt', {
    sessionId: created.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: `只回复 ${marker}，不要输出其他内容。` }],
  })
  await waitFor(async () => containsAssistantMarker(
    await rpc('session.history', { sessionId: created.sessionId, maxMessages: 10 }), marker,
  ), 'real DeepSeek response through Harness', 120_000)

  await page.getByRole('button', { name: '首页' }).click()
  await page.getByRole('button', { name: '停止 DeepSeek Harness' }).click()
  await waitFor(async () => {
    try { await fetch(baseUrl); return false } catch { return true }
  }, 'Harness stop', 30_000)
  await page.getByRole('button', { name: '启动 DeepSeek Harness' }).click()
  await waitFor(async () => (await fetch(baseUrl)).ok, 'Harness restart', 90_000)
  const afterRestart = await rpc('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] })
  const persisted = afterRestart.credentials?.DEEPSEEK_API_KEY
  if (!persisted?.configured || persisted.source !== 'file' || persisted.writable !== true) {
    throw new Error('credential synchronization did not survive Harness restart')
  }

  if (consoleErrors.length) throw new Error(`launcher console errors: ${consoleErrors.join(' | ')}`)
  console.log(JSON.stringify({
    launcherToHarnessModel: true,
    harnessToLauncherModel: true,
    harnessToLauncherKey: true,
    credentialSource: persisted.source,
    credentialWritable: persisted.writable,
    realModelResponse: marker,
    restartPersistence: true,
    consoleErrors: 0,
  }))
} finally {
  if (!restored) {
    try { await rpc('credentials.set', { ref: 'DEEPSEEK_API_KEY', value: apiKey }) } catch { /* best effort */ }
  }
  await app.close()
}
