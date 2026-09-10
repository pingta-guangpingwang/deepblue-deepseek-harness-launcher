// Uses the upstream ACP SDK and Cursor's documented `agent acp` transport.
// No IDE database writes, UI keystroke injection, copied OAuth secrets, or --force.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { childEnvironmentWithoutSecret, terminateRuntime, validateInstruction } from './runner-common.mjs';
import { safeFinalReply } from './privacy.mjs';
import { redactSensitiveText, unwrapRemoteInstruction } from './session-history.mjs';

const sessionIdPattern = /^[A-Za-z0-9._:-]{1,191}$/;
export function cursorArguments(args = []) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /^(?:--(?:force|yolo|trust|approve-mcps|sandbox|api-key|auth-token|header)(?:=|$)|-[fH]$)/i.test(value))) throw new Error('Cursor 包装参数不得覆盖沙箱、自动批准或传入明文凭据');
  if (args.length > 1 || args.length === 1 && (!path.isAbsolute(args[0]) || path.basename(args[0]) !== 'index.js')) throw new Error('Cursor 只接受官方可执行程序或一个绝对路径 index.js 入口');
  return [...args, '--sandbox', 'enabled', 'acp'];
}
const normalizePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
async function sameDirectory(a, b) { return normalizePath(await realpath(a)) === normalizePath(await realpath(b)); }
async function insideProject(candidate, root) {
  if (!path.isAbsolute(candidate || '')) return false;
  root = await realpath(root).catch(() => '');
  if (!root) return false;
  let existing = path.resolve(candidate);
  while (true) {
    const resolved = await realpath(existing).catch(() => '');
    if (resolved) {
      const relative = path.relative(normalizePath(root), normalizePath(resolved));
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    }
    const parent = path.dirname(existing); if (parent === existing) return false; existing = parent;
  }
}

export async function cursorPermission(params, projectRoot, sandbox, sessionId) {
  const reject = () => {
    const option = params.options?.find(item => item.kind === 'reject_once');
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  };
  if (params.sessionId !== sessionId) return reject();
  const kind = params.toolCall?.kind;
  const allowedKinds = sandbox === 'workspace-write' ? ['read', 'search', 'edit'] : ['read', 'search'];
  const locations = params.toolCall?.locations;
  // Never blanket-approve shell, network, delete, move, or unknown operations.
  if (!allowedKinds.includes(kind) || !Array.isArray(locations) || locations.length === 0) return reject();
  if (!(await Promise.all(locations.map(item => insideProject(item.path, projectRoot)))).every(Boolean)) return reject();
  const option = params.options?.find(item => item.kind === 'allow_once');
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : reject();
}

export function createCursorClient(state, options) {
  return acp.client({ name: 'shenlan-cursor', version: '1.0.0' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.sessionId !== state.sessionId) return;
      const update = params.update;
      if (state.capturing && ['tool_call', 'tool_call_update'].includes(update.sessionUpdate) && update.toolCallId) {
        state.toolCalls ||= new Map();
        state.toolCalls.set(update.toolCallId, mergeCursorToolCall(state.toolCalls.get(update.toolCallId), update));
      }
      if (state.capturing && typeof options.onEvent === 'function' && ['agent_message_chunk', 'user_message_chunk', 'tool_call', 'tool_call_update', 'plan', 'usage_update'].includes(update.sessionUpdate)) {
        state.eventQueue = (state.eventQueue || Promise.resolve()).then(async () => {
          if (!state.eventError) await options.onEvent({ source: 'cursor', type: update.sessionUpdate, data: update });
        }).catch(error => { state.eventError ||= error; });
      }
      if (state.captureHistory && ['user_message_chunk', 'agent_message_chunk'].includes(update.sessionUpdate) && update.content?.type === 'text') {
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
        const last = state.history.at(-1);
        if (last?.role === role) last.text = (last.text + update.content.text).slice(0, 50000);
        else state.history.push({ role, text: update.content.text.slice(0, 50000), ordinal: state.historyOrdinal++ });
        state.history = state.history.slice(-20);
      }
      if (!state.capturing) return;
      if (update.sessionUpdate === 'tool_call') state.reply = '';
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        state.reply += update.content.text;
        if (!options.fullOutput && state.reply.length > 100000) { state.reply = state.reply.slice(0, 100000); state.truncated = true; }
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      let decision;
      await state.eventQueue;
      if (state.eventError) {
        state.permissionDenied = true;
        return { outcome: { outcome: 'cancelled' } };
      }
      if (typeof options.onApproval === 'function' && params.sessionId === state.sessionId) {
        const toolCall = mergeCursorToolCall(state.toolCalls?.get(params.toolCall?.toolCallId), params.toolCall);
        const raw = toolCall.rawInput;
        const kind = toolCall.kind === 'fetch' ? 'network' : toolCall.kind || 'other';
        const command = typeof raw === 'string' ? raw : typeof raw?.command === 'string' ? raw.command : typeof raw?.commandLine === 'string' ? raw.commandLine : '';
        const approved = await options.onApproval({ nativeId: toolCall.toolCallId || '', kind,
          paths: (toolCall.locations || []).map(item => path.isAbsolute(item.path) ? item.path : path.resolve(options.projectRoot, item.path)),
          command, destination: typeof raw?.url === 'string' ? raw.url : '', title: toolCall.title || '', rawInput: raw ?? null });
        const selected = params.options?.find(item => item.kind === (approved?.approved === true ? 'allow_once' : 'reject_once'));
        decision = selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } };
      } else decision = await cursorPermission(params, options.projectRoot, options.sandbox, state.sessionId);
      const selected = params.options?.find(item => item.optionId === decision.outcome.optionId);
      if (selected?.kind !== 'allow_once') state.permissionDenied = true;
      return decision;
    })
    .onRequest('cursor/ask_question', value => value, () => ({ outcome: { outcome: 'skipped', reason: '请在群聊最终回复中提出需要用户补充的问题。' } }))
    .onRequest('cursor/create_plan', value => value, () => ({ outcome: 'rejected', reason: '远程连接不自动批准额外计划，请向用户说明。' }));
}

// ACP updates are partial. An absent/null field retains the last supplied value;
// an explicitly supplied empty object/array replaces it (never reuse stale input).
export function mergeCursorToolCall(previous = {}, incoming = {}) {
  return { ...previous, ...Object.fromEntries(Object.entries(incoming || {}).filter(([, value]) => value !== undefined && value !== null)) };
}

async function initialize(ctx, state) {
  state.stage = 'initialize';
  const result = await ctx.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  if (result.protocolVersion !== 1 || !result.authMethods?.some(item => item.id === 'cursor_login')) throw new Error('本机不是受支持的 Cursor ACP 服务');
  state.stage = 'authenticate';
  await ctx.request(acp.methods.agent.authenticate, { methodId: 'cursor_login' });
  return result;
}

export async function listCursorSessions(ctx, cwd) {
  const rows = []; const cursors = new Set(); let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await ctx.request(acp.methods.agent.session.list, { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.sessions)) throw new Error('Cursor 会话目录格式无效');
    rows.push(...result.sessions);
    if (rows.length > 4000) throw new Error('Cursor 目录超过同步上限');
    if (!result.nextCursor) return rows;
    if (cursors.has(result.nextCursor)) throw new Error('Cursor 目录分页未推进');
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new Error('Cursor 目录分页超过同步上限');
}

export async function cursorWorkflow(ctx, state, options) {
  const init = await initialize(ctx, state);
  if (options.catalogOnly) {
    state.stage = 'catalog';
    if (!init.agentCapabilities?.sessionCapabilities?.list) throw new Error('Cursor 未提供原生会话目录');
    return listCursorSessions(ctx);
  }
  const { projectRoot, sandbox, control = {}, onProgress = async () => {} } = options;
  const resumeSessionId = options.historySessionId || options.resumeSessionId || '';
  if (control.cancelled) return { cancelled: true, exitCode: 1, finalReply: '' };
  let session;
  if (resumeSessionId) {
    state.stage = 'resume_catalog';
    if (!sessionIdPattern.test(resumeSessionId) || !init.agentCapabilities?.loadSession || !init.agentCapabilities?.sessionCapabilities?.list) throw new Error('Cursor 不能验证这个原生会话的续聊归属');
    const row = (await listCursorSessions(ctx, projectRoot)).find(item => item.sessionId === resumeSessionId);
    if (!row || !(await sameDirectory(row.cwd, projectRoot)) || row.additionalDirectories?.some(directory => normalizePath(path.resolve(directory)) !== normalizePath(projectRoot))) throw new Error('Cursor 会话不属于当前唯一授权项目');
    state.sessionId = resumeSessionId;
    state.stage = 'load';
    if (options.historySessionId) { state.captureHistory = true; state.history = []; state.historyOrdinal = 0; }
    session = await ctx.request(acp.methods.agent.session.load, { sessionId: resumeSessionId, cwd: projectRoot, mcpServers: [] });
    state.captureHistory = false;
    if (options.historySessionId) return state.history.map(message => ({ id: 'cursor-acp:' + createHash('sha256').update(resumeSessionId).digest('hex').slice(0, 32) + ':' + String(message.ordinal).padStart(10, '0'), role: message.role, text: redactSensitiveText(unwrapRemoteInstruction(message.text)), occurredAt: '' }));
  } else {
    state.stage = 'new';
    session = await ctx.request(acp.methods.agent.session.new, { cwd: projectRoot, mcpServers: [] });
    if (!sessionIdPattern.test(session.sessionId || '')) throw new Error('Cursor 未返回有效原生会话编号');
    state.sessionId = session.sessionId;
  }
  const mode = sandbox === 'read-only' ? 'ask' : 'agent';
  await options.onSession?.(state.sessionId);
  state.stage = 'mode';
  if (!session.modes?.availableModes?.some(item => item.id === mode)) throw new Error('Cursor 没有提供要求的执行模式');
  await ctx.request(acp.methods.agent.session.setMode, { sessionId: state.sessionId, modeId: mode });
  control.cancel = () => ctx.notify(acp.methods.agent.session.cancel, { sessionId: state.sessionId });
  await onProgress({ summary: 'Cursor 原生会话已确认，使用官方 ACP 开始处理', progressPercent: 20 });
  if (control.cancelled) return { sessionId: state.sessionId, cancelled: true, exitCode: 1, finalReply: '' };
  state.toolCalls = new Map(); state.eventError = null;
  state.capturing = true; state.attempted = true;
  state.stage = 'prompt';
  options.onExecute?.();
  const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId: state.sessionId, prompt: [{ type: 'text', text: validateInstruction(options.instruction) }] });
  state.capturing = false;
  await state.eventQueue;
  if (state.eventError) throw state.eventError;
  const finalReply = options.fullOutput ? state.reply : safeFinalReply(state.reply + (state.truncated ? '\n[回复已截断]' : ''));
  return { sessionId: state.sessionId, resumeSessionId, finalReply, exitCode: result.stopReason === 'end_turn' && !state.permissionDenied && state.reply.trim() ? 0 : 1, cancelled: result.stopReason === 'cancelled', diagnostic: state.permissionDenied ? 'Cursor 请求了当前授权范围以外的操作，已拒绝；没有自动提权。' : result.stopReason === 'end_turn' ? (state.reply.trim() ? '' : 'Cursor 没有返回可确认的最终回复。') : `Cursor 未正常完成：${result.stopReason}`, signal: '' };
}

export async function withCursorRuntime(options, operations = {}) {
  const projectRoot = await realpath(options.project.path);
  const sandbox = options.sandbox || 'workspace-write';
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Cursor 不接受此权限模式');
  const child = (operations.spawn || spawn)(options.executable, cursorArguments(options.executableArgs), { cwd: projectRoot, shell: false, windowsHide: true, env: childEnvironmentWithoutSecret(options.interactionKeyEnv), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr?.resume();
  const state = { sessionId: '', capturing: false, attempted: false, reply: '', permissionDenied: false };
  let timeout = setTimeout(() => terminateRuntime({ child, cancelled: false }), 30000);
  const spawnFailure = new Promise((_, reject) => child.once('error', reject));
  try {
    const workflow = createCursorClient(state, { ...options, projectRoot, sandbox }).connectWith(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), ctx => cursorWorkflow(ctx, state, { ...options, projectRoot, sandbox, onExecute: () => { clearTimeout(timeout); timeout = setTimeout(() => terminateRuntime({ child, cancelled: false }), 30 * 60 * 1000); } }));
    return await Promise.race([workflow, spawnFailure]);
  } catch (cause) {
    const error = new Error('Cursor 本机连接或会话未完成，请检查官方 CLI 登录与原生会话状态。');
    error.stage = state.stage || 'spawn';
    if (Number.isSafeInteger(cause?.code)) error.protocolCode = cause.code;
    if (state.attempted) error.taskMayHaveExecuted = true;
    throw error;
  } finally {
    clearTimeout(timeout); if (options.control) { options.control.closed = true; delete options.control.cancel; }
    child.stdin?.end(); if (child.exitCode === null) terminateRuntime({ child, cancelled: false });
  }
}
export const runCursorTask = options => withCursorRuntime(options);
export const cursorNativeCatalog = config => withCursorRuntime({ ...config, executable: config.runtimeExecutable, executableArgs: config.runtimeExecutableArgs, project: config.projects[0], catalogOnly: true });
export const cursorSessionHistory = (config, project, session) => withCursorRuntime({ ...config, executable: config.runtimeExecutable, executableArgs: config.runtimeExecutableArgs, project, historySessionId: session.runtimeSessionId });
