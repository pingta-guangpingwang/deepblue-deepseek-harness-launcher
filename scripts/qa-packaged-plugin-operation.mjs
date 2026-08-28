#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_PLUGIN_OUTPUT || path.join('output', 'playwright', 'packaged-plugin-operation'))
const profileRoot = path.join(outputRoot, 'profile')
const appDataRoot = path.join(profileRoot, 'appdata')
const localAppDataRoot = path.join(profileRoot, 'localappdata')
const launcherDataRoot = path.join(appDataRoot, 'deepseek-harness-launcher')
const storageRoot = path.join(profileRoot, 'storage')
const workspace = path.join(profileRoot, 'workspace')
const webProfileRoot = path.join(storageRoot, 'harness-data', 'profiles', 'web')
const partialRemotePackageRoot = path.join(webProfileRoot, 'node_modules', '@linxin666', 'dsh-remote-web-ui')

const relativeOutputRoot = path.relative(root, outputRoot)
if (!relativeOutputRoot || relativeOutputRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutputRoot)) {
  throw new Error(`QA output must stay inside the launcher workspace: ${outputRoot}`)
}
await rm(outputRoot, { recursive: true, force: true })
await Promise.all([launcherDataRoot, localAppDataRoot, storageRoot, workspace, partialRemotePackageRoot].map((target) => mkdir(target, { recursive: true })))

// Reproduce pnpm's failure shape: dependency files were written, but DSH did
// not register the bundle because pnpm exited non-zero. The launcher must keep
// showing Install instead of treating this half state as success.
await writeFile(path.join(webProfileRoot, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { '@linxin666/dsh-remote-web-ui': '0.3.5' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}, null, 2)}\n`, 'utf8')
await writeFile(path.join(webProfileRoot, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n', 'utf8')
await writeFile(path.join(partialRemotePackageRoot, 'package.json'), `${JSON.stringify({
  name: '@linxin666/dsh-remote-web-ui',
  version: '0.3.5',
  dsh: { bundle: { patch: './cordis.patch.yml' } }
}, null, 2)}\n`, 'utf8')

await writeFile(path.join(launcherDataRoot, 'launcher.json'), `${JSON.stringify({
  activeVersion: '0.1.1-rc.2',
  settings: {
    storageRoot,
    storageSetupCompleted: true,
    workspace,
    autoOpen: false,
    theme: 'light',
    port: 32931
  }
}, null, 2)}\n`, 'utf8')

const failures = []
function check(label, condition, detail = '') {
  process.stderr.write(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}\n`)
  if (!condition) failures.push(label)
}

async function waitForSnapshot(page, predicate, timeoutMs, label) {
  const startedAt = Date.now()
  let latest
  while (Date.now() - startedAt < timeoutMs) {
    latest = await page.evaluate(() => window.launcher.getSnapshot())
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`${label}超时：${JSON.stringify({ runStatus: latest?.runStatus, launchProgress: latest?.launchProgress })}`)
}

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${launcherDataRoot}`, '--disable-gpu'],
  env: { ...process.env, APPDATA: appDataRoot, LOCALAPPDATA: localAppDataRoot }
})

try {
  const page = await app.firstWindow()
  const rendererErrors = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') rendererErrors.push(message.text()) })
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'AI 工具', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click()
  await page.getByRole('tab', { name: /DSH 生态/ }).click()
  await page.getByRole('tab', { name: '高级能力', exact: true }).click()
  const remoteRow = page.locator('.ecosystem-row').filter({ hasText: '手机 / PC 远程配对' })
  await remoteRow.waitFor({ state: 'visible', timeout: 30_000 })
  check('失败后只写入依赖文件不会误报插件已安装', await remoteRow.getByRole('button', { name: '安装', exact: true }).count() === 1)
  const dialog = page.locator('.plugin-operation-dialog[role="dialog"]')
  const runtimeDialog = page.locator('.runtime-update-dialog[role="dialog"]')
  const dismissRuntimeDialog = async () => {
    if (!await runtimeDialog.isVisible().catch(() => false)) return
    await runtimeDialog.locator('.runtime-update-actions').getByRole('button', { name: '关闭', exact: true }).click()
    await runtimeDialog.waitFor({ state: 'hidden' })
  }
  const showOperationDialog = async () => {
    await dialog.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined)
    if (!await dialog.isVisible().catch(() => false)) {
      await page.locator('.ecosystem-actions').getByRole('button', { name: '查看进度', exact: true }).first().click()
      await dialog.waitFor({ state: 'visible', timeout: 30_000 })
    }
  }

  // Return the profile to a clean baseline before exercising the normal
  // install/remove/restart flow below.
  await rm(path.join(webProfileRoot, 'node_modules'), { recursive: true, force: true })
  await writeFile(path.join(webProfileRoot, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
  }, null, 2)}\n`, 'utf8')

  await remoteRow.getByRole('button', { name: '安装', exact: true }).click()
  await showOperationDialog()
  await dialog.locator('.plugin-operation-progress.completed, .plugin-operation-progress.failed').waitFor({ state: 'visible', timeout: 780_000 })
  const remoteInstallState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pluginOperation)
  check('远程配对插件真实安装通过 cloudflared 审核策略', remoteInstallState?.status === 'completed', remoteInstallState?.message)
  check('远程配对安装不再触发 PNPM_IGNORED_BUILDS', !(remoteInstallState?.files || []).some((line) => /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(line)), remoteInstallState?.currentFile)
  await page.screenshot({ path: path.join(outputRoot, 'remote-pairing-install-completed.png') })
  await dialog.locator('.plugin-operation-actions').getByRole('button', { name: '关闭', exact: true }).click()
  await dismissRuntimeDialog()
  await remoteRow.getByRole('button', { name: '卸载', exact: true }).click()
  await showOperationDialog()
  await dialog.locator('.plugin-operation-progress.completed, .plugin-operation-progress.failed').waitFor({ state: 'visible', timeout: 180_000 })
  const remoteRemoveState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pluginOperation)
  check('远程配对插件真实卸载完成', remoteRemoveState?.status === 'completed', remoteRemoveState?.message)
  await dialog.locator('.plugin-operation-actions').getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('tab', { name: '推荐增强', exact: true }).click()
  const targetRow = page.locator('.ecosystem-row').filter({ hasText: '任务看板' })
  await targetRow.waitFor({ state: 'visible', timeout: 30_000 })

  await targetRow.getByRole('button', { name: '安装', exact: true }).click()
  await showOperationDialog()
  check('插件操作立即显示下载与安装进度条', await dialog.getByRole('progressbar', { name: '插件下载与安装进度' }).count() === 1)
  check('插件操作显示可滚动的文件与组件区域', await dialog.locator('.plugin-file-scroll').count() === 1)
  await page.screenshot({ path: path.join(outputRoot, 'plugin-install-progress.png') })

  await dialog.locator('.plugin-operation-progress.completed, .plugin-operation-progress.failed').waitFor({ state: 'visible', timeout: 180_000 })
  const installState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pluginOperation)
  check('真实插件安装进入明确成功终态', installState?.status === 'completed', installState?.message)
  check('真实安装输出保留文件与组件明细', (installState?.files.length || 0) >= 3, `lines=${installState?.files.length || 0}`)
  check('Harness 未运行时明确提示下次启动自动生效', !installState?.restartRequired && /下次启动/.test(installState?.message || ''), installState?.message)
  check('安装完成后其他安装与卸载按钮立即恢复', await page.locator('.ecosystem-actions button:last-child').evaluateAll((buttons) => buttons.every((button) => !button.disabled)))
  check('安装完成后卡片立即切换为卸载', await targetRow.getByRole('button', { name: '卸载', exact: true }).count() === 1)
  await page.screenshot({ path: path.join(outputRoot, 'plugin-install-completed.png') })

  await dialog.locator('.plugin-operation-actions').getByRole('button', { name: '关闭', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await dismissRuntimeDialog()
  await targetRow.getByRole('button', { name: '卸载', exact: true }).click()
  await dialog.waitFor({ state: 'visible', timeout: 30_000 })
  await dialog.locator('.plugin-operation-progress.completed, .plugin-operation-progress.failed').waitFor({ state: 'visible', timeout: 180_000 })
  const removeState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pluginOperation)
  check('真实插件卸载进入明确成功终态', removeState?.status === 'completed', removeState?.message)
  check('卸载完成后全部操作按钮再次立即恢复', await page.locator('.ecosystem-actions button:last-child').evaluateAll((buttons) => buttons.every((button) => !button.disabled)))
  check('卸载完成后卡片立即恢复安装入口', await targetRow.getByRole('button', { name: '安装', exact: true }).count() === 1)

  await dialog.locator('.plugin-operation-actions').getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => window.launcher.startHarness())
  await waitForSnapshot(page, (current) => current.runStatus === 'running', 120_000, '首次启动 Harness')
  await targetRow.getByRole('button', { name: '安装', exact: true }).click()
  await dialog.waitFor({ state: 'visible', timeout: 30_000 })
  await dialog.locator('.plugin-operation-progress.completed, .plugin-operation-progress.failed').waitFor({ state: 'visible', timeout: 180_000 })
  const runningInstallState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pluginOperation)
  check('Harness 运行中安装完成会询问是否重启', runningInstallState?.status === 'completed' && runningInstallState.restartRequired, runningInstallState?.message)
  check('重启提示提供立即重启 Harness 按钮', await dialog.getByRole('button', { name: '立即重启 Harness', exact: true }).count() === 1)
  await page.screenshot({ path: path.join(outputRoot, 'plugin-restart-prompt.png') })
  await dialog.getByRole('button', { name: '立即重启 Harness', exact: true }).click()
  await waitForSnapshot(page, (current) => current.runStatus === 'starting' && current.launchProgress.status === 'waiting', 30_000, 'Harness 进入重启等待阶段')
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
  const restartedSnapshot = await waitForSnapshot(page, (current) => current.runStatus === 'running' && current.launchProgress.status === 'ready', 120_000, 'Harness 重启完成')
  check('点击提示后 Harness 完成服务级重启', true, JSON.stringify({ runStatus: restartedSnapshot.runStatus, launchStatus: restartedSnapshot.launchProgress.status, launchMessage: restartedSnapshot.launchProgress.message }))
  await page.evaluate(async () => {
    await window.launcher.stopHarness()
    await window.launcher.pluginAction('remove', '@linxin666/dsh-client-ui-task-board@latest')
  })
  await page.evaluate(() => window.launcher.pluginAction('install', '@linxin666/dsh-install-failure-probe@0.0.0'))
  await dialog.locator('.plugin-operation-progress.failed').waitFor({ state: 'visible', timeout: 120_000 })
  const failedState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pluginOperation)
  check('包管理器非零退出码只进入失败终态', failedState?.status === 'failed' && failedState.progress < 100, `${failedState?.progress}% · ${failedState?.message}`)
  check('失败弹窗不会显示安装成功提示', await dialog.locator('.plugin-operation-progress.completed, .plugin-restart-prompt').count() === 0)
  await page.screenshot({ path: path.join(outputRoot, 'plugin-install-failed.png') })
  check('真实打包应用没有渲染错误', rendererErrors.length === 0, rendererErrors.join(' | '))
  await page.screenshot({ path: path.join(outputRoot, 'plugin-remove-completed.png') })
} finally {
  await app.close().catch(() => undefined)
}

process.stderr.write(`\n插件操作截图写入 ${path.relative(root, outputRoot)}\n`)
if (failures.length) process.exit(1)
process.stderr.write('正式打包插件安装/卸载进度与按钮释放门禁通过\n')
