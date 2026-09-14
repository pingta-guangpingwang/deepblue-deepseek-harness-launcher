#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'

const root = path.resolve(import.meta.dirname, '..')
const executablePath = path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(process.env.QA_LEGACY_RECOVERY_OUTPUT || path.join(root, 'output', 'playwright', 'legacy-harness-recovery'))
const profileRoot = path.join(outputRoot, 'profile')
const userDataRoot = path.join(profileRoot, 'electron-user-data')
const appDataRoot = path.join(profileRoot, 'appdata')
const localAppDataRoot = path.join(profileRoot, 'localappdata')
const storageRoot = path.join(profileRoot, 'storage')
const credentialsPath = path.join(storageRoot, 'harness-data', '.credentials.yaml')
const port = 32891

await rm(outputRoot, { recursive: true, force: true })
await Promise.all([userDataRoot, appDataRoot, localAppDataRoot, path.dirname(credentialsPath)].map(target => mkdir(target, { recursive: true })))
await writeFile(credentialsPath, 'DEEPSEEK_API_KEY: qa-placeholder-key\n', 'utf8')
await writeFile(path.join(userDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: { storageRoot, storageSetupCompleted: true, autoOpen: false, theme: 'light', port, workspace: path.join(profileRoot, 'workspace') },
  activeVersion: '0.1.1-rc.2',
  workspaces: [],
  resourceLibrary: [],
  modelRouting: { credentialSyncVersion: 1 }
}, null, 2)}\n`, 'utf8')

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataRoot}`],
  env: { ...process.env, APPDATA: appDataRoot, LOCALAPPDATA: localAppDataRoot, DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' }
})
const report = { passed: false, testedAt: new Date().toISOString(), launcherVersion: '', migratedVersion: '', stableRunning: false, errors: [] }
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(String(error)))
  await page.locator('#root > *').waitFor({ state: 'visible', timeout: 15_000 })
  const migrated = parse(await readFile(credentialsPath, 'utf8'))
  if (migrated.version !== 1) throw new Error(`Credential version was not normalized: ${typeof migrated.version}`)
  report.migratedVersion = String(migrated.version)
  const started = await page.evaluate(() => window.launcher.startHarness())
  report.launcherVersion = started.launcherVersion
  const deadline = Date.now() + 60_000
  let snapshot = await page.evaluate(() => window.launcher.getSnapshot())
  while (Date.now() < deadline && snapshot.runStatus !== 'running') {
    await page.waitForTimeout(500)
    snapshot = await page.evaluate(() => window.launcher.getSnapshot())
    if (snapshot.runStatus === 'error' && Date.now() > deadline - 55_000) break
  }
  if (snapshot.runStatus !== 'running') {
    await page.waitForTimeout(1_000)
    const failed = await page.evaluate(() => window.launcher.getSnapshot())
    const tail = failed.logs.slice(-8).map(line => `${line.level} ${line.message}`).join(' | ')
    throw new Error(`Harness did not remain running: ${failed.launchProgress.message}; ${tail}`)
  }
  await page.waitForTimeout(3_000)
  const stable = await page.evaluate(() => window.launcher.getSnapshot())
  if (stable.runStatus !== 'running') throw new Error(`Harness exited after readiness: ${stable.launchProgress.message}`)
  report.stableRunning = true
  report.passed = report.launcherVersion === '0.10.36' && report.migratedVersion === '1' && report.errors.length === 0
  await page.screenshot({ path: path.join(outputRoot, 'legacy-credential-recovered-and-running.png') })
  await page.evaluate(() => window.launcher.stopHarness())
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, output: outputRoot }, null, 2))
  await app.close().catch(() => undefined)
}
