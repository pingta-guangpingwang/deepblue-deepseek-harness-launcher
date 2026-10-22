#!/usr/bin/env node
// Run through run-qa-launcher-041-installer-handoff.ps1. This gate executes a
// real installer; the wrapper protects the exact host registration/shortcuts.
import assert from 'node:assert/strict'
import { createHash, verify } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const runFile = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const planPath = path.resolve(process.env.QA_HANDOFF_PLAN || path.join(root, 'release/release-041-plan.json'))
const manifestPath = path.resolve(process.env.QA_HANDOFF_MANIFEST || path.join(root, 'release/launcher-manifest.041.dsh02.json'))
const expectedPlanSha = process.env.EXPECTED_RELEASE_041_PLAN_SHA256 || ''
assert.match(expectedPlanSha, /^[a-f0-9]{64}$/u, 'Supply the reviewed release plan SHA-256')
const planBytes = await readFile(planPath)
assert.equal(sha(planBytes), expectedPlanSha, 'Reviewed release plan changed')
const plan = JSON.parse(planBytes)
assert.equal(plan.version, '0.10.41')
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes)
const publicKey = await readFile(path.join(root, 'resources/runtime-update-public-key.pem'))
assert.equal(manifest.algorithm, 'ed25519')
assert.equal(verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64')), true, 'Catalog signature failed')
assert.equal(sha(jsonBytes(manifest.payload)), plan.payloads.channel.sha256, 'Signed catalog differs from the frozen plan')
assert.equal(manifest.payload.launcher.version, '0.10.41')
const offline = manifest.payload.launcher.artifacts.find(item => item.platform === 'win32' && item.arch === 'x64' && item.distribution === 'offline')
const plannedOffline = plan.items.find(item => item.role === 'offline')
assert.ok(offline && plannedOffline, 'The signed plan must contain the complete offline installer')
assert.deepEqual({ sha256: offline.sha256, size: offline.size }, { sha256: plannedOffline.sha256, size: plannedOffline.size })
assert.equal(offline.url, `https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/${plannedOffline.key}`)
assert.match(offline.sha256, /^[a-f0-9]{64}$/u)
assert.ok(Number.isSafeInteger(offline.size) && offline.size > 0)
const sourceRoot = path.resolve(process.env.QA_HANDOFF_SOURCE || path.join(root, 'release/win-unpacked'))
const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, 'resources/app/package.json'), 'utf8'))
assert.equal(sourcePackage.version, '0.10.41')
const executable = '深蓝DeepSeekHarness启动器.exe'
assert.ok((await stat(path.join(sourceRoot, executable))).isFile())
if (process.argv.includes('--preflight')) {
  console.log(JSON.stringify({ passed: true, preflightOnly: true, planSha256: expectedPlanSha, manifestSha256: sha(manifestBytes), offline }))
  process.exit(0)
}
assert.equal(process.platform, 'win32')
assert.equal(process.env.QA_HANDOFF_HOST_BACKUP_READY, '1', 'Use the PowerShell backup/restore wrapper')
const output = path.resolve(process.env.QA_HANDOFF_OUTPUT || '')
const outputParent = path.join(root, 'output/qa-041-handoff')
const relativeOutput = path.relative(outputParent, output)
assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), 'QA output must be a dedicated directory inside output/qa-041-handoff')
const installRoot = path.join(output, 'install with spaces')
const oldShell = path.join(installRoot, 'shells/0.10.39')
const newShell = path.join(installRoot, 'shells/0.10.41')
const oldExe = path.join(oldShell, executable)
const newExe = path.join(newShell, executable)
const alternateExe = path.join(output, 'safe alternate installer default/shells/0.10.41', executable)
const ownedExecutables = [oldExe, newExe, alternateExe]
const qaHome = path.join(output, 'profile/home')
const appData = path.join(qaHome, 'AppData/Roaming')
const localAppData = path.join(qaHome, 'AppData/Local')
const userData = path.join(appData, 'deepseek-harness-launcher')
assert.ok(path.join(userData, 'updates', `${offline.sha256}.exe`).length < 260, 'Use a short unique QA output directory so the native installer cache path stays below MAX_PATH')
const storageRoot = path.join(installRoot, 'custom storage/DeepBlueHarnessData')
const profileFile = path.join(userData, 'launcher.json')
const sentinel = path.join(storageRoot, 'preserve-user-data.sentinel')
const sentinelBytes = Buffer.from('041 installer handoff: nested custom storage must survive\n')
const hookLog = path.join(output, 'main-process-hooks.json')
await mkdir(installRoot, { recursive: false })
await Promise.all([userData, localAppData, storageRoot, path.dirname(oldShell), path.join(output, 'profile/redirected-desktop'), path.join(qaHome, 'Desktop'), path.join(qaHome, 'Documents'), path.join(localAppData, 'Temp'), path.join(appData, 'Microsoft/Windows/Start Menu/Programs')].map(folder => mkdir(folder, { recursive: true })))
await cp(sourceRoot, oldShell, { recursive: true, errorOnExist: true, force: false })
await writeFile(profileFile, jsonBytes({ settings: { workspace: path.join(output, 'workspace'), storageRoot, storageSetupCompleted: true, autoOpen: false, theme: 'dark' } }))
await mkdir(path.join(output, 'workspace'))
await writeFile(sentinel, sentinelBytes)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|access.?token|auth.?token|password|secret|^(APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/iu.test(key)))
Object.assign(env, { USERPROFILE: qaHome, HOMEDRIVE: qaHome.slice(0, 2), HOMEPATH: qaHome.slice(2), TEMP: path.join(localAppData, 'Temp'), TMP: path.join(localAppData, 'Temp'), APPDATA: appData, LOCALAPPDATA: localAppData, DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' })
const report = { passed: false, testedAt: new Date().toISOString(), output, installRoot, oldExe, newExe, userData, storageRoot, planSha256: expectedPlanSha, manifestSha256: sha(manifestBytes), offline }
// A pure copied-package probe executes before any Launcher module can load.
// It restores the copied package.json byte-for-byte before the real QA launch.
const probePackageFile = path.join(oldShell, 'resources/app/package.json')
const originalProbePackage = await readFile(probePackageFile)
const probeOutput = path.join(output, 'pre-business-profile-proof.json')
const probeEntry = path.join(oldShell, 'resources/app/__qa_profile_probe.cjs')
const probeCode = "const {app}=require('electron');const fs=require('node:fs');const result={pid:process.pid,isPackaged:app.isPackaged,appData:app.getPath('appData'),userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),desktop:app.getPath('desktop'),documents:app.getPath('documents')};fs.writeFileSync("+JSON.stringify(probeOutput)+",JSON.stringify(result,null,2));app.exit(0);"
try {
  await writeFile(probeEntry, probeCode, { flag: 'wx' })
  await writeFile(probePackageFile, jsonBytes({ ...JSON.parse(originalProbePackage), main: '__qa_profile_probe.cjs' }))
  await new Promise((resolve, reject) => {
    const probe = spawn(oldExe, [], { env, windowsHide: true, stdio: 'ignore' })
    const timeout = setTimeout(() => { probe.kill(); reject(new Error('Pure profile probe timed out; business launch blocked')) }, 30000)
    probe.once('error', error => { clearTimeout(timeout); reject(error) })
    probe.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Pure profile probe failed: '+code)) })
  })
  const proof = JSON.parse(await readFile(probeOutput, 'utf8'))
  assert.equal(proof.isPackaged, true)
  for (const [key, expected] of Object.entries({ appData, userData, sessionData: userData, desktop: path.join(qaHome, 'Desktop'), documents: path.join(qaHome, 'Documents') })) assert.equal(path.resolve(proof[key]).toLowerCase(), path.resolve(expected).toLowerCase(), 'Unsafe KnownFolder '+key+'; business launch blocked')
  report.profileIsolation = { passed: true, mechanism: 'USERPROFILE and matching APPDATA/LOCALAPPDATA inherited by native installer; no NODE_OPTIONS, no product edits', proof }
} finally {
  await writeFile(probePackageFile, originalProbePackage)
  assert.equal(sha(await readFile(probePackageFile)), sha(originalProbePackage))
}
let app, oldPid
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'"
async function powershell(script) {
  const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
async function ownedProcesses() {
  const result = await powershell(`$paths=@(${ownedExecutables.map(psLiteral).join(',')}); $items=@(Get-CimInstance Win32_Process | Where-Object { $paths -contains $_.ExecutablePath } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine); ConvertTo-Json -InputObject $items -Compress`)
  return result ? JSON.parse(result) : []
}
async function until(label, action, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)) }
  throw new Error(`Timed out: ${label}`)
}
async function digestFile(file) {
  const hasher = createHash('sha256')
  for await (const chunk of createReadStream(file)) hasher.update(chunk)
  return { sha256: hasher.digest('hex'), size: (await stat(file)).size }
}
try {
  app = await electron.launch({ executablePath: oldExe, args: ['--disable-gpu'], env })
  const page = await app.firstWindow()
  await page.locator('#root > *').waitFor({ timeout: 90000 })
  const paths = await app.evaluate(({ app }) => ({ pid: process.pid, execPath: process.execPath, userData: app.getPath('userData'), appData: app.getPath('appData'), version: app.getVersion() }))
  oldPid = paths.pid
  assert.equal(path.resolve(paths.execPath).toLowerCase(), oldExe.toLowerCase())
  assert.equal(path.resolve(paths.userData).toLowerCase(), userData.toLowerCase(), 'Default profile must use isolated APPDATA; no --user-data-dir may be supplied')
  report.initialProcess = paths
  await app.evaluate(async ({ app, shell }, fixture) => {
    const { createRequire, syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const require = createRequire(process.execPath)
    const fs = require('node:fs')
    const childProcess = require('node:child_process')
    const nativeSpawn = childProcess.spawn
    const nativeFetch = globalThis.fetch
    const state = globalThis.__qaHandoff = { artifactGets: 0, manifestGets: 0, spawns: [], external: [], gateWaiting: false }
    const persist = () => fs.writeFileSync(fixture.hookLog, JSON.stringify(state, null, 2) + '\n')
    app.getVersion = () => '0.10.39'
    app.setPath('desktop', fixture.redirectedDesktop)
    shell.openExternal = async url => { state.external.push(url); persist(); throw new Error('An updater must not launch an external browser') }
    childProcess.spawn = function (file, args, options) {
      if (String(file).toLowerCase().endsWith(fixture.cacheName.toLowerCase())) {
        state.spawns.push({ file, args, options, parentPid: process.pid }); persist()
      }
      return nativeSpawn.apply(this, arguments)
    }
    syncBuiltinESMExports()
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url || String(input)
      if (url === fixture.catalogUrl) { state.manifestGets++; persist(); return new Response(Buffer.from(fixture.manifestBase64, 'base64'), { status: 200, headers: { 'content-type': 'application/json' } }) }
      if (url === fixture.artifactUrl) {
        state.artifactGets++; persist()
        if (state.artifactGets === 1) { state.gateWaiting = true; persist(); await new Promise(resolve => { globalThis.__qaReleaseDownload = resolve }); state.gateWaiting = false; persist() }
      }
      return nativeFetch(input, init)
    }
    persist()
  }, { catalogUrl: plan.source.url, manifestBase64: manifestBytes.toString('base64'), artifactUrl: offline.url, cacheName: `${offline.sha256}.exe`, hookLog, redirectedDesktop: path.join(output, 'profile/redirected-desktop') })
  const onboarding = page.getByRole('button', { name: '暂时不用', exact: true })
  if (await onboarding.isVisible()) await onboarding.click()
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.evaluate(() => window.launcher.checkSources())
    const snapshot = await page.evaluate(() => window.launcher.getSnapshot())
    if (snapshot.launcherUpdate?.version === '0.10.41') break
    if (attempt === 3) throw new Error('Signed candidate did not produce the proactive update prompt')
  }
  const dialog = page.getByRole('dialog', { name: /检测到可处理的更新|部分更新未完成/u })
  await dialog.waitFor({ timeout: 30000 })
  const updateButton = () => page.getByRole('button', { name: /^下载并安装新版本/u })
  await updateButton().click()
  await until('first artifact fetch waiting at the gate', () => app.evaluate(() => globalThis.__qaHandoff.gateWaiting))
  // The real fetch is paused until the interface reports busy. This guarantees
  // that even a very fast local mirror cannot outrun the final busy guard.
  await page.waitForTimeout(100)
  await page.evaluate(() => window.launcher.setInterfaceBusy('qa-block-installer'))
  await app.evaluate(() => globalThis.__qaReleaseDownload())
  console.log(JSON.stringify({ phase: 'real-complete-offline-download', bytes: offline.size, oldPid }))
  const deferred = await until('verified download deferred by active work', async () => {
    const snapshot = await page.evaluate(() => window.launcher.getSnapshot())
    const task = snapshot.tasks.find(item => item.title.startsWith('下载启动器'))
    return task?.status === 'failed' ? { snapshot, task } : undefined
  }, 30 * 60 * 1000)
  assert.match(deferred.task.detail, /已校验并缓存|无需重新下载/u)
  assert.equal(await app.evaluate(() => process.pid), oldPid, 'Busy deferral must preserve the old launcher')
  const cachedPath = path.join(userData, 'updates', `${offline.sha256}.exe`)
  assert.deepEqual(await digestFile(cachedPath), { sha256: offline.sha256, size: offline.size })
  const firstHooks = await app.evaluate(() => ({ ...globalThis.__qaHandoff }))
  assert.equal(firstHooks.artifactGets, 1)
  assert.equal(firstHooks.spawns.length, 0)
  report.downloadAndDeferral = { passed: true, task: deferred.task, cachedPath, artifactGets: firstHooks.artifactGets, oldProcessStillAlive: true }
  await page.screenshot({ path: path.join(output, 'verified-download-deferred.png') })
  await page.evaluate(() => window.launcher.setInterfaceBusy(''))
  await until('download button available for cache retry', () => updateButton().isEnabled())
  const beforeRestart = JSON.parse(await readFile(profileFile, 'utf8'))
  const profileWrittenBefore = (await stat(profileFile)).mtimeMs
  const closed = app.waitForEvent('close', { timeout: 120000 })
  await updateButton().click().catch(error => { if (!/closed|destroyed/iu.test(String(error))) throw error })
  await closed
  console.log(JSON.stringify({ phase: 'installer-handoff-old-launcher-closed', oldPid }))
  const hooks = JSON.parse(await readFile(hookLog, 'utf8'))
  assert.equal(hooks.artifactGets, 1, 'Retry must reuse the fully verified cache')
  assert.deepEqual(hooks.external, [], 'Kernel update must never launch a browser')
  assert.equal(hooks.spawns.length, 1)
  const handoff = hooks.spawns[0]
  assert.equal(path.resolve(handoff.file).toLowerCase(), cachedPath.toLowerCase())
  assert.ok(handoff.args.includes('/S') && handoff.args.includes('/AUTOSTART') && handoff.args.includes(`/WAITPID=${oldPid}`))
  assert.equal(handoff.args.at(-1), `/D=${installRoot}`)
  assert.deepEqual(handoff.options, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, argv0: `"${cachedPath}"` })
  const restarted = await until('installer starts the new versioned shell', async () => {
    const processes = await ownedProcesses()
    assert.ok(!processes.some(item => item.ExecutablePath.toLowerCase() === alternateExe.toLowerCase()), 'NSIS ignored the explicit spaced /D destination and installed into the alternate default')
    // CDP can disconnect slightly before Windows publishes the main PID exit.
    if (processes.some(item => item.ProcessId === oldPid)) return undefined
    return processes.find(item => item.ExecutablePath.toLowerCase() === newExe.toLowerCase() && !/(?:^|\s)--type=|--crashpad-handler/iu.test(item.CommandLine || ''))
  }, 5 * 60 * 1000)
  assert.equal(path.resolve(restarted.ExecutablePath).toLowerCase(), path.resolve(newExe).toLowerCase(), 'Restarted executable must be the new shell inside the explicit install root')
  assert.equal(path.dirname(path.dirname(path.dirname(path.resolve(restarted.ExecutablePath)))).toLowerCase(), path.resolve(installRoot).toLowerCase())
  await until('restarted launcher rewrites the same default profile', async () => (await stat(profileFile)).mtimeMs > profileWrittenBefore)
  const afterRestart = JSON.parse(await readFile(profileFile, 'utf8'))
  assert.equal(afterRestart.settings.theme, beforeRestart.settings.theme)
  assert.equal(afterRestart.settings.storageRoot, storageRoot)
  assert.equal(afterRestart.settings.workspace, beforeRestart.settings.workspace)
  assert.equal(afterRestart.settings.storageSetupCompleted, true)
  assert.deepEqual(await readFile(sentinel), sentinelBytes)
  assert.ok((await stat(oldExe)).isFile(), 'The previous shell must remain available')
  assert.equal(JSON.parse(await readFile(path.join(newShell, 'resources/app/package.json'), 'utf8')).version, '0.10.41')
  report.handoff = { passed: true, installDestinationVerified: true, intendedInstallRoot: installRoot, cacheReused: true, artifactGets: hooks.artifactGets, handoff, restartedPid: restarted.ProcessId, executablePath: restarted.ExecutablePath, profilePreserved: true, nestedStoragePreserved: true, oldShellPreserved: true }
  report.installDestinationVerified = true
  report.cacheReused = true
  report.passed = true
} catch (error) { report.error = String(error?.stack || error); process.exitCode = 1 }
finally {
  // Stop only this gate's three exact allowed executable paths. Preserve all files
  // and evidence; never remove the install root, a profile, or a user's process.
  try {
    await powershell(`$paths=@(${ownedExecutables.map(psLiteral).join(',')}); Get-CimInstance Win32_Process | Where-Object { $paths -contains $_.ExecutablePath } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`)
    report.isolatedProcessesStopped = true
  } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1 }
  await writeFile(path.join(output, 'report.json'), jsonBytes(report))
  console.log(JSON.stringify(report, null, 2))
}
