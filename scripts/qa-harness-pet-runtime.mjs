#!/usr/bin/env node

import { _electron as electron, chromium } from 'playwright'
import { access, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcherExecutable = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_HARNESS_PET_OUTPUT || path.join('output', 'playwright', 'harness-pet-runtime'))
const qaAppData = path.join(outputRoot, 'profile', 'appdata')
const qaLocalAppData = path.join(outputRoot, 'profile', 'localappdata')
const qaLauncherData = path.join(qaAppData, 'deepseek-harness-launcher')
const storageRoot = process.env.QA_HARNESS_STORAGE_ROOT || path.join(process.env.APPDATA || '', 'deepseek-harness-launcher')
const activePetPath = path.join(storageRoot, 'pets', 'active.json')
const port = Number(process.env.QA_HARNESS_PET_PORT || 3097)
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

async function existingBytes(filename) {
  try { return await readFile(filename) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

await access(launcherExecutable)
const originalActivePet = await existingBytes(activePetPath)
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
  executablePath: launcherExecutable,
  args: [`--user-data-dir=${qaLauncherData}`],
  env: { ...process.env, APPDATA: qaAppData, LOCALAPPDATA: qaLocalAppData }
})
let browser
let launcher
try {
  launcher = await app.firstWindow()
  await launcher.getByRole('button', { name: '启动 DeepSeek Harness', exact: true }).waitFor({ timeout: 30_000 })
  const refreshed = await launcher.evaluate(() => window.launcher.refreshPets())
  const pixel = refreshed.pets.items.find(item => item.catalogSource === 'pixel')
  const live2d = refreshed.pets.items.find(item => item.catalogSource === 'live2d')
  if (!pixel || !live2d) throw new Error(`真实目录缺少测试宠物：pixel=${Boolean(pixel)}, live2d=${Boolean(live2d)}`)

  const browserExecutable = await installedBrowser()
  browser = await chromium.launch({ headless: true, ...(browserExecutable ? { executablePath: browserExecutable } : {}) })

  async function startHarnessPage() {
    let snapshot = await launcher.evaluate(() => window.launcher.startHarness())
    for (let attempt = 0; attempt < 120 && snapshot.runStatus === 'starting'; attempt += 1) {
      await launcher.waitForTimeout(1_000)
      snapshot = await launcher.evaluate(() => window.launcher.getSnapshot())
    }
    if (snapshot.runStatus !== 'running') throw new Error(`Harness 启动失败：${snapshot.runStatus}`)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    return { page, errors }
  }

  await launcher.evaluate(petId => window.launcher.applyPet(petId), pixel.id)
  let current = await startHarnessPage()
  const pixelPet = current.page.locator('.deepblue-pet[data-pack-kind="pixel-atlas"]')
  await pixelPet.waitFor({ state: 'visible', timeout: 30_000 })
  const pixelCanvas = pixelPet.locator('canvas')
  const idleFrames = []
  for (let sample = 0; sample < 6; sample += 1) {
    idleFrames.push(await pixelCanvas.getAttribute('data-frame-index'))
    await current.page.waitForTimeout(170)
  }
  check('DSH 像素宠物持续循环待机帧', new Set(idleFrames).size > 1 && await pixelCanvas.getAttribute('data-animation-row') === '0', idleFrames.join('→'))
  await pixelPet.click()
  await current.page.waitForFunction(() => {
    const row = document.querySelector('.deepblue-pet[data-pack-kind="pixel-atlas"] canvas')?.getAttribute('data-animation-row')
    return row === '3' || row === '4'
  }, undefined, { timeout: 5_000 })
  check('DSH 像素宠物单击后切换互动动作', ['3', '4'].includes(await pixelCanvas.getAttribute('data-animation-row')))
  await current.page.screenshot({ path: path.join(outputRoot, 'harness-pixel-click.png'), fullPage: true })
  check('DSH 像素宠物页面没有脚本错误', current.errors.length === 0, current.errors.join(' | '))
  await current.page.close()
  await launcher.evaluate(() => window.launcher.stopHarness())

  await launcher.evaluate(petId => window.launcher.applyPet(petId), live2d.id)
  current = await startHarnessPage()
  const live2dPet = current.page.locator('.deepblue-pet[data-pack-kind="live2d"]')
  await live2dPet.waitFor({ state: 'visible', timeout: 30_000 })
  await current.page.waitForFunction(() => document.querySelector('.deepblue-pet[data-pack-kind="live2d"]')?.getAttribute('data-live2d') === 'ready', undefined, { timeout: 90_000 })
  check('DSH Live2D 加载完整动态模型而非纹理碎图', await live2dPet.getAttribute('data-live2d') === 'ready' && await live2dPet.locator('canvas').count() === 1)
  const beforeMotion = await live2dPet.getAttribute('data-live2d-motion')
  await live2dPet.click()
  await current.page.waitForFunction(previous => {
    const motion = document.querySelector('.deepblue-pet[data-pack-kind="live2d"]')?.getAttribute('data-live2d-motion')
    return Boolean(motion && motion !== previous)
  }, beforeMotion, { timeout: 10_000 })
  const clickedMotion = await live2dPet.getAttribute('data-live2d-motion')
  check('DSH Live2D 单击后真实播放模型互动动作', Boolean(clickedMotion), clickedMotion || '')
  await current.page.screenshot({ path: path.join(outputRoot, 'harness-live2d-click.png'), fullPage: true })
  check('DSH Live2D 页面没有脚本错误', current.errors.length === 0, current.errors.join(' | '))
  await current.page.close()
  await launcher.evaluate(() => window.launcher.stopHarness())
} finally {
  try { await launcher?.evaluate(() => window.launcher.stopHarness()) } catch { /* Harness may already be stopped. */ }
  await browser?.close()
  await app.close()
  await mkdir(path.dirname(activePetPath), { recursive: true })
  if (originalActivePet) await writeFile(activePetPath, originalActivePet)
  else await unlink(activePetPath).catch(() => undefined)
}

process.stderr.write(`\n截图写入 ${path.relative(root, outputRoot)}\n`)
if (failures.length) process.exit(1)
process.stderr.write('Harness 像素/Live2D 宠物待机与点击互动验收通过\n')
