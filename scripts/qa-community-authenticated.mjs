#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executablePath = process.env.QA_LAUNCHER_EXE || path.join(root, 'release', 'win-unpacked', '深蓝DeepSeekHarness启动器.exe')
const sessionSource = path.resolve(process.env.QA_COMMUNITY_SESSION_SOURCE || path.join(process.env.APPDATA || '', 'deepseek-harness-launcher'))
const outputRoot = path.resolve(root, process.env.QA_COMMUNITY_AUTH_OUTPUT || path.join('output', 'playwright', 'community-authenticated'))
const profileRoot = path.join(outputRoot, 'profile')
const userDataRoot = path.join(profileRoot, 'electron-user-data')
const appDataRoot = path.join(profileRoot, 'appdata')
const localAppDataRoot = path.join(profileRoot, 'localappdata')
const storageRoot = path.join(profileRoot, 'storage')
const uiVersion = 'ui-163ebaa2152b8bc4'
const uiRoot = path.join(storageRoot, 'runtime', 'modules', 'launcher-ui', uiVersion)

await rm(outputRoot, { recursive: true, force: true })
await Promise.all([userDataRoot, appDataRoot, localAppDataRoot, storageRoot, uiRoot].map((target) => mkdir(target, { recursive: true })))

// Copy only Chromium's encrypted session material. The test never reads or prints
// cookies, passwords, tokens or storage values; it asks the packaged launcher to
// prove that the remembered HttpOnly session still works through its public IPC.
for (const name of ['Local State', 'Preferences']) {
  await cp(path.join(sessionSource, name), path.join(userDataRoot, name), { force: true }).catch(() => undefined)
}
await cp(path.join(sessionSource, 'Network'), path.join(userDataRoot, 'Network'), { recursive: true, force: true })

await cp(path.join(root, 'out', 'renderer'), path.join(uiRoot, 'renderer'), { recursive: true })
await writeFile(path.join(storageRoot, 'runtime', 'modules', 'state.json'), `${JSON.stringify({
  schemaVersion: 1,
  active: { 'launcher-ui': uiVersion },
  previous: {},
  installed: { 'launcher-ui': [uiVersion] }
}, null, 2)}\n`, 'utf8')
await writeFile(path.join(userDataRoot, 'launcher.json'), `${JSON.stringify({
  settings: { storageRoot, storageSetupCompleted: true, autoOpen: false, theme: 'light', port: 32891 }
}, null, 2)}\n`, 'utf8')

const imagePath = path.resolve(root, '..', 'remove-codex-quota-release', 'apps', 'account', 'assets', 'deepblue-coin', 'deepblue-ai-coin-logo-320.png')
const gifPath = path.join(root, 'node_modules', 'electron-winstaller', 'resources', 'install-spinner.gif')
const marker = `launcher-0.10.33-${Date.now()}`
const qaUsername = `launcher_qa_${Date.now().toString(36)}`
const qaPassword = `qa-${randomBytes(12).toString('base64url')}`
const reports = []
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataRoot}`],
  env: {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    DSH_LAUNCHER_ALLOW_PARALLEL: '1',
    DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1'
  }
})

let page
try {
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.launcher?.communityRequest), undefined, { timeout: 30_000 })
  const accountDeadline = Date.now() + 30_000
  while (Date.now() < accountDeadline) {
    const status = await page.evaluate(async () => (await window.launcher.getSnapshot()).account.status)
    if (status !== 'checking') break
    await page.waitForTimeout(500)
  }
  const start = await page.evaluate(async () => {
    const snapshot = await window.launcher.getSnapshot()
    return { launcherVersion: snapshot.launcherVersion, accountStatus: snapshot.account.status, sessionRemembered: snapshot.account.sessionRemembered }
  })
  reports.push({ gate: 'login', ...start })
  if (start.launcherVersion !== '0.10.33') throw new Error(`Expected launcher 0.10.33, received ${start.launcherVersion}`)
  if (start.accountStatus !== 'signed_in') {
    const authWindowPromise = app.waitForEvent('window', { timeout: 20_000 })
    let loginCallError
    const loginCall = page.evaluate(() => window.launcher.accountLogin()).catch((error) => { loginCallError = error })
    const authWindow = await authWindowPromise
    await Promise.race([loginCall, new Promise((resolve) => setTimeout(resolve, 4_000))])
    if (!authWindow.isClosed()) {
      await authWindow.waitForLoadState('domcontentloaded')
      const accountEntry = authWindow.getByRole('button', { name: /登录\s*\/\s*注册/ })
      if (await accountEntry.count()) {
        await accountEntry.click()
        await Promise.race([loginCall, new Promise((resolve) => setTimeout(resolve, 12_000))])
      }
    }
    if (!authWindow.isClosed()) {
      const createAccount = authWindow.getByRole('button', { name: /创建新账号/ })
      if (!(await createAccount.count())) {
        await loginCall
      } else {
        await createAccount.click()
        await authWindow.waitForURL(/\/signup\/oauth\/authorize/, { timeout: 30_000 })

        const usernameInput = authWindow.locator('input[autocomplete="username"], input[name="username"], input[placeholder*="用户名"]').first()
        const passwordInputs = authWindow.locator('input[type="password"]')
        await usernameInput.waitFor({ state: 'visible', timeout: 30_000 })
        if (await passwordInputs.count() < 2) throw new Error(`Signup form is missing password confirmation at ${authWindow.url()}`)
        await usernameInput.fill(qaUsername)
        await passwordInputs.nth(0).fill(qaPassword)
        await passwordInputs.nth(1).fill(qaPassword)
        const agreement = authWindow.locator('input[type="checkbox"]')
        for (let index = 0; index < await agreement.count(); index += 1) {
          const checkbox = agreement.nth(index)
          if (await checkbox.isVisible() && await checkbox.isEnabled() && !(await checkbox.isChecked())) await checkbox.check()
        }
        await authWindow.getByRole('button', { name: /^(注册|创建账号|Sign up)$/i }).click()
        await authWindow.waitForURL(/\/login\/oauth\/authorize/, { timeout: 30_000 })

        const loginUsername = authWindow.locator('input[autocomplete="username"], input[name="username"], input[placeholder*="用户名"]').first()
        const loginPassword = authWindow.locator('input[type="password"]').first()
        await loginUsername.fill(qaUsername)
        await loginPassword.fill(qaPassword)
        await authWindow.getByRole('button', { name: /^(登录|Sign in)$/i }).click()
        await loginCall
      }
    }
    if (loginCallError) throw loginCallError
    const signedIn = await page.evaluate(async () => {
      const snapshot = await window.launcher.getSnapshot()
      return { accountStatus: snapshot.account.status, sessionRemembered: snapshot.account.sessionRemembered }
    })
    reports.push({ gate: 'qa-account-login', ...signedIn })
    if (signedIn.accountStatus !== 'signed_in' || !signedIn.sessionRemembered) throw new Error(`QA account login failed: ${signedIn.accountStatus}`)
  } else if (!start.sessionRemembered) {
    throw new Error('Signed-in account did not report a remembered session')
  }

  const send = async (kind, body) => {
    const result = await page.evaluate(async (body) => window.launcher.communityRequest({ scope: 'chat', method: 'POST', action: 'send_chat', channel: 'plaza', body }), body)
    if (result.ok !== true || typeof result.messageId !== 'string') throw new Error(`${kind} send returned an invalid result`)
    reports.push({ gate: kind, messageId: result.messageId, imageStored: typeof result.imageUrl === 'string' && result.imageUrl.length > 0 })
    return result.messageId
  }

  await page.getByRole('button', { name: '兴趣社区', exact: true }).click()
  await page.getByRole('tab', { name: 'AI 聊天广场', exact: true }).click()
  await page.locator('.community-chat-composer textarea').waitFor({ state: 'visible', timeout: 30_000 })

  const sendMedia = async (kind, body, filePath, accept) => {
    await page.locator(`.community-chat-composer input[type="file"][accept="${accept}"]`).setInputFiles(filePath)
    await page.locator('.community-chat-composer textarea').fill(body)
    await page.locator('.community-chat-composer').getByRole('button', { name: '发送', exact: true }).click()
    const deadline = Date.now() + 70_000
    while (Date.now() < deadline) {
      const result = await page.evaluate(async () => window.launcher.communityRequest({ scope: 'chat', method: 'GET', channel: 'plaza' }))
      const message = Array.isArray(result.messages) ? result.messages.find((item) => item && item.body === body) : undefined
      if (message && typeof message.id === 'string') {
        const imageStored = typeof message.imageUrl === 'string' && message.imageUrl.length > 0
        reports.push({ gate: kind, messageId: message.id, imageStored })
        if (!imageStored) throw new Error(`${kind} persisted without media`)
        return message.id
      }
      const error = await page.locator('.community-chat-composer .community-inline-error').textContent().catch(() => '')
      if (error) throw new Error(`${kind} send failed: ${error.trim()}`)
      await page.waitForTimeout(1_000)
    }
    throw new Error(`${kind} send did not persist within the timeout`)
  }

  const textId = await send('text', `[自动验收 ${marker}] 启动器文字发送与刷新持久化测试。`)
  await page.waitForTimeout(3_500)
  const imageId = await sendMedia('image', `[自动验收 ${marker}] 启动器图片上传与持久化测试。`, imagePath, 'image/jpeg,image/png,image/webp')
  await page.waitForTimeout(3_500)
  const gifId = await sendMedia('gif', `[自动验收 ${marker}] 启动器 GIF 动图上传与持久化测试。`, gifPath, 'image/gif,.gif')

  const expected = [textId, imageId, gifId]
  const verify = async (gate) => {
    const result = await page.evaluate(async () => window.launcher.communityRequest({ scope: 'chat', method: 'GET', channel: 'plaza' }))
    const messages = Array.isArray(result.messages) ? result.messages : []
    const persisted = expected.every((id) => messages.some((message) => message && message.id === id))
    const mediaPersisted = [imageId, gifId].every((id) => messages.some((message) => message && message.id === id && typeof message.imageUrl === 'string' && message.imageUrl.length > 0))
    reports.push({ gate, messageCount: messages.length, persisted, mediaPersisted })
    if (!persisted || !mediaPersisted) throw new Error(`${gate} did not return all sent messages and media`)
  }

  await verify('before-refresh')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.launcher?.communityRequest), undefined, { timeout: 30_000 })
  await verify('after-refresh')
  await page.screenshot({ path: path.join(outputRoot, 'community-after-refresh.png') })
} finally {
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify({ passed: reports.some((item) => item.gate === 'after-refresh' && item.persisted && item.mediaPersisted), testedAt: new Date().toISOString(), marker, reports }, null, 2)}\n`, 'utf8')
  await app.close().catch(() => undefined)
}

process.stderr.write('AUTHENTICATED COMMUNITY GATE PASSED: login, text, image, GIF and refresh persistence.\n')
