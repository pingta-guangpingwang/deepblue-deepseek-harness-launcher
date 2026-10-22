#!/usr/bin/env node
// This runs the NEW 041 code in disposable profiles. The 039 getVersion fixture
// exercises upgrade detection; it does not claim that published 039 has this code.
// No real installer is executed here. Root owns full offline handoff/registry QA.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, RELEASE, VERSION, CHANNEL_KEY, SOURCE_ID, publicUrl, sha, jsonBytes,
  releaseFile, trustedManifest, replacementItem } from './release-041-qa.mjs'

const help = 'Usage: node scripts/qa-launcher-041-self-update.mjs [--mode=all|auto|interrupt] [--preflight]\n' +
  'Set EXPECTED_RELEASE_041_PLAN_SHA256 and optionally QA_LAUNCHER_EXE / QA_SELF_UPDATE_OUTPUT.\n' +
  'Requires release-041-plan.json, its signed RC2 candidate, and publicly downloadable planned artifacts.\n' +
  'Only auto-module/busy/prompt/interrupted-download/restart QA is covered; no installer handoff or account login.\n'
if (process.argv.includes('--help')) { process.stdout.write(help); process.exit(0) }
const modeArgument = process.argv.slice(2).find(value => value.startsWith('--mode=')) || '--mode=all'
const mode = modeArgument.slice('--mode='.length)
assert.ok(['all', 'auto', 'interrupt'].includes(mode), help)
assert.ok(process.argv.slice(2).every(value => value === modeArgument || value === '--preflight'), help)

const planBytes = await readFile(await releaseFile('release-041-plan.json', 256 * 1024))
const planSha256 = sha(planBytes)
assert.equal(planSha256, process.env.EXPECTED_RELEASE_041_PLAN_SHA256, 'Supply the reviewed 041 plan SHA256')
const plan = JSON.parse(planBytes)
assert.equal(plan.version, VERSION)
assert.equal(plan.source.id, SOURCE_ID)
assert.equal(plan.source.url, publicUrl(CHANNEL_KEY))
assert.equal(plan.items.length, 4)
assert.deepEqual(plan.items.map(item => item.role).sort(), ['launcher-ui', 'offline', 'online', 'shell'])
const manifestBytes = await readFile(await releaseFile(plan.payloads.channel.signedFile, 256 * 1024))
const candidate = await trustedManifest(manifestBytes)
assert.equal(candidate.payload.launcher.version, VERSION)
assert.equal(sha(jsonBytes(candidate.payload)), plan.payloads.channel.sha256, 'Signed candidate differs from reviewed payload')
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(), plan.sourceCommit, 'QA must use the frozen release source')
const uiModule = candidate.payload.runtimeModules.find(item => item.id === 'launcher-ui')
const uiArtifact = uiModule.artifacts.find(item => item.platform === 'win32' && item.arch === 'x64')
assert.deepEqual(replacementItem(uiModule), plan.items.find(item => item.role === 'launcher-ui'))
const offlineItem = plan.items.find(item => item.role === 'offline')
const offline = candidate.payload.launcher.artifacts.find(item => item.distribution === 'offline' && item.platform === 'win32' && item.arch === 'x64')
assert.equal(offline.url, publicUrl(offlineItem.key))
assert.equal(offline.sha256, offlineItem.sha256)
assert.equal(offline.size, offlineItem.size)
assert.ok(offline.size > 4096, 'Interruption QA requires the real complete installer')
const executablePath = path.resolve(process.env.QA_LAUNCHER_EXE || path.join(RELEASE, 'win-unpacked', '深蓝DeepSeekHarness启动器.exe'))
const executableRelative = path.relative(ROOT, executablePath)
assert.ok(!path.isAbsolute(executableRelative) && /^(?:release|output)[\\/]/u.test(executableRelative) && !executableRelative.split(/[\\/]/u).includes('..'), 'Use a candidate executable inside this workspace release/output tree')
await access(executablePath)
const packagedAppRoot = path.join(path.dirname(executablePath), 'resources', 'app')
const packaged = JSON.parse(await readFile(path.join(packagedAppRoot, 'package.json'), 'utf8'))
assert.equal(packaged.version, VERSION, 'Use the new 041 candidate executable, never an installed 039 binary')
await access(path.join(packagedAppRoot, 'out', 'renderer', 'index.html'))
if (process.argv.includes('--preflight')) {
  process.stdout.write(JSON.stringify({ passed: true, preflightOnly: true, mode, planSha256, sourceCommit: plan.sourceCommit,
    catalogSha256: sha(manifestBytes), executablePath, uiVersion: uiModule.version, offlineSha256: offline.sha256 }, null, 2) + '\n')
  process.exit(0)
}
assert.equal(process.platform, 'win32', 'This 041 packaged update gate targets Windows')
const { _electron: electron } = await import('playwright')
const outputBase = path.resolve(ROOT, process.env.QA_SELF_UPDATE_OUTPUT || 'output/playwright/self-update-041')
const outputRelative = path.relative(ROOT, outputBase)
assert.ok(!path.isAbsolute(outputRelative) && /^output[\\/]/u.test(outputRelative) && !outputRelative.split(/[\\/]/u).includes('..'), 'Disposable QA output must stay below workspace output/')
await mkdir(outputBase, { recursive: true })
const outputRoot = await mkdtemp(path.join(outputBase, 'run-'))
const report = { passed: false, mode, testedAt: new Date().toISOString(), planSha256, sourceCommit: plan.sourceCommit,
  catalogSha256: sha(manifestBytes), executablePath, outputRoot,
  scope: '041 candidate code, actual signed candidate, real public module bytes, interrupted real installer download; no installer execution',
  fixtures: { manifest: 'Exact production-signed local candidate bytes injected only at the fixed RC2 HTTPS catalog URL',
    oldUi: 'Current 041 renderer under a synthetic prior UI version to exercise activation',
    busyState: 'Normal setInterfaceBusy IPC with a synthetic active-operation label; no actual Harness task is started',
    kernelVersion: 'app.getVersion is overridden to 0.10.39 only in the interruption/restart scenarios; code remains 041' },
  actualInstallerHandoffTested: false, scenarios: {} }
const OLD_UI = 'ui-0000000000000041'
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function poll(label, action, timeout = 120000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result } catch (error) { lastError = error }
    await delay(300)
  }
  throw new Error(`${label} timed out${lastError ? ': ' + lastError.message : ''}`)
}

async function seedProfile(name, oldUi = false) {
  const profileRoot = path.join(outputRoot, name)
  const profile = { profileRoot, userData: path.join(profileRoot, 'electron-user-data'), appData: path.join(profileRoot, 'appdata'),
    localAppData: path.join(profileRoot, 'localappdata'), storage: path.join(profileRoot, 'storage'), desktop: path.join(profileRoot, 'desktop') }
  await Promise.all(Object.values(profile).map(directory => mkdir(directory, { recursive: true })))
  await mkdir(path.join(profile.storage, 'workspace'), { recursive: true })
  const sources = [
    { id: SOURCE_ID, name: '041 signed candidate QA', enabled: true, kind: 'manifest', baseUrl: publicUrl(CHANNEL_KEY) },
    ...['gitee', 'github', 'npmmirror'].map(id => ({ id, enabled: false, baseUrl: id === 'npmmirror' ? 'https://registry.npmmirror.com' : `https://${id}.com/` }))
  ]
  await writeFile(path.join(profile.userData, 'launcher.json'), jsonBytes({ settings: { storageRoot: profile.storage,
    storageSetupCompleted: true, autoOpen: false, theme: 'dark', port: 32894, workspace: path.join(profile.storage, 'workspace'), sources },
    activeVersion: '0.2.1-rc.2', workspaces: [], resourceLibrary: [] }))
  await writeFile(path.join(profile.storage, 'qa-preserved-user-data.txt'), 'isolated 041 update preservation marker\n')
  if (oldUi) {
    const moduleRoot = path.join(profile.storage, 'runtime', 'modules', 'launcher-ui', OLD_UI)
    await mkdir(moduleRoot, { recursive: true })
    await cp(path.join(packagedAppRoot, 'out', 'renderer'), path.join(moduleRoot, 'renderer'), { recursive: true })
    await writeFile(path.join(profile.storage, 'runtime', 'modules', 'state.json'), jsonBytes({ schemaVersion: 1,
      active: { 'launcher-ui': OLD_UI }, previous: {}, installed: { 'launcher-ui': [OLD_UI] } }))
  }
  return profile
}

async function checkProfile(profile) {
  assert.equal(await readFile(path.join(profile.storage, 'qa-preserved-user-data.txt'), 'utf8'), 'isolated 041 update preservation marker\n')
  const config = JSON.parse(await readFile(path.join(profile.userData, 'launcher.json'), 'utf8'))
  assert.equal(config.settings.storageRoot, profile.storage)
  assert.equal(config.settings.theme, 'dark')
  assert.equal(config.settings.workspace, path.join(profile.storage, 'workspace'))
  assert.equal(config.settings.autoOpen, false)
  return { storageRoot: config.settings.storageRoot, theme: config.settings.theme, markerUnchanged: true }
}

async function closeOnboarding(page) {
  const dialog = page.locator('dialog.agent-setup-dialog[open]')
  if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: '暂时不用' }).click()
}

async function launch(profile, interrupt = false) {
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile.userData}`, '--disable-gpu'],
    env: { ...process.env, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData,
      DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' } })
  const diagnostics = []
  app.process().stderr?.on('data', data => diagnostics.push(String(data).slice(0, 2000)))
  try {
    // Install before firstWindow: normal initialization source checks remain active.
    await app.evaluate(async ({ app, shell }, input) => {
      if (app.getPath('userData') !== input.userData) throw new Error('QA userData isolation failed')
      if (app.getVersion() !== input.version) throw new Error('QA requires new 041 code')
      app.setPath('desktop', input.desktop)
      const nativeFetch = globalThis.fetch
      let releaseCatalog
      const catalogGate = new Promise(resolve => { releaseCatalog = resolve })
      const state = { catalogRequests: 0, catalogReleased: false, artifactRequests: [], interruptedBytes: 0, blockedInstallerExecutions: 0 }
      globalThis.__launcher041UpdateQa = state
      globalThis.__launcher041ReleaseCatalog = () => { state.catalogReleased = true; releaseCatalog() }
      if (input.interrupt) {
        app.getVersion = () => '0.10.39'
        const originalOpenPath = shell.openPath
        shell.openPath = async target => {
          if (String(target).toLowerCase().endsWith(input.offline.sha256 + '.exe')) { state.blockedInstallerExecutions++; throw new Error('QA never executes an installer') }
          return originalOpenPath(target)
        }
        const childProcess = process.getBuiltinModule('node:child_process')
        const originalSpawn = childProcess.spawn
        childProcess.spawn = function(target, ...args) {
          if (String(target).toLowerCase().endsWith(input.offline.sha256 + '.exe')) { state.blockedInstallerExecutions++; throw new Error('QA never spawns an installer') }
          return originalSpawn.call(this, target, ...args)
        }
        const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
        syncBuiltinESMExports()
      }
      globalThis.fetch = async (request, init) => {
        const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
        if (url === input.catalogUrl) {
          state.catalogRequests++
          // Hold only this fixture response until the UI can report its busy
          // state, avoiding a fast startup winning the 1.5 second idle timer.
          await catalogGate
          return new Response(input.manifest, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        const owner = input.artifactOwners[url]
        if (owner) state.artifactRequests.push({ owner, url, method: init?.method || 'GET' })
        if (url === input.offline.url && input.interrupt) {
          state.artifactRequests.push({ owner: 'offline-installer', url, method: init?.method || 'GET' })
          const response = await nativeFetch(request, init)
          if (!response.ok || !response.body) throw new Error(`Real public offline artifact returned HTTP ${response.status}`)
          const reader = response.body.getReader()
          const first = await reader.read()
          if (first.done || !first.value?.length) throw new Error('No actual public installer bytes received')
          const bytes = first.value.subarray(0, Math.min(first.value.length, 64 * 1024, input.offline.size - 1))
          state.interruptedBytes += bytes.length
          const stream = new ReadableStream({ start(controller) {
            controller.enqueue(bytes)
            setTimeout(() => { void reader.cancel().catch(() => {}); controller.error(new Error('Intentional QA transport interruption after real public bytes')) }, 100)
          }, cancel() { return reader.cancel() } })
          return new Response(stream, { status: response.status, headers: response.headers })
        }
        return nativeFetch(request, init)
      }
    }, { userData: profile.userData, desktop: profile.desktop, version: VERSION, interrupt,
      catalogUrl: publicUrl(CHANNEL_KEY), manifest: manifestBytes.toString('utf8'), offline,
      artifactOwners: Object.fromEntries(candidate.payload.runtimeModules.flatMap(module => module.artifacts.flatMap(artifact =>
        artifact.mirrors.flatMap(mirror => [[mirror.url, module.id], ...(mirror.parts || []).map(part => [part.url, module.id])])))) })
    let page = await app.firstWindow()
    const currentPage = () => app.windows().find(target => target.url().startsWith('file:') && !target.url().includes('conversation=')) || page
    const snapshot = async () => { page = currentPage(); return page.evaluate(() => window.launcher?.getSnapshot()) }
    await poll('launcher API', async () => (await snapshot())?.launcherVersion)
    // Preload IPC becomes callable before React's initial busy effect settles.
    // Set synthetic busy only after the real home UI and first paints exist.
    await currentPage().locator('#root > *').waitFor({ state: 'visible', timeout: 60000 })
    await currentPage().getByRole('button', { name: '启动 DeepSeek Harness', exact: true }).waitFor({ state: 'visible', timeout: 60000 })
    await currentPage().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))))
    await closeOnboarding(currentPage())
    await delay(500)
    const events = []
    page.on('pageerror', error => events.push(error.message))
    const state = () => app.evaluate(() => structuredClone(globalThis.__launcher041UpdateQa))
    return { app, profile, snapshot, state, page: currentPage, events, diagnostics, kernelPid: app.process().pid,
      releaseCatalog: () => app.evaluate(() => globalThis.__launcher041ReleaseCatalog()),
      close: () => app.close().catch(() => {}) }
  } catch (error) { await app.close().catch(() => {}); throw error }
}

async function automaticUi() {
  const profile = await seedProfile('auto', true)
  const session = await launch(profile)
  try {
    await session.page().evaluate(() => window.launcher.setInterfaceBusy('qa-active-work'))
    const initial = await session.snapshot()
    assert.equal(initial.launcherUiVersion, OLD_UI, 'Fixture must still be active before source discovery')
    await session.releaseCatalog()
    const available = await poll('signed UI update detection', async () => {
      const snapshot = await session.snapshot()
      return snapshot?.runtimeUpdates.status === 'available' ? snapshot : undefined
    })
    assert.equal(available.launcherUpdate, undefined, '041 UI-only phase must not offer a kernel update')
    assert.deepEqual(available.runtimeUpdates.items.map(item => item.id), ['launcher-ui'])
    assert.ok((await session.state()).catalogRequests > 0, 'Normal startup must fetch the signed catalog')
    const holdDeadline = Date.now() + 17000
    while (Date.now() < holdDeadline) {
      assert.equal((await session.snapshot()).launcherUiVersion, OLD_UI, 'Busy work must defer automatic UI activation')
      assert.equal((await session.state()).artifactRequests.filter(item => item.owner === 'launcher-ui' && item.method === 'GET').length, 0, 'Busy work must defer the download')
      await delay(500)
    }
    await session.page().screenshot({ path: path.join(outputRoot, 'auto-busy-deferred.png') })
    await session.page().evaluate(() => window.launcher.setInterfaceBusy(''))
    const final = await poll('automatic UI hot activation without clicking update', async () => {
      const snapshot = await session.snapshot()
      return snapshot?.launcherUiVersion === uiModule.version && snapshot.runtimeUpdates.status === 'idle' ? snapshot : undefined
    })
    assert.equal(session.app.process().pid, session.kernelPid)
    assert.equal(final.runStatus, 'stopped')
    const state = JSON.parse(await readFile(path.join(profile.storage, 'runtime/modules/state.json'), 'utf8'))
    assert.equal(state.active['launcher-ui'], uiModule.version)
    assert.equal(state.previous['launcher-ui'], OLD_UI)
    assert.deepEqual(Object.keys(state.active), ['launcher-ui'])
    const receipt = JSON.parse(await readFile(path.join(profile.storage, 'runtime/modules/launcher-ui', uiModule.version, 'module-receipt.json'), 'utf8'))
    assert.equal(receipt.artifactSha256, uiArtifact.sha256)
    const transport = await session.state()
    assert.ok(transport.artifactRequests.some(item => item.owner === 'launcher-ui' && item.method === 'GET'), 'The UI archive must come from a real public download')
    assert.ok(!transport.artifactRequests.some(item => item.owner !== 'launcher-ui' && item.method === 'GET'), 'Unchanged core/runtime modules must not be downloaded')
    await session.page().screenshot({ path: path.join(outputRoot, 'auto-ui-applied.png') })
    return { passed: true, automaticModules: true, busyDeferral: true, kernelPidUnchanged: true, kernelPid: session.kernelPid,
      oldUiVersion: OLD_UI, installedUiVersion: final.launcherUiVersion, receipt, transport, profile: await checkProfile(profile) }
  } catch (error) {
    report.failureDiagnostics = { stage: 'auto', pageErrors: session.events, main: session.diagnostics.slice(-20), transport: await session.state().catch(() => undefined) }
    await session.page().screenshot({ path: path.join(outputRoot, 'auto-failure.png') }).catch(() => {})
    throw error
  }
  finally { await session.close() }
}

async function interruptedKernel() {
  const profile = await seedProfile('interruption')
  const first = await launch(profile, true)
  let interruption
  try {
    await first.releaseCatalog()
    const offered = await poll('proactive kernel popup', async () => {
      const snapshot = await first.snapshot()
      return snapshot?.launcherUpdate?.version === VERSION ? snapshot : undefined
    })
    assert.equal(offered.launcherUpdate.artifact.distribution, 'offline')
    assert.equal(offered.launcherUpdate.artifact.sha256, offline.sha256)
    const dialog = first.page().getByRole('dialog', { name: '检测到可处理的更新' })
    await dialog.waitFor({ state: 'visible', timeout: 15000 })
    await closeOnboarding(first.page())
    await first.page().screenshot({ path: path.join(outputRoot, 'kernel-proactive-prompt.png') })
    await dialog.getByRole('button', { name: /下载并安装新版本/u }).click()
    const failed = await poll('interrupted download reports failure without exiting', async () => {
      const snapshot = await first.snapshot()
      return snapshot?.tasks.find(task => task.title.startsWith('下载启动器') && task.status === 'failed')
    })
    const transport = await first.state()
    assert.ok(transport.interruptedBytes > 0 && transport.interruptedBytes < offline.size)
    assert.equal(transport.blockedInstallerExecutions, 0, 'An interrupted download must not even attempt installer execution')
    assert.equal(first.app.process().exitCode, null, 'Failed download must leave the same process usable')
    assert.equal((await first.snapshot()).runStatus, 'stopped')
    assert.match(failed.detail, /重试|下次启动/u)
    const updates = await readdir(path.join(profile.userData, 'updates'))
    assert.ok(!updates.some(name => name.endsWith('.exe') || name.endsWith('.download')), 'Incomplete installer must not become a cache hit')
    await first.page().screenshot({ path: path.join(outputRoot, 'kernel-download-interrupted.png') })
    interruption = { sameProcessRemainedAvailable: true, failedTask: { title: failed.title, detail: failed.detail, receivedBytes: failed.receivedBytes }, transport }
  } catch (error) {
    report.failureDiagnostics = { stage: 'interruption', pageErrors: first.events, main: first.diagnostics.slice(-20), transport: await first.state().catch(() => undefined) }
    await first.page().screenshot({ path: path.join(outputRoot, 'kernel-interruption-failure.png') }).catch(() => {})
    throw error
  } finally { await first.close() }
  const second = await launch(profile, true)
  try {
    await second.releaseCatalog()
    assert.notEqual(second.kernelPid, first.kernelPid)
    const offered = await poll('next startup detects the same pending kernel update', async () => {
      const snapshot = await second.snapshot()
      return snapshot?.launcherUpdate?.version === VERSION ? snapshot : undefined
    })
    assert.equal(offered.launcherUpdate.artifact.sha256, offline.sha256)
    await second.page().getByRole('dialog', { name: '检测到可处理的更新' }).waitFor({ state: 'visible', timeout: 15000 })
    const transport = await second.state()
    assert.ok(transport.catalogRequests > 0, 'Restart must perform its normal signed source check')
    assert.equal(transport.interruptedBytes, 0, 'A kernel download requires a new user confirmation')
    assert.equal(transport.blockedInstallerExecutions, 0)
    await second.page().screenshot({ path: path.join(outputRoot, 'kernel-next-startup-prompt.png') })
    return { passed: true, proactivePrompt: true, interruptedRetry: true, installerDistribution: 'offline',
      installerSha256: offline.sha256, installerSize: offline.size, interruption, restart: { firstPid: first.kernelPid,
        secondPid: second.kernelPid, automaticallyPrompted: true, transport }, profile: await checkProfile(profile) }
  } catch (error) {
    report.failureDiagnostics = { stage: 'restart', pageErrors: second.events, main: second.diagnostics.slice(-20), transport: await second.state().catch(() => undefined) }
    await second.page().screenshot({ path: path.join(outputRoot, 'kernel-restart-failure.png') }).catch(() => {})
    throw error
  } finally { await second.close() }
}

try {
  if (mode !== 'interrupt') report.scenarios.automaticUi = await automaticUi()
  if (mode !== 'auto') report.scenarios.interruptedKernel = await interruptedKernel()
  report.passed = Object.values(report.scenarios).every(scenario => scenario.passed)
  report.finishedAt = new Date().toISOString()
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  await writeFile(path.join(outputRoot, 'report.json'), jsonBytes(report))
  process.stdout.write(JSON.stringify({ passed: report.passed, report: path.join(outputRoot, 'report.json'), mode,
    actualInstallerHandoffTested: false, failure: report.failure }, null, 2) + '\n')
}
