// UI-only fixture validation. Does not use account credentials or real agent processes.
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const base = process.env.AGENT_WORKSPACE_QA_URL || 'http://127.0.0.1:4316'
const output = path.resolve('output/playwright/agent-workspace')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: process.env.AGENT_WORKSPACE_BROWSER || 'msedge' })
const failures = []
const checks = []
function check(label, condition) { checks.push({ label, pass: Boolean(condition) }); if (!condition) failures.push(label); process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`) }
async function open(width, height, query = '') {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.route('**/__workspace-qa**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/src/agent-workspace.qa.tsx");</script></body></html>' }))
  await page.goto(`${base}/__workspace-qa${query}`)
  return page
}
try {
  const desktop = await open(1440, 900)
  const errors = []
  desktop.on('pageerror', error => errors.push(error.message))
  await desktop.getByRole('button', { name: /修复连接并同步原生会话/ }).click({ timeout: 20000 })
  await desktop.locator('.aw-message').first().waitFor({ timeout: 20000 })
  await desktop.screenshot({ path: path.join(output, 'desktop.png') })
  check('Desktop shows three fixed panes and pinned composer', await desktop.locator('.aw-agent-pane').isVisible() && await desktop.locator('.aw-session-pane').isVisible() && await desktop.locator('.aw-composer').isVisible())
  check('Initial native history opens at latest', await desktop.locator('.aw-messages').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 10))
  const beforeReselect = await desktop.evaluate(() => window.workspaceQa.calls.filter(item => item.action === 'session_history').length)
  await desktop.getByRole('button', { name: /修复连接并同步原生会话/ }).click()
  await desktop.waitForFunction(previous => window.workspaceQa.calls.filter(item => item.action === 'session_history').length > previous, beforeReselect, { timeout: 15000 })
  check('Re-selecting current session keeps polling alive', true)
  await desktop.locator('.aw-messages').evaluate(node => { node.scrollTop = 100; node.dispatchEvent(new Event('scroll')) })
  const position = await desktop.locator('.aw-messages').evaluate(node => node.scrollTop)
  await desktop.waitForTimeout(4400)
  check('Unchanged polling preserves reader position', Math.abs(await desktop.locator('.aw-messages').evaluate(node => node.scrollTop) - position) < 2)
  await desktop.evaluate(() => window.workspaceQa.appendHistory())
  await desktop.getByRole('button', { name: '刷新工作台状态' }).click()
  await desktop.getByRole('button', { name: '有新内容，回到最新' }).waitFor({ timeout: 15000 })
  check('New content offers explicit jump without stealing scroll', Math.abs(await desktop.locator('.aw-messages').evaluate(node => node.scrollTop) - position) < 2)
  await desktop.getByRole('button', { name: '有新内容，回到最新' }).click()
  await desktop.evaluate(() => window.workspaceQa.failSend())
  await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).fill('UI QA: one idempotent request')
  await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).press('Enter')
  await desktop.getByRole('alert').filter({ hasText: '网络中断' }).waitFor()
  check('Failed sending preserves draft', await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).inputValue() === 'UI QA: one idempotent request')
  await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).press('Enter')
  await desktop.getByRole('status').filter({ hasText: '任务已进入同一账号的队列' }).waitFor()
  check('Retry reuses idempotency ID', await desktop.evaluate(() => { const calls = window.workspaceQa.calls.filter(item => item.action === 'send_task'); return calls.length === 2 && calls[0].body.clientRequestId === calls[1].body.clientRequestId }))
  check('Successful task clears draft only after acknowledgement', await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).inputValue() === '')
  await desktop.evaluate(() => window.workspaceQa.setDelay(1500))
  await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).fill('UI QA: busy state')
  await desktop.getByRole('textbox', { name: '发送给当前智能体的任务' }).press('Enter')
  check('In-flight sending disables composer action', await desktop.getByRole('button', { name: '发送中' }).isDisabled())
  await desktop.waitForTimeout(1700)
  await desktop.evaluate(() => { window.workspaceQa.setDelay(0); window.workspaceQa.setExpired(true) })
  await desktop.getByRole('button', { name: '刷新工作台状态' }).click()
  await desktop.getByRole('alert').filter({ hasText: '登录已过期' }).waitFor({ timeout: 15000 })
  check('Expired session is explicitly reported', await desktop.getByRole('alert').filter({ hasText: '登录已过期' }).isVisible())
  check('Expired session exposes in-app login recovery', await desktop.getByRole('button', { name: '重新登录', exact: true }).isVisible())
  await desktop.evaluate(() => { window.workspaceQa.setExpired(false); window.workspaceQa.disconnect() })
  await desktop.getByRole('button', { name: '刷新工作台状态' }).click()
  await desktop.getByRole('button', { name: '启动', exact: true }).waitFor({ timeout: 15000 })
  check('Disconnected runtime cannot dispatch new tasks', await desktop.getByRole('button', { name: '发送任务', exact: true }).isDisabled())
  check('No JavaScript errors', errors.length === 0)

  const mobile = await open(390, 844)
  await mobile.getByRole('button', { name: /Codex · 网站开发.*本机托管/ }).click({ timeout: 20000 })
  await mobile.getByRole('button', { name: /修复连接并同步原生会话/ }).click({ timeout: 20000 })
  await mobile.locator('.aw-message').first().waitFor({ timeout: 20000 })
  await mobile.screenshot({ path: path.join(output, 'mobile.png') })
  check('Mobile shows one conversation pane with input inside viewport', await mobile.locator('.aw-composer').isVisible() && !(await mobile.locator('.aw-agent-pane').isVisible()) && await mobile.locator('.aw-composer').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight + 1))
  check('No page-level horizontal or vertical overflow', await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight))
  const legacy = await open(900, 650, '?legacy=1')
  await legacy.getByRole('heading', { name: '请升级启动器' }).waitFor()
  check('Missing IPC shows upgrade instead of demo success', await legacy.getByRole('button', { name: '下载最新版启动器' }).isVisible() && await legacy.locator('.aw-composer').count() === 0)
  await legacy.screenshot({ path: path.join(output, 'legacy-upgrade.png') })
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ fixtureOnly: true, checks, failures }, null, 2))
} finally { await browser.close() }
if (failures.length) process.exitCode = 1
