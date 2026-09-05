import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

const DEFAULT_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGES = 30;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_HISTORY_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CHARACTERS = 50000;
const NEAR_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeTime(value, fallback = '') {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\bagh_live_[A-Za-z0-9_-]+\b/g, '[交互密钥已隐藏]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[GitHub 密钥已隐藏]')
    .replace(/\bghp_[A-Za-z0-9]+\b/g, '[GitHub 密钥已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[模型密钥已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [凭据已隐藏]')
    .replace(/((?:password|passwd|密码)\s*[:=：]\s*)[^\s,，;；]{6,}/gi, '$1[已隐藏]');
}

export function unwrapRemoteInstruction(value) {
  const text = String(value || '').trim();
  const matches = [...text.matchAll(/(?:^|\n)用户任务\s*[:：]\s*/g)];
  if (!matches.length) return text;
  const last = matches[matches.length - 1];
  return text.slice((last.index || 0) + last[0].length).trim();
}

function normalizedVisibleText(value) {
  return redactSensitiveText(unwrapRemoteInstruction(value))
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_MESSAGE_CHARACTERS);
}

export function visibleContentText(content) {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).filter(Boolean).join('\n\n');
}

function visibleMessage(namespace, role, value, occurredAt, sequence) {
  const body = normalizedVisibleText(value);
  if (!body) return null;
  return {
    id: hash(`${namespace}-history-v1\0${role}\0${occurredAt}\0${sequence}\0${body}`),
    role,
    text: body,
    occurredAt
  };
}

export function semanticSessionTitle(...candidates) {
  for (const candidate of candidates) {
    let text = normalizedVisibleText(candidate);
    if (!text) continue;
    text = text
      .replace(/<[^>]{1,120}>/g, ' ')
      .replace(/```[\s\S]*?```/g, ' 代码 ')
      .replace(/[`*_>#\[\](){}]/g, ' ')
      .replace(/https?:\/\/\S+/gi, ' 链接 ')
      .replace(/\s+/g, ' ')
      .replace(/^(?:(?:请|麻烦|帮我|你能否|能不能)\s*)+/i, '')
      .trim();
    if (!text) continue;
    const characters = Array.from(text);
    return characters.length > 42 ? `${characters.slice(0, 41).join('')}…` : text;
  }
  return '未命名话题';
}

async function readTail(filePath, maximumBytes = MAX_HISTORY_BYTES) {
  const metadata = await stat(filePath);
  const start = Math.max(0, metadata.size - maximumBytes);
  const length = metadata.size - start;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally { await handle.close(); }
}

function codexVisibleMessage(event, sequence) {
  if (event?.type !== 'event_msg' || !event.payload || typeof event.payload !== 'object') return null;
  const type = String(event.payload.type || '');
  if (type !== 'user_message' && type !== 'agent_message') return null;
  if (type === 'agent_message' && event.payload.phase && event.payload.phase !== 'final_answer') return null;
  const role = type === 'user_message' ? 'user' : 'assistant';
  const occurredAt = safeTime(event.timestamp || event.payload.timestamp);
  return visibleMessage('codex', role, event.payload.message || '', occurredAt, sequence);
}

function claudeVisibleMessage(event, sequence) {
  if (!event || !['user', 'assistant'].includes(String(event.type || '')) || event.isSidechain === true || event.isMeta === true) return null;
  const role = event.type === 'user' ? 'user' : 'assistant';
  const content = visibleContentText(event.message?.content);
  return visibleMessage('claude', role, content, safeTime(event.timestamp || event.message?.timestamp), sequence);
}

function qclawVisibleMessage(event, sequence) {
  if (event?.type !== 'message' || !event.message || !['user', 'assistant'].includes(String(event.message.role || ''))) return null;
  const role = String(event.message.role);
  const content = visibleContentText(event.message.content);
  return visibleMessage('qclaw', role, content, safeTime(event.timestamp || event.message.timestamp), sequence);
}

function parseHistoryText(text, maximum, parser) {
  const messages = [];
  let sequence = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = parser(event, sequence++);
    if (!message) continue;
    const previous = messages[messages.length - 1];
    const previousTime = previous ? Date.parse(previous.occurredAt || '') : NaN;
    const messageTime = Date.parse(message.occurredAt || '');
    const nearDuplicate = previous && previous.role === message.role && previous.text === message.text
      && Number.isFinite(previousTime) && Number.isFinite(messageTime)
      && Math.abs(messageTime - previousTime) <= NEAR_DUPLICATE_WINDOW_MS;
    if (!nearDuplicate) messages.push(message);
  }
  const bounded = Math.max(1, Math.min(MAX_HISTORY_MESSAGES, Number(maximum) || DEFAULT_HISTORY_MESSAGES));
  return messages.slice(-bounded);
}

export function parseCodexHistoryText(text, maximum = DEFAULT_HISTORY_MESSAGES) {
  return parseHistoryText(text, maximum, codexVisibleMessage);
}

export function parseClaudeHistoryText(text, maximum = DEFAULT_HISTORY_MESSAGES) {
  return parseHistoryText(text, maximum, claudeVisibleMessage);
}

export function parseQClawHistoryText(text, maximum = DEFAULT_HISTORY_MESSAGES) {
  return parseHistoryText(text, maximum, qclawVisibleMessage);
}

export async function readRuntimeSessionHistory(session, adapterCode, maximum = DEFAULT_HISTORY_MESSAGES) {
  if (!session || !session.historyPath) return [];
  if (adapterCode === 'codex') {
    let messages = [];
    const expected = Math.max(1, Math.min(MAX_HISTORY_MESSAGES, Number(maximum) || DEFAULT_HISTORY_MESSAGES));
    for (const maximumBytes of [MAX_HISTORY_BYTES, 16 * 1024 * 1024, MAX_CODEX_HISTORY_SCAN_BYTES]) {
      const source = await readTail(session.historyPath, maximumBytes).catch(() => '');
      messages = parseCodexHistoryText(source, maximum);
      if (messages.length >= expected) break;
    }
    const firstUser = messages.findIndex((message) => message.role === 'user');
    if (firstUser > 0) messages = messages.slice(firstUser);
    return messages;
  }
  const source = await readTail(session.historyPath).catch(() => '');
  if (adapterCode === 'claude-code' || adapterCode === 'codebuddy') return parseClaudeHistoryText(source, maximum);
  if (adapterCode === 'qclaw') return parseQClawHistoryText(source, maximum);
  return [];
}
