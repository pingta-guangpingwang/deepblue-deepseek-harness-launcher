#!/usr/bin/env node

import { _electron as electron, chromium } from 'playwright'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_HARNESS_SKIN_OUTPUT || path.join('output', 'playwright', 'harness-skin-clarity'))
const qaAppData = path.join(outputRoot, 'profile', 'appdata')
const qaLocalAppData = path.join(outputRoot, 'profile', 'localappdata')
const qaLauncherData = path.join(qaAppData, 'deepseek-harness-launcher')
const storageRoot = process.env.QA_HARNESS_STORAGE_ROOT || path.join(process.env.APPDATA || '', 'deepseek-harness-launcher')
const activeSkinPath = path.join(storageRoot, 'skins', 'active.json')
const port = Number(process.env.QA_HARNESS_PORT || 3098)
const browserCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean)

async function installedBrowser() {
  for (const candidate of browserCandidates) {
    try { await access(candidate); return candidate } catch { /* Try the next installed Chromium browser. */ }
  }
  return undefined
}

await access(executablePath)
const activeSkin = JSON.parse(await readFile(activeSkinPath, 'utf8'))
await access(activeSkin.mediaPath)
await rm(outputRoot, { recursive: true, force: true })
await mkdir(qaLauncherData, { recursive: true })
await mkdir(qaLocalAppData, { recursive: true })
await mkdir(path.join(outputRoot, 'workspace'), { recursive: true })
await writeFile(path.join(qaLauncherData, 'launcher.json'), JSON.stringify({
  settings: {
    storageRoot,
    storageSetupCompleted: true,
    workspace: path.join(outputRoot, 'workspace'),
    port,
    autoOpen: false,
    theme: 'light'
  },
  activeVersion: '0.1.1-rc.2'
}, null, 2))

const failures = []
function check(label, condition, detail = '') {
  process.stderr.write(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}\n`)
  if (!condition) failures.push(label)
}

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${qaLauncherData}`],
  env: { ...process.env, APPDATA: qaAppData, LOCALAPPDATA: qaLocalAppData }
})
let browser
try {
  const launcher = await app.firstWindow()
  await launcher.getByRole('button', { name: '启动 DeepSeek Harness', exact: true }).waitFor({ timeout: 30_000 })
  await launcher.getByRole('button', { name: '启动 DeepSeek Harness', exact: true }).click()
  await launcher.getByText('Harness 正在运行', { exact: true }).waitFor({ timeout: 120_000 })

  const executablePath = await installedBrowser()
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2_000)
  await page.screenshot({ path: path.join(outputRoot, 'harness-loaded.png'), fullPage: true })
  const toggle = page.locator('.deepblue-skin-clarity-toggle')
  const toggleReady = await toggle.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
  const pluginState = await page.evaluate(async () => ({
    text: document.body.innerText.slice(0, 1200),
    wallpaper: Boolean(document.querySelector('.deepblue-skin-wallpaper')),
    configStatus: await fetch('/deepblue-skin/config').then(response => response.status, () => 0)
  }))
  check('清透切换按钮在空白首页右上角全局可见', toggleReady && await toggle.count() === 1, JSON.stringify(pluginState))
  if (!toggleReady) throw new Error(`Harness 外观插件未显示清透按钮：${JSON.stringify(pluginState)}；控制台：${consoleErrors.join(' | ')}`)
  check('按钮默认提供清透壁纸动作', (await toggle.textContent())?.trim() === '清透壁纸')

  const overlayState = await page.evaluate(() => ({
    mode: document.documentElement.dataset.deepblueSkinClarity,
    overlay: document.documentElement.style.getPropertyValue('--deepblue-skin-overlay-current'),
    layer: document.documentElement.style.getPropertyValue('--deepblue-skin-bg-layer-1-light')
  }))
  check('默认状态保留蒙版与内容表面', overlayState.mode === 'overlay' && overlayState.overlay !== 'transparent', JSON.stringify(overlayState))
  await page.screenshot({ path: path.join(outputRoot, 'harness-overlay.png'), fullPage: true })

  await toggle.click()
  await page.waitForTimeout(300)
  const clearState = await page.evaluate(() => ({
    mode: document.documentElement.dataset.deepblueSkinClarity,
    overlay: document.documentElement.style.getPropertyValue('--deepblue-skin-overlay-current'),
    saved: localStorage.getItem('deepblue-skin-clarity'),
    layer: document.documentElement.style.getPropertyValue('--deepblue-skin-bg-layer-1-light')
  }))
  check('单击后即时去除蒙版并降低白色表面遮挡', clearState.mode === 'clear' && clearState.overlay === 'transparent' && clearState.layer.includes('0.07'), JSON.stringify(clearState))
  check('清透状态已持久保存', clearState.saved === 'clear')
  check('清透状态下按钮变为恢复蒙版', (await toggle.textContent())?.trim() === '恢复蒙版')
  await page.screenshot({ path: path.join(outputRoot, 'harness-clear.png'), fullPage: true })

  await toggle.click()
  await page.waitForTimeout(250)
  const restored = await page.evaluate(() => ({ mode: document.documentElement.dataset.deepblueSkinClarity, saved: localStorage.getItem('deepblue-skin-clarity') }))
  check('再次单击恢复蒙版状态', restored.mode === 'overlay' && restored.saved === 'overlay', JSON.stringify(restored))
  check('Harness 页面没有未处理的脚本错误', consoleErrors.length === 0, consoleErrors.join(' | '))

  const installedManifest = JSON.parse(await readFile(path.join(storageRoot, 'harness-data', 'profiles', 'web', 'node_modules', '@deepblue', 'dsh-skin-runtime', 'package.json'), 'utf8'))
  check('实际 web profile 已升级外观插件', installedManifest.version === '0.8.1', installedManifest.version)
  // A remote update notice may appear while the Harness page is under test;
  // stop through the same trusted IPC instead of letting that modal block QA
  // cleanup pointer input.
  await launcher.evaluate(() => window.launcher.stopHarness())
  await launcher.getByRole('button', { name: '启动 DeepSeek Harness', exact: true }).waitFor({ timeout: 30_000 })
} finally {
  await browser?.close()
  await app.close()
}

process.stderr.write(`\n截图写入 ${path.relative(root, outputRoot)}\n`)
if (failures.length) process.exit(1)
process.stderr.write('Harness 壁纸清透/蒙版双状态可视化验收通过\n')
