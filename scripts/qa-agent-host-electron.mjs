import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = path.resolve(import.meta.dirname, '..');
const packagedExe = process.env.QA_AGENT_HOST_EXE ? path.resolve(process.env.QA_AGENT_HOST_EXE) : undefined;
const moduleDir = packagedExe ? path.join(path.dirname(packagedExe), 'resources/app/out/agent-host') : path.join(root, 'out/agent-host');
const output = path.join(root, 'output/playwright/agent-host-native', String(Date.now()));
const profile = path.join(output, 'profile');
await mkdir(profile, { recursive: true });
await writeFile(path.join(profile, 'launcher.json'), JSON.stringify({ settings: { storageRoot: path.join(output, 'storage'), storageSetupCompleted: true, autoOpen: false, port: 38972 } }));
const report = { passed: false, packagedExe: packagedExe ?? null, moduleDir, bindingApiFixture: true, productionWrites: false, checks: [], output, stage: 'setup', stdout: '', stderr: '', mainErrors: [] };
let application;
const execFileAsync = promisify(execFile);
function stage(name) { report.stage = name; console.error(`[agent-host native QA] ${name}`); }
function append(channel, message) { report[channel] = (report[channel] + String(message)).slice(-64000); }
async function bounded(operation, milliseconds, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function cleanupOwnedProfile() {
  // Only the exact fresh profile made above may be terminated. Never match a
  // product name or touch the user's installed/running launcher.
  const scope = path.join(root, 'output', 'playwright', 'agent-host-native') + path.sep;
  assert.ok(profile.startsWith(scope) && path.basename(profile) === 'profile');
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', '$qaProfile=$env:DSH_QA_EXACT_PROFILE; $qaCandidates=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("electron.exe","cmd.exe",$env:DSH_QA_EXE_NAME) -and $_.CommandLine -and $_.CommandLine.Contains($qaProfile) }; foreach($qaProc in $qaCandidates) { Stop-Process -Id $qaProc.ProcessId -Force -ErrorAction SilentlyContinue }'], { windowsHide: true, timeout: 8000, env: { ...process.env, DSH_QA_EXACT_PROFILE: profile, DSH_QA_EXE_NAME: packagedExe ? path.basename(packagedExe) : 'electron.exe' } }).catch((error) => append('stderr', `\nScoped cleanup: ${error.message}`));
  } else application?.process()?.kill('SIGTERM');
}
async function saveReport() { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
const watchdog = setTimeout(() => {
  report.error = `Native QA overall timeout at ${report.stage}`;
  report.passed = false;
  void cleanupOwnedProfile().finally(async () => { await saveReport(); console.error(report.error); process.exit(1); });
}, 110000);
try {
  stage('launch');
  const environment = { ...process.env, APPDATA: path.join(output, 'appdata'), LOCALAPPDATA: path.join(output, 'localappdata'), DSH_LAUNCHER_ALLOW_PARALLEL: '1', DSH_LAUNCHER_DISABLE_HARDWARE_ACCELERATION: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Let Playwright resolve Electron so its readiness loader is installed. An
  // explicit development electron.exe skips that loader in Playwright 1.x.
  application = await bounded(electron.launch({ ...(packagedExe ? { executablePath: packagedExe } : {}), args: [...(packagedExe ? [] : [root]), `--user-data-dir=${profile}`, '--disable-gpu'], cwd: root, env: environment, timeout: 30000,
    logger: { isEnabled: () => true, log: (name, severity, message) => append('stderr', `[${name}/${severity}] ${message}\n`) }
  }), 35000, 'Electron launch');
  application.process().stdout?.on('data', (chunk) => append('stdout', chunk));
  application.process().stderr?.on('data', (chunk) => append('stderr', chunk));
  application.on('console', (message) => { if (message.type() === 'error') report.mainErrors.push(message.text()); });
  stage('first-window');
  const page = await application.firstWindow({ timeout: 15000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  stage('preload-ipc');
  await page.waitForFunction(() => !!window.launcher?.agentHostState, null, { timeout: 20000 });
  stage('compiled-host-load');
  let state;
  for (let attempt = 0; attempt < 40; attempt++) {
    state = await page.evaluate(() => window.launcher.agentHostState());
    if (state?.supported) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(state?.supported, true, 'compiled native host loads through stable bridge');
  assert.equal(state.connection, 'unbound');
  report.checks.push('real Electron preload → main → compiled agent-host module');
  stage('packaged-connector-child');
  const childCheck = await bounded(application.evaluate(async (_electron, args) => {
    const { createRequire } = process.getBuiltinModule('module');
    const require = createRequire(args.modulePath);
    const { fork } = require('node:child_process');
    const child = fork(args.entry, [], { execPath: process.execPath, execArgv: [], cwd: args.cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    return await new Promise((resolve, reject) => {
      let ready = false, stderr = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Packaged connector child timeout')); }, 8000);
      child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000); });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('message', message => {
        if (message.type === 'ready' && message.protocolVersion === 1) { ready = true; child.send({ type: 'stop' }); }
      });
      child.on('exit', code => { clearTimeout(timeout); if (ready && code === 0) resolve(true); else reject(new Error(`Packaged connector exit ${code}: ${stderr}`)); });
    });
  }, { modulePath: path.join(moduleDir, 'host-service.cjs'), entry: path.join(moduleDir, 'connector/host-child.mjs'), cwd: output }), 10000, 'Packaged connector child');
  assert.equal(childCheck, true);
  report.checks.push('packaged Electron-as-Node child IPC boots and stops with bundled connector dependencies');
  stage('discovery');
  const discovery = await bounded(page.evaluate(() => window.launcher.agentHostAction({ action: 'discover' })), 15000, 'Adapter discovery');
  assert.equal(discovery.discovered.length, 3);
  report.checks.push('local adapter discovery (no runtime task launched)');
  const rejected = await page.evaluate(async () => {
    try { await window.launcher.agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'bootstrap' }); return false; }
    catch (error) { return String(error).includes('登录'); }
  });
  assert.equal(rejected, true);
  report.checks.push('anonymous workspace access rejected');
  stage('workspace-ui');
  await page.getByRole('button', { name: '智能体工作台', exact: true }).click({ timeout: 10000 });
  await page.locator('.agent-workspace').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.aw-device-line').filter({ hasText: '未绑定' }).waitFor({ state: 'visible', timeout: 10000 });
  await page.screenshot({ path: path.join(output, 'native-workspace.png') });
  stage('native-encryption-fixture');
  const cryptoCheck = await bounded(application.evaluate(async ({ safeStorage }, args) => {
    // CDP's evaluated function has no dynamic-import callback. Electron's
    // bundled Node exposes the builtin loader without depending on that hook.
    const { createRequire } = process.getBuiltinModule('module');
    const require = createRequire(args.modulePath);
    const { readFile } = require('node:fs/promises');
    const { AgentHostService, AGENT_HOST_PROTOCOL } = require(args.modulePath);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System encryption unavailable');
    let fixtureKey = '';
    const options = { storageDir: args.storageDir, moduleDir: args.moduleDir, nodePath: process.execPath, launcherVersion: 'qa', ownerId: () => 'qa-owner', onChange: () => {}, chooseDirectory: async () => undefined,
      request: async (request) => { fixtureKey = request.body.registrationKey; return { ok: true, device: { id: 'a'.repeat(32) }, deviceKey: fixtureKey }; },
      fetch: async () => new Response(JSON.stringify({ ok: true, commands: [], boundAgentIds: [], heartbeatSeconds: 15 }), { headers: { 'content-type': 'application/json' } }) };
    const first = new AgentHostService(options);
    await first.initialize();
    await first.action({ action: 'bind_device' });
    await first.tick();
    const online = first.snapshot().connection === 'online';
    await first.dispose();
    const file = await readFile(args.storageDir + '/host-state.enc');
    const encrypted = !!fixtureKey && !file.includes(Buffer.from(fixtureKey));
    const second = new AgentHostService(options);
    await second.initialize();
    const restored = second.snapshot().deviceId === 'a'.repeat(32);
    await second.action({ action: 'pause' });
    await second.dispose();
    return { protocol: AGENT_HOST_PROTOCOL, online, encrypted, restored };
  }, { modulePath: path.join(moduleDir, 'host-service.cjs'), moduleDir, storageDir: path.join(output, 'encrypted-binding') }), 15000, 'Native encryption fixture');
  assert.deepEqual(cryptoCheck, { protocol: 1, online: true, encrypted: true, restored: true });
  report.checks.push('native system encryption + cold reload preserves device binding; isolated API fixture');
  assert.deepEqual(errors, []);
  assert.deepEqual(report.mainErrors.filter(message => !message.includes("Error occurred in handler for 'launcher:agent-workspace-request': Error: 请先登录 AI历史书账号")), []);
  report.checks.push('no renderer exceptions');
  report.passed = true;
} catch (error) {
  report.error = error?.stack || String(error);
  process.exitCode = 1;
} finally {
  const failedStage = report.stage;
  stage('closing');
  if (application) {
    try { await bounded(application.close(), 5000, 'Electron close'); }
    catch (error) { report.closeError = String(error); await cleanupOwnedProfile(); }
  } else await cleanupOwnedProfile();
  clearTimeout(watchdog);
  report.stage = report.passed ? 'complete' : failedStage;
  await saveReport();
}
console.log(JSON.stringify(report, null, 2));
