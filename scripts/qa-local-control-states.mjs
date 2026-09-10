import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'), port = 4319, base = `http://127.0.0.1:${port}`;
const output = path.join(root, 'output/playwright/local-control-states', String(Date.now())); await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'vite.renderer.config.ts', '--port', String(port)], { cwd: root, windowsHide: true, stdio: 'ignore' });
const report = { passed: false, synthetic: true, checks: [], output }; let browser;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) { if (server.exitCode !== null) throw new Error('Isolated QA server could not start'); try { ready = (await fetch(base)).ok; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready);
  browser = await chromium.launch({ channel: 'msedge', headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/__local-qa', route => route.fulfill({ contentType: 'text/html', body: '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/src/local-control.qa.tsx");</script></body></html>' }));
  await page.goto(base + '/__local-qa'); await page.getByRole('heading', { name: '边界状态合成验收' }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop-approval.png') });
  await page.getByRole('button', { name: '加载更早的本地记录' }).click(); await page.getByText('合成历史 1', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: '主控审批级别' }).selectOption('ask');
  assert.equal(await page.getByText('合成历史 1', { exact: true }).count(), 1); report.checks.push('permission change retains all loaded historical messages');
  const input = page.getByRole('textbox', { name: '本地协作任务' }); await input.fill('输入法确认不是发送');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  assert.equal(await page.evaluate(() => window.localQa.calls.filter(row => row.command === 'send_room').length), 0); report.checks.push('IME Enter confirmation does not send');
  await page.getByRole('tab', { name: '原生执行记录', exact: true }).click(); await page.getByText('合成工具结果：全部测试通过。此内容不代表真实模型执行。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop-native.png') });
  await page.evaluate(() => window.localQa.delay(1000));
  await page.getByRole('button', { name: '批准一次', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '正在提交审批决定' }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop-pending.png') });
  await page.getByRole('button', { name: '批准一次', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '审批决定已提交' }).waitFor();
  assert.equal(await page.evaluate(() => window.localQa.calls.filter(row => row.command === 'decide_approval').length), 1); report.checks.push('approval pending state is visible and duplicate clicks do not submit');
  await page.evaluate(() => { window.localQa.delay(0); window.localQa.fail(); });
  await input.fill('合成重试草稿'); await input.press('Enter'); await page.getByRole('alert').filter({ hasText: '合成失败' }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop-error.png') });
  await input.press('Enter');
  await page.waitForFunction(() => window.localQa.calls.filter(row => row.command === 'send_room').length === 2);
  assert.equal(await page.evaluate(() => { const rows = window.localQa.calls.filter(row => row.command === 'send_room'); return rows[0].requestId === rows[1].requestId; }), true); report.checks.push('uncertain send retry retains request identity');
  await page.setViewportSize({ width: 480, height: 850 }); await page.screenshot({ path: path.join(output, 'mobile-native.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '任务与审批', exact: true }).click(); await page.screenshot({ path: path.join(output, 'mobile-tasks.png'), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false); report.checks.push('mobile task and native panels render without horizontal overflow'); report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { await browser?.close(); server.kill(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
