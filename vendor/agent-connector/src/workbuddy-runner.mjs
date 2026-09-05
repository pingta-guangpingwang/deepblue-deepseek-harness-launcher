import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { safeFinalReply } from './privacy.mjs';
import { childEnvironmentWithoutSecret, closeControl, validateInstruction } from './runner-common.mjs';

const hosts = new Map();

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

async function waitReady(baseUrl, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('WorkBuddy Gateway 启动后立即退出');
    const ok = await fetch(`${baseUrl}/api/openapi.json`, { headers: { 'X-CodeBuddy-Request': '1' } }).then((response) => response.ok).catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('等待 WorkBuddy Gateway 就绪超时');
}

async function hostFor(project, executable, interactionKeyEnv) {
  const key = process.platform === 'win32' ? project.path.toLowerCase() : project.path;
  const previous = hosts.get(key);
  if (previous && previous.child.exitCode === null) return previous;
  const cli = await workBuddyCli(executable === 'workbuddy' ? '' : executable);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [cli, '--serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: project.path, env: childEnvironmentWithoutSecret(interactionKeyEnv), shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']
  });
  const host = { child, baseUrl, projectPath: project.path };
  hosts.set(key, host);
  child.once('close', () => { if (hosts.get(key) === host) hosts.delete(key); });
  await waitReady(baseUrl, child);
  return host;
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
  const headers = { 'Content-Type': 'application/json', 'X-CodeBuddy-Request': '1', 'X-Shenlan-Trace': randomBytes(12).toString('hex') };
  const created = await fetch(`${host.baseUrl}/api/v1/runs`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!created.ok) throw new Error(`WorkBuddy Gateway 拒绝任务（HTTP ${created.status}）`);
  const createdBody = await created.json().catch(() => ({}));
  const actualRunId = workBuddyRunId(createdBody, runId);
  control.closed = false; control.cancelled = false;
  control.cancel = async () => {
    control.cancelled = true;
    await fetch(`${host.baseUrl}/api/v1/runs/${encodeURIComponent(actualRunId)}/cancel`, { method: 'POST', headers: { 'X-CodeBuddy-Request': '1' } }).catch(() => {});
  };
  await onProgress({ summary: 'WorkBuddy 已通过本机 Gateway 开始处理', progressPercent: 35 });
  try {
    const stream = await fetch(`${host.baseUrl}/api/v1/runs/${encodeURIComponent(actualRunId)}/stream`, { headers: { 'X-CodeBuddy-Request': '1', Accept: 'text/event-stream' } });
    if (!stream.ok) throw new Error(`WorkBuddy 结果流连接失败（HTTP ${stream.status}）`);
    const text = await stream.text();
    const parsed = finalFromEvents(eventDataBlocks(text));
    return { sessionId: parsed.sessionId || conversationId, finalReply: safeFinalReply(parsed.reply), diagnostic: parsed.reply ? '' : 'WorkBuddy 完成事件没有可展示的 markdown 内容', resumeSessionId, exitCode: parsed.reply ? 0 : 1, signal: '', cancelled: Boolean(control.cancelled) };
  } finally { closeControl(control); }
}

export async function shutdownWorkBuddyHosts() {
  const running = [...hosts.values()];
  hosts.clear();
  for (const host of running) if (host.child.exitCode === null) host.child.kill('SIGTERM');
}
