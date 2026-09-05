// Local-artifact installer gate. Deliberately not a public-download smoke test.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, 'output', 'qa-agent-host-installed');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'run-'));
const installRoot = path.join(output, '自定义安装目录');
await mkdir(installRoot);
const metadata = JSON.parse(await readFile(path.join(root, 'release/launcher-shell.generated.json'), 'utf8'));
const installer = path.join(root, 'release/deepblue-deepseek-harness-launcher-win-x64-online-bootstrap.exe');
const archive = path.join(root, 'release', metadata.fileName);
const sentinel = path.join(installRoot, 'user-data-preservation.marker');
await writeFile(sentinel, 'existing user data must remain');
const report = { passed: false, localArtifact: true, publicNetwork: false, registryOrShortcutsModified: false, defaultRegistryPathRecoveryTested: false, output, installRoot, checks: [] };
function run(exe, args, env = process.env, timeout = 150000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installer QA timeout')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`QA child exit ${code}: ${stderr || stdout}`)); });
  });
}
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    await run(installer, ['/S', '/QA', `/LOCAL_SHELL=${archive}`, `/D=${installRoot}`]);
    const appRoot = path.join(installRoot, 'shells', metadata.version, 'resources/app');
    const installed = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
    assert.equal(installed.version, metadata.version);
    assert.equal(await readFile(sentinel, 'utf8'), 'existing user data must remain');
    const module = JSON.parse(await readFile(path.join(appRoot, 'out/agent-host/module.json'), 'utf8'));
    assert.equal(module.id, 'agent-host');
    report.checks.push(attempt ? 'same custom directory overwrite preserves user marker and host module' : 'fresh custom directory installation contains host module');
  }
  const exe = path.join(installRoot, 'shells', metadata.version, metadata.executable);
  report.native = JSON.parse(await run(process.execPath, ['scripts/qa-agent-host-electron.mjs'], { ...process.env, QA_AGENT_HOST_EXE: exe }));
  assert.equal(report.native.passed, true);
  report.passed = true;
} catch (error) { report.error = error.stack || String(error); process.exitCode = 1; }
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
