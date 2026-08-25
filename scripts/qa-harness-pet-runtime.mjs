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
  await app.firstWindow()
  for (let attempt = 0; attempt < 120 && !launcher; attempt += 1) {
    for (const candidate of app.windows()) {
      if (await candidate.evaluate(() => Boolean(window.launcher)).catch(() => false)) {
        launcher = candidate
        break
      }
    }
    if (!launcher) await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!launcher) throw new Error('未找到带启动器 IPC 的主窗口')
  try {
    await launcher.getByRole('button', { name: '启动 DeepSeek Harness', exact: true }).waitFor({ timeout: 60_000 })
  } catch (error) {
    await launcher.screenshot({ path: path.join(outputRoot, 'launcher-startup-failure.png') }).catch(() => undefined)
    const visibleText = (await launcher.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 600)
    throw new Error(`Harness 宠物验收未进入可启动首页：${visibleText || error.message}`)
  }
  await launcher.waitForFunction(async () => {
    const snapshot = await window.launcher.getSnapshot()
    return snapshot?.pets?.status && snapshot.pets.status !== 'loading' && snapshot.pets.items.length > 0
  }, undefined, { timeout: 45_000 })
  let refreshed = await launcher.evaluate(() => window.launcher.getSnapshot())
  for (let attempt = 0; attempt < 4 && !refreshed.pets.items.some(item => item.catalogSource === 'pixel'); attempt += 1) {
    await launcher.waitForTimeout(1_500)
    refreshed = await launcher.evaluate(() => window.launcher.refreshPets())
  }
  const pixel = refreshed.pets.items.find(item => item.catalogSource === 'pixel')
  if (!pixel) throw new Error('真实目录缺少像素宠物')
  check('启动器目录已彻底移除 Live2D 来源和条目', !refreshed.pets.sources.some(source => source.id === 'live2d') && !refreshed.pets.items.some(item => item.packKind === 'live2d'))

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
  const interactionRows = []
  let thirdClickBubble = ''
  for (let interaction = 0; interaction < 4; interaction += 1) {
    await pixelPet.click()
    await current.page.waitForFunction(() => Number(document.querySelector('.deepblue-pet[data-pack-kind="pixel-atlas"]')?.getAttribute('data-interaction-row')) > 0, undefined, { timeout: 5_000 })
    interactionRows.push(Number(await pixelPet.getAttribute('data-interaction-row')))
    if (interaction === 2) {
      await current.page.waitForFunction(() => {
        const text = document.querySelector('.deepblue-pet-bubble')?.textContent?.trim() || ''
        return text !== '正在查询 DeepSeek 余额…' && /(DeepSeek|模型连接|余额)/.test(text)
      }, undefined, { timeout: 15_000 })
      thirdClickBubble = (await pixelPet.locator('.deepblue-pet-bubble').textContent())?.trim() || ''
    }
    await current.page.waitForTimeout(1_180)
  }
  check('DSH 像素宠物单击从全部有效非待机动作随机播放', interactionRows.every(row => row > 0) && new Set(interactionRows).size > 1, interactionRows.join('→'))
  check('DSH 像素宠物不会连续重复同一互动动作', interactionRows.every((row, index) => index === 0 || row !== interactionRows[index - 1]), interactionRows.join('→'))
  check('DSH 网页宠物前两次随机对话、第 3 次必定返回 DeepSeek 余额状态', Boolean(thirdClickBubble))
  if (process.env.QA_REQUIRE_LIVE_DEEPSEEK_BALANCE === '1') {
    check('DSH 网页宠物第 3 次真实调用官方接口返回金额', /^DeepSeek 余额：[\u00a5$]/.test(thirdClickBubble))
  }

  await current.page.evaluate(() => window.__deepblueWebPetDebug?.triggerPresence())
  await current.page.waitForFunction(() => document.querySelector('.deepblue-pet')?.getAttribute('data-interaction-source') === 'presence')
  check('DSH 网页宠物待机后会主动随机展示存在感动作', Number(await pixelPet.getAttribute('data-interaction-row')) > 0)

  await current.page.waitForTimeout(1_180)
  const beforeDrag = await pixelPet.boundingBox()
  if (!beforeDrag) throw new Error('无法读取网页宠物位置')
  await current.page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2)
  await current.page.mouse.down()
  await current.page.mouse.move(beforeDrag.x - 130, beforeDrag.y - 90, { steps: 8 })
  await current.page.mouse.up()
  const draggedPosition = await pixelPet.evaluate(node => ({ left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top), source: node.getAttribute('data-interaction-source') }))
  check('DSH 网页宠物支持拖拽且不会误触单击互动', draggedPosition.left < beforeDrag.x && draggedPosition.top < beforeDrag.y && draggedPosition.source === 'idle', JSON.stringify(draggedPosition))
  const savedPosition = await current.page.evaluate(petId => JSON.parse(localStorage.getItem(`deepblue-pet-position:${petId}`) || 'null'), pixel.id)
  check('DSH 网页宠物释放后持久保存位置', Number.isFinite(savedPosition?.x) && Number.isFinite(savedPosition?.y), JSON.stringify(savedPosition))
  await current.page.reload({ waitUntil: 'domcontentloaded' })
  const reloadedPet = current.page.locator('.deepblue-pet[data-pack-kind="pixel-atlas"]')
  await reloadedPet.waitFor({ state: 'visible', timeout: 30_000 })
  const restoredPosition = await reloadedPet.evaluate(node => ({ left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top) }))
  check('DSH 网页宠物刷新后恢复拖拽位置', Math.abs(restoredPosition.left - savedPosition.x) < 2 && Math.abs(restoredPosition.top - savedPosition.y) < 2, `${JSON.stringify(savedPosition)} -> ${JSON.stringify(restoredPosition)}`)
  await current.page.screenshot({ path: path.join(outputRoot, 'harness-pixel-click.png'), fullPage: true })
  check('DSH 像素宠物页面没有脚本错误', current.errors.length === 0, current.errors.join(' | '))
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
process.stderr.write('Harness 像素宠物待机、随机互动、拖拽与位置持久化验收通过\n')
