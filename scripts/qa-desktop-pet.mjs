#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  process.stderr.write('Desktop pet QA is only available on Windows.\n')
  process.exit(0)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_PET_OUTPUT || path.join('output', 'playwright', 'desktop-pet'))
const appDataRoot = path.join(outputRoot, 'profile', 'appdata')
const localAppDataRoot = path.join(outputRoot, 'profile', 'localappdata')
const launcherDataRoot = path.join(appDataRoot, 'deepseek-harness-launcher')
const powershell = path.join(path.resolve(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const captureHelper = path.join(root, 'scripts', 'capture-desktop-qa.ps1')

function captureDesktop(filename, compareTo, minimumChangeRatio = 0) {
  const outputPath = path.join(outputRoot, filename)
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', captureHelper, '-OutputPath', outputPath]
  if (compareTo) args.push('-CompareTo', compareTo, '-MinimumChangeRatio', String(minimumChangeRatio))
  const result = JSON.parse(execFileSync(powershell, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim())
  process.stderr.write(`ok  桌面截图：${result.path}${typeof result.changeRatio === 'number' ? `（可见变化 ${(result.changeRatio * 100).toFixed(2)}%）` : ''}\n`)
  return result.path
}

function checkTransfer(petId, snapshot) {
  const transfer = snapshot.pets.transfers[petId]
  if (transfer?.operation !== 'desktop' || transfer.status !== 'completed') throw new Error(`桌面宠物应用失败：${transfer?.message || '未返回状态'}`)
  if (snapshot.pets.desktopPet?.petId !== petId || snapshot.pets.desktopPet.running !== true) throw new Error(`桌面宠物运行状态不正确：${JSON.stringify(snapshot.pets.desktopPet)}`)
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(launcherDataRoot, { recursive: true })
await mkdir(localAppDataRoot, { recursive: true })
await writeFile(path.join(launcherDataRoot, 'launcher.json'), JSON.stringify({
  settings: { storageRoot: launcherDataRoot, storageSetupCompleted: true, theme: 'dark' }
}, null, 2))

const baseline = captureDesktop('desktop-before.png')
let app
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${launcherDataRoot}`],
    env: { ...process.env, APPDATA: appDataRoot, LOCALAPPDATA: localAppDataRoot }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.launcher), undefined, { timeout: 20_000 })
  const catalog = await page.evaluate(() => window.launcher.refreshPets())
  const pet = catalog.pets.items.find(item => item.catalogSource === 'pixel' && item.packKind === 'pixel-atlas')
    || catalog.pets.items.find(item => item.packKind !== 'live2d')
  if (!pet) throw new Error('签名宠物目录中没有可运行的桌面宠物')

  const result = await page.evaluate(petId => window.launcher.applyPetToDesktop(petId), pet.id)
  checkTransfer(pet.id, result)
  await page.waitForTimeout(500)
  const petPage = app.windows().find(candidate => candidate !== page)
  if (!petPage) throw new Error('桌面宠物状态已启动，但没有找到独立渲染窗口')
  await petPage.waitForLoadState('domcontentloaded')
  await petPage.locator('#pet').waitFor({ state: 'visible', timeout: 20_000 })
  const windowState = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => ({ visible: window.isVisible(), transparent: window.isFocusable(), bounds: window.getBounds() })))
  if (windowState.length !== 2 || !windowState.every(window => window.visible)) throw new Error(`桌面宠物未创建独立可见层：${JSON.stringify(windowState)}`)
  process.stderr.write(`ok  独立桌面宠物窗口已创建：${pet.name}\n`)

  const firstFrame = await petPage.locator('canvas').getAttribute('data-frame-index')
  await petPage.waitForTimeout(500)
  const nextFrame = await petPage.locator('canvas').getAttribute('data-frame-index')
  if (pet.packKind === 'pixel-atlas' && (!firstFrame || firstFrame === nextFrame)) throw new Error('桌面像素宠物帧动画没有播放')
  process.stderr.write('ok  桌面宠物帧动画正在播放\n')

  await petPage.locator('#pet').click({ force: true })
  if (!(await petPage.locator('#bubble').evaluate(node => node.classList.contains('show')))) throw new Error('点击桌面宠物后没有触发交互')
  if (pet.packKind === 'pixel-atlas') {
    const interactionRow = await petPage.locator('canvas').getAttribute('data-animation-row')
    if (!interactionRow || interactionRow === '0') throw new Error('点击像素宠物后没有切换到互动动作行')
  }
  await petPage.screenshot({ path: path.join(outputRoot, 'desktop-pet-window.png'), omitBackground: true })
  process.stderr.write('ok  桌面宠物可点击交互\n')

  const applied = captureDesktop('desktop-pet-applied.png', baseline, 0.0005)
  await page.evaluate(() => window.launcher.windowAction('close'))
  await page.waitForTimeout(800)
  const persistent = await page.evaluate(() => window.launcher.getSnapshot())
  checkTransfer(pet.id, persistent)
  captureDesktop('desktop-pet-main-hidden.png', applied, 0)
  process.stderr.write('ok  主窗口关闭后桌面宠物仍在运行\n')

  const stopped = await page.evaluate(() => window.launcher.stopDesktopPet())
  if (stopped.pets.desktopPet) throw new Error('停止后桌面宠物状态未清除')
  await petPage.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined)
  const remaining = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length)
  if (remaining !== 1) throw new Error(`停止后仍有桌面宠物窗口：${remaining}`)
  process.stderr.write('ok  桌面宠物停止后安全层与持久化状态已清除\n')
} finally {
  if (app) await app.close().catch(() => undefined)
  captureDesktop('desktop-after-cleanup.png')
}

process.stderr.write('打包应用桌面宠物的下载、动画、点击、持续运行与停止实测全部通过\n')
