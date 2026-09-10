import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

function freshState() {
  return {
    schemaVersion: 1,
    installationId: randomBytes(32).toString('hex'),
    stateRevision: 0,
    registered: false,
    syncMode: 'standby',
    syncActiveUntil: null,
    runtimeLease: '',
    pendingRuntimeLease: '',
    codexHostToken: '',
    codexManagerSessionId: '',
    retiredCodexSessionIds: [],
    localOnlyRuntimeIds: [],
    sessions: {},
    sessionRelays: {},
    pendingCommands: []
  };
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1) throw new Error('本地状态版本不受支持');
  if (!/^[a-f0-9]{64}$/.test(String(state.installationId || ''))) throw new Error('本地安装标识无效');
  if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) state.sessions = {};
  if (!state.sessionRelays || typeof state.sessionRelays !== 'object' || Array.isArray(state.sessionRelays)) state.sessionRelays = {};
  state.codexManagerSessionId = String(state.codexManagerSessionId || '').trim().slice(0, 191);
  state.retiredCodexSessionIds = Array.isArray(state.retiredCodexSessionIds)
    ? [...new Set(state.retiredCodexSessionIds.map((item) => String(item || '').trim().slice(0, 191)).filter(Boolean))].slice(0, 32)
    : [];
  if (!Array.isArray(state.pendingCommands)) state.pendingCommands = [];
  state.localOnlyRuntimeIds = Array.isArray(state.localOnlyRuntimeIds) ? [...new Set(state.localOnlyRuntimeIds.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 191))] : [];
  state.stateRevision = Math.max(0, Number(state.stateRevision || 0));
  state.registered = Boolean(state.registered);
  state.syncMode = state.syncMode === 'active' ? 'active' : 'standby';
  const syncActiveUntil = Date.parse(String(state.syncActiveUntil || ''));
  state.syncActiveUntil = Number.isFinite(syncActiveUntil) ? new Date(syncActiveUntil).toISOString() : null;
  if (!/^[a-f0-9]{64}$/.test(String(state.runtimeLease || ''))) state.runtimeLease = '';
  if (!/^[a-f0-9]{64}$/.test(String(state.pendingRuntimeLease || ''))) state.pendingRuntimeLease = '';
  if (state.codexHostToken && !/^[A-Za-z0-9_-]{43,128}$/.test(String(state.codexHostToken))) state.codexHostToken = '';
  return state;
}

export class LocalStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.saveQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      return validateState(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      try {
        const previous = validateState(JSON.parse(await readFile(`${this.filePath}.bak`, 'utf8')));
        // A recovery copy may predate a native turn submission. Preserve its
        // command IDs but never replay tasks whose latest outcome was lost.
        previous.recoveredFromBackup = true;
        previous.pendingCommands = previous.pendingCommands.map((command) => command.command_type === 'run_task' && command._localStatus !== 'final_pending' ? {
          ...command, _localStatus: 'final_pending', _localFinal: {
            status: 'failed', errorCode: 'local_state_recovered', summary: '状态已从备份恢复，请检查原生会话',
            reply: '本地状态从备份恢复，无法安全确认该任务的最新执行结果。为避免重复修改项目，不会自动重放，请检查原生会话后再继续。'
          }
        } : command);
        await this.atomicWrite(this.filePath, `${JSON.stringify(previous, null, 2)}\n`);
        return previous;
      } catch (backupError) {
        if (error.code !== 'ENOENT' || backupError.code !== 'ENOENT') {
          throw new Error('本地状态文件及备份无法读取，请恢复备份后再启动；不会重置任务记录。');
        }
      }
      const state = freshState();
      await this.save(state);
      return state;
    }
  }

  async save(state) {
    const serialized = `${JSON.stringify(validateState(structuredClone(state)), null, 2)}\n`;
    const operation = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      // Only a validated last-good primary may replace the recovery copy.
      let previous = null;
      try {
        const body = await readFile(this.filePath, 'utf8');
        validateState(JSON.parse(body));
        previous = body;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous !== null) await this.atomicWrite(`${this.filePath}.bak`, previous);
      await this.atomicWrite(this.filePath, serialized);
    };
    const save = this.saveQueue.then(operation, operation);
    this.saveQueue = save.catch(() => {});
    return save;
  }

  async atomicWrite(target, serialized) {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
      if (process.platform !== 'win32') {
        await chmod(target, 0o600);
        const directory = await open(path.dirname(target), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
}
