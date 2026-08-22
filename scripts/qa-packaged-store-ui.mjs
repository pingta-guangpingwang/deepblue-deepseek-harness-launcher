#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_STORE_OUTPUT || path.join('output', 'playwright', 'packaged-catalog-pagination'))
const profileRoot = path.join(outputRoot, 'profile')
const appDataRoot = path.join(profileRoot, 'appdata')
const localAppDataRoot = path.join(profileRoot, 'localappdata')
const launcherDataRoot = path.join(appDataRoot, 'deepseek-harness-launcher')

await rm(outputRoot, { recursive: true, force: true })
await mkdir(launcherDataRoot, { recursive: true })
await mkdir(localAppDataRoot, { recursive: true })
await mkdir(path.join(launcherDataRoot, 'skins'), { recursive: true })
const bundledSkinCatalog = JSON.parse(await readFile(path.join(root, 'skin-store', 'catalog.payload.json'), 'utf8'))
const seededSkinId = bundledSkinCatalog.items.find(item => item.id === 'sd2-aurora-library-motion')?.id || bundledSkinCatalog.items[0]?.id
if (!seededSkinId) throw new Error('Bundled skin catalog is empty')
await writeFile(path.join(launcherDataRoot, 'launcher.json'), JSON.stringify({
  settings: {
    storageRoot: launcherDataRoot,
    storageSetupCompleted: true,
    theme: 'dark',
  },
}, null, 2))
await writeFile(path.join(launcherDataRoot, 'skins', 'favorites.json'), JSON.stringify({ schemaVersion: 1, skinIds: [seededSkinId] }, null, 2))
await writeFile(path.join(launcherDataRoot, 'skins', 'active.json'), JSON.stringify({ schemaVersion: 1, skinId: seededSkinId }, null, 2))

const failures = []
function check(label, condition, detail = '') {
  process.stderr.write(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}\n`)
  if (!condition) failures.push(label)
}

async function waitForCards(page, selector) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(700)
}

async function inspectStore(page, { button, card, label, expectedWidth, expectedHeight }) {
  await page.getByRole('button', { name: button, exact: true }).click()
  await waitForCards(page, card)
  const firstPage = page.locator('.catalog-page-buttons button').filter({ hasText: /^1$/ }).first()
  if (await firstPage.count()) {
    await firstPage.click()
    await page.waitForTimeout(350)
  }

  const firstMetrics = await page.evaluate((selector) => {
    const pageNode = document.querySelector('.page-scroll.catalog-fixed-page')
    const viewportNode = document.querySelector('.catalog-grid-viewport')
    const gridNode = document.querySelector(selector)?.parentElement
    const pagerNode = document.querySelector('.catalog-pagination')
    const current = document.querySelector('.catalog-page-buttons button[aria-current="page"]')
    const rect = (node) => {
      if (!node) return null
      const value = node.getBoundingClientRect()
      return { top: value.top, bottom: value.bottom, width: value.width, height: value.height }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
        canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
        scrollY,
      },
      pageOverflow: pageNode ? pageNode.scrollHeight - pageNode.clientHeight : 999,
      viewportOverflow: viewportNode ? viewportNode.scrollHeight - viewportNode.clientHeight : 999,
      gridOverflow: gridNode ? gridNode.scrollHeight - gridNode.clientHeight : 999,
      cards: document.querySelectorAll(selector).length,
      current: current?.textContent?.trim(),
      page: rect(pageNode),
      grid: rect(gridNode),
      pager: rect(pagerNode),
      pagerText: pagerNode?.textContent?.replace(/\s+/g, ' ').trim() || '',
    }
  }, card)

  check(`${label} 使用真实窗口尺寸`, firstMetrics.viewport.width === expectedWidth && firstMetrics.viewport.height === expectedHeight, `${firstMetrics.viewport.width}×${firstMetrics.viewport.height}`)
  check(`${label} 页面本身不能纵向滚动`, !firstMetrics.document.canScrollY && firstMetrics.pageOverflow <= 2, `document=${firstMetrics.document.scrollHeight}/${firstMetrics.document.clientHeight}, pageOverflow=${firstMetrics.pageOverflow}`)
  check(`${label} 卡片区域没有第二条纵向滚动`, firstMetrics.viewportOverflow <= 2 && firstMetrics.gridOverflow <= 2, `viewportOverflow=${firstMetrics.viewportOverflow}, gridOverflow=${firstMetrics.gridOverflow}`)
  check(`${label} 首屏显示自适应卡片`, firstMetrics.cards > 0, `cards=${firstMetrics.cards}`)
  check(`${label} 数字分页从第 1 页开始`, firstMetrics.current === '1' && /1/.test(firstMetrics.pagerText), firstMetrics.pagerText)
  check(`${label} 分页位于窗口内`, Boolean(firstMetrics.pager && firstMetrics.pager.bottom <= firstMetrics.viewport.height + 1), `bottom=${firstMetrics.pager?.bottom}`)

  await page.mouse.move(Math.floor(expectedWidth * 0.72), Math.floor(expectedHeight * 0.54))
  await page.mouse.wheel(0, 1200)
  await page.waitForTimeout(250)
  const wheelResult = await page.evaluate(() => ({ scrollY, active: document.querySelector('.catalog-page-buttons button[aria-current="page"]')?.textContent?.trim() }))
  check(`${label} 鼠标滚轮不会把商店向下推走`, wheelResult.scrollY === 0 && wheelResult.active === '1', `scrollY=${wheelResult.scrollY}`)

  await page.screenshot({ path: path.join(outputRoot, `${label}-page-1.png`) })
  if (label.includes('skins')) {
    const skinState = await page.evaluate(async () => (await window.launcher.getSnapshot()).skins)
    const stateDetail = `active=${skinState.activeSkinId || 'none'}, favorites=${skinState.favoriteSkinIds.join(',') || 'none'}, matchingActive=${skinState.items.some(item => item.id === skinState.activeSkinId)}`
    const currentTab = page.getByRole('tab', { name: /正在使用/ })
    const favoriteTab = page.getByRole('tab', { name: /我的收藏/ })
    check(`${label} 提供当前使用和收藏视图`, await currentTab.count() === 1 && await favoriteTab.count() === 1)
    await currentTab.click()
    await page.waitForTimeout(250)
    check(`${label} 当前使用视图同步真实皮肤`, await page.locator('.skin-card').count() === 1 && await page.locator('.skin-active').count() === 1, stateDetail)
    await page.screenshot({ path: path.join(outputRoot, `${label}-current.png`) })
    await favoriteTab.click()
    await page.waitForTimeout(250)
    check(`${label} 我的收藏视图读取持久化收藏`, await page.locator('.skin-card').count() === 1 && await page.getByRole('button', { name: /取消收藏/ }).count() === 1, stateDetail)
    await page.screenshot({ path: path.join(outputRoot, `${label}-favorites.png`) })
    await page.getByRole('tab', { name: /全部商店/ }).click()
    await page.waitForTimeout(250)
    if (label === 'wide-skins') {
      const addFavorite = page.getByRole('button', { name: /^收藏/ }).first()
      await addFavorite.click()
      await page.waitForTimeout(250)
      await favoriteTab.click()
      await page.waitForTimeout(250)
      check(`${label} 可从商店收藏并立即进入我的收藏`, await page.locator('.skin-card').count() === 2)
      await page.getByRole('button', { name: /^取消收藏/ }).last().click()
      await page.waitForTimeout(250)
      check(`${label} 可取消收藏并恢复原收藏集`, await page.locator('.skin-card').count() === 1)
      await page.getByRole('tab', { name: /全部商店/ }).click()
      await page.waitForTimeout(250)
    }
  }
  const secondPage = page.locator('.catalog-page-buttons button').filter({ hasText: /^2$/ }).first()
  check(`${label} 提供第 2 页按钮`, await secondPage.count() === 1)
  if (await secondPage.count()) {
    await secondPage.click()
    await page.waitForTimeout(700)
    const active = await page.locator('.catalog-page-buttons button[aria-current="page"]').textContent()
    check(`${label} 单击可切换到第 2 页`, active?.trim() === '2', `active=${active?.trim()}`)
    await page.screenshot({ path: path.join(outputRoot, `${label}-page-2.png`) })
  }

  return firstMetrics
}

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${launcherDataRoot}`],
  env: {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
  },
})

try {
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: '皮肤商店', exact: true }).waitFor({ timeout: 20_000 })

  const launchedBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())
  check('启动时窗口尺寸符合桌面布局', launchedBounds.width === 1440 && launchedBounds.height === 900, `${launchedBounds.width}×${launchedBounds.height}`)
  await inspectStore(page, { button: '皮肤商店', card: '.skin-card', label: 'wide-skins', expectedWidth: launchedBounds.width, expectedHeight: launchedBounds.height })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 720))
  await page.waitForTimeout(800)
  await inspectStore(page, { button: '皮肤商店', card: '.skin-card', label: 'compact-skins', expectedWidth: 1100, expectedHeight: 720 })
  await inspectStore(page, { button: '宠物商店', card: '.pet-card', label: 'compact-pets', expectedWidth: 1100, expectedHeight: 720 })

  check('真实打包应用没有控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '))
} finally {
  await app.close()
}

process.stderr.write(`\n截图写入 ${path.relative(root, outputRoot)}\n`)
if (failures.length) process.exit(1)
process.stderr.write('打包应用皮肤/宠物商店视觉与交互检查全部通过\n')
