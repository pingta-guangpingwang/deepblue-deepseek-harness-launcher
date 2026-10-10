#!/usr/bin/env node

import { _electron as electron, chromium } from 'playwright'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import process from 'node:process'

const executablePath = process.env.QA_PUBLIC_LAUNCHER_EXE
const qaRoot = process.env.QA_PUBLIC_ROOT
const outputRoot = process.env.QA_PUBLIC_OUTPUT
const timeoutMs = Number(process.env.QA_PUBLIC_TIMEOUT_MS || 20 * 60 * 1_000)
if (!executablePath || !qaRoot || !outputRoot) throw new Error('Public install QA paths were not supplied')

const userDataRoot = path.join(qaRoot, 'electron-user-data')
const appDataRoot = path.join(qaRoot, 'appdata')
const localAppDataRoot = path.join(qaRoot, 'localappdata')
const storageRoot = path.join(qaRoot, 'fresh-storage')
const workspace = path.join(qaRoot, 'workspace')
const qaPort = await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      reject(new Error('Unable to reserve a free Harness QA port'))
      return
    }
    server.close((error) => error ? reject(error) : resolve(address.port))
  })
})
await Promise.all([userDataRoot, appDataRoot, localAppDataRoot, storageRoot, workspace, outputRoot].map((target) => mkdir(target, { recursive: true })))
await writeFile(path.join(userDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: {
    workspace,
    storageRoot,
    storageSetupCompleted: true,
    autoOpen: false,
    theme: 'dark',
    port: qaPort
  }
}, null, 2)}\n`, 'utf8')

const observedSources = new Set()
const observedProgress = []
const startedAt = Date.now()
const isolatedEnvironment = { ...process.env, APPDATA: appDataRoot, LOCALAPPDATA: localAppDataRoot, DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' }
for (const key of Object.keys(isolatedEnvironment)) if (/api.?key|access.?token|auth.?token|password|secret/i.test(key)) delete isolatedEnvironment[key]
delete isolatedEnvironment.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataRoot}`, '--disable-gpu'],
  env: isolatedEnvironment
})

let finalSnapshot
let page
let browser
let authenticatedBrowser = false
let localToken = ''
let unauthenticatedStatus
try {
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const startButton = page.getByRole('button', { name: '启动 DeepSeek Harness', exact: true })
  await startButton.waitFor({ state: 'visible', timeout: 60_000 })
  await page.screenshot({ path: path.join(outputRoot, 'public-fresh-install-ready.png') })
  await startButton.click()

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await page.evaluate(async () => window.launcher.getSnapshot())
    finalSnapshot = snapshot
    for (const task of snapshot.tasks) {
      for (const step of task.steps || []) if (step.source) observedSources.add(step.source)
    }
    const progressKey = `${snapshot.launchProgress.status}:${snapshot.launchProgress.progress}:${snapshot.launchProgress.message}`
    if (observedProgress.at(-1) !== progressKey) observedProgress.push(progressKey)
    if (snapshot.runStatus === 'running' && snapshot.serviceUrl) {
      const response = await fetch(snapshot.serviceUrl)
      unauthenticatedStatus = response.status
      if (snapshot.activeHarnessVersion === '0.2.1-alpha.2') {
        if (response.status !== 401) throw new Error('DSH 0.2 unauthenticated root must reject access')
        const auth = JSON.parse(await readFile(path.join(storageRoot, 'harness-data-v2/launcher/process-auth.json'), 'utf8'))
        if (auth.version !== snapshot.activeHarnessVersion || new URL(auth.url).origin !== snapshot.serviceUrl) throw new Error('Private process authentication did not match fresh DSH')
        localToken = new URL(auth.url).searchParams.get('token') || ''
        browser = await chromium.launch({ channel: 'msedge', headless: true })
        const web = await browser.newPage()
        await web.goto(auth.url, { waitUntil: 'domcontentloaded' })
        await web.locator('#root > *').waitFor({ state: 'visible', timeout: 30000 })
        const preview = web.getByRole('button', { name: '继续', exact: true })
        if (await preview.isVisible()) await preview.click()
        authenticatedBrowser = !new URL(web.url()).searchParams.has('token') && (await web.locator('body').innerText()).includes('新会话')
        if (!authenticatedBrowser) throw new Error('Authenticated public DSH browser did not render the workspace')
        await web.screenshot({ path: path.join(outputRoot, 'public-fresh-install-authenticated-dsh.png') })
      } else if (!response.ok) throw new Error(`Harness service returned HTTP ${response.status}`)
      break
    }
    if (snapshot.runStatus === 'error' || snapshot.launchProgress.status === 'failed') {
      throw new Error(snapshot.launchProgress.message || snapshot.logs.at(-1)?.message || 'Harness failed during public fresh-install QA')
    }
    await page.waitForTimeout(1_000)
  }

  if (!finalSnapshot?.serviceUrl || finalSnapshot.runStatus !== 'running') throw new Error(`Harness did not become ready within ${Math.round(timeoutMs / 60_000)} minutes`)
  if (finalSnapshot.launcherVersion !== '0.10.37' || finalSnapshot.activeHarnessVersion !== '0.2.1-alpha.2') throw new Error('Public release QA requires the exact 0.10.37 / DSH 0.2.1-alpha.2 candidate')
  const channels = finalSnapshot.settings.sources.filter(item => item.enabled && item.kind === 'manifest')
  if (channels.length !== 1 || channels[0].id !== 'runtime-v2-dsh02' || channels[0].baseUrl !== 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/dsh02/launcher-manifest.json') throw new Error('New kernel must use only the approved DSH 0.2 public catalog')
  if (!authenticatedBrowser) throw new Error('DSH 0.2 authenticated browser acceptance missing')
  const environment = Object.fromEntries(finalSnapshot.environment.map((item) => [item.id, { status: item.status, version: item.version, detail: item.detail }]))
  if (environment.node?.status !== 'ready' || environment.harness?.status !== 'ready') throw new Error('Fresh public install did not prepare both Node.js and Harness')
  await page.screenshot({ path: path.join(outputRoot, 'public-fresh-install-harness-running.png') })
  await page.evaluate(async () => window.launcher.stopHarness())
  const reportText = `${JSON.stringify({
    passed: true,
    testedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    qaRoot,
    storageRoot,
    launcherVersion: finalSnapshot.launcherVersion,
    harnessVersion: finalSnapshot.activeHarnessVersion,
    authenticatedBrowser,
    unauthenticatedStatus,
    sourceIds: finalSnapshot.settings.sources.filter(item => item.enabled && item.kind === 'manifest').map(item => item.id),
    requestedPort: qaPort,
    serviceUrl: finalSnapshot.serviceUrl,
    observedSources: [...observedSources],
    environment,
    observedProgress,
    finalLogs: finalSnapshot.logs.slice(-30)
  }, null, 2)}\n`
  if (localToken && reportText.includes(localToken)) throw new Error('Authentication secret entered the public-install report')
  await writeFile(path.join(outputRoot, 'public-fresh-install-report.json'), reportText, 'utf8')
} finally {
  if (finalSnapshot?.runStatus !== 'running') {
    await page?.screenshot({ path: path.join(outputRoot, 'public-fresh-install-failed.png') }).catch(() => undefined)
    await writeFile(path.join(outputRoot, 'public-fresh-install-failure.json'), `${JSON.stringify({
      passed: false,
      testedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      observedSources: [...observedSources],
      observedProgress,
      snapshot: finalSnapshot
    }, null, 2)}\n`, 'utf8').catch(() => undefined)
  }
  await app.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
}

process.stderr.write(`Public fresh-install QA passed in ${Math.round((Date.now() - startedAt) / 1_000)}s; sources: ${[...observedSources].join(', ') || 'cache-free signed catalog'}\n`)
