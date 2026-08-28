#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const outputRoot = path.resolve(root, process.env.QA_COMMUNITY_OUTPUT || path.join('output', 'playwright', 'community-packaged'))
const appDataRoot = path.join(outputRoot, 'profile', 'appdata')
const localAppDataRoot = path.join(outputRoot, 'profile', 'localappdata')
const launcherDataRoot = path.join(appDataRoot, 'deepseek-harness-launcher')
const storageRoot = path.join(outputRoot, 'profile', 'storage')

await rm(outputRoot, { recursive: true, force: true })
await Promise.all([launcherDataRoot, localAppDataRoot, storageRoot].map((target) => mkdir(target, { recursive: true })))
await writeFile(path.join(launcherDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: { storageRoot, storageSetupCompleted: true, autoOpen: false, theme: 'light', port: 32888 }
}, null, 2)}\n`, 'utf8')

const failures = []
function check(label, condition) {
  process.stderr.write(`${condition ? 'ok  ' : 'FAIL'} ${label}\n`)
  if (!condition) failures.push(label)
}

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${launcherDataRoot}`, '--disable-gpu'],
  env: { ...process.env, APPDATA: appDataRoot, LOCALAPPDATA: localAppDataRoot }
})

try {
  const page = await app.firstWindow()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const location = message.location().url
    consoleErrors.push(`${message.text()}${location ? ` @ ${location}` : ''}`)
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.launcher?.communityRequest), undefined, { timeout: 30_000 })

  async function dismissUpdateDialog() {
    const dialog = page.locator('.runtime-update-backdrop')
    if (await dialog.count() && await dialog.isVisible()) {
      const later = dialog.getByRole('button', { name: /^(?:关闭|稍后更新)$/ })
      if (await later.count()) await later.click()
    }
  }

  const publicData = await page.evaluate(async () => {
    const chat = await window.launcher.communityRequest({ scope: 'chat', method: 'GET', channel: 'deepseek' })
    const forum = await window.launcher.communityRequest({ scope: 'forum', method: 'GET', action: 'bootstrap', realm: 'tool', circle: 'deepseek', sort: 'latest' })
    let protectedWrite = ''
    try {
      await window.launcher.communityRequest({ scope: 'chat', method: 'POST', action: 'send_chat', channel: 'deepseek', body: '未登录验收消息，不应发送' })
    } catch (error) {
      protectedWrite = error instanceof Error ? error.message : String(error)
    }
    return {
      chatOk: chat.ok === true,
      chatMessages: Array.isArray(chat.messages) ? chat.messages.length : -1,
      forumOk: forum.ok === true,
      forumThreads: Array.isArray(forum.threads) ? forum.threads.length : -1,
      protectedWrite
    }
  })
  check('真实聊天公开接口通过 IPC 返回数据', publicData.chatOk && publicData.chatMessages > 0 && publicData.chatMessages <= 100)
  check('真实帖子公开接口通过 IPC 返回数据', publicData.forumOk && publicData.forumThreads > 0)
  check('未登录写入在启动器内被拦截', /请先登录/.test(publicData.protectedWrite))

  await page.getByRole('button', { name: '兴趣社区', exact: true }).click()
  await page.getByRole('tab', { name: 'DeepSeek 房间', exact: true }).waitFor({ state: 'visible' })
  await page.locator('.community-message').first().waitFor({ state: 'visible', timeout: 30_000 })
  check('启动器原生社区包含 3 个主入口', await page.getByRole('tab').count() >= 3)
  check('启动器只保留最新 100 条聊天', await page.locator('.community-message').count() <= 100)

  await page.waitForTimeout(1_200)
  await dismissUpdateDialog()
  const scrollBefore = await page.locator('.community-message-list').evaluate((node) => {
    node.scrollTop = 0
    return node.scrollTop
  })
  await page.waitForTimeout(13_000)
  await dismissUpdateDialog()
  const scrollAfter = await page.locator('.community-message-list').evaluate((node) => node.scrollTop)
  check('无新消息时轮询不重置聊天阅读位置', Math.abs(scrollAfter - scrollBefore) <= 1)
  await page.screenshot({ path: path.join(outputRoot, 'deepseek-room-live.png') })

  await dismissUpdateDialog()
  await page.getByRole('tab', { name: '兴趣帖子', exact: true }).click()
  await page.locator('.community-thread-list article').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.community-thread-list article').first().click()
  await page.getByRole('dialog').filter({ has: page.locator('#community-thread-title') }).waitFor({ state: 'visible' })
  check('帖子详情在启动器内弹窗打开', app.windows().length === 1)
  await page.screenshot({ path: path.join(outputRoot, 'thread-detail-live.png') })

  const fixedOverflow = await page.locator('.page-scroll.community-fixed-page').evaluate((node) => node.scrollHeight - node.clientHeight)
  check('社区使用固定工作区，不引入整页下拉', fixedOverflow <= 2)

  await page.getByRole('button', { name: '关闭讨论', exact: true }).click()
  await page.getByRole('button', { name: 'AI 工具', exact: true }).click()
  await page.getByRole('tab', { name: /AI历史书工具/ }).waitFor({ state: 'visible' })
  check('AI 工具默认显示网站同步目录', await page.locator('.resource-directory-card').count() > 0)
  await page.getByRole('tab', { name: /DSH 生态/ }).click()
  await page.locator('.ecosystem-row').first().waitFor({ state: 'visible' })
  check('DSH 生态位于 AI 工具二级切页', await page.getByRole('tab', { name: /DSH 生态/ }).getAttribute('aria-selected') === 'true')
  check('侧栏不再重复显示 DSH 生态', await page.locator('.sidebar nav').getByRole('button', { name: 'DSH 生态', exact: true }).count() === 0)
  check('AI 工具与生态详情不打开外部浏览器', app.windows().length === 1)
  await page.screenshot({ path: path.join(outputRoot, 'ai-tools-dsh-ecosystem.png') })

  check(`控制台无错误${consoleErrors.length ? `：${consoleErrors.join(' | ')}` : ''}`, consoleErrors.length === 0)
} finally {
  await app.close().catch(() => undefined)
}

if (failures.length) process.exit(1)
process.stderr.write(`社区真实数据与 Electron 界面验收通过，截图写入 ${path.relative(root, outputRoot)}\n`)
