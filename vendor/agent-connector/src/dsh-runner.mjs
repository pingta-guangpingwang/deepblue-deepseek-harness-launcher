import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DshClient, dshEventsSince, dshSessionRows } from './dsh-rpc.mjs';
import { safeFinalReply } from './privacy.mjs';
import { validateInstruction } from './runner-common.mjs';
import { redactSensitiveText, unwrapRemoteInstruction } from './session-history.mjs';
import { openDshApprovalBridge } from './dsh-native-approvals.mjs';

const sessionsInFlight = new Set();
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value;
async function sameDirectory(left, right) {
  const [a, b] = await Promise.all([realpath(left), realpath(right)]);
  return keyPath(a) === keyPath(b);
}

export async function probeDshHost(config, client = new DshClient(config.dshHost?.endpoint)) {
  const host = await client.call('host.describe');
  if (!host || typeof host.version !== 'string' || !path.isAbsolute(host.cwd || '') || !Number.isSafeInteger(host.attachedSessions)) throw new Error('本机端口不是兼容的 DSH Host');
  // The packaged 0.1.1-rc.2 Web composition reports its app version as 0.0.1,
  // not the npm cohort version. The Launcher independently pins the core.
  if ((config.dshHost?.expectedVersion || '0.1.1-rc.2') !== '0.1.1-rc.2' || !['0.0.1', '0.1.1-rc.2'].includes(host.version)) throw new Error('DSH 核心版本与已验证协议不一致，请更新适配器');
  if (config.dshHost?.expectedCwd && !(await sameDirectory(host.cwd, config.dshHost.expectedCwd))) throw new Error('本机 DSH 工作区与启动器配置不一致');
  return host;
}

/** Match a native turn by durable user-rpc identity, never the latest reply. */
export function dshTurnOutcome(events, rpcId) {
  let turn = null, owned = false, foreign = false, reply = '', pendingApproval = false;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn; owned = false; foreign = false; reply = ''; pendingApproval = false; }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      if (event.data.source.rpcId === rpcId) owned = true;
      else foreign = true;
    }
    if (owned && event.type === 'assistant/message') reply = (event.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('') || reply;
    if (owned && event.type === 'approval/asked') pendingApproval = true;
    if (owned && event.type === 'approval/decided') pendingApproval = false;
    if (owned && event.type === 'turn/end' && event.data?.turn === turn) return { owned, foreign, turn, pendingApproval: false, terminal: true, reply, reason: event.data.reason };
  }
  return { owned, foreign, turn, pendingApproval, terminal: false, reply };
}

export async function readDshSessionHistory(config, project, session, maximum = 20, client = new DshClient(config.dshHost?.endpoint)) {
  await probeDshHost(config, client);
  const row = dshSessionRows(await client.call('session.list')).find(item => item.sessionId === session.runtimeSessionId);
  if (!row || !(await sameDirectory(row.cwd, project.path))) throw new Error('DSH 会话历史不属于当前授权项目');
  const history = await client.call('session.history', { sessionId: row.sessionId, maxMessages: Math.min(30, maximum) });
  if (!Array.isArray(history?.events)) throw new Error('DSH 会话历史格式无效');
  return history.events.flatMap(({ event }) => {
    const user = event?.type === 'user/message' && event.data?.source?.kind === 'user';
    const assistant = event?.type === 'assistant/message';
    if (!user && !assistant) return [];
    const message = user ? event.data : event.data?.message;
    const text = (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    if (!text.trim()) return [];
    return [{ id: createHash('sha256').update(`dsh:${row.sessionId}:${event.seq}`).digest('hex'), role: user ? 'user' : 'assistant', text: redactSensitiveText(unwrapRemoteInstruction(text)).slice(0, 50000), occurredAt: new Date(event.time).toISOString() }];
  }).slice(-Math.min(30, maximum));
}

function assertPermissions(events, sandbox) {
  const mode = events.findLast(event => event.type === 'sandbox/mode')?.data?.mode;
  const policy = events.findLast(event => event.type === 'approval/policy')?.data?.policy;
  if (mode !== sandbox || !['ask', 'never'].includes(policy)) throw new Error('DSH 原生沙箱未确认；不会以更高权限发送任务');
}

export async function runDshTask({ dshHost, project, instruction, sandbox = 'workspace-write', resumeSessionId = '', runtimeRequestId = randomUUID(), onProgress = async () => {}, onSession, onEvent, onApproval, fullOutput = false, managedPermissions = false, control = {} }, operations = {}) {
  const client = operations.client || new DshClient(dshHost?.endpoint);
  const sleep = operations.sleep || delay;
  const deadline = Date.now() + (operations.timeoutMs || 30 * 60 * 1000);
  if (!['workspace-write', 'read-only'].includes(sandbox)) throw new Error('DSH 不接受扩大权限的沙箱模式');
  const prompt = validateInstruction(instruction);
  const digest = createHash('sha256').update(runtimeRequestId).digest('hex');
  const sessionId = resumeSessionId || `session-shenlan-${digest.slice(0, 40)}`;
  if (!/^[a-zA-Z0-9._:-]{1,191}$/.test(sessionId)) throw new Error('DSH 原生会话编号无效');
  const lock = `${client.endpoint || dshHost?.endpoint}:${sessionId}`;
  if (sessionsInFlight.has(lock)) throw Object.assign(new Error('DSH 当前会话已有远程任务'), { dshSessionBusy: true });
  sessionsInFlight.add(lock);
  const rpcId = `shenlan-prompt-${digest}`;
  let sent = false, attempted = false, baseline = -1, ownTurn = null, cancelRequested = false, bridge, lastEventSeq = -1;
  const result = (outcome, cancelled = false) => ({ sessionId, resumeSessionId, finalReply: fullOutput ? outcome.reply || '' : safeFinalReply(outcome.reply || ''), exitCode: !cancelled && !outcome.foreign && outcome.reason?.kind === 'completed' ? 0 : 1, cancelled, diagnostic: outcome.foreign ? 'DSH 同一轮混入其他用户消息，结果未作为当前远程任务确认' : outcome.reason?.kind === 'completed' ? '' : `DSH 本轮未完成：${String(outcome.reason?.kind || 'unknown').replace(/[^a-z-]/g, '')}`, signal: '' });
  try {
    await probeDshHost({ dshHost }, client);
    let rows = dshSessionRows(await client.call('session.list'));
    let existing = rows.find(row => row.sessionId === sessionId);
    if (resumeSessionId && !existing) throw new Error('DSH 原生会话不存在或不是可续聊主会话');
    if (existing && !(await sameDirectory(existing.cwd, project.path))) throw new Error('DSH 会话不属于本次授权项目');
    if (!existing) {
      if (control.cancelled) return result({ reason: { kind: 'aborted' } }, true);
      const created = await client.call('session.create', { sessionId, cwd: project.path });
      if (created?.sessionId !== sessionId) throw new Error('DSH 创建的会话编号不匹配');
      rows = dshSessionRows(await client.call('session.list'));
      existing = rows.find(row => row.sessionId === sessionId);
      if (!existing || !(await sameDirectory(existing.cwd, project.path))) throw new Error('DSH 新会话工作区未确认');
    }
    let events = await dshEventsSince(client, sessionId);
    const previous = dshTurnOutcome(events, rpcId);
    if (previous.terminal) return result(previous);
    sent = previous.owned; attempted = previous.owned;
    if (existing.running && !previous.owned) throw Object.assign(new Error('DSH 会话正在本机执行；不会插入或接管现有任务'), { dshSessionBusy: true });
    await onSession?.(sessionId);
    if (!previous.owned) {
      if (managedPermissions) {
        const selected = await client.call('commands/execute', { args: { agentId: sessionId, line: '/permission ' + sandbox, images: [] } });
        if (selected?.result?.kind !== 'success') throw new Error('DSH 未确认当前会话的受限权限设置');
        events = await dshEventsSince(client, sessionId);
      }
      // Inspect durable native facts; do not send slash commands over prompt.
      // Some 0.1.1 builds treat that text as a real model prompt, not a command.
      assertPermissions(events, sandbox);
      baseline = events.at(-1)?.seq ?? -1;
    }
    lastEventSeq = baseline;
    control.cancel = async () => {
      if (!sent || cancelRequested) return;
      const current = dshTurnOutcome(await dshEventsSince(client, sessionId, baseline), rpcId);
      if (!current.owned || current.foreign || current.terminal) return;
      // Cancelling the exact native turn must never stop another user's turn.
      if (ownTurn !== null && current.turn !== ownTurn) return;
      await client.call('session.cancel', { sessionId });
      cancelRequested = true;
    };
    if (typeof onApproval === 'function') {
      bridge = await (operations.openApprovalBridge || openDshApprovalBridge)({ ...dshHost, projectRoot: project.path, sessionId,
        readEvents: () => dshEventsSince(client, sessionId, baseline),
        isOwned: rows => { const outcome = dshTurnOutcome(rows, rpcId); return outcome.owned && !outcome.foreign && !outcome.terminal; }, onApproval, onProgress });
    }
    if (control.cancelled && !previous.owned) return result({ reason: { kind: 'aborted' } }, true);
    await onProgress({ summary: 'DSH 原生会话与项目权限已确认', progressPercent: 20 });
    if (!previous.owned) {
      if (control.cancelled) return result({ reason: { kind: 'aborted' } }, true);
      attempted = true;
      const accepted = await client.call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, { rpcId });
      if (accepted?.accepted !== true || accepted.command) throw new Error('DSH 未确认本轮消息接收');
    }
    sent = true;
    let approvalNotified = false;
    while (Date.now() < deadline) {
      const currentEvents = await dshEventsSince(client, sessionId, baseline);
      const outcome = dshTurnOutcome(currentEvents, rpcId);
      if (onEvent && outcome.owned && !outcome.foreign) for (const event of currentEvents) {
        if (event.seq <= lastEventSeq) continue;
        lastEventSeq = event.seq;
        if (['assistant/message', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'turn/start', 'turn/end', 'todo/write', 'goal/change', 'plan/mode'].includes(event.type) || event.type === 'user/message' && event.data?.source?.kind === 'user') await onEvent({ source: 'deepseek-harness', type: event.type, nativeSeq: event.seq, occurredAt: new Date(event.time).toISOString(), data: event.data });
      }
      if (outcome.owned) ownTurn = outcome.turn;
      if (outcome.terminal) return result(outcome, cancelRequested && outcome.reason?.kind === 'aborted');
      if (outcome.foreign && outcome.owned) throw new Error('DSH 当前远程回合混入本机消息；不会确认结果或中断本机任务');
      if (bridge?.failure) { await control.cancel(); throw new Error('DSH 审批通道中断，已停止本轮且不会自动重发'); }
      if (outcome.pendingApproval && !approvalNotified) { approvalNotified = true; await onProgress({ summary: onApproval ? 'DSH 正等待本地总控审核本次操作' : 'DSH 正等待本机权限确认，请在原生窗口处理；远程不会自动批准', progressPercent: 50 }); }
      if (control.cancelled) await control.cancel();
      await sleep(operations.pollIntervalMs ?? 1000);
    }
    await control.cancel();
    throw new Error('DSH 等待本轮完成超时；不会自动重复发送');
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error('DSH 请求失败');
    if (attempted) error.taskMayHaveExecuted = true;
    throw error;
  } finally {
    await bridge?.close();
    control.closed = true; delete control.cancel;
    sessionsInFlight.delete(lock);
  }
}
