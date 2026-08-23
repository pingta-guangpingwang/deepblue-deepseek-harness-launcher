#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
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
await Promise.all([userDataRoot, appDataRoot, localAppDataRoot, storageRoot, workspace, outputRoot].map((target) => mkdir(target, { recursive: true })))
await writeFile(path.join(userDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: {
    workspace,
    storageRoot,
    storageSetupCompleted: true,
    autoOpen: false,
    theme: 'dark'
  }
}, null, 2)}\n`, 'utf8')

const observedSources = new Set()
const observedProgress = []
const startedAt = Date.now()
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataRoot}`, '--disable-gpu'],
  env: {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot
  }
})

let finalSnapshot
try {
  const page = await app.firstWindow()
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
      if (!response.ok) throw new Error(`Harness service returned HTTP ${response.status}`)
      break
    }
    if (snapshot.runStatus === 'error' || snapshot.launchProgress.status === 'failed') {
      throw new Error(snapshot.launchProgress.message || snapshot.logs.at(-1)?.message || 'Harness failed during public fresh-install QA')
    }
    await page.waitForTimeout(1_000)
  }

  if (!finalSnapshot?.serviceUrl || finalSnapshot.runStatus !== 'running') throw new Error(`Harness did not become ready within ${Math.round(timeoutMs / 60_000)} minutes`)
  const environment = Object.fromEntries(finalSnapshot.environment.map((item) => [item.id, { status: item.status, version: item.version, detail: item.detail }]))
  if (environment.node?.status !== 'ready' || environment.harness?.status !== 'ready') throw new Error('Fresh public install did not prepare both Node.js and Harness')
  await page.screenshot({ path: path.join(outputRoot, 'public-fresh-install-harness-running.png') })
  await page.evaluate(async () => window.launcher.stopHarness())
  await writeFile(path.join(outputRoot, 'public-fresh-install-report.json'), `${JSON.stringify({
    passed: true,
    testedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    launcherVersion: finalSnapshot.launcherVersion,
    harnessVersion: finalSnapshot.activeHarnessVersion,
    serviceUrl: finalSnapshot.serviceUrl,
    observedSources: [...observedSources],
    environment,
    observedProgress,
    finalLogs: finalSnapshot.logs.slice(-30)
  }, null, 2)}\n`, 'utf8')
} finally {
  await app.close().catch(() => undefined)
}

process.stderr.write(`Public fresh-install QA passed in ${Math.round((Date.now() - startedAt) / 1_000)}s; sources: ${[...observedSources].join(', ') || 'cache-free signed catalog'}\n`)
