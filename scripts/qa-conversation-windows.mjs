// Real Electron windows, IPC, renderer and SQLite; synthetic conversation, no model calls.
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const { LocalDirector } = await import(pathToFileURL(path.resolve(root, '../remove-codex-quota-release/packages/agent-connector/src/local-control/child.mjs')));
const output = path.join(root, 'output/playwright/conversation-windows', String(Date.now()));
const profile = path.join(output, 'profile'), storage = path.join(output, 'storage'), project = path.join(output, 'project');
await mkdir(profile, { recursive: true }); await mkdir(project, { recursive: true });
await writeFile(path.join(profile, 'launcher.json'), JSON.stringify({ settings: { storageRoot: storage, storageSetupCompleted: true, autoOpen: false, port: 38974, theme: 'light', launcherSkin: 'deepseek' } }));
const director = new LocalDirector({ directory: path.join(storage, 'agent-host/local-control'), descriptors: [{ id: 'qa', name: '合成成员', adapter: 'codex', projects: [{ id: 'project', path: project, name: '合成项目' }] }], execute: async () => { throw new Error('No model execution permitted in UI QA'); } });
await director.initialize();
const { roomId } = await director.command('create_room', { name: '独立窗口验收', members: [{ id: '1'.repeat(32), displayName: '项目主控', mentionHandle: '主控', agentId: 'qa', projectId: 'project' }] });
for (let index = 1; index <= 12; index++) director.store.append(roomId, 'message', { authorType: index % 2 ? 'user' : 'assistant', body: index === 12 ? '长消息测试。'.repeat(350) : `合成消息 ${index}：用于角色气泡和窗口验证。`, memberId: '1'.repeat(32) });
director.store.put('run', { id: '2'.repeat(32), roomId, status: 'completed', phase: 'awaiting_review', validationStatus: 'awaiting_review', instruction: '合成验收状态，不代表真实模型执行', stepCount: 1, maxSteps: 16 });
await director.close();
const report = { passed: false, synthetic: true, modelCalls: 0, output, checks: [], errors: [] }; let app;
const env = { ...process.env, APPDATA: path.join(output, 'appdata'), LOCALAPPDATA: path.join(output, 'localappdata'), DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' }; delete env.ELECTRON_RUN_AS_NODE;
async function launch() { return electron.launch({ args: [root, `--user-data-dir=${profile}`, '--disable-gpu'], cwd: root, env, timeout: 30000 }); }
try {
  app = await launch(); const main = await app.firstWindow(); main.on('pageerror', error => report.errors.push(error.message));
  await main.addLocatorHandler(main.getByRole('button', { name: '关闭连接指引' }), async () => main.getByRole('button', { name: '关闭连接指引' }).click());
  await main.addLocatorHandler(main.locator('.runtime-update-dialog'), async () => main.keyboard.press('Escape'));
  await main.getByRole('button', { name: '智能体工作台', exact: true }).click(); await main.getByRole('button', { name: '群聊（多智能会话）', exact: true }).click();
  await main.getByRole('heading', { name: '独立窗口验收', exact: true }).waitFor();
  assert.ok(await main.locator('.chat-message.user').count() > 0); assert.ok(await main.locator('.chat-message.assistant').count() > 0);
  main.once('dialog', dialog => dialog.accept()); await main.getByRole('button', { name: '确认验收', exact: true }).click(); await main.getByText('用户已验收', { exact: true }).waitFor(); report.checks.push('explicit user acceptance is recorded separately from execution completion');
  await main.getByRole('button', { name: '收起房间列表', exact: true }).click(); assert.equal(await main.locator('.lcr-rooms').isVisible(), false);
  await main.getByRole('button', { name: '收起任务面板', exact: true }).click(); assert.equal(await main.locator('.lcr-tasks').isVisible(), false);
  await main.getByRole('button', { name: '展开完整消息', exact: true }).click(); await main.getByRole('button', { name: '收起长消息', exact: true }).click();
  await main.screenshot({ path: path.join(output, 'main-collapsed.png') }); report.checks.push('role bubbles, list collapse and long-message disclosure work');
  const popupReady = app.waitForEvent('window'); await main.getByRole('button', { name: '独立窗口', exact: true }).click(); const popup = await popupReady;
  popup.on('pageerror', error => report.errors.push(error.message)); await popup.getByRole('heading', { name: '独立窗口验收', exact: true }).waitFor();
  const context = await popup.evaluate(() => window.launcher.getConversationContext()); assert.equal(context.roomId, roomId);
  const reused = await main.evaluate(target => window.launcher.openConversation(target), context); assert.equal(reused.reused, true);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('conversation=1')).length), 1);
  report.checks.push('real native popout uses the same room and deduplicates windows');
  await popup.getByRole('button', { name: '对话全屏', exact: true }).click(); await popup.waitForFunction(() => Boolean(document.fullscreenElement));
  await popup.getByRole('button', { name: '退出全屏', exact: true }).click(); await popup.waitForFunction(() => !document.fullscreenElement);
  for (let i = 0; i < 30; i++) { if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')).isFullScreen()))) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')); w.focus(); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' }); });
  for (let i = 0; i < 30; i++) { if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')).isFullScreen())) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')).isFullScreen()), true);
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); });
  for (let i = 0; i < 30; i++) { if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')).isFullScreen()))) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')).isFullScreen()), false);
  report.checks.push('conversation fullscreen and native F11/Escape work');
  await main.getByRole('button', { name: '打开设置', exact: true }).click();
  await main.locator('.launcher-skin-choice').filter({ hasText: '竹青' }).click();
  await main.getByLabel('明暗模式', { exact: true }).selectOption('dark');
  await main.getByRole('button', { name: '保存设置', exact: true }).first().click();
  await popup.waitForFunction(() => document.documentElement.dataset.launcherSkin === 'jade' && document.documentElement.dataset.theme === 'dark');
  await main.screenshot({ path: path.join(output, 'settings-jade-dark.png') });
  await popup.screenshot({ path: path.join(output, 'popup-jade-dark.png') });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('conversation=1')); w.setSize(500, 850); });
  await popup.waitForFunction(() => innerWidth <= 500);
  await popup.screenshot({ path: path.join(output, 'popup-narrow.png') });
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await Promise.all([popup.waitForEvent('close'), popup.getByRole('button', { name: '关闭聊天窗口', exact: true }).click()]);
  assert.equal(main.isClosed(), false); assert.ok((await main.evaluate(() => window.launcher.getSnapshot())).settings);
  report.checks.push('skin broadcasts, narrow window renders, closing popup keeps main controller alive');
  await app.close(); app = await launch(); const restarted = await app.firstWindow();
  await restarted.waitForFunction(() => document.documentElement.dataset.launcherSkin === 'jade' && document.documentElement.dataset.theme === 'dark');
  report.checks.push('skin and theme persist after actual process restart'); assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; for (const [index, page] of (app?.windows() || []).entries()) await page.screenshot({ path: path.join(output, `failed-${index}.png`) }).catch(() => {}); }
finally { await app?.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
