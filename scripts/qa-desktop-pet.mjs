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
    || catalog.pets.items[0]
  if (!pet) throw new Error('签名宠物目录中没有可运行的桌面宠物')

  const result = await page.evaluate(petId => window.launcher.applyPetToDesktop(petId), pet.id)
  checkTransfer(pet.id, result)
  await page.waitForTimeout(500)
  const petPage = app.windows().find(candidate => candidate !== page)
  if (!petPage) throw new Error('桌面宠物状态已启动，但没有找到独立渲染窗口')
  await petPage.waitForLoadState('domcontentloaded')
  await petPage.locator('#pet').waitFor({ state: 'visible', timeout: 20_000 })
  const windowState = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => ({ visible: window.isVisible(), focusable: window.isFocusable(), alwaysOnTop: window.isAlwaysOnTop(), bounds: window.getBounds(), url: window.webContents.getURL() })))
  if (windowState.length !== 2 || !windowState.every(window => window.visible)) throw new Error(`桌面宠物未创建独立可见层：${JSON.stringify(windowState)}`)
  const petWindowState = windowState.find(window => window.url.includes('desktop-pet-host.html'))
  if (!petWindowState?.alwaysOnTop) throw new Error(`桌面宠物没有保持系统最上层：${JSON.stringify(windowState)}`)
  process.stderr.write(`ok  独立桌面宠物窗口已创建并保持系统最上层：${pet.name}\n`)

  const firstFrame = await petPage.locator('canvas').getAttribute('data-frame-index')
  await petPage.waitForTimeout(500)
  const nextFrame = await petPage.locator('canvas').getAttribute('data-frame-index')
  if (pet.packKind === 'pixel-atlas' && (!firstFrame || firstFrame === nextFrame)) throw new Error('桌面像素宠物帧动画没有播放')
  process.stderr.write('ok  桌面宠物帧动画正在播放\n')

  const interactionRows = []
  for (let interaction = 0; interaction < 4; interaction += 1) {
    await petPage.evaluate(() => window.__deepbluePetDebug?.triggerClick())
    await petPage.waitForFunction(() => Number(document.querySelector('#pet')?.getAttribute('data-interaction-row')) > 0)
    interactionRows.push(Number(await petPage.locator('#pet').getAttribute('data-interaction-row')))
    await petPage.waitForTimeout(1_180)
  }
  if (!(await petPage.locator('#bubble').evaluate(node => node.classList.contains('show')))) throw new Error('点击桌面宠物后没有触发交互')
  if (pet.packKind === 'pixel-atlas') {
    if (!interactionRows.every((row, index) => row > 0 && (index === 0 || row !== interactionRows[index - 1]))) throw new Error(`桌面像素宠物随机动作重复或无效：${interactionRows.join('→')}`)
  }
  await petPage.screenshot({ path: path.join(outputRoot, 'desktop-pet-window.png'), omitBackground: true })
  process.stderr.write(`ok  桌面宠物随机点击动作不连续重复：${interactionRows.join('→')}\n`)

  await petPage.evaluate(() => window.__deepbluePetDebug?.triggerPresence())
  await petPage.waitForFunction(() => document.querySelector('#pet')?.getAttribute('data-interaction-source') === 'presence')
  process.stderr.write('ok  桌面宠物待机后可主动随机展示存在感动作\n')
  await petPage.waitForTimeout(1_180)

  const beforeDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('desktop-pet-host.html'))?.getBounds())
  if (!beforeDrag) throw new Error('拖拽前无法读取桌面宠物窗口位置')
  await petPage.evaluate(() => {
    const target = document.querySelector('#pet')
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 71, clientX: 90, clientY: 120, screenX: 900, screenY: 600 }))
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 71, clientX: 170, clientY: 180, screenX: 980, screenY: 660 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 71, clientX: 170, clientY: 180, screenX: 980, screenY: 660 }))
  })
  await petPage.waitForTimeout(500)
  const afterDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('desktop-pet-host.html'))?.getBounds())
  if (!afterDrag || (afterDrag.x === beforeDrag.x && afterDrag.y === beforeDrag.y)) throw new Error(`桌面宠物拖拽未移动窗口：${JSON.stringify(beforeDrag)} -> ${JSON.stringify(afterDrag)}`)
  if (await petPage.locator('#pet').getAttribute('data-interaction-source') !== 'idle') throw new Error('拖拽桌面宠物被误判成单击互动')
  const persistedPosition = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(launcherDataRoot, 'pets', 'desktop-state.json'), 'utf8')).position
  if (persistedPosition?.x !== afterDrag.x || persistedPosition?.y !== afterDrag.y) throw new Error(`桌面宠物位置未持久化：${JSON.stringify(persistedPosition)} != ${JSON.stringify(afterDrag)}`)
  process.stderr.write(`ok  桌面宠物按住拖拽、单击区分与位置持久化：(${afterDrag.x}, ${afterDrag.y})\n`)

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
