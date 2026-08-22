#!/usr/bin/env node
/**
 * Verifies that skin and pet catalogs use adaptive numbered pages without
 * introducing a second vertical scroll area.
 *
 * Start `npm run dev:web`, then run:
 *   node scripts/qa-skin-store-ui.mjs [--url http://127.0.0.1:4312/] [--out docs/qa/catalog-pagination]
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = { url: 'http://127.0.0.1:4312/', out: path.join(root, 'docs', 'qa', 'catalog-pagination') }
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--url') options.url = process.argv[++index]
  if (process.argv[index] === '--out') options.out = path.resolve(root, process.argv[++index])
}
await mkdir(options.out, { recursive: true })

const failures = []
function check(label, condition) {
  process.stderr.write(`${condition ? 'ok  ' : 'FAIL'} ${label}\n`)
  if (!condition) failures.push(label)
}

const browser = await chromium.launch({ headless: true, channel: 'chromium' })
try {
  for (const viewport of [{ width: 1440, height: 980, label: 'wide' }, { width: 1100, height: 720, label: 'compact' }]) {
    const page = await browser.newPage({ viewport })
    const consoleErrors = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.goto(options.url, { waitUntil: 'networkidle' })
    if (await page.getByRole('dialog', { name: '先确认运行资源放在哪里' }).count()) await page.getByRole('button', { name: '使用此位置并开始' }).click()
    if (await page.locator('.runtime-update-backdrop').count()) await page.getByRole('button', { name: '稍后更新' }).click()

    for (const store of [{ button: '皮肤商店', grid: '.skin-card', label: 'skins' }, { button: '宠物商店', grid: '.pet-card', label: 'pets' }]) {
      await page.getByRole('button', { name: store.button, exact: true }).click()
      await page.waitForTimeout(400)
      const metrics = await page.evaluate((selector) => {
        const pageNode = document.querySelector('.page-scroll.catalog-fixed-page')
        const viewportNode = document.querySelector('.catalog-grid-viewport')
        const current = document.querySelector('.catalog-page-buttons button[aria-current="page"]')
        return {
          pageOverflow: pageNode ? pageNode.scrollHeight - pageNode.clientHeight : 999,
          viewportOverflow: viewportNode ? viewportNode.scrollHeight - viewportNode.clientHeight : 999,
          cards: document.querySelectorAll(selector).length,
          current: current?.textContent?.trim()
        }
      }, store.grid)
      check(`${viewport.label} ${store.label} 固定页面无纵向滚动`, metrics.pageOverflow <= 2 && metrics.viewportOverflow <= 2)
      check(`${viewport.label} ${store.label} 显示自适应卡片`, metrics.cards > 0)
      check(`${viewport.label} ${store.label} 数字分页从第 1 页开始`, metrics.current === '1')

      const secondPage = page.locator('.catalog-page-buttons button').filter({ hasText: /^2$/ })
      if (await secondPage.count()) {
        await secondPage.first().evaluate(button => button.click())
        await page.waitForTimeout(600)
        check(`${viewport.label} ${store.label} 可切换到第 2 页`, await page.locator('.catalog-page-buttons button[aria-current="page"]').textContent() === '2')
      }
      await page.screenshot({ path: path.join(options.out, `${viewport.label}-${store.label}.png`) })
    }
    check(`${viewport.label} 页面没有控制台错误${consoleErrors.length ? `：${consoleErrors.join(' | ')}` : ''}`, consoleErrors.length === 0)
    await page.close()
  }
} finally {
  await browser.close()
}

process.stderr.write(`\n截图写入 ${path.relative(root, options.out)}\n`)
if (failures.length) process.exit(1)
process.stderr.write('全部检查通过\n')
