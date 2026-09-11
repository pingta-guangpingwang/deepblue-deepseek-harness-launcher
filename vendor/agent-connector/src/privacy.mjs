import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function cleanLabel(value, maximum = 160) {
  return String(value || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maximum);
}

async function gitBranch(projectPath, interactionKeyEnv) {
  return new Promise((resolve) => {
    const childEnvironment = { ...process.env };
    if (interactionKeyEnv) delete childEnvironment[interactionKeyEnv];
    delete childEnvironment.SHENLAN_AGENT_INTERACTION_KEY;
    const child = spawn('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    child.stdout.on('data', (chunk) => { if (output.length < 512) output += chunk.toString('utf8').slice(0, 512 - output.length); });
    child.once('error', () => { clearTimeout(timer); resolve(''); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 ? cleanLabel(output) : ''); });
  });
}

export async function buildProjectCatalog(projects, installationId, interactionKeyEnv = '') {
  const catalog = [];
  const seen = new Set();
  for (const project of projects) {
    const id = sha256(`project-v1\0${installationId}\0${project.identitySeed || project.name}`);
    if (seen.has(id)) throw new Error(`项目标识重复，无法生成唯一稳定哈希：${project.name}`);
    seen.add(id);
    const branch = cleanLabel(project.branch || await gitBranch(project.path, interactionKeyEnv));
    const worktreeName = cleanLabel(project.worktreeName || path.basename(project.path));
    catalog.push({
      id,
      name: cleanLabel(project.name),
      path: project.path,
      branch,
      worktreeName,
      runtimeAgentId: cleanLabel(project.runtimeAgentId || 'main', 120),
      workspaceKind: cleanLabel(project.workspaceKind || 'project', 24),
      lastActivityAt: project.lastActivityAt || null
    });
  }
  return catalog;
}

// 目录身份指纹：仅 sha256 单向摘要，不含任何明文路径。群聊「共用一个项目文件夹」
// 用它把不同成员的项目按真实目录归组（盘符/分隔符先归一化再哈希，大小写不敏感）。
export function projectPathKey(projectPath) {
  const value = String(projectPath || '').trim();
  if (!value) return '';
  return sha256(value.replace(/\\/g, '/').toLowerCase());
}

export function projectSnapshot(project) {
  const pathKey = projectPathKey(project.path);
  return {
    id: project.id,
    name: project.name,
    kind: project.workspaceKind || 'project',
    meta: {
      branch: project.branch,
      worktreeName: project.worktreeName,
      repositoryName: project.name,
      runtimeAgentId: project.runtimeAgentId,
      ...(pathKey ? { pathKey } : {})
    },
    revision: 1,
    ...(project.lastActivityAt ? { lastActivityAt: project.lastActivityAt } : {})
  };
}

export function sessionSnapshot(session) {
  const runtimeSessionId = session.runtimeSessionId || session.codexSessionId;
  return {
    id: runtimeSessionId,
    projectId: session.projectId,
    title: cleanLabel(session.title || '智能体会话', 180),
    titleQuality: ['native', 'prompt', 'generated', 'fallback'].includes(session.titleQuality) ? session.titleQuality : 'fallback',
    status: ['idle', 'running', 'waiting', 'completed', 'error'].includes(session.status) ? session.status : 'idle',
    revision: Math.max(0, Number(session.revision || 0)),
    lastActivityAt: session.lastActivityAt || new Date().toISOString()
  };
}

function safeIdentifier(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 191 || /[\x00-\x1F]/.test(text)) return '';
  return text;
}

export function parseCodexJsonLine(line) {
  let event;
  try { event = JSON.parse(line); }
  catch { return null; }
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '');
  const sessionId = safeIdentifier(
    event.thread_id || event.threadId || event.session_id || event.sessionId ||
    (event.thread && event.thread.id) || (type === 'thread.started' ? event.id : '')
  );
  let progress = null;
  if (type === 'thread.started') progress = { summary: '已建立 Codex 会话', progressPercent: 12 };
  else if (type === 'turn.started') progress = { summary: 'Codex 已开始处理任务', progressPercent: 20 };
  else if (type === 'item.started' || type === 'item.completed') {
    const itemType = String(event.item && event.item.type || '');
    if (['command_execution', 'mcp_tool_call', 'tool_call'].includes(itemType)) progress = { summary: '正在执行项目操作', progressPercent: 55 };
    else if (['file_change', 'file_changes'].includes(itemType)) progress = { summary: '正在整理文件变更', progressPercent: 75 };
    else if (itemType === 'agent_message') progress = { summary: '正在整理最终回复', progressPercent: 88 };
  } else if (type === 'turn.completed') progress = { summary: 'Codex 已完成本地任务', progressPercent: 96 };
  else if (type === 'error') progress = { summary: 'Codex 本地执行遇到问题', progressPercent: null };
  return { type, sessionId, progress };
}

export function parseClaudeJsonLine(line) {
  let event;
  try { event = JSON.parse(line); }
  catch { return null; }
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '');
  const subtype = String(event.subtype || '');
  const sessionId = safeIdentifier(event.session_id || event.sessionId);
  let progress = null;
  let finalReply = '';
  if (type === 'system' && subtype === 'init') progress = { summary: '已建立 Claude Code 会话', progressPercent: 12 };
  else if (type === 'assistant') {
    const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
    if (content.some((item) => item && item.type === 'tool_use')) progress = { summary: 'Claude Code 正在执行项目操作', progressPercent: 60 };
    else progress = { summary: 'Claude Code 正在分析任务', progressPercent: 35 };
  } else if (type === 'result') {
    finalReply = safeFinalReply(event.result || '');
    progress = subtype === 'success'
      ? { summary: 'Claude Code 已完成本地任务', progressPercent: 96 }
      : { summary: 'Claude Code 本地执行遇到问题', progressPercent: null };
  }
  return { type, subtype, sessionId, progress, finalReply };
}

export function parseCodeBuddyResult(value) {
  const body = String(value || '').trim();
  if (!body) return null;
  let event;
  try { event = JSON.parse(body); }
  catch {
    // Windows PowerShell can prepend a CLIXML progress record before
    // CodeBuddy's JSON event array. Keep stdout as the source of truth, but
    // isolate the complete JSON envelope instead of treating the successful
    // native run as an empty reply.
    for (const [opening, closing] of [['[', ']'], ['{', '}']]) {
      const start = body.indexOf(opening);
      const end = body.lastIndexOf(closing);
      if (start < 0 || end <= start) continue;
      try { event = JSON.parse(body.slice(start, end + 1)); break; } catch {}
    }
  }
  if (!event) {
    const lines = body.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { event = JSON.parse(lines[index]); break; } catch {}
    }
  }
  if (!event || typeof event !== 'object') return null;
  const events = Array.isArray(event) ? event : [event];
  let finalReply = '';
  let sessionId = '';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (!item || typeof item !== 'object') continue;
    const result = item.result && typeof item.result === 'object' ? item.result : item;
    if (!sessionId) sessionId = safeIdentifier(result.session_id || result.sessionId || item.session_id || item.sessionId);
    if (!finalReply) {
      finalReply = safeFinalReply(
        typeof result.result === 'string' ? result.result :
          result.final || result.finalReply || result.message?.content || item.final || ''
      );
    }
    if (!finalReply && item.role === 'assistant' && Array.isArray(item.content)) {
      finalReply = safeFinalReply(item.content
        .filter((content) => content && ['output_text', 'text'].includes(String(content.type || '')))
        .map((content) => content.text || content.output_text || '')
        .filter(Boolean)
        .join('\n\n'));
    }
    if (finalReply && sessionId) break;
  }
  if (!finalReply && !sessionId) return null;
  return { sessionId, finalReply };
}

export function parseQClawResult(value) {
  let envelope = value;
  if (typeof value === 'string') {
    const start = value.indexOf('{');
    if (start < 0) return null;
    try { envelope = JSON.parse(value.slice(start)); }
    catch { return null; }
  }
  if (!envelope || typeof envelope !== 'object') return null;
  const result = envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope;
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const finalReply = safeFinalReply(
    envelope.final || result.final || payloads.map((item) => item && item.text || '').filter(Boolean).join('\n\n')
  );
  const agentMeta = result.meta && result.meta.agentMeta || envelope.meta && envelope.meta.agentMeta || {};
  const sessionId = safeIdentifier(envelope.sessionId || result.sessionId || agentMeta.sessionId);
  const status = String(envelope.status || result.status || '');
  return {
    sessionId,
    finalReply,
    ok: envelope.ok === true || status === 'ok' || status === 'success',
    status
  };
}

export function safeFinalReply(value) {
  const reply = String(value || '').trim();
  return reply.length <= 200000 ? reply : reply.slice(0, 200000);
}

export function publicSnapshotDocument(projects, sessions, baseRevision, commandId) {
  return {
    baseRevision: Math.max(0, Number(baseRevision || 0)),
    projects: projects.map(projectSnapshot),
    sessions: sessions.map(sessionSnapshot),
    ...(commandId ? { commandId } : {})
  };
}
