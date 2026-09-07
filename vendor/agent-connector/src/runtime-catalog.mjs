import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { semanticSessionTitle, unwrapRemoteInstruction, visibleContentText } from './session-history.mjs';

function pathKey(value) {
  const resolved = path.resolve(nativeProjectPath(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function nativeProjectPath(value) {
  const text = String(value || '');
  // Codex exec on Windows records extended-length paths; they identify the
  // same project as the ordinary drive path used by the desktop application.
  return process.platform === 'win32' ? text.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1') : text;
}

function cleanLabel(value, fallback = '未命名项目', maximum = 160) {
  const text = String(value || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  return (text || fallback).slice(0, maximum);
}

function isoTime(value, fallback = Date.now()) {
  const number = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return new Date(Number.isFinite(number) ? number : fallback).toISOString();
}

function isInside(candidate, root, allowRootProject) {
  const relative = path.relative(root, candidate);
  if (!relative) return Boolean(allowRootProject);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isExcluded(candidate, exclusions) {
  return exclusions.some((root) => {
    const relative = path.relative(root, candidate);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

async function authorizedDirectory(candidate, discovery, explicitPaths) {
  if (!candidate) return '';
  const resolved = nativeProjectPath(await realpath(path.resolve(nativeProjectPath(candidate))).catch(() => ''));
  if (!resolved) return '';
  const metadata = await stat(resolved).catch(() => null);
  if (!metadata?.isDirectory()) return '';
  if (explicitPaths.has(pathKey(resolved))) return resolved;
  if (isExcluded(resolved, discovery.excludePaths)) return '';
  // Local-only metadata browsing is not remote execution authorization. This
  // option is supplied only by the native observer, never by loadConfigObject.
  if (discovery.localReadOnly === true && resolved !== path.parse(resolved).root) return resolved;
  return discovery.roots.some((root) => isInside(resolved, root, discovery.allowRootProjects)) ? resolved : '';
}

async function walkJsonl(root, maximum, depth = 0, output = []) {
  if (!root || output.length >= maximum || depth > 8) return output;
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    if (output.length >= maximum) break;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await walkJsonl(target, maximum, depth + 1, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const metadata = await stat(target).catch(() => null);
      if (metadata) output.push({ path: target, mtimeMs: metadata.mtimeMs });
    }
  }
  return output;
}

async function readPrefix(filePath, maximum = 512 * 1024) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function fallbackSessionTitle(label, lastActivityAt) {
  const date = new Date(lastActivityAt);
  const stamp = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : '历史会话';
  return `${label} · ${stamp}`;
}

function timeNumber(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function addProject(projects, candidate) {
  const key = pathKey(candidate.path);
  const previous = projects.get(key);
  if (!previous || Date.parse(candidate.lastActivityAt || 0) > Date.parse(previous.lastActivityAt || 0)) projects.set(key, candidate);
}

function addSession(sessions, candidate) {
  const id = String(candidate.runtimeSessionId || '').trim();
  if (!id || id.length > 191 || /[\x00-\x1F]/.test(id)) return;
  const previous = sessions.get(id);
  if (!previous || Date.parse(candidate.lastActivityAt || 0) > Date.parse(previous.lastActivityAt || 0)) sessions.set(id, candidate);
}

function remoteManagedRuntimeText(...values) {
  const text = values.map((value) => String(value || '')).join('\n');
  return /你正在通过深蓝智能体工作台|深蓝远程办公(?:总控|接力)|shenlan_remote_office/i.test(text);
}

function codexSourceKind(value) {
  if (value && typeof value === 'object') {
    if (value.subAgent || value.subagent) return 'subagent';
    return String(value.custom || '').trim().replace(/[-_]/g, '').toLowerCase();
  }
  const source = String(value || '').trim();
  if (!source) return '';
  if (source.startsWith('{')) {
    try { return codexSourceKind(JSON.parse(source)); } catch { return 'unknown'; }
  }
  return source.replace(/[-_]/g, '').toLowerCase();
}

function codexInteractiveSource(value) {
  const source = codexSourceKind(value);
  return !source || ['vscode', 'cli', 'exec', 'appserver', 'user'].includes(source);
}

export function codexDatabaseThreadIsVisible(row = {}) {
  const threadSource = String(row.thread_source || '').trim().toLowerCase();
  const source = codexSourceKind(row.source);
  if (threadSource === 'subagent' || (source ? !codexInteractiveSource(row.source) : !['user', 'composer_link'].includes(threadSource))) return false;
  return !remoteManagedRuntimeText(row.first_user_message, row.preview, row.title, row.name);
}

export function codexAppServerThreadIsVisible(thread = {}) {
  if (!thread.id || !thread.cwd || thread.ephemeral === true || thread.parentThreadId || thread.agentNickname || thread.agentRole) return false;
  if (!codexInteractiveSource(thread.source)) return false;
  return !remoteManagedRuntimeText(thread.preview, thread.name);
}

function codexTopLevelSource(payload, firstUserMessage = '') {
  const source = payload?.source;
  if (!source || typeof source === 'object') return false;
  const sourceKind = String(source).trim().toLowerCase();
  if (!['vscode', 'cli', 'exec', 'user'].includes(sourceKind)) return false;
  return !remoteManagedRuntimeText(firstUserMessage, payload?.serviceName, payload?.service_name);
}

function codexPrefixMetadata(prefix) {
  let payload = null;
  let firstUserMessage = '';
  for (const line of String(prefix || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!payload && event?.type === 'session_meta' && event.payload && typeof event.payload === 'object') payload = event.payload;
    if (!firstUserMessage && event?.type === 'event_msg' && event?.payload?.type === 'user_message') {
      firstUserMessage = unwrapRemoteInstruction(event.payload.message || '');
    }
    if (payload && firstUserMessage) break;
  }
  return { payload, firstUserMessage };
}

function codexSessionMetaLineage(prefix) {
  const ids = [];
  for (const line of String(prefix || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'session_meta') continue;
    const id = String(event?.payload?.id || event?.payload?.session_id || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length > 2) break;
  }
  return ids;
}

export function codexResumeArtifact(prefix, currentThreadId, metadata = {}) {
  if (metadata?.forkedFromId || metadata?.parentThreadId) return false;
  const current = String(currentThreadId || '').trim();
  const lineage = codexSessionMetaLineage(prefix);
  return Boolean(current && lineage[0] === current && lineage.slice(1).some((id) => id !== current));
}

function repairCodexIndexTitle(value) {
  const source = String(value || '').trim();
  if (!source || [...source].some((character) => character.codePointAt(0) > 255)) return source;
  const bytes = Uint8Array.from([...source], (character) => character.charCodeAt(0));
  let repaired = '';
  try { repaired = new TextDecoder('gbk', { fatal: true }).decode(bytes).trim(); } catch { return source; }
  const chineseCount = (text) => (String(text).match(/[\u3400-\u9FFF]/g) || []).length;
  return chineseCount(repaired) > chineseCount(source) ? repaired : source;
}

async function codexThreadTitleIndex(runtimeHome) {
  const indexPath = path.join(runtimeHome, 'session_index.jsonl');
  let contents = '';
  try { contents = await readFile(indexPath, 'utf8'); } catch { return new Map(); }
  const titles = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const id = String(entry?.id || '').trim();
    const threadName = repairCodexIndexTitle(entry?.thread_name);
    if (!id || !threadName) continue;
    const updatedAt = timeNumber(entry.updated_at);
    const previous = titles.get(id);
    if (!previous || updatedAt >= previous.updatedAt) titles.set(id, { title: threadName, updatedAt });
  }
  return new Map([...titles].map(([id, entry]) => [id, entry.title]));
}

async function codexStateDatabase(runtimeHome) {
  const entries = await readdir(runtimeHome, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^state(?:_[0-9]+)?\.sqlite$/i.test(entry.name)) continue;
    const candidate = path.join(runtimeHome, entry.name);
    const metadata = await stat(candidate).catch(() => null);
    if (metadata) candidates.push({ path: candidate, mtimeMs: metadata.mtimeMs });
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path || '';
}

function recentRuntimeStatus(value, runningWindowMs = 30000) {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(time) && Date.now() - time <= runningWindowMs ? 'running' : 'idle';
}

async function discoverCodexFromDatabase(config, projects, sessions, explicitPaths) {
  const databasePath = await codexStateDatabase(config.projectDiscovery.runtimeHome);
  if (!databasePath) return false;
  const indexedTitles = await codexThreadTitleIndex(config.projectDiscovery.runtimeHome);
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return false; }
  let database;
  try {
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare(`SELECT id,rollout_path,cwd,title,name,first_user_message,preview,updated_at,thread_source,source
      FROM threads
      WHERE archived=0
      ORDER BY updated_at DESC
      LIMIT ?`).all(config.projectDiscovery.historyFileLimit);
    for (const row of rows) {
      if (!codexDatabaseThreadIsVisible(row)) continue;
      const runtimeSessionId = String(row.id || '').trim();
      const historyPath = String(row.rollout_path || '').trim();
      const lineagePrefix = historyPath ? await readPrefix(historyPath, 256 * 1024).catch(() => '') : '';
      if (codexResumeArtifact(lineagePrefix, runtimeSessionId)) continue;
      const projectPath = await authorizedDirectory(row.cwd, config.projectDiscovery, explicitPaths);
      if (!runtimeSessionId || !projectPath) continue;
      const seconds = Number(row.updated_at || 0);
      const lastActivityAt = isoTime(seconds > 100000000000 ? seconds : seconds * 1000);
      addProject(projects, {
        name: cleanLabel(path.basename(projectPath)), path: projectPath, runtimeAgentId: 'main', workspaceKind: 'project',
        identitySeed: `codex:${pathKey(projectPath)}`, lastActivityAt
      });
      addSession(sessions, {
        runtimeSessionId,
        projectPath,
        title: semanticSessionTitle(row.name, indexedTitles.get(runtimeSessionId), row.title, row.first_user_message, row.preview),
        titleQuality: row.name || indexedTitles.has(runtimeSessionId) ? 'native' : row.title || row.first_user_message || row.preview ? 'prompt' : 'fallback',
        historyPath,
        status: recentRuntimeStatus(seconds > 100000000000 ? seconds : seconds * 1000),
        revision: Math.max(0, Math.floor(seconds)),
        lastActivityAt
      });
    }
    return true;
  } catch { return false; }
  finally { try { database?.close(); } catch {} }
}

function codexThreadStatus(thread) {
  const status = String(thread?.status?.type || '').trim();
  if (status === 'active') return 'running';
  if (status === 'systemError') return 'error';
  return 'idle';
}

async function discoverCodexFromAppServer(config, projects, sessions, explicitPaths, threadProvider) {
  if (typeof threadProvider !== 'function') return false;
  let threads;
  try { threads = await threadProvider(config.projectDiscovery.historyFileLimit); }
  catch { return false; }
  if (!Array.isArray(threads)) return false;
  for (const thread of threads) {
    if (!codexAppServerThreadIsVisible(thread)) continue;
    const runtimeSessionId = String(thread.id || '').trim();
    const historyPath = String(thread.path || thread.rolloutPath || '').trim();
    const lineagePrefix = historyPath ? await readPrefix(historyPath, 256 * 1024).catch(() => '') : '';
    if (codexResumeArtifact(lineagePrefix, runtimeSessionId, thread)) continue;
    const projectPath = await authorizedDirectory(thread.cwd, config.projectDiscovery, explicitPaths);
    if (!runtimeSessionId || !projectPath) continue;
    const seconds = Number(thread.updatedAt || thread.recencyAt || thread.createdAt || 0);
    const lastActivityAt = isoTime(seconds > 100000000000 ? seconds : seconds * 1000);
    addProject(projects, {
      name: cleanLabel(path.basename(projectPath)), path: projectPath, runtimeAgentId: 'main', workspaceKind: 'project',
      identitySeed: `codex:${pathKey(projectPath)}`, lastActivityAt
    });
    addSession(sessions, {
      runtimeSessionId,
      projectPath,
      title: semanticSessionTitle(thread.name, thread.preview),
      titleQuality: thread.name ? 'native' : thread.preview ? 'prompt' : 'fallback',
      historyPath,
      status: codexThreadStatus(thread),
      revision: Math.max(0, Math.floor(seconds)),
      lastActivityAt
    });
  }
  return true;
}

async function discoverCodex(config, projects, sessions, explicitPaths, threadProvider) {
  if (await discoverCodexFromAppServer(config, projects, sessions, explicitPaths, threadProvider)) return;
  if (await discoverCodexFromDatabase(config, projects, sessions, explicitPaths)) return;
  const indexedTitles = await codexThreadTitleIndex(config.projectDiscovery.runtimeHome);
  const root = path.join(config.projectDiscovery.runtimeHome, 'sessions');
  const files = (await walkJsonl(root, config.projectDiscovery.historyFileLimit))
    .sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, config.projectDiscovery.historyFileLimit);
  for (const file of files) {
    const prefix = await readPrefix(file.path, 2 * 1024 * 1024).catch(() => '');
    const { payload, firstUserMessage } = codexPrefixMetadata(prefix);
    if (!codexTopLevelSource(payload, firstUserMessage)) continue;
    const runtimeSessionId = String(payload?.id || payload?.session_id || '').trim();
    if (codexResumeArtifact(prefix, runtimeSessionId)) continue;
    const projectPath = await authorizedDirectory(payload?.cwd, config.projectDiscovery, explicitPaths);
    if (!runtimeSessionId || !projectPath) continue;
    const lastActivityAt = isoTime(file.mtimeMs, Date.parse(payload?.timestamp || '') || file.mtimeMs);
    addProject(projects, {
      name: cleanLabel(path.basename(projectPath)), path: projectPath, runtimeAgentId: 'main', workspaceKind: 'project',
      identitySeed: `codex:${pathKey(projectPath)}`, lastActivityAt
    });
    addSession(sessions, {
      runtimeSessionId,
      projectPath,
      title: semanticSessionTitle(indexedTitles.get(runtimeSessionId), firstUserMessage),
      titleQuality: indexedTitles.has(runtimeSessionId) ? 'native' : firstUserMessage ? 'prompt' : 'fallback',
      historyPath: file.path,
      status: recentRuntimeStatus(file.mtimeMs),
      revision: Math.floor(file.mtimeMs / 1000),
      lastActivityAt
    });
  }
}

async function discoverClaude(config, projects, sessions, explicitPaths, runtimeCode = 'claude-code') {
  const root = path.join(config.projectDiscovery.runtimeHome, 'projects');
  const files = (await walkJsonl(root, config.projectDiscovery.historyFileLimit)).sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files) {
    const segments = file.path.split(path.sep);
    if (segments.includes('subagents') || path.basename(file.path).startsWith('agent-')) continue;
    const prefix = await readPrefix(file.path, 2 * 1024 * 1024).catch(() => '');
    let metadata = null;
    let nativeTitle = '';
    let firstUserMessage = '';
    let rawFirstUserMessage = '';
    let sidechain = false;
    for (const line of prefix.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (!metadata && event?.cwd && event?.sessionId) metadata = event;
        if (!nativeTitle && event?.type === 'ai-title') nativeTitle = String(event.aiTitle || '').trim();
        if (!firstUserMessage && event?.type === 'user' && event.isSidechain !== true && event.isMeta !== true) {
          rawFirstUserMessage = visibleContentText(event.message?.content);
          firstUserMessage = unwrapRemoteInstruction(rawFirstUserMessage);
        }
        if (event?.isSidechain === true) sidechain = true;
      } catch {}
    }
    const projectPath = await authorizedDirectory(metadata?.cwd, config.projectDiscovery, explicitPaths);
    if (!metadata?.sessionId || !projectPath || sidechain || remoteManagedRuntimeText(rawFirstUserMessage)) continue;
    const lastActivityAt = isoTime(file.mtimeMs, Date.parse(metadata.timestamp || '') || file.mtimeMs);
    addProject(projects, {
      name: cleanLabel(path.basename(projectPath)), path: projectPath, runtimeAgentId: 'main', workspaceKind: runtimeCode === 'codebuddy' ? 'project' : 'directory',
      identitySeed: `${runtimeCode}:${pathKey(projectPath)}`, lastActivityAt
    });
    addSession(sessions, {
      runtimeSessionId: metadata.sessionId,
      projectPath,
      title: semanticSessionTitle(nativeTitle, firstUserMessage),
      titleQuality: nativeTitle ? 'native' : firstUserMessage ? 'prompt' : 'fallback',
      historyPath: file.path,
      status: recentRuntimeStatus(file.mtimeMs),
      revision: Math.floor(file.mtimeMs / 1000),
      lastActivityAt
    });
  }
}

function qclawUserFacingSession(sessionKey, runtimeAgentId, entry) {
  const prefix = `agent:${runtimeAgentId}:`;
  if (!String(sessionKey || '').startsWith(prefix)) return false;
  const tail = String(sessionKey).slice(prefix.length);
  if (!tail || tail === 'cron' || tail.startsWith('cron:')) return false;
  if (tail.startsWith('shenlan-')) return false;
  if (tail === 'main') return true;
  return Boolean(entry?.origin || entry?.deliveryContext || entry?.chatType || entry?.channel || entry?.displayName);
}

async function qclawHistoryMetadata(entry, sessionDirectory) {
  const requested = String(entry?.sessionFile || '').trim();
  if (!requested) return { historyPath: '', firstUserMessage: '' };
  const [historyPath, authorizedRoot] = await Promise.all([
    realpath(requested).catch(() => ''),
    realpath(sessionDirectory).catch(() => path.resolve(sessionDirectory))
  ]);
  if (!historyPath || path.extname(historyPath).toLowerCase() !== '.jsonl' || !isInside(historyPath, authorizedRoot, false)) return { historyPath: '', firstUserMessage: '' };
  const prefix = await readPrefix(historyPath, 1024 * 1024).catch(() => '');
  let firstUserMessage = '';
  for (const line of prefix.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'message' && event.message?.role === 'user') {
        firstUserMessage = unwrapRemoteInstruction(visibleContentText(event.message.content));
        if (firstUserMessage) break;
      }
    } catch {}
  }
  return { historyPath, firstUserMessage };
}

async function discoverQClaw(config, projects, sessions, explicitPaths) {
  const stateRoot = config.qclawStateDir || config.projectDiscovery.runtimeHome;
  const configPath = config.qclawConfigPath || path.join(stateRoot, 'openclaw.json');
  let source;
  try { source = JSON.parse(await readFile(configPath, 'utf8')); } catch { source = {}; }
  const agents = Array.isArray(source?.agents?.list) ? source.agents.list : [];
  if (!agents.some((agent) => String(agent?.id || '') === config.qclawAgentId)) agents.unshift({ id: config.qclawAgentId, name: 'QClaw' });
  for (const agent of agents) {
    const runtimeAgentId = cleanLabel(agent?.id, '', 120);
    if (!runtimeAgentId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runtimeAgentId)) continue;
    const configuredWorkspace = agent?.workspace || (runtimeAgentId === 'main' ? path.join(stateRoot, 'workspace') : '');
    const projectPath = await authorizedDirectory(configuredWorkspace, config.projectDiscovery, explicitPaths);
    if (!projectPath) continue;
    const sessionFile = path.join(stateRoot, 'agents', runtimeAgentId, 'sessions', 'sessions.json');
    const sessionDirectory = path.dirname(sessionFile);
    let sessionEntries = [];
    try {
      const document = JSON.parse(await readFile(sessionFile, 'utf8'));
      sessionEntries = Object.entries(document && typeof document === 'object' ? document : {});
    } catch {}
    sessionEntries = sessionEntries
      .filter(([sessionKey, entry]) => qclawUserFacingSession(sessionKey, runtimeAgentId, entry))
      .sort((left, right) => timeNumber(right[1]?.updatedAt) - timeNumber(left[1]?.updatedAt));
    const latest = sessionEntries[0]?.[1]?.updatedAt || Date.now();
    const lastActivityAt = isoTime(latest);
    addProject(projects, {
      name: cleanLabel(agent?.name || `${runtimeAgentId} 工作区`), path: projectPath, runtimeAgentId, workspaceKind: 'workspace',
      identitySeed: `qclaw:${runtimeAgentId}:${pathKey(projectPath)}`, lastActivityAt
    });
    for (const [sessionKey, entry] of sessionEntries.slice(0, config.projectDiscovery.maxSessionsPerProject)) {
      const runtimeSessionId = String(entry?.sessionId || '').trim();
      if (!runtimeSessionId) continue;
      const activity = isoTime(entry.updatedAt || entry.lastInteractionAt || latest);
      const history = await qclawHistoryMetadata(entry, sessionDirectory);
      const nativeTitle = cleanLabel(entry.label || entry.displayName || entry.origin?.label || entry.deliveryContext?.displayName || '', '', 180);
      const isMain = sessionKey === `agent:${runtimeAgentId}:main`;
      const generatedTitle = isMain ? `${cleanLabel(agent?.name || 'QClaw')} 主会话` : `${cleanLabel(agent?.name || 'QClaw')} 任务线程`;
      const status = entry.status === 'running' ? 'running' : entry.status === 'failed' || entry.status === 'killed' ? 'error' : entry.status === 'done' ? 'completed' : 'idle';
      addSession(sessions, {
        runtimeSessionId,
        projectPath,
        runtimeAgentId,
        title: semanticSessionTitle(nativeTitle, history.firstUserMessage, generatedTitle),
        titleQuality: nativeTitle ? 'native' : history.firstUserMessage ? 'prompt' : 'generated',
        historyPath: history.historyPath,
        status,
        revision: Math.floor((Date.parse(activity) || 0) / 1000),
        lastActivityAt: activity
      });
    }
  }
}

function trimSessions(sessions, maximumPerProject) {
  const grouped = new Map();
  for (const session of sessions.values()) {
    const key = `${pathKey(session.projectPath)}\0${session.runtimeAgentId || ''}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(session);
  }
  return [...grouped.values()].flatMap((items) => items.sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)).slice(0, maximumPerProject));
}

export async function discoverRuntimeCatalog(config, options = {}) {
  const discovery = config.projectDiscovery;
  if (!discovery?.enabled) return { projects: [], sessions: [] };
  const [roots, excludePaths, explicitDirectories] = await Promise.all([
    Promise.all(discovery.roots.map((root) => realpath(root).catch(() => path.resolve(root)))),
    Promise.all(discovery.excludePaths.map((root) => realpath(root).catch(() => path.resolve(root)))),
    Promise.all(config.projects.map((project) => realpath(project.path).catch(() => path.resolve(project.path))))
  ]);
  const normalizedConfig = { ...config, projectDiscovery: { ...discovery, roots, excludePaths, localReadOnly: options.localReadOnly === true } };
  const explicitPaths = new Set(explicitDirectories.map(pathKey));
  const projects = new Map();
  const sessions = new Map();
  if (config.adapterCode === 'codex') await discoverCodex(normalizedConfig, projects, sessions, explicitPaths, options.codexThreadProvider);
  else if (config.adapterCode === 'claude-code') await discoverClaude(normalizedConfig, projects, sessions, explicitPaths, 'claude-code');
  else if (config.adapterCode === 'codebuddy') await discoverClaude(normalizedConfig, projects, sessions, explicitPaths, 'codebuddy');
  else if (config.adapterCode === 'qclaw') await discoverQClaw(normalizedConfig, projects, sessions, explicitPaths);
  const orderedProjects = [...projects.values()].sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)).slice(0, discovery.maxProjects);
  const accepted = new Set(orderedProjects.map((project) => pathKey(project.path)));
  return {
    projects: orderedProjects,
    sessions: trimSessions(sessions, discovery.maxSessionsPerProject).filter((session) => accepted.has(pathKey(session.projectPath)))
  };
}

export function mergeProjectSources(explicitProjects, discoveredProjects, maximum) {
  const merged = new Map();
  for (const project of explicitProjects) merged.set(pathKey(project.path), { ...project, identitySeed: project.identitySeed || `explicit:${project.name}` });
  for (const project of discoveredProjects) {
    const key = pathKey(project.path);
    if (!merged.has(key)) merged.set(key, project);
    else {
      const explicit = merged.get(key);
      merged.set(key, { ...project, ...explicit, lastActivityAt: project.lastActivityAt || explicit.lastActivityAt });
    }
  }
  const result = [...merged.values()].slice(0, Math.max(explicitProjects.length, maximum));
  const counts = new Map();
  for (const project of result) counts.set(project.name, (counts.get(project.name) || 0) + 1);
  const used = new Set();
  return result.map((project, index) => {
    let name = project.name;
    if ((counts.get(name) || 0) > 1) name = `${name} · ${path.basename(path.dirname(project.path))}`;
    while (used.has(name)) name = `${project.name} · ${index + 1}`;
    used.add(name);
    return { ...project, name };
  });
}

export function bindDiscoveredSessions(discoveredSessions, projects) {
  const byPath = new Map(projects.map((project) => [pathKey(project.path), project]));
  return discoveredSessions.flatMap((session) => {
    const project = byPath.get(pathKey(session.projectPath));
    if (!project || (session.runtimeAgentId && project.runtimeAgentId !== session.runtimeAgentId)) return [];
    return [{ ...session, projectId: project.id }];
  });
}
