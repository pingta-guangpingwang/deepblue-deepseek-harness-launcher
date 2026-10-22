#!/usr/bin/env node
// Public 042 bootstrap -> new directory -> actual signed runtime -> local DSH.
// /QA suppresses registry/shortcut writes. No account, forum or model task runs.
import assert from 'node:assert/strict'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, VERSION, DSH_VERSION, SOURCE_ID, CHANNEL_KEY, ALIAS_KEY, publicUrl, sha, jsonBytes,
  releaseFile, trustedManifest, fileDigest, assertReusedUi } from './release-042-qa.mjs'
import { fetchReleaseArtifact } from './release-artifact-fetch.mjs'

const help = 'Usage: node scripts/qa-public-fresh-install-042.mjs [--preflight]\n' +
  'Requires EXPECTED_RELEASE_042_PLAN_SHA256 and frozen release-042 plan/signed RC2 candidate.\n' +
  'After the RC2 channel is public, downloads the immutable online installer and runs /S /QA in a new spaced output directory.\n' +
  'Optional QA_FRESH_042_OUTPUT, QA_FRESH_042_CHROME, QA_FRESH_042_TIMEOUT_MS (default 20 minutes).\n'
if (process.argv.includes('--help')) { process.stdout.write(help); process.exit(0) }
assert.ok(process.argv.slice(2).every(value => value === '--preflight'), help)
const planBytes = await readFile(await releaseFile('release-042-plan.json', 256 * 1024))
const planSha256 = sha(planBytes)
assert.equal(planSha256, process.env.EXPECTED_RELEASE_042_PLAN_SHA256, 'Supply the reviewed 042 plan SHA256')
const plan = JSON.parse(planBytes)
assert.equal(plan.version, VERSION)
assert.equal(plan.dshVersion, DSH_VERSION)
assert.deepEqual(plan.source, { id: SOURCE_ID, url: publicUrl(CHANNEL_KEY) })
assert.equal(plan.items.length, 4)
assert.deepEqual(plan.items.map(item => item.role).sort(), ['launcher-ui', 'offline', 'online', 'shell'])
assertReusedUi(plan.items.find(item => item.role === 'launcher-ui'))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(), plan.sourceCommit, 'Public QA must use frozen source')
const candidateBytes = await readFile(await releaseFile(plan.payloads.channel.signedFile, 256 * 1024))
const candidate = await trustedManifest(candidateBytes)
assert.equal(candidate.payload.launcher.version, VERSION)
assert.equal(sha(jsonBytes(candidate.payload)), plan.payloads.channel.sha256, 'Signed candidate differs from reviewed payload')
const online = plan.items.find(item => item.role === 'online')
const shell = plan.items.find(item => item.role === 'shell')
assert.equal(online.key, `download/deepblue-deepseek-harness-launcher-${VERSION}-win-x64-online.exe`)
const signedOnline = candidate.payload.launcher.artifacts.find(item => item.distribution === 'online')
assert.equal(signedOnline.url, publicUrl(ALIAS_KEY))
assert.equal(signedOnline.sha256, online.sha256)
assert.equal(signedOnline.size, online.size)
for (const id of ['node-runtime', 'harness-core', 'package-manager', 'agent-host']) {
  const module = candidate.payload.runtimeModules.find(item => item.id === id)
  assert.ok(module?.artifacts.some(item => item.platform === 'win32' && item.arch === 'x64'), `Signed module missing ${id}`)
}
assert.equal(candidate.payload.runtimeModules.find(item => item.id === 'harness-core').version, DSH_VERSION)
const chromeExecutable = path.resolve(process.env.QA_FRESH_042_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe')
await access(chromeExecutable)
const timeoutMs = Number(process.env.QA_FRESH_042_TIMEOUT_MS || 20 * 60_000)
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 30 * 60_000)
if (process.argv.includes('--preflight')) {
  process.stdout.write(JSON.stringify({ passed: true, preflightOnly: true, planSha256, sourceCommit: plan.sourceCommit,
    catalogSha256: sha(candidateBytes), installerUrl: publicUrl(online.key), installerSha256: online.sha256,
    installerBytes: online.size, chromeExecutable }, null, 2) + '\n')
  process.exit(0)
}
assert.equal(process.platform, 'win32', '042 public bootstrap QA targets Windows')
const { _electron: electron, chromium } = await import('playwright')
const outputBase = path.resolve(ROOT, process.env.QA_FRESH_042_OUTPUT || 'output/playwright/public-fresh-install-042')
const relativeOutput = path.relative(ROOT, outputBase)
assert.ok(!path.isAbsolute(relativeOutput) && /^output[\\/]/u.test(relativeOutput) && !relativeOutput.split(/[\\/]/u).includes('..'), 'Fresh QA output must stay below workspace output/')
await mkdir(outputBase, { recursive: true })
const qaRoot = await mkdtemp(path.join(outputBase, 'run-'))
const installRoot = path.join(qaRoot, 'Fresh install with spaces')
const userData = path.join(qaRoot, 'electron-user-data')
const appData = path.join(qaRoot, 'appdata')
const localAppData = path.join(qaRoot, 'localappdata')
const storage = path.join(qaRoot, 'fresh-storage')
const workspace = path.join(qaRoot, 'workspace')
const temporary = path.join(qaRoot, 'temporary')
const installerFile = path.join(qaRoot, online.file)
const report = { passed: false, testedAt: new Date().toISOString(), planSha256, sourceCommit: plan.sourceCommit,
  catalogUrl: publicUrl(CHANNEL_KEY), catalogSha256: sha(candidateBytes), qaRoot, installRoot,
  installerUrl: publicUrl(online.key), installerSha256: online.sha256, installerBytes: online.size,
  shellSha256: shell.sha256, sourceId: SOURCE_ID, installerQaMode: true, realPublicDownload: false,
  controlledBrowser: false, accountLoginPerformed: false, forumRequestsPerformed: false, modelRequestsPerformed: false,
  modules: {}, observedSources: [], observedProgress: [] }
const startedAt = Date.now()
let app, browser, page, lastSnapshot, localToken = '', serviceOrigin
const execute = promisify(execFile)
const observedSources = new Set()
function safeText(value) {
  let text = String(value)
  if (localToken) text = text.split(localToken).join('[redacted]')
  return text.replace(/([?&](?:token|auth_token)=)[^\s"&]+/giu, '$1[redacted]')
}
function safeValue(value) {
  if (typeof value === 'string') return safeText(value)
  if (Array.isArray(value)) return value.map(safeValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item)]))
  return value
}
async function exists(file) { return access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }) }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function poll(label, action, limit = timeoutMs) {
  const end = Date.now() + limit
  while (Date.now() < end) {
    const value = await action(); if (value) return value
    await delay(500)
  }
  throw new Error(`${label} timed out after ${Math.round(limit / 1000)} seconds`)
}
async function exactPublicGet(url, expected) {
  const result = await fetchReleaseArtifact(url, { maxBytes: expected.size, redirect: 'error', timeoutMs: 120000 })
  assert.ok([200, 206].includes(result.response.status), `Public object unavailable: ${url}`)
  assert.equal(result.bytes.length, expected.size, 'Public object size differs from the frozen plan')
  assert.equal(sha(result.bytes), expected.sha256, 'Public object SHA256 differs from the frozen plan')
  return result.bytes
}
async function installerExit(environment) {
  // /D is deliberately the final unquoted remainder of NSIS's command line.
  const child = spawn(installerFile, ['/S', '/QA', `/D=${installRoot}`], {
    env: environment, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore'
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref()
      reject(new Error('Public online installer exceeded its 5 minute deadline'))
    }, 5 * 60_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 && !signal ? resolve() : reject(new Error(`Public online installer exited ${code}/${signal || 'none'}`)) })
  })
}
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
function sample(snapshot) {
  lastSnapshot = snapshot
  for (const task of snapshot.tasks) for (const step of task.steps || []) if (step.source) observedSources.add(step.source)
  const progress = snapshot.launchProgress
  const label = safeText(`${progress.status}:${progress.progress}:${progress.message}`)
  if (report.observedProgress.at(-1) !== label) report.observedProgress.push(label)
}

try {
  assert.equal(await exists(installRoot), false)
  assert.equal(await exists(path.join(storage, 'runtime')), false)
  report.freshBeforeLaunch = { installRootAbsent: true, runtimeModulesAbsent: true, runtimeDownloadsAbsent: true }
  const publicCatalog = await exactPublicGet(publicUrl(CHANNEL_KEY), { size: candidateBytes.length, sha256: sha(candidateBytes) })
  await trustedManifest(publicCatalog)
  await writeFile(installerFile, await exactPublicGet(publicUrl(online.key), online), { flag: 'wx' })
  report.realPublicDownload = true
  await Promise.all([userData, appData, localAppData, storage, workspace, temporary].map(directory => mkdir(directory, { recursive: true })))
  const environment = { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: temporary, TMP: temporary,
    DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' }
  for (const key of Object.keys(environment)) if (/api.?key|access.?token|auth.?token|password|secret/iu.test(key)) delete environment[key]
  delete environment.ELECTRON_RUN_AS_NODE
  await installerExit(environment)
  const installedShell = path.join(installRoot, 'shells', VERSION)
  const executablePath = path.join(installedShell, '深蓝DeepSeekHarness启动器.exe')
  await access(executablePath)
  const appRoot = path.join(installedShell, 'resources', 'app')
  const packaged = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packaged.version, VERSION)
  for (const name of ['node', 'pnpm', '@deepseek-ai/dsh']) assert.equal(await exists(path.join(appRoot, 'node_modules', ...name.split('/'))), false, `Online shell unexpectedly bundles ${name}`)
  assert.deepEqual(await readdir(path.join(installRoot, 'shells')), [VERSION])
  assert.equal(await exists(path.join(storage, 'runtime')), false)
  report.emptyDirectoryInstall = true
  report.onlineShellContainsNoCoreRuntime = true
  const port = await freePort()
  await writeFile(path.join(userData, 'launcher.json'), jsonBytes({ settings: { workspace, storageRoot: storage,
    storageSetupCompleted: true, autoOpen: false, theme: 'dark', port }, activeVersion: DSH_VERSION, workspaces: [], resourceLibrary: [] }))
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`, '--disable-gpu'], env: environment })
  await app.evaluate(({ app }, expected) => { if (app.getPath('userData') !== expected) throw new Error('Public QA userData isolation failed') }, userData)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const start = page.getByRole('button', { name: '启动 DeepSeek Harness', exact: true })
  await start.waitFor({ state: 'visible', timeout: 60000 })
  const onboarding = page.locator('dialog.agent-setup-dialog[open]')
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '暂时不用', exact: true }).click()
  await page.screenshot({ path: path.join(qaRoot, 'public-042-shell-ready.png') })
  await start.click()
  const running = await poll('Fresh signed Node/Harness installation and startup', async () => {
    const snapshot = await page.evaluate(() => window.launcher.getSnapshot())
    sample(snapshot)
    if (snapshot.runStatus === 'error' || snapshot.launchProgress.status === 'failed') throw new Error(safeText(snapshot.launchProgress.message || 'Harness startup failed'))
    return snapshot.runStatus === 'running' && snapshot.serviceUrl ? snapshot : undefined
  })
  assert.equal(running.launcherVersion, VERSION)
  assert.equal(running.activeHarnessVersion, DSH_VERSION)
  const channels = running.settings.sources.filter(source => source.enabled && source.kind === 'manifest')
  assert.equal(channels.length, 1)
  assert.equal(channels[0].id, SOURCE_ID)
  assert.equal(channels[0].baseUrl, publicUrl(CHANNEL_KEY))
  serviceOrigin = new URL(running.serviceUrl).origin
  assert.equal(serviceOrigin, `http://127.0.0.1:${port}`)
  const unauthenticated = await fetch(serviceOrigin, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  report.unauthenticatedStatus = unauthenticated.status
  await unauthenticated.body?.cancel()
  assert.equal(unauthenticated.status, 401, 'DSH root must require local process authentication')
  const authFile = path.join(storage, 'harness-data-v2-rc2', 'launcher', 'process-auth.json')
  const authStat = await lstat(authFile)
  assert.ok(authStat.isFile() && !authStat.isSymbolicLink() && authStat.size <= 8192)
  const auth = JSON.parse(await readFile(authFile, 'utf8'))
  assert.equal(auth.version, DSH_VERSION)
  assert.equal(new URL(auth.url).origin, serviceOrigin)
  assert.equal(path.resolve(auth.cwd), workspace)
  localToken = new URL(auth.url).searchParams.get('token') || ''
  assert.ok(localToken.length > 0, 'Local process authentication token was not published')
  browser = await chromium.launch({ executablePath: chromeExecutable, headless: true, env: environment })
  const web = await browser.newPage()
  await web.goto(auth.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await web.locator('#root > *').waitFor({ state: 'visible', timeout: 30000 })
  const continueButton = web.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.isVisible()) await continueButton.click()
  await web.getByText('新会话', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 })
  assert.ok(!new URL(web.url()).searchParams.has('token'), 'Authentication must exchange the token for a local browser session')
  await web.screenshot({ path: path.join(qaRoot, 'public-042-controlled-dsh.png'), animations: 'disabled' })
  report.controlledBrowser = true
  await browser.close(); browser = undefined

  const runtime = path.join(storage, 'runtime')
  const state = JSON.parse(await readFile(path.join(runtime, 'modules', 'state.json'), 'utf8'))
  for (const id of ['node-runtime', 'harness-core', 'package-manager', 'agent-host']) {
    const module = candidate.payload.runtimeModules.find(item => item.id === id)
    const artifact = module.artifacts.find(item => item.platform === 'win32' && item.arch === 'x64')
    if (state.active?.[id] === module.version) {
      const receipt = JSON.parse(await readFile(path.join(runtime, 'modules', id, module.version, 'module-receipt.json'), 'utf8'))
      assert.equal(receipt.id, id); assert.equal(receipt.version, module.version); assert.equal(receipt.artifactSha256, artifact.sha256)
      assert.ok(Date.parse(receipt.installedAt) >= startedAt, 'Fresh runtime must not reuse a previous installation receipt')
      const archive = path.join(runtime, 'downloads', `${id}-${module.version}-${artifact.sha256}.tar.gz`)
      assert.deepEqual(await fileDigest(archive), { sha256: artifact.sha256, size: artifact.size })
      report.modules[id] = { version: module.version, activated: true, receipt, archiveSha256: artifact.sha256, archiveBytes: artifact.size, source: 'actual-launcher-public-install' }
    } else {
      assert.ok(!['node-runtime', 'harness-core'].includes(id), `Fresh Harness must activate the actual ${id} signed module`)
      const mirror = artifact.mirrors.find(item => item.id === 'oss')
      assert.ok(mirror, 'Use the signed immutable OSS archive for optional availability readback')
      await exactPublicGet(mirror.url, artifact)
      report.modules[id] = { version: module.version, activated: false, notActivated: true, publicArchiveVerified: true,
        archiveSha256: artifact.sha256, archiveBytes: artifact.size, source: id === 'agent-host' ? 'bundled-current-host' : 'optional-on-demand-not-installed' }
      if (id === 'agent-host') {
        const host = JSON.parse(await readFile(path.join(appRoot, 'out', 'agent-host', 'module.json'), 'utf8'))
        assert.equal(host.version, module.version)
        report.modules[id].bundledVersion = host.version
      }
    }
  }
  const nodeModule = candidate.payload.runtimeModules.find(item => item.id === 'node-runtime')
  const nodeExecutable = path.join(runtime, 'modules', 'node-runtime', nodeModule.version, 'bin', 'node.exe')
  const versionEnvironment = { ...environment, DSH_HOME: path.join(storage, 'harness-data-v2-rc2') }
  const nodeVersion = await execute(nodeExecutable, ['--version'], { env: versionEnvironment, windowsHide: true, timeout: 30000 })
  assert.equal(nodeVersion.stdout.trim(), `v${nodeModule.version}`)
  const coreExecutable = path.join(runtime, 'modules', 'harness-core', DSH_VERSION, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const coreVersion = await execute(nodeExecutable, [coreExecutable, '--version'], { env: versionEnvironment, windowsHide: true, timeout: 30000 })
  assert.ok(coreVersion.stdout.includes(DSH_VERSION), 'Actual downloaded Harness CLI version must match the signed RC2 module')
  report.actualVersions = { node: nodeModule.version, harness: DSH_VERSION }
  const packageManager = candidate.payload.runtimeModules.find(item => item.id === 'package-manager')
  if (report.modules['package-manager'].activated) {
    const pnpm = path.join(runtime, 'modules', 'package-manager', packageManager.version, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const result = await execute(nodeExecutable, [pnpm, '--version'], { env: versionEnvironment, windowsHide: true, timeout: 30000 })
    assert.equal(result.stdout.trim(), packageManager.version)
    report.actualVersions.pnpm = packageManager.version
  }
  await page.screenshot({ path: path.join(qaRoot, 'public-042-harness-running.png') })
  await page.evaluate(() => window.launcher.stopHarness())
  await poll('Harness shutdown', async () => (await page.evaluate(() => window.launcher.getSnapshot())).runStatus === 'stopped', 30000)
  assert.equal(await exists(authFile), false, 'Stopping the QA-owned Harness must clear its own process-auth marker')
  Object.assign(report, { passed: true, launcherVersion: VERSION, installedLauncherVersion: VERSION,
    harnessVersion: DSH_VERSION, installedDshVersion: DSH_VERSION, requestedPort: port, serviceOrigin,
    sourceIds: channels.map(source => source.id), environment: Object.fromEntries(running.environment.map(item => [item.id, { status: item.status, version: item.version }])),
    harnessStopped: true, processAuthMarkerCleared: true, emptyRuntimeCacheBeforeLaunch: true })
} catch (error) {
  report.failure = safeText(error instanceof Error ? error.stack : error)
  if (lastSnapshot) report.lastState = { launcherVersion: lastSnapshot.launcherVersion, harnessVersion: lastSnapshot.activeHarnessVersion,
    runStatus: lastSnapshot.runStatus, launchProgress: { status: lastSnapshot.launchProgress.status, progress: lastSnapshot.launchProgress.progress,
      message: safeText(lastSnapshot.launchProgress.message) } }
  await page?.screenshot({ path: path.join(qaRoot, 'public-042-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (page) await page.evaluate(() => window.launcher.stopHarness()).catch(() => {})
  await app?.close().catch(() => {})
  report.elapsedMs = Date.now() - startedAt
  report.observedSources = [...observedSources]
  const text = JSON.stringify(safeValue(report), null, 2) + '\n'
  assert.ok(!localToken || !text.includes(localToken), 'Authentication token cannot enter public QA evidence')
  await writeFile(path.join(qaRoot, 'public-fresh-install-report.json'), text)
  process.stdout.write(JSON.stringify({ passed: report.passed, report: path.join(qaRoot, 'public-fresh-install-report.json'), elapsedMs: report.elapsedMs,
    failure: report.failure }, null, 2) + '\n')
}
