import { _electron as electron, chromium } from 'playwright'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const root = path.resolve(import.meta.dirname, '..')
const exe = path.join(root, 'release/win-unpacked/深蓝DeepSeekHarness启动器.exe')
const output = path.join(root, 'output/playwright/dsh-021-packaged-' + randomUUID())
const userData = path.join(output, 'user-data'), storage = path.join(output, 'storage'), workspace = path.join(output, 'workspace')
await Promise.all([userData, storage, workspace].map(directory => mkdir(directory, { recursive: true })))
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
const legacy = process.argv.includes('--legacy')
await writeFile(path.join(userData, 'launcher.json'), JSON.stringify({ activeVersion: legacy ? '0.1.1-rc.2' : '0.2.1-alpha.2', settings: { storageRoot: storage, workspace, storageSetupCompleted: true, autoOpen: false, port, theme: 'light' } }))
const env = { ...process.env, APPDATA: path.join(output, 'appdata'), LOCALAPPDATA: path.join(output, 'localappdata'), DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' }
for (const key of Object.keys(env)) if (/api.?key|access.?token|auth.?token|password|secret/i.test(key)) delete env[key]
const report = { output, version: '0.10.37', legacy, checks: {}, errors: [] }
let app, browser, launchedPid
try {
  app = await electron.launch({ executablePath: exe, args: ['--user-data-dir=' + userData], env })
  const page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')))
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: /启动 DeepSeek Harness/ }).first().waitFor({ state: 'visible', timeout: 20000 })
  const initial = await page.evaluate(async () => { const state = await window.launcher.getSnapshot(); return { storageRoot: state.settings.storageRoot, workspace: state.settings.workspace, runStatus: state.runStatus } })
  if (path.resolve(initial.storageRoot).toLowerCase() !== storage.toLowerCase() || path.resolve(initial.workspace).toLowerCase() !== workspace.toLowerCase()) throw Error('QA isolation was not applied')
  const guideDismiss = page.getByRole('button', { name: '暂时不用', exact: true })
  if (await guideDismiss.isVisible()) await guideDismiss.click()
  const updateDismiss = page.locator('.runtime-update-dialog').getByRole('button', { name: '关闭', exact: true })
  if (await updateDismiss.isVisible()) await updateDismiss.click()
  await page.screenshot({ path: path.join(output, 'launcher-ready.png') })
  await page.getByRole('button', { name: /启动 DeepSeek Harness/ }).first().click()
  let runStatus = ''
  for (let attempt = 0; attempt < 200; attempt++) {
    runStatus = await page.evaluate(async () => (await window.launcher.getSnapshot()).runStatus)
    if (runStatus === 'running') break
    if (runStatus === 'error') throw Error('Launcher reported a DSH startup error')
    await page.waitForTimeout(300)
  }
  report.checks.runStatus = runStatus
  if (runStatus !== 'running') throw Error('DSH startup did not reach running')
  await page.waitForTimeout(500)
  const state = await page.evaluate(async () => { const value = await window.launcher.getSnapshot(); return { version: value.launcherVersion, active: value.activeHarnessVersion, url: value.serviceUrl, logs: value.logs } })
  report.checks.launcherVersion = state.version; report.checks.dshVersion = state.active
  report.checks.logTokensRedacted = state.logs.every(line => !/[?&]token=(?!\[redacted\])/.test(line.message))
  report.checks.modelEntriesActive = state.logs.every(line => !/entry did not activate|catalog model.*no longer supported/i.test(line.message))
  report.checks.authFileCreated = (await stat(path.join(storage, 'harness-data/launcher/process-auth.json'))).isFile()
  report.checks.snapshotUrlClean = !new URL(state.url).search
  const auth = JSON.parse(await readFile(path.join(storage, 'harness-data/launcher/process-auth.json'), 'utf8'))
  launchedPid = auth.pid
  const encodedFile = Buffer.from(path.join(storage, 'harness-data/launcher/process-auth.json'), 'utf8').toString('base64')
  const aclScript = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFile}')); $d=[IO.Directory]::GetAccessControl([IO.Path]::GetDirectoryName($p)); $a=[IO.File]::GetAccessControl($p); $ids=@($a.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }); $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); if(!$d.AreAccessRulesProtected -or $ids.Count -ne 3 -or @($ids | Where-Object { $_ -notin $allowed }).Count) { exit 2 }; Write-Output 'PRIVATE_ACL_OK'`
  report.checks.authenticationAclPrivate = (await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')], { windowsHide: true })).stdout.trim() === 'PRIVATE_ACL_OK'
  report.checks.unauthenticatedRoot = (await fetch('http://127.0.0.1:' + port)).status
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext()
  const web = await context.newPage(); web.on('pageerror', error => report.errors.push(error.message.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')))
  await web.goto(auth.url, { waitUntil: 'domcontentloaded' })
  await web.locator('#root > *').waitFor({ state: 'visible', timeout: 30000 })
  await web.waitForTimeout(500)
  const previewContinue = web.getByRole('button', { name: '继续', exact: true })
  if (await previewContinue.isVisible()) await previewContinue.click()
  report.checks.browserTokenRemoved = !new URL(web.url()).searchParams.has('token')
  report.checks.browserBody = (await web.locator('body').innerText()).slice(0, 2500)
  await web.screenshot({ path: path.join(output, 'dsh-authenticated-web.png') })
  await page.screenshot({ path: path.join(output, 'launcher-running.png') })
  report.checks.processAlive = Number.isSafeInteger(auth.pid)
  await page.evaluate(async () => window.launcher.stopHarness())
  report.checks.stopAuthenticationRemoved = await stat(path.join(storage, 'harness-data/launcher/process-auth.json')).then(() => false, () => true)
  if (await updateDismiss.isVisible()) await updateDismiss.click()
  await page.getByRole('button', { name: /启动 DeepSeek Harness/ }).first().click()
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await page.evaluate(async () => (await window.launcher.getSnapshot()).runStatus) === 'running') break
    await page.waitForTimeout(300)
  }
  launchedPid = JSON.parse(await readFile(path.join(storage, 'harness-data/launcher/process-auth.json'), 'utf8')).pid
  if (state.version !== '0.10.37' || state.active !== '0.2.1-alpha.2' || !report.checks.logTokensRedacted || !report.checks.modelEntriesActive || !report.checks.browserTokenRemoved || report.errors.length) throw Error('Packaged launcher/browser acceptance failed')
  report.passed = true
} catch(error) { report.error = String(error.message).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'); process.exitCode = 1 }
finally { await browser?.close(); await app?.close(); report.checks.exitAuthenticationRemoved = await stat(path.join(storage, 'harness-data/launcher/process-auth.json')).then(() => false, () => true); if (launchedPid) await promisify(execFile)('taskkill', ['/pid', String(launchedPid), '/t', '/f'], { windowsHide: true }).catch(() => {}); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify(report, null, 2))
