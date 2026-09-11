import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { discoverRuntimeCatalog } from './runtime-catalog.mjs';
import { readRuntimeSessionHistory } from './session-history.mjs';

const id = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
export async function codexSessionOwnership(runtimeHome, sessionId) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('无效的原生会话编号');
  try { await readFile(path.join(runtimeHome, 'thread-writer-locks', `${sessionId}.lock`)); return 'unknown'; }
  catch (error) {
    if (error.code === 'EBUSY') return 'native_owned';
    if (error.code === 'ENOENT') return 'unknown';
    return 'unavailable';
  }
}
export function localRuntimeHomes(environment, home) {
  return {
    codex: environment.CODEX_HOME || path.join(home, '.codex'),
    'claude-code': environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    qclaw: environment.OPENCLAW_STATE_DIR || path.join(home, '.qclaw')
  };
}
export class LocalObserver {
  constructor(environment = process.env) { this.environment = environment; this.sessions = new Map(); }
  async scan() {
    const home = this.environment.USERPROFILE || this.environment.HOME;
    if (!home) throw new Error('无法定位本机用户目录');
    const homes = localRuntimeHomes(this.environment, home);
    const projects = [], sessions = [], errors = [];
    const next = new Map();
    for (const [adapter, runtimeHome] of Object.entries(homes)) {
      try {
        const source = await discoverRuntimeCatalog({ adapterCode: adapter, projects: [], qclawAgentId: 'main',
          projectDiscovery: { enabled: true, roots: [], excludePaths: [], runtimeHome, maxProjects: Number.MAX_SAFE_INTEGER, maxSessionsPerProject: 100, historyFileLimit: 3000, allowRootProjects: false }
        }, { localReadOnly: true });
        const projectIds = new Map();
        for (const item of source.projects) {
          const projectId = id(`${adapter}:${item.path.toLowerCase()}`);
          projectIds.set(item.path.toLowerCase(), projectId);
          projects.push({ id: projectId, adapter, name: item.name, path: item.path, lastActivityAt: item.lastActivityAt });
        }
        for (const item of source.sessions) {
          const projectId = projectIds.get(item.projectPath.toLowerCase());
          if (!projectId) continue;
          const sessionId = id(`${adapter}:${item.runtimeSessionId}`);
          // Modification time is recency, not evidence that a task is running.
          const status = adapter === 'codex' ? await codexSessionOwnership(runtimeHome, item.runtimeSessionId) : 'unknown';
          sessions.push({ id: sessionId, projectId, adapter, runtimeSessionId: item.runtimeSessionId, title: item.title, lastActivityAt: item.lastActivityAt, status });
          next.set(sessionId, { ...item, adapter, runtimeHome });
        }
      } catch { errors.push(`${adapter} 本机目录读取失败，请检查文件访问权限`); }
    }
    projects.sort((a,b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    sessions.sort((a,b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    this.sessions = next;
    let models = [];
    try {
      const cache = JSON.parse(await readFile(path.join(homes.codex, 'models_cache.json'), 'utf8'));
      models = (cache.models || []).filter(item => typeof item.slug === 'string' && item.visibility !== 'hide').map(item => ({ id: item.slug, name: item.display_name || item.slug, adapter: 'codex' }));
    } catch { /* Missing native model cache means native default, not invented models. */ }
    return { scannedAt: new Date().toISOString(), projects, sessions, errors, models };
  }
  async history(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('本机会话已变化，请刷新后重新选择');
    const root = await realpath(session.runtimeHome);
    const file = await realpath(session.historyPath || '');
    if (!inside(root, file)) throw new Error('会话记录不在智能体本机数据目录内');
    return { sessionId, messages: await readRuntimeSessionHistory({ ...session, historyPath: file }, session.adapter, 100), readAt: new Date().toISOString() };
  }
}
export function runObserver() {
  if (!process.send) throw new Error('本机观察器仅允许通过本地 IPC 启动');
  const observer = new LocalObserver();
  let queue = Promise.resolve();
  process.on('message', message => {
    if (!message || !['scan', 'history'].includes(message.type)) return;
    queue = queue.catch(() => {}).then(async () => {
      try { const result = message.type === 'scan' ? await observer.scan() : await observer.history(message.sessionId); process.send?.({ requestId: message.requestId, result }); }
      catch (error) { process.send?.({ requestId: message.requestId, error: String(error.message).slice(0, 300) }); }
    });
  });
  process.on('disconnect', () => process.exit(0));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runObserver();
