#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_UI_HOT_UPDATE_OUTPUT || path.join('output', 'playwright', 'public-ui-hot-update'))
const profileRoot = path.join(outputRoot, 'profile')
const userDataRoot = path.join(profileRoot, 'electron-user-data')
const appDataRoot = path.join(profileRoot, 'appdata')
const localAppDataRoot = path.join(profileRoot, 'localappdata')
const storageRoot = path.join(profileRoot, 'storage')
const runtimeRoot = path.join(storageRoot, 'runtime')
const oldVersion = 'ui-0000000000000001'
const oldModuleRoot = path.join(runtimeRoot, 'modules', 'launcher-ui', oldVersion)
const generated = JSON.parse(await readFile(path.join(root, 'release', 'launcher-ui.generated.json'), 'utf8'))
const expectedVersion = generated.version
const expectedSize = generated.artifacts?.[0]?.size
if (!Number.isSafeInteger(expectedSize) || expectedSize < 1) throw new Error('Generated launcher-ui metadata has no valid artifact size')

await rm(outputRoot, { recursive: true, force: true })
await Promise.all([userDataRoot, appDataRoot, localAppDataRoot, storageRoot, oldModuleRoot].map((target) => mkdir(target, { recursive: true })))
await cp(path.join(root, 'out', 'renderer'), path.join(oldModuleRoot, 'renderer'), { recursive: true })
await writeFile(path.join(runtimeRoot, 'modules', 'state.json'), `${JSON.stringify({
  schemaVersion: 1,
  active: { 'launcher-ui': oldVersion },
  previous: {},
  installed: { 'launcher-ui': [oldVersion] }
}, null, 2)}\n`, 'utf8')
await writeFile(path.join(userDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: {
    storageRoot,
    storageSetupCompleted: true,
    autoOpen: false,
    theme: 'dark',
    port: 32888
  }
}, null, 2)}\n`, 'utf8')

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataRoot}`, '--disable-gpu'],
  env: {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot
  }
})

const kernelPid = app.process().pid
let page = await app.firstWindow()
const report = {
  passed: false,
  testedAt: new Date().toISOString(),
  kernelPid,
  oldVersion,
  expectedVersion,
  expectedSize,
  plannedModules: [],
  finalSnapshot: undefined,
  moduleState: undefined
}

async function snapshotFromCurrentWindow() {
  const windows = app.windows()
  if (windows.length !== 1) throw new Error(`UI hot update must keep one launcher window; found ${windows.length}`)
  page = windows[0]
  return page.evaluate(async () => window.launcher.getSnapshot())
}

try {
  await page.waitForLoadState('domcontentloaded')
  const checkButton = page.getByRole('button', { name: '检查更新', exact: true })
  await checkButton.waitFor({ state: 'visible', timeout: 60_000 })
  const initial = await snapshotFromCurrentWindow()
  if (initial.launcherUiVersion !== oldVersion || initial.launcherUiSource !== 'updated') {
    throw new Error(`Old UI fixture was not selected: ${initial.launcherUiVersion}/${initial.launcherUiSource}`)
  }

  await checkButton.click()
  const checkDeadline = Date.now() + 120_000
  let available
  while (Date.now() < checkDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const current = await snapshotFromCurrentWindow()
    if (current.runtimeUpdates.status === 'failed') {
      throw new Error(`Check update failed: ${current.runtimeUpdates.message || 'no signed catalog'}`)
    }
    if (current.runtimeUpdates.checkedAt && current.runtimeUpdates.status !== 'idle') {
      available = current
      break
    }
  }
  if (!available) throw new Error('Check update produced no visible result within 120 seconds')
  report.plannedModules = available.runtimeUpdates.items
  if (available.runtimeUpdates.items.length !== 1 || available.runtimeUpdates.items[0]?.id !== 'launcher-ui') {
    throw new Error(`Expected only launcher-ui, got ${available.runtimeUpdates.items.map((item) => item.id).join(', ') || 'none'}`)
  }
  if (available.runtimeUpdates.items[0].size !== expectedSize) {
    throw new Error(`Unexpected launcher-ui size: ${available.runtimeUpdates.items[0].size}, expected ${expectedSize}`)
  }
  const dialog = page.getByRole('dialog', { name: /检测到可处理的更新/ })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: path.join(outputRoot, 'ui-update-available.png') })
  await dialog.getByRole('button', { name: /^更新 1 个模块/ }).click()

  const deadline = Date.now() + 120_000
  let finalSnapshot
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const current = await snapshotFromCurrentWindow()
      if (current.launcherUiVersion === expectedVersion && current.runtimeUpdates.status === 'idle') {
        finalSnapshot = current
        break
      }
    } catch {
      // loadFile briefly replaces the renderer execution context in the same BrowserWindow.
    }
  }
  if (!finalSnapshot) throw new Error('Launcher UI did not hot-activate in the existing window')
  if (app.process().pid !== kernelPid) throw new Error('Launcher kernel process restarted during a UI-only update')
  if (finalSnapshot.launcherUiSource !== 'updated') throw new Error(`Unexpected final UI source: ${finalSnapshot.launcherUiSource}`)
  if (finalSnapshot.runStatus !== 'stopped') throw new Error(`UI-only update changed Harness status: ${finalSnapshot.runStatus}`)
  if (!/热更新完成|无需重启/u.test(finalSnapshot.runtimeUpdates.message || '')) {
    throw new Error(`Missing successful hot-update feedback: ${finalSnapshot.runtimeUpdates.message || 'empty'}`)
  }

  const moduleState = JSON.parse(await readFile(path.join(runtimeRoot, 'modules', 'state.json'), 'utf8'))
  if (moduleState.active?.['launcher-ui'] !== expectedVersion || moduleState.previous?.['launcher-ui'] !== oldVersion) {
    throw new Error('Launcher UI active/rollback pointers were not advanced atomically')
  }
  const installedIds = Object.keys(moduleState.installed || {}).filter((id) => (moduleState.installed[id] || []).length)
  if (installedIds.length !== 1 || installedIds[0] !== 'launcher-ui') {
    throw new Error(`UI-only update installed unrelated modules: ${installedIds.join(', ')}`)
  }

  report.passed = true
  report.finalSnapshot = {
    launcherVersion: finalSnapshot.launcherVersion,
    launcherUiVersion: finalSnapshot.launcherUiVersion,
    launcherUiSource: finalSnapshot.launcherUiSource,
    runtimeUpdateMessage: finalSnapshot.runtimeUpdates.message,
    runStatus: finalSnapshot.runStatus
  }
  report.moduleState = moduleState
  await page.screenshot({ path: path.join(outputRoot, 'ui-update-applied-without-restart.png') })
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
} finally {
  if (!report.passed) await writeFile(path.join(outputRoot, 'failure.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined)
  await app.close().catch(() => undefined)
}

process.stderr.write(`PUBLIC UI HOT-UPDATE GATE PASSED: ${oldVersion} -> ${expectedVersion}, ${expectedSize} bytes, kernel PID ${kernelPid} unchanged.\n`)
