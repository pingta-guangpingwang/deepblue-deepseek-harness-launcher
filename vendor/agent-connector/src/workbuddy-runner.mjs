import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { safeFinalReply } from './privacy.mjs';
import { childEnvironmentWithoutSecret, closeControl, validateInstruction, terminateRuntime } from './runner-common.mjs';
import { spawnCodeBuddy } from './codebuddy-runner.mjs';

const hosts = new Map();

async function stopOwnedGateway(host) {
  if (host.child.exitCode !== null) return;
  const control = { child: host.child, closed: false };
  const done = new Promise(resolve => host.child.once('close', resolve));
  terminateRuntime(control);
  let timer;
  try { await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 7000); })]); }
  finally { clearTimeout(timer); closeControl(control); }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function workBuddyCli(configured = '') {
  const requested = String(configured || '').trim();
  const candidates = [
    requested && path.resolve(requested),
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy') : '',
    process.platform === 'darwin' ? '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' : ''
  ].filter(Boolean);
  for (const candidate of candidates) if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  throw new Error('找不到 WorkBuddy 本机 Gateway，请重新运行 WorkBuddy Skill 安装自检');
}

async function waitReady(baseUrl, child, host) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (host.spawnError || child.exitCode !== null) throw new Error('WorkBuddy Gateway 启动失败，请检查本机运行环境');
    const ok = await fetch(`${baseUrl}/api/openapi.json`, { signal: AbortSignal.timeout(1500), headers: host.headers }).then((response) => response.ok).catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('等待 WorkBuddy Gateway 就绪超时');
}

async function hostFor(project, executable, interactionKeyEnv) {
  const identity = `${executable || 'workbuddy'}\0${project.path}`;
  const key = process.platform === 'win32' ? identity.toLowerCase() : identity;
  const previous = hosts.get(key);
  if (previous && previous.child.exitCode === null) return previous;
  const cli = await workBuddyCli(executable === 'workbuddy' ? '' : executable);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Per-process credential: never expose it in URLs, logs, renderer state or disk.
  const password = randomBytes(32).toString('hex');
  const args = ['--serve', '--host', '127.0.0.1', '--port', String(port)];
  const options = { cwd: project.path, env: { ...childEnvironmentWithoutSecret(interactionKeyEnv), CODEBUDDY_GATEWAY_AUTH: 'password', CODEBUDDY_GATEWAY_PASSWORD: password } };
  const launched = /\.(cmd|bat|exe)$/i.test(cli)
    ? await spawnCodeBuddy(cli, args, options)
    : { child: spawn(process.execPath, [cli, ...args], { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }), specPath: '' };
  const child = launched.child;
  child.stdout?.resume(); child.stderr?.resume();
  const host = { child, baseUrl, projectPath: project.path, headers: { 'X-CodeBuddy-Request': '1', Authorization: `Bearer ${password}` } };
  child.once('error', () => { host.spawnError = true; });
  hosts.set(key, host);
  child.once('close', () => { if (hosts.get(key) === host) hosts.delete(key); if (launched.specPath) void unlink(launched.specPath).catch(() => {}); });
  try { await waitReady(baseUrl, child, host); }
  catch (error) { if (hosts.get(key) === host) hosts.delete(key); await stopOwnedGateway(host); throw error; }
  return host;
}

export function gatewayAccountReady(body) {
  // This is provider account state, not merely the Gateway password login.
  return (body?.data || body)?.authenticated === true;
}

export async function probeWorkBuddyRuntime({ project, executable, interactionKeyEnv }) {
  const host = await hostFor(project, executable, interactionKeyEnv);
  const response = await fetch(`${host.baseUrl}/api/v1/auth/account/status`, { headers: host.headers, signal: AbortSignal.timeout(5000) });
  return response.ok && gatewayAccountReady(await response.json());
}

function eventDataBlocks(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') return [];
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

function finalFromEvents(events) {
  let reply = '';
  let sessionId = '';
  for (const event of events) {
    sessionId = String(event?.agent?.sessionId || event?.sessionId || sessionId || '');
    const markdown = event?.content?.markdown || event?.result?.content?.markdown || event?.payload?.content?.markdown;
    if (typeof markdown === 'string' && markdown.trim()) reply = markdown.trim();
  }
  return { reply, sessionId };
}

export function workBuddyRunId(createdBody, fallback = '') {
  return String(createdBody?.id || createdBody?.runId || createdBody?.data?.id || createdBody?.data?.runId || fallback);
}

export async function runWorkBuddyTask({ executable, project, instruction, resumeSessionId = '', interactionKeyEnv, onProgress = async () => {}, control = {} }) {
  const host = await hostFor(project, executable, interactionKeyEnv);
  const runId = randomUUID();
  const conversationId = resumeSessionId || `shenlan-${randomUUID()}`;
  const body = {
    version: '1.0', id: runId, type: 'message', source: { platform: 'shenlan', sender: { id: 'remote-user' }, conversation: { id: conversationId } }, payload: { text: validateInstruction(instruction) }
  };
  const headers = { ...host.headers, 'Content-Type': 'application/json', 'X-Shenlan-Trace': randomBytes(12).toString('hex') };
  const created = await fetch(`${host.baseUrl}/api/v1/runs`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!created.ok) throw new Error(`WorkBuddy Gateway 拒绝任务（HTTP ${created.status}）`);
  const createdBody = await created.json().catch(() => ({}));
  const actualRunId = workBuddyRunId(createdBody, runId);
  control.closed = false; control.cancelled = false;
  control.cancel = async () => {
    control.cancelled = true;
    await fetch(`${host.baseUrl}/api/v1/runs/${encodeURIComponent(actualRunId)}/cancel`, { method: 'POST', headers: host.headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
  };
  await onProgress({ summary: 'WorkBuddy 已通过本机 Gateway 开始处理', progressPercent: 35 });
  try {
    const stream = await fetch(`${host.baseUrl}/api/v1/runs/${encodeURIComponent(actualRunId)}/stream`, { headers: { ...host.headers, Accept: 'text/event-stream' } });
    if (!stream.ok) throw new Error(`WorkBuddy 结果流连接失败（HTTP ${stream.status}）`);
    const text = await stream.text();
    const parsed = finalFromEvents(eventDataBlocks(text));
    return { sessionId: parsed.sessionId || conversationId, finalReply: safeFinalReply(parsed.reply), diagnostic: parsed.reply ? '' : 'WorkBuddy 完成事件没有可展示的 markdown 内容', resumeSessionId, exitCode: parsed.reply ? 0 : 1, signal: '', cancelled: Boolean(control.cancelled) };
  } finally { closeControl(control); }
}

export async function shutdownWorkBuddyHosts() {
  const running = [...hosts.values()];
  hosts.clear();
  await Promise.all(running.map(stopOwnedGateway));
}
