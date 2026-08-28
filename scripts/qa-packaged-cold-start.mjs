#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_COLD_START_OUTPUT || path.join('output', 'playwright', 'packaged-cold-start'))
const profileRoot = path.join(outputRoot, 'profile')
const userDataRoot = path.join(profileRoot, 'electron-user-data')
const appDataRoot = path.join(profileRoot, 'appdata')
const localAppDataRoot = path.join(profileRoot, 'localappdata')
const storageRoot = path.join(profileRoot, 'storage')
const uiVersion = 'ui-cold-start-fixture'
const uiRoot = path.join(storageRoot, 'runtime', 'modules', 'launcher-ui', uiVersion)

await rm(outputRoot, { recursive: true, force: true })
await Promise.all([userDataRoot, appDataRoot, localAppDataRoot, storageRoot, uiRoot].map((target) => mkdir(target, { recursive: true })))
await cp(path.join(root, 'out', 'renderer'), path.join(uiRoot, 'renderer'), { recursive: true })
await mkdir(path.join(storageRoot, 'runtime', 'modules'), { recursive: true })
await writeFile(path.join(storageRoot, 'runtime', 'modules', 'state.json'), `${JSON.stringify({
  schemaVersion: 1,
  active: { 'launcher-ui': uiVersion },
  previous: {},
  installed: { 'launcher-ui': [uiVersion] }
}, null, 2)}\n`, 'utf8')
await writeFile(path.join(userDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: {
    storageRoot,
    storageSetupCompleted: true,
    autoOpen: false,
    theme: 'light',
    port: 32889
  }
}, null, 2)}\n`, 'utf8')

const pageErrors = []
const consoleErrors = []
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataRoot}`],
  env: {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    DSH_LAUNCHER_ALLOW_PARALLEL: '1',
    DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1'
  }
})
const mainProcess = app.process()
const mainProcessDiagnostics = []
mainProcess.stdout?.on('data', (chunk) => mainProcessDiagnostics.push(`stdout: ${String(chunk).trim()}`))
mainProcess.stderr?.on('data', (chunk) => mainProcessDiagnostics.push(`stderr: ${String(chunk).trim()}`))
mainProcess.on('exit', (code, signal) => mainProcessDiagnostics.push(`exit: ${code ?? 'null'}/${signal ?? 'none'}`))
app.on('window', (page) => {
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('crash', () => pageErrors.push('renderer process crashed'))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
})

let page
const report = {
  passed: false,
  testedAt: new Date().toISOString(),
  uiVersion,
  pageErrors,
  consoleErrors,
  mainProcessDiagnostics
}

try {
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#root > *').waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByText('DeepSeek Harness', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
  const snapshot = await page.evaluate(async () => window.launcher.getSnapshot())
  if (!snapshot || snapshot.launcherUiVersion !== uiVersion || snapshot.launcherUiSource !== 'updated') {
    throw new Error(`Cold start selected an unexpected UI: ${snapshot?.launcherUiVersion || 'missing'}/${snapshot?.launcherUiSource || 'missing'}`)
  }
  if (pageErrors.length) throw new Error(`Cold start renderer errors: ${pageErrors.join(' | ')}`)
  if (consoleErrors.length) throw new Error(`Cold start console errors: ${consoleErrors.join(' | ')}`)
  const bodyText = await page.locator('body').innerText()
  if (!bodyText.includes('启动 DeepSeek Harness')) throw new Error('Cold start did not render the launcher home action')
  await page.screenshot({ path: path.join(outputRoot, 'cold-start-ready.png') })
  Object.assign(report, {
    passed: true,
    title: await page.title(),
    url: page.url(),
    rootChildren: await page.locator('#root > *').count(),
    launcherVersion: snapshot.launcherVersion,
    launcherUiVersion: snapshot.launcherUiVersion,
    launcherUiSource: snapshot.launcherUiSource
  })
} catch (error) {
  if (page) await page.screenshot({ path: path.join(outputRoot, 'cold-start-failed.png') }).catch(() => undefined)
  report.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await app.close().catch(() => undefined)
}

process.stderr.write(`PACKAGED COLD-START GATE PASSED: ${report.launcherVersion}, ${report.launcherUiVersion}, first load rendered without reload.\n`)
