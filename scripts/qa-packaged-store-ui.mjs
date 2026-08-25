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
await mkdir(path.join(launcherDataRoot, 'pets'), { recursive: true })
const bundledSkinCatalog = JSON.parse(await readFile(path.join(root, 'skin-store', 'catalog.payload.json'), 'utf8'))
const bundledPetCatalog = JSON.parse(await readFile(path.join(root, 'pet-store', 'catalog.payload.json'), 'utf8'))
const seededSkinId = bundledSkinCatalog.items.find(item => item.id === 'sd2-aurora-library-motion')?.id || bundledSkinCatalog.items[0]?.id
const seededPetId = bundledPetCatalog.items[0]?.id
if (!seededSkinId) throw new Error('Bundled skin catalog is empty')
if (!seededPetId) throw new Error('Bundled pet catalog is empty')
await writeFile(path.join(launcherDataRoot, 'launcher.json'), JSON.stringify({
  settings: {
    storageRoot: launcherDataRoot,
    storageSetupCompleted: true,
    theme: 'dark',
  },
}, null, 2))
await writeFile(path.join(launcherDataRoot, 'skins', 'favorites.json'), JSON.stringify({ schemaVersion: 1, skinIds: [seededSkinId] }, null, 2))
await writeFile(path.join(launcherDataRoot, 'skins', 'active.json'), JSON.stringify({ schemaVersion: 1, skinId: seededSkinId }, null, 2))
await writeFile(path.join(launcherDataRoot, 'pets', 'favorites.json'), JSON.stringify({ schemaVersion: 1, petIds: [seededPetId] }, null, 2))
await writeFile(path.join(launcherDataRoot, 'pets', 'active.json'), JSON.stringify({ schemaVersion: 1, petId: seededPetId }, null, 2))

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
    const visibleCards = await page.locator('.skin-card').count()
    const desktopActions = await page.locator('.skin-card .desktop-wallpaper-button').count()
    const harnessActions = await page.getByRole('button', { name: /^(应用到 Harness|Harness 已应用)$/ }).count()
    check(`${label} 每款壁纸都有独立的 Harness 与电脑桌面入口`, desktopActions === visibleCards && harnessActions === visibleCards, `cards=${visibleCards}, harness=${harnessActions}, desktop=${desktopActions}`)
    const actionsFit = await page.locator('.skin-card-actions').evaluateAll(nodes => nodes.every(node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1))
    check(`${label} 双入口按钮没有被卡片裁切`, actionsFit)
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
  if (label.includes('pets')) {
    const petState = await page.evaluate(async () => (await window.launcher.getSnapshot()).pets)
    check(`${label} 合并两个固定宠物目录`, petState.sources.length === 2 && petState.items.length >= 50, `sources=${petState.sources.map(source => `${source.id}:${source.itemCount}`).join(',')}`)
    check(`${label} 打开商店默认显示像素精灵`, await page.getByRole('button', { name: /像素精灵/ }).evaluate(button => button.classList.contains('active')) && await page.locator('.pet-card:not([data-catalog-source="pixel"])').count() === 0)
    check(`${label} 提供预览、下载、Harness 与电脑桌面入口`, await page.getByRole('button', { name: '预览', exact: true }).count() > 0 && await page.getByRole('button', { name: /^(下载|删除)$/ }).count() > 0 && await page.getByRole('button', { name: /^(应用到 Harness|Harness 已应用)$/ }).count() > 0 && await page.getByRole('button', { name: /^(应用到桌面|停止桌面宠物)$/ }).count() > 0)
    const petActionsVisible = await page.locator('.pet-card').evaluateAll(cards => cards.every(card => {
      const cardRect = card.getBoundingClientRect()
      const actions = card.querySelector('.pet-card-actions')
      if (!actions) return false
      const actionRect = actions.getBoundingClientRect()
      return actionRect.height > 20 && actionRect.top >= cardRect.top && actionRect.bottom <= cardRect.bottom + 1 && [...actions.querySelectorAll('button')].every(button => {
        const rect = button.getBoundingClientRect()
        return rect.width > 20 && rect.height > 20 && rect.bottom <= cardRect.bottom + 1
      })
    }))
    check(`${label} 宠物操作按钮实际可见且未被卡片裁切`, petActionsVisible)
    const currentTab = page.getByRole('tab', { name: /正在使用/ })
    const favoriteTab = page.getByRole('tab', { name: /我的收藏/ })
    check(`${label} 提供当前使用和收藏视图`, await currentTab.count() === 1 && await favoriteTab.count() === 1)
    await currentTab.click()
    await page.waitForTimeout(250)
    check(`${label} 当前使用视图同步真实宠物`, await page.locator('.pet-card').count() === 1 && await page.locator('.skin-active').count() === 1)
    await favoriteTab.click()
    await page.waitForTimeout(250)
    check(`${label} 我的收藏视图读取持久化收藏`, await page.locator('.pet-card').count() === 1 && await page.getByRole('button', { name: /取消收藏/ }).count() === 1)
    await page.getByRole('tab', { name: /全部商店/ }).click()
    await page.waitForTimeout(250)
    if (label === 'compact-pets') {
      await page.getByRole('button', { name: /像素精灵 800/ }).evaluate(button => button.click())
      const pixelCard = page.locator('.pet-card[data-catalog-source="pixel"]').first()
      await pixelCard.waitFor({ state: 'visible', timeout: 30_000 })
      await pixelCard.getByRole('button', { name: '预览', exact: true }).evaluate(button => button.click())
      const pixelDialog = page.locator('.pet-preview-modal[role="dialog"]')
      await pixelDialog.waitFor({ state: 'visible', timeout: 90_000 })
      const pixelCanvas = pixelDialog.locator('canvas')
      check(`${label} 像素目录可真实下载并打开帧动画预览`, await pixelCanvas.count() === 1)
      const sampledFrames = []
      for (let sample = 0; sample < 5; sample += 1) {
        sampledFrames.push(await pixelCanvas.getAttribute('data-frame-index'))
        await page.waitForTimeout(170)
      }
      check(`${label} 像素宠物预览帧持续变化`, new Set(sampledFrames).size > 1, sampledFrames.join('→'))
      await pixelDialog.locator('.pixel-atlas-preview-button').click()
      await page.waitForFunction(() => Number(document.querySelector('.pixel-atlas-preview-button canvas')?.getAttribute('data-animation-row')) > 0)
      check(`${label} 点击像素宠物会随机切换有效互动动作`, Number(await pixelCanvas.getAttribute('data-animation-row')) > 0)
      await page.screenshot({ path: path.join(outputRoot, `${label}-pixel-preview.png`) })
      await pixelDialog.getByRole('button', { name: /关闭/ }).evaluate(button => button.click())
      await page.evaluate(async () => { const pet = (await window.launcher.getSnapshot()).pets.items.find(item => item.catalogSource === 'pixel'); if (pet) await window.launcher.applyPet(pet.id) })
      const activePixel = await page.evaluate(async () => (await window.launcher.getSnapshot()).pets.activePetId)
      check(`${label} 像素帧动画可应用到 Harness`, Boolean(activePixel?.startsWith('px-')), `active=${activePixel}`)
      await page.evaluate(async () => { const pet = (await window.launcher.getSnapshot()).pets.items.find(item => item.catalogSource === 'pixel'); if (pet) await window.launcher.applyPetToDesktop(pet.id) })
      const desktopPixel = await page.evaluate(async () => (await window.launcher.getSnapshot()).pets.desktopPet)
      check(`${label} 像素帧动画可应用到电脑桌面`, Boolean(desktopPixel?.running && desktopPixel.petId.startsWith('px-')), `desktop=${JSON.stringify(desktopPixel)}`)
      const desktopWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length)
      check(`${label} 桌面宠物使用独立透明安全层`, desktopWindows === 2, `windows=${desktopWindows}`)
      await page.evaluate(() => window.launcher.stopDesktopPet())

      check(`${label} 已移除 Live2D 来源、筛选与宠物卡片`, await page.getByText('Live2D', { exact: false }).count() === 0 && await page.locator('.pet-card[data-catalog-source="live2d"]').count() === 0)
      await page.getByRole('button', { name: /全部来源/ }).evaluate(button => button.click())
      await waitForCards(page, '.pet-card')
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

  const updateCheck = page.getByRole('button', { name: '检查更新', exact: true })
  await updateCheck.click()
  const feedback = page.locator('.update-check-feedback[role="status"]')
  const updateDialog = page.locator('.runtime-update-dialog[role="dialog"]')
  await Promise.race([
    feedback.waitFor({ state: 'visible', timeout: 45_000 }),
    updateDialog.waitFor({ state: 'visible', timeout: 45_000 })
  ])
  const feedbackVisible = await feedback.isVisible().catch(() => false)
  const dialogVisible = await updateDialog.isVisible().catch(() => false)
  check('检查更新完成后保留明确的可见结果', feedbackVisible ? Boolean((await feedback.textContent())?.trim()) : dialogVisible)
  await page.screenshot({ path: path.join(outputRoot, 'update-check-feedback.png') })
  if (dialogVisible) {
    await page.waitForFunction(() => !document.querySelector('#runtimeUpdateTitle')?.textContent?.includes('正在检测'), undefined, { timeout: 45_000 })
    await updateDialog.getByRole('button', { name: /^(关闭|稍后更新)$/ }).click()
    await updateDialog.waitFor({ state: 'hidden' })
  }

  const launchedBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())
  check('启动时窗口尺寸符合桌面布局', launchedBounds.width === 1440 && launchedBounds.height === 900, `${launchedBounds.width}×${launchedBounds.height}`)
  await inspectStore(page, { button: '皮肤商店', card: '.skin-card', label: 'wide-skins', expectedWidth: launchedBounds.width, expectedHeight: launchedBounds.height })

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 720))
  await page.waitForTimeout(800)
  await inspectStore(page, { button: '皮肤商店', card: '.skin-card', label: 'compact-skins', expectedWidth: 1100, expectedHeight: 720 })
  await inspectStore(page, { button: '宠物商店', card: '.pet-card', label: 'compact-pets', expectedWidth: 1100, expectedHeight: 720 })

  await page.getByRole('button', { name: 'DSH 生态', exact: true }).click()
  await page.getByRole('heading', { name: '把成熟能力装进 DSH，不复制一套新外壳' }).waitFor({ state: 'visible' })
  check('DSH 生态页只展示明确权限的可选插件', await page.locator('.ecosystem-row').count() >= 4 && await page.locator('.ecosystem-row code').count() >= 4)
  check('DSH 生态页保留两个上游开源来源', await page.locator('.ecosystem-sources a').count() === 2)
  await page.getByRole('tab', { name: '高级能力' }).click()
  check('网络与系统级插件不默认安装', await page.locator('.ecosystem-row[data-permission="network"], .ecosystem-row[data-permission="system"]').count() > 0)
  await page.screenshot({ path: path.join(outputRoot, 'compact-ecosystem.png') })

  await page.getByRole('button', { name: '首页', exact: true }).click()
  await page.locator('.configuration-card .config-row').filter({ hasText: '运行端口' }).getByRole('button', { name: '更改' }).click()
  const portInput = page.locator('#harness-port-setting')
  await portInput.waitFor({ state: 'visible' })
  check('首页端口更改直达设置并聚焦输入框', await portInput.evaluate(input => document.activeElement === input))
  await portInput.fill('1023')
  check('非法端口不允许保存', await page.getByRole('button', { name: '保存设置' }).isDisabled())
  await portInput.fill('3180')
  check('合法端口可保存', !(await page.getByRole('button', { name: '保存设置' }).isDisabled()))
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.getByText('设置已保存，下次启动将使用端口 3180。').waitFor({ state: 'visible' })
  const savedPort = await page.evaluate(async () => (await window.launcher.getSnapshot()).settings.port)
  check('手动端口通过主进程校验并真实持久化', savedPort === 3180, `port=${savedPort}`)
  await page.screenshot({ path: path.join(outputRoot, 'compact-port-settings.png') })

  check('真实打包应用没有控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '))
} finally {
  await app.close()
}

process.stderr.write(`\n截图写入 ${path.relative(root, outputRoot)}\n`)
if (failures.length) process.exit(1)
process.stderr.write('打包应用皮肤/宠物商店视觉与交互检查全部通过\n')
