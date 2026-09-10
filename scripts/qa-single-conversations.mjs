// Real Electron window/IPC routing with synthetic local/cloud read transports.
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/playwright/single-conversations', String(Date.now())), profile = path.join(output, 'profile');
await mkdir(profile, { recursive: true });
await writeFile(path.join(profile, 'launcher.json'), JSON.stringify({ settings: { storageRoot: path.join(output, 'storage'), storageSetupCompleted: true, autoOpen: false, port: 38975 } }));
const report = { passed: false, synthetic: true, modelCalls: 0, output, checks: [] }; let app;
try {
  const env = { ...process.env, APPDATA: path.join(output, 'appdata'), LOCALAPPDATA: path.join(output, 'localappdata'), DSH_LAUNCHER_ALLOW_PARALLEL: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root, `--user-data-dir=${profile}`, '--disable-gpu'], cwd: root, env }); const main = await app.firstWindow(); await main.waitForFunction(() => Boolean(window.launcher));
  const snapshot = await main.evaluate(() => window.launcher.getSnapshot());
  await app.evaluate(({ ipcMain, app }, snapshot) => {
    const signed = value => ({ ...value, account: { ...value.account, status: 'signed_in', user: { id: 'synthetic-user' } } });
    app.on('browser-window-created', (_event, window) => { const send = window.webContents.send.bind(window.webContents); window.webContents.send = (channel, ...args) => send(channel, ...(channel === 'launcher:snapshot' ? [signed(args[0])] : args)); });
    const host = { supported: true, enabled: false, agents: [], discovered: [], connection: 'unbound', localTasks: [], localCatalog: { projects: [{ id: 'project', adapter: 'codex', name: '合成单聊项目', path: 'E:/synthetic/project' }], sessions: [{ id: 'session', projectId: 'project', title: '本机单聊验收' }], models: [], scannedAt: '2026-09-10T00:00:00Z' }, localHistory: { sessionId: 'session', messages: [{ id: 'one', role: 'user', text: '用户提出的合成问题' }, { id: 'two', role: 'assistant', text: 'Codex 的合成回复，仅验证界面。' }] } };
    for (const channel of ['launcher:agent-host-state','launcher:agent-host-action','launcher:agent-workspace-request','launcher:get-snapshot']) ipcMain.removeHandler(channel);
    ipcMain.handle('launcher:agent-host-state', () => host);
    ipcMain.handle('launcher:agent-host-action', (_event, input) => { if (!['scan_local','read_local_history','refresh_local_models'].includes(input.action)) throw Error('Synthetic QA forbids execution'); return host; });
    ipcMain.handle('launcher:get-snapshot', event => event.sender.getURL().includes('conversation=1') ? { ...snapshot, account: { ...snapshot.account, status: 'signed_in', user: { id: 'synthetic-user' } } } : snapshot);
    ipcMain.handle('launcher:agent-workspace-request', (_event, request) => {
      const agent = { id: 'agent', display_name: '云端 Codex', adapter_code: 'codex', status: 'offline' };
      if (request.action === 'bootstrap') return { agents: [agent] };
      if (request.action === 'agent_state') return { state: { agent, projects: [{ id: 'project', source_name: '合成云项目' }], sessions: [{ id: 'cloud-session', project_id: 'project', source_title: '云端单聊验收', source_status: 'idle' }], tasks: [] } };
      if (request.action === 'session_history') return { messages: [{ external_message_id: 'one', message_role: 'user', body_text: '云端用户合成问题' }, { external_message_id: 'two', message_role: 'assistant', body_text: '云端智能体合成回复' }] };
      if (request.action === 'activate_sync') return { ok: true };
      throw Error('Synthetic QA forbids external writes');
    });
  }, snapshot);
  for (const target of [{ kind: 'local-session', projectId: 'project', sessionId: 'session', title: '本机单聊验收' }, { kind: 'cloud-session', agentId: 'agent', projectId: 'project', sessionId: 'cloud-session', title: '云端单聊验收' }]) {
    const pending = app.waitForEvent('window'); await main.evaluate(target => window.launcher.openConversation(target), target); const page = await pending;
    await page.getByRole('heading', { name: target.title, exact: true }).waitFor(); await page.locator('.chat-message.assistant').waitFor();
    assert.equal(await page.locator('.chat-message.user').count(), 1); assert.equal(await page.locator('.chat-message.assistant').count(), 1);
    assert.equal(await page.locator('.aw-agent-pane').isVisible(), false); assert.equal(await page.locator('.aw-session-pane').isVisible(), false);
    assert.equal((await page.evaluate(() => window.launcher.getConversationContext())).sessionId, target.sessionId);
    await page.screenshot({ path: path.join(output, target.kind + '.png') });
    await page.getByRole('button', { name: '对话全屏', exact: true }).click(); await page.waitForFunction(() => Boolean(document.fullscreenElement)); await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    await Promise.all([page.waitForEvent('close'), page.getByRole('button', { name: '关闭聊天窗口', exact: true }).click()]);
    report.checks.push(target.kind + ': fixed session, role bubbles, collapsed lists, fullscreen, close without closing main');
  }
  assert.equal(main.isClosed(), false); report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; for (const [index, page] of (app?.windows() || []).entries()) await page.screenshot({ path: path.join(output, `failed-${index}.png`) }).catch(() => {}); }
finally { await app?.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
