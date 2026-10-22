import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'output/qa-040-games', process.env.QA_GAMES_RUN || String(Date.now()))
const profile = path.join(output, 'profile')
const storage = path.join(profile, 'storage')
const userData = path.join(profile, 'user-data')
await Promise.all([storage, userData].map(folder => mkdir(folder, { recursive: true })))
await writeFile(path.join(userData, 'launcher.json'), JSON.stringify({ settings: { storageRoot: storage, storageSetupCompleted: true, autoOpen: false, theme: 'dark' } }))
const env = { ...process.env, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'), DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: process.env.QA_LAUNCHER_EXE || path.join(root, 'release/win-unpacked/深蓝DeepSeekHarness启动器.exe'), args: [`--user-data-dir=${userData}`], env })
const report = { passed: false, testedAt: new Date().toISOString(), output }
let game
try {
  const page = await app.firstWindow()
  await page.locator('#root > *').waitFor({ timeout: 60000 })
  let snapshot
  for (let attempt = 0; attempt < 90; attempt++) {
    snapshot = await page.evaluate(() => window.launcher.getSnapshot())
    if (snapshot.discovery.status !== 'loading' && snapshot.discovery.games.some(game => game.mode === 'hosted_playable')) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  report.discovery = { status: snapshot.discovery.status, message: snapshot.discovery.message, total: snapshot.discovery.games.length }
  const official = await (await fetch('https://shenlanai.com/api/games.php?action=list')).json()
  const games = snapshot.discovery.games.filter(game => game.mode === 'hosted_playable')
  assert.deepEqual(games.map(game => game.slug), official.games.map(game => game.slug))
  report.gamesCatalog = { source: 'https://shenlanai.com/api/games.php?action=list', count: games.length, serverOrderPreserved: true }
  const onboarding = page.getByRole('button', { name: '暂时不用', exact: true })
  if (await onboarding.isVisible()) await onboarding.click()
  await page.getByRole('button', { name: 'AI 游戏', exact: true }).click()
  const cta = page.getByRole('link', { name: '去深蓝试玩学习' })
  await cta.waitFor()
  assert.equal(await cta.getAttribute('href'), 'https://shenlanai.com/ai-games/')
  report.externalLearningCta = { url: 'https://shenlanai.com/ai-games/', passed: true }
  await page.screenshot({ path: path.join(output, 'catalog.png') })
  const slug = process.env.QA_GAME_SLUG || games[0].slug
  const selected = games.find(game => game.slug === slug)
  assert.ok(selected)
  await app.evaluate(({ Menu }) => { const original = Menu.buildFromTemplate.bind(Menu); Menu.buildFromTemplate = items => { const menu = original(items); if (items[0]?.label === '游戏试玩') globalThis.__qaGameMenu = menu; return menu } })
  const childPromise = app.waitForEvent('window')
  const card = page.locator('.game-discovery-card').filter({ has: page.getByRole('heading', { name: selected.title, exact: true }) }).first()
  // Entering this page also refreshes its directory. Let that operation finish
  // before invoking the same UI action used by a normal user.
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await page.evaluate(() => window.launcher.getSnapshot())).discovery.status !== 'loading') break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  await card.getByRole('button', { name: '启动器内试玩', exact: true }).click()
  game = await childPromise
  await game.waitForURL(`https://shenlanai.com/ai-games/player.html?slug=${slug}`)
  const childId = await app.evaluate(({ BrowserWindow }, slug) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('slug=' + slug))?.id, slug)
  assert.ok(childId)
  const preferences = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.getLastWebPreferences(), childId)
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.ok(!preferences.preload)
  assert.deepEqual(await game.evaluate(() => [typeof require, typeof window.launcher]), ['undefined', 'undefined'])
  const before = app.windows().length
  await game.evaluate(() => window.open('https://example.com/'))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(app.windows().length, before)
  const playerUrl = game.url()
  await game.evaluate(() => { location.href = 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(game.url(), playerUrl)
  const blockedDownload = await app.evaluate(({ BrowserWindow }, id) => { let blocked = false; BrowserWindow.fromId(id).webContents.session.emit('will-download', { preventDefault() { blocked = true } }); return blocked }, childId)
  assert.equal(blockedDownload, true)
  // Exercise the actual failure page and native retry command without changing
  // the website or creating additional sessions.
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.session.webRequest.onBeforeRequest({ urls: ['https://shenlanai.com/ai-games/player.html*'] }, (_details, done) => done({ cancel: true })), childId)
  await app.evaluate(() => globalThis.__qaGameMenu.items[0].submenu.items[0].click())
  await game.getByRole('heading', { name: '游戏暂时无法打开' }).waitFor()
  await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).webContents.session.webRequest.onBeforeRequest(null); globalThis.__qaGameMenu.items[0].submenu.items[0].click() }, childId)
  await game.waitForURL(playerUrl)
  const start = game.locator('#start-game')
  await start.waitFor()
  await game.waitForFunction(() => !document.querySelector('#start-game').disabled)
  let started = false, ended = false
  game.on('response', response => { if (response.url().includes('action=start_session') && response.ok()) started = true; if (response.url().includes('action=end_session') && response.ok()) ended = true })
  await start.click()
  await game.waitForFunction(() => document.querySelector('#player-status').dataset.state === 'playing', undefined, { timeout: 90000 })
  const frameElement = game.locator('#runtime-frame iframe')
  await frameElement.waitFor()
  const runtimeFrame = await (await frameElement.elementHandle()).contentFrame()
  assert.ok(runtimeFrame && runtimeFrame.url().startsWith('https://play.shenlanai.com/h5-runtime/'))
  await runtimeFrame.waitForLoadState('domcontentloaded')
  const runtimeText = await runtimeFrame.locator('body').innerText()
  await runtimeFrame.locator('body').click({ position: { x: 240, y: 220 } })
  await runtimeFrame.locator('body').press('Enter')
  await runtimeFrame.locator('body').press('ArrowRight')
  await game.screenshot({ path: path.join(output, 'gameplay.png') })
  const endResponse = game.waitForResponse(response => response.url().includes('action=end_session') && response.ok())
  await game.locator('#exit-game').click()
  await game.waitForFunction(() => document.querySelector('#player-status').dataset.state === 'idle')
  await endResponse
  assert.ok(started && ended, 'Normal guest session start/end must both succeed')
  report.realTask = { kind: 'public-shenlan-guest-gameplay', passed: true, gameSlug: slug, interactionVerified: true, guestSessionEnded: true, runtimeText: runtimeText.slice(0, 1200) }
  // Keep the test's main-process inspector alive while the real parent/child
  // destruction runs; production normally quits when its final window closes.
  await app.evaluate(({ app }) => { app.removeAllListeners('window-all-closed') })
  await app.evaluate(({ BrowserWindow }, id) => { setTimeout(() => BrowserWindow.fromId(id).getParentWindow().destroy(), 50) }, childId)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await app.evaluate(({ BrowserWindow }, id) => !BrowserWindow.fromId(id), childId), true)
  report.gameWindow = { passed: true, sandboxed: true, contextIsolated: true, nodeIntegrationDisabled: true, noPreload: true, popupsDenied: true, unexpectedNavigationDenied: true, downloadsBlocked: true, failureRecovery: true, parentCloseCleanup: true }
  report.passed = true
} catch (error) { report.error = String(error?.stack || error); throw error }
finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const cleanup = setTimeout(() => app.process().kill(), 5000); cleanup.unref()
  await app.close().catch(() => {}); clearTimeout(cleanup)
  console.log(JSON.stringify(report, null, 2))
}
