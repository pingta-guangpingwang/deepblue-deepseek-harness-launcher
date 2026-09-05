#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CALLBACK_ROOT = path.resolve(process.env.SHENLAN_IDE_CALLBACK_DIR || path.join(os.tmpdir(), 'shenlan-agent-ide-callbacks'));
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,96}$/;

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function failure(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function clip(value, maximum) { return String(value || '').replace(/\u0000/g, '').trim().slice(0, maximum); }

async function atomicJson(target, value) {
  await mkdir(CALLBACK_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

async function callTool(name, args = {}) {
  const taskToken = clip(args.taskToken, 96);
  if (!TOKEN_PATTERN.test(taskToken)) throw new Error('taskToken 无效');
  if (name === 'shenlan_remote_progress') {
    await atomicJson(path.join(CALLBACK_ROOT, `${taskToken}.progress.json`), {
      status: 'running', summary: clip(args.summary, 240) || '智能体正在处理', progressPercent: Math.max(1, Math.min(95, Number(args.progressPercent) || 50)), updatedAt: new Date().toISOString()
    });
    return { content: [{ type: 'text', text: '进度已安全回传。' }] };
  }
  if (name === 'shenlan_remote_complete') {
    const reply = clip(args.reply, 200000);
    if (!reply) throw new Error('reply 不能为空');
    await atomicJson(path.join(CALLBACK_ROOT, `${taskToken}.result.json`), { status: 'completed', reply, updatedAt: new Date().toISOString() });
    return { content: [{ type: 'text', text: '最终结果已安全回传，可以结束本次任务。' }] };
  }
  if (name === 'shenlan_remote_fail') {
    await atomicJson(path.join(CALLBACK_ROOT, `${taskToken}.result.json`), { status: 'failed', message: clip(args.message, 4000) || '智能体未能完成任务', updatedAt: new Date().toISOString() });
    return { content: [{ type: 'text', text: '失败原因已安全回传。' }] };
  }
  throw new Error('未知工具');
}

const tools = [
  { name: 'shenlan_remote_progress', description: '向深蓝远程办公网页回传当前任务进度。', inputSchema: { type: 'object', properties: { taskToken: { type: 'string' }, summary: { type: 'string' }, progressPercent: { type: 'number' } }, required: ['taskToken', 'summary'] } },
  { name: 'shenlan_remote_complete', description: '任务完成后把可直接展示给用户的最终回答回传到深蓝远程办公网页。每个远程任务必须调用一次。', inputSchema: { type: 'object', properties: { taskToken: { type: 'string' }, reply: { type: 'string' } }, required: ['taskToken', 'reply'] } },
  { name: 'shenlan_remote_fail', description: '任务无法完成时把明确、脱敏的失败原因回传到深蓝远程办公网页。', inputSchema: { type: 'object', properties: { taskToken: { type: 'string' }, message: { type: 'string' } }, required: ['taskToken', 'message'] } }
];

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return null;
  if (message.method === 'initialize') return response(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shenlan-remote-office', version: '1.0.0' } });
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null;
  if (message.method === 'ping') return response(message.id, {});
  if (message.method === 'tools/list') return response(message.id, { tools });
  if (message.method === 'tools/call') {
    try { return response(message.id, await callTool(message.params?.name, message.params?.arguments)); }
    catch (error) { return failure(message.id, -32602, clip(error.message, 500)); }
  }
  return message.id === undefined ? null : failure(message.id, -32601, 'Method not found');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    Promise.resolve().then(() => handle(JSON.parse(line))).then((value) => {
      if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
    }).catch((error) => process.stdout.write(`${JSON.stringify(failure(null, -32603, clip(error.message, 500)))}\n`));
  }
});
