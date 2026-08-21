#!/usr/bin/env node
/**
 * Drives the renderer preview through the skin store, including the external
 * source opt-in flow, and captures acceptance screenshots.
 *
 * Start the preview first:
 *   npm run dev:web
 *
 * Then:
 *   node scripts/qa-skin-store-ui.mjs [--url http://127.0.0.1:4312/] [--out docs/qa/skin-store-external]
 *
 * Exits non-zero when a step fails, an element overflows its box, or the page
 * logs a console error, so it can gate a release the same way the other qa and
 * smoke scripts do.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArguments(argv) {
  const options = { url: 'http://127.0.0.1:4312/', out: path.join(ROOT, 'docs', 'qa', 'skin-store-external') }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') options.url = argv[index + 1]
    if (argv[index] === '--out') options.out = path.resolve(ROOT, argv[index + 1])
  }
  return options
}

const options = parseArguments(process.argv.slice(2))
await mkdir(options.out, { recursive: true })

const failures = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

function check(label, condition) {
  process.stderr.write(`${condition ? 'ok  ' : 'FAIL'} ${label}\n`)
  if (!condition) failures.push(label)
}

async function shot(name) {
  await page.screenshot({ path: path.join(options.out, `${name}.png`) })
}

async function clickText(text) {
  const target = page.getByRole('button', { name: text, exact: false }).first()
  await target.waitFor({ state: 'visible', timeout: 15_000 })
  await target.click()
  await page.waitForTimeout(500)
}

try {
  await page.goto(options.url, { waitUntil: 'networkidle' })

  await clickText('皮肤商店')
  await page.waitForTimeout(600)
  check('皮肤商店页签行渲染', (await page.locator('.skin-tab-row').count()) === 1)
  check('官方目录工具栏渲染', (await page.locator('.skin-toolbar').count()) === 1)
  await shot('01-official-tab')

  await clickText('外部来源')
  check('外部来源默认显示开启确认面板', (await page.locator('.external-optin').count()) === 1)
  check('确认面板说明了未声明许可证的情况', (await page.locator('.external-optin-list').innerText()).includes('LICENSE'))
  await shot('02-external-optin')

  await clickText('我已了解，开启外部来源')
  await page.waitForTimeout(800)
  const externalCards = await page.locator('.skin-card.external').count()
  check('上游仓库列表渲染', (await page.locator('.external-sources').count()) === 1)
  check('外部素材卡片渲染', externalCards > 0)
  check('每张外部卡片都带来源标识', (await page.locator('.skin-external-tag').count()) === externalCards)
  check('每张外部卡片都带权利说明', (await page.locator('.external-notice').count()) === externalCards)
  await shot('03-external-enabled')

  const filters = page.locator('.external-source-row button')
  const filterCount = await filters.count()
  check('来源筛选按钮包含全部与各仓库', filterCount > 1)
  if (filterCount > 1) {
    await filters.nth(1).click()
    await page.waitForTimeout(500)
    check('选中单个来源后显示许可证与作者明细', (await page.locator('.external-source-detail').count()) === 1)
    await shot('04-external-source-filtered')
  }

  await clickText('官方目录')
  await page.waitForTimeout(600)
  check('切回官方目录后工具栏恢复', (await page.locator('.skin-toolbar').count()) === 1)
  check('切回官方目录后不再显示外部卡片', (await page.locator('.skin-card.external').count()) === 0)
  await shot('05-back-to-official')

  const overflow = await page.evaluate(() => {
    const bad = []
    for (const node of document.querySelectorAll('.skin-card, .external-optin, .external-sources, .skin-tab-row, .skin-notice')) {
      if (node.scrollWidth > node.clientWidth + 2) bad.push(`${node.className} ${node.scrollWidth}>${node.clientWidth}`)
    }
    return bad
  })
  check(`没有元素溢出容器${overflow.length ? `：${overflow.join(' | ')}` : ''}`, overflow.length === 0)

  const brokenImages = await page.evaluate(() => Array.from(document.images)
    .filter((image) => image.complete && image.naturalWidth === 0)
    .map((image) => image.currentSrc || image.src))
  if (brokenImages.length) {
    process.stderr.write(`note 有 ${brokenImages.length} 张图未加载（外部预览走远端 CDN，离线环境属正常）：\n`)
    for (const src of brokenImages) process.stderr.write(`     ${src}\n`)
  }

  check(`页面没有控制台错误${consoleErrors.length ? `：${consoleErrors.join(' | ')}` : ''}`, consoleErrors.length === 0)
} finally {
  await browser.close()
}

process.stderr.write(`\n截图写入 ${path.relative(ROOT, options.out)}\n`)
if (failures.length) {
  process.stderr.write(`\n${failures.length} 项检查未通过\n`)
  process.exit(1)
}
process.stderr.write('全部检查通过\n')
