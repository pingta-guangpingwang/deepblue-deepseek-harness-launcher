import { arch, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ConnectorApi, ConnectorApiError } from './api.mjs';
import { LocalStateStore } from './state.mjs';
import { buildProjectCatalog, publicSnapshotDocument, safeFinalReply, sha256 } from './privacy.mjs';
import { attachmentInstruction, buildRuntimeInstruction, classifyRuntimeException, classifyRuntimeFailure, runRuntimeTask, runtimeProfile, runtimeSessionAvailability, runtimeTaskConcurrency, shutdownRuntimeHosts, terminateAgent } from './runtime-runner.mjs';
import { AttachmentTransferError, cleanupTaskAttachments, downloadTaskAttachments } from './attachment-transfer.mjs';
import { bindDiscoveredSessions, discoverRuntimeCatalog, mergeProjectSources } from './runtime-catalog.mjs';
import { readRuntimeSessionHistory } from './session-history.mjs';
import { readDshSessionHistory } from './dsh-runner.mjs';
import { cursorSessionHistory } from './cursor-runner.mjs';
import { CodexAppServerHost } from './codex-app-server.mjs';
import { realpath } from 'node:fs/promises';
import { isPathWithinRoot } from './config.mjs';
import { localOnlySessionIds } from './local-control/private-sessions.mjs';

const CONNECTOR_VERSION = '0.10.11';
const MAX_RUNTIME_WAIT_MS = 15000;
const MANAGED_SESSION_SETTLE_MS = 45000;

function boundedInterval(value, fallback, minimum = 500, maximum = 600000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

function taskIdOf(command) {
  return String(command.task_id || command.payload && command.payload.taskId || '').trim();
}

function commandProjectId(command) {
  const payload = command.payload || {};
  return String(payload.projectExternalId || '').trim();
}

function commandSessionId(command) {
  const payload = command.payload || {};
  return String(payload.externalSessionId || '').trim();
}

export function commandExecutionLane(command) {
  const projectId = commandProjectId(command);
  const sessionId = commandSessionId(command);
  if (sessionId) return `session:${projectId}:${sessionId}`;
  const taskId = taskIdOf(command);
  return `task:${taskId || String(command && command.id || 'unknown')}`;
}

export function migrateCodexManagerSession(state = {}) {
  const retired = new Set(Array.isArray(state.retiredCodexSessionIds) ? state.retiredCodexSessionIds : []);
  const current = String(state.codexManagerSessionId || '').trim();
  if (current) retired.add(current);
  for (const item of Object.values(state.sessionRelays || {})) {
    const id = String(item && item.runtimeSessionId || '').trim();
    if (id) retired.add(id);
  }
  state.retiredCodexSessionIds = [...retired].slice(0, 32);
  state.codexManagerSessionId = '';
  state.sessionRelays = {};
  return state.retiredCodexSessionIds;
}

export function logicalRuntimeSessionId(mode, sourceSessionId, executedSessionId) {
  return mode === 'continue_session' ? String(sourceSessionId || '') : String(executedSessionId || '');
}

export function selectRunnableCommands(commands, runningTasks, maximum = 4, now = Date.now(), laneResolver = commandExecutionLane) {
  const limit = Math.max(1, Math.min(12, Number(maximum) || 4));
  const running = runningTasks instanceof Map ? [...runningTasks.values()] : [];
  const reservedLanes = new Set(running.map((task) => String(task && task.laneKey || '')).filter(Boolean));
  let capacity = Math.max(0, limit - running.length);
  const selected = [];
  for (const command of Array.isArray(commands) ? commands : []) {
    if (!command || command.command_type !== 'run_task') continue;
    const laneKey = laneResolver(command);
    const status = String(command._localStatus || 'pending');
    if (['running', 'preparing', 'final_pending'].includes(status)) {
      reservedLanes.add(laneKey);
      continue;
    }
    if (reservedLanes.has(laneKey)) continue;
    if (Number(command._retryAt || 0) > now) {
      reservedLanes.add(laneKey);
      continue;
    }
    if (capacity <= 0) continue;
    selected.push({ command, laneKey });
    reservedLanes.add(laneKey);
    capacity -= 1;
  }
  return selected;
}

function boundedSummary(value, fallback) {
  const text = String(value || fallback || '').trim();
  return text.slice(0, 500);
}

export function reconciledRuntimeStatus(discoveredStatus, options = {}) {
  if (options.managedRunning) return 'running';
  if (Number(options.settledUntil || 0) > Number(options.now || Date.now())) return 'idle';
  return discoveredStatus;
}

export function recoverInterruptedCommands(commands, runtimeLabel = '本地智能体') {
  return (Array.isArray(commands) ? commands : []).map((command) => {
    if (!command || command._localStatus !== 'running') return command;
    return {
      ...command,
      _localStatus: 'final_pending',
      _localFinal: {
        status: 'failed',
        reply: `本地 Skill 同步服务在任务执行期间重新启动，无法安全确认上一次 ${runtimeLabel} 进程的结果。为避免重复修改项目，本次任务已停止，请检查本地项目后再重新派发。`,
        summary: '同步服务重启，任务已安全停止',
        errorCode: 'connector_restarted_during_task'
      }
    };
  });
}

export class AgentConnector {
  constructor(config, options = {}) {
    this.config = config;
    this.profile = runtimeProfile(config.adapterCode);
    this.store = options.store || new LocalStateStore(config.stateFile);
    this.api = options.api || new ConnectorApi(config);
    this.logger = options.logger || console;
    this.state = null;
    this.projects = [];
    this.running = false;
    this.draining = false;
    this.handoffPaused = false;
    this.handoffPromise = null;
    this.handoffFrozen = false;
    this.executionPromises = new Set();
    this.heartbeatPromises = new Set();
    this.runRuntimeTask = options.runRuntimeTask || runRuntimeTask;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.pollBusy = false;
    this.commandDrainPromise = null;
    this.lastCatalogSyncAt = 0;
    this.syncPollAfterMs = config.idlePollIntervalMs;
    this.syncHeartbeatAfterMs = config.idleHeartbeatIntervalMs;
    this.syncCatalogAfterMs = config.catalogSyncIntervalMs;
    this.runningTasks = new Map();
    this.managedSessionSettledUntil = new Map();
    this.flushingCommands = new Set();
    this.runtimeFingerprint = '';
    this.runtimeLease = randomBytes(32).toString('hex');
    this.previousRuntimeLease = '';
    this.runtimeStatus = 'unknown';
    this.runtimeMode = options.runtimeMode === 'launcher_hosted' ? 'launcher_hosted' : 'standalone';
    this.runtimeStatusFresh = false;
    this.codexHost = options.codexHost || null;
    this.disconnectSent = false;
    this.mutationQueue = Promise.resolve();
    this.stoppedPromise = new Promise((resolve) => { this.resolveStopped = resolve; });
  }

  async persist() {
    await this.store.save(this.state);
  }

  updateRevision(response) {
    const revision = Number(response && response.stateRevision);
    if (Number.isFinite(revision)) this.state.stateRevision = Math.max(this.state.stateRevision, revision);
  }

  setRuntimeStatus(status) {
    this.runtimeStatus = ['ready', 'busy', 'needs_login', 'not_installed', 'unavailable', 'stopped', 'running', 'error', 'starting'].includes(status) ? status : 'unknown';
    this.runtimeStatusFresh = true;
  }

  syncIsActive(now = Date.now()) {
    if (this.runningTasks.size > 0) return true;
    if (!this.state || this.state.syncMode !== 'active') return false;
    const activeUntil = Date.parse(String(this.state.syncActiveUntil || ''));
    return Number.isFinite(activeUntil) && activeUntil > now;
  }

  pollDelay() {
    return this.syncIsActive()
      ? boundedInterval(this.syncPollAfterMs, this.config.pollIntervalMs, 500, 60000)
      : this.config.idlePollIntervalMs;
  }

  heartbeatDelay() {
    return this.syncIsActive()
      ? boundedInterval(this.syncHeartbeatAfterMs, this.config.heartbeatIntervalMs, 1000, 300000)
      : this.config.idleHeartbeatIntervalMs;
  }

  applySyncDirective(response) {
    const directive = response && response.sync;
    if (!directive || !this.state) return false;
    const wasActive = this.syncIsActive();
    const activeUntilMs = Date.parse(String(directive.activeUntil || ''));
    const active = directive.mode === 'active' && Number.isFinite(activeUntilMs) && activeUntilMs > Date.now();
    this.state.syncMode = active ? 'active' : 'standby';
    this.state.syncActiveUntil = active ? new Date(activeUntilMs).toISOString() : null;
    this.syncPollAfterMs = boundedInterval(directive.pollAfterMs, active ? this.config.pollIntervalMs : this.config.idlePollIntervalMs, 500, 300000);
    this.syncHeartbeatAfterMs = boundedInterval(directive.heartbeatAfterMs, active ? this.config.heartbeatIntervalMs : this.config.idleHeartbeatIntervalMs, 1000, 600000);
    this.syncCatalogAfterMs = boundedInterval(directive.catalogSyncAfterMs, this.config.catalogSyncIntervalMs, 1000, 300000);
    const isActive = this.syncIsActive();
    if (wasActive !== isActive) this.logger.info?.(isActive ? '网页已激活，进入快速同步' : '网页空闲，进入轻量待机');
    return !wasActive && isActive;
  }

  serializeMutation(operation) {
    const execution = this.mutationQueue.then(operation, operation);
    this.mutationQueue = execution.catch(() => {});
    return execution;
  }

  async start() {
    if (this.running) return;
    this.state = await this.store.load();
    this.profile = runtimeProfile(this.config.adapterCode);
    if (this.config.adapterCode === 'codex') migrateCodexManagerSession(this.state);
    this.state.pendingCommands = recoverInterruptedCommands(this.state.pendingCommands, this.profile.label);
    this.previousRuntimeLease = String(this.state.runtimeLease || '');
    this.runtimeLease = String(this.state.pendingRuntimeLease || '') || randomBytes(32).toString('hex');
    this.state.pendingRuntimeLease = this.runtimeLease;
    await this.persist();
    if (this.config.adapterCode === 'codex' && this.config.codexHost?.enabled && !process.env.SHENLAN_DESKTOP_RUNNER) {
      if (!this.codexHost) this.codexHost = new CodexAppServerHost(this.config, this.state, () => this.persist(), { logger: this.logger });
      await this.codexHost.start();
      await this.retireLegacyCodexSessions();
    }
    this.runtimeFingerprint = sha256(`runtime-v1\0${this.state.installationId}`);
    this.api.setRuntimeIdentity?.(this.runtimeFingerprint, this.runtimeLease, this.previousRuntimeLease);
    await this.register();
    if (this.syncIsActive()) await this.sendSnapshot();
    await this.heartbeat({ synchronizeIfActivated: false });
    this.running = true;
    this.schedulePoll(0);
    this.scheduleHeartbeat();
  }

  async retireLegacyCodexSessions() {
    const pending = Array.isArray(this.state.retiredCodexSessionIds) ? [...this.state.retiredCodexSessionIds] : [];
    if (!pending.length || !this.codexHost || typeof this.codexHost.archiveThread !== 'function') return;
    const remaining = [];
    for (const threadId of pending) {
      try {
        await this.codexHost.archiveThread(threadId);
        this.logger.info?.('已归档旧版深蓝中转话题；新版只向用户选中的原生话题投递。');
      } catch (error) {
        remaining.push(threadId);
        this.logger.warn?.(`旧版中转话题暂未归档，将在下次启动重试：${error.message}`);
      }
    }
    this.state.retiredCodexSessionIds = remaining;
    await this.persist();
  }

  async register() {
    return this.serializeMutation(async () => {
      const response = await this.api.request('register', {
        method: 'POST',
        idempotencyKey: `register:${this.state.installationId}`,
        body: {
          adapterCode: this.config.adapterCode,
          connectorVersion: CONNECTOR_VERSION,
          runtimeFingerprint: this.runtimeFingerprint,
          runtimeMode: this.runtimeMode,
          runtimeLabel: this.config.runtimeLabel,
          osFamily: platform(),
          architecture: arch(),
          capabilities: this.codexHost
            ? [...this.profile.capabilities, 'session.shared_host', 'task.queue', 'task.interrupt']
            : this.profile.capabilities
        }
      });
      this.updateRevision(response);
      this.applySyncDirective(response);
      this.state.registered = true;
      this.state.runtimeLease = this.runtimeLease;
      this.state.pendingRuntimeLease = '';
      this.previousRuntimeLease = '';
      this.api.setRuntimeIdentity?.(this.runtimeFingerprint, this.runtimeLease, '');
      await this.persist();
      return response;
    });
  }

  async heartbeat(options = {}) {
    if (this.handoffFrozen) return;
    const operation = this.heartbeatInternal(options);
    this.heartbeatPromises.add(operation);
    try { return await operation; }
    finally { this.heartbeatPromises.delete(operation); }
  }

  async heartbeatInternal(options = {}) {
    if (!this.state) return;
    let becameActive = false;
    const response = await this.serializeMutation(async () => {
      const runtimeChecked = this.runtimeStatusFresh;
      this.runtimeStatusFresh = false;
      const response = await this.api.request('heartbeat', {
        method: 'POST',
        idempotencyKey: `heartbeat:${this.state.installationId}:${Math.floor(Date.now() / 10000)}`,
        body: {
          status: this.runningTasks.size ? 'working' : 'online',
          runtimeStatus: this.runningTasks.size && this.runtimeStatus === 'ready' ? 'busy' : this.runtimeStatus,
          runtimeChecked
        }
      });
      this.updateRevision(response);
      becameActive = this.applySyncDirective(response);
      await this.persist();
      return response;
    });
    if (becameActive && options.synchronizeIfActivated !== false) {
      await this.sendSnapshot('', { onlyIfChanged: true }).catch((error) => this.logger.error?.(`激活状态同步失败：${error.message}`));
    }
    return response;
  }

  snapshotSessions() {
    const projectIds = new Set(this.projects.map((project) => project.id));
    return Object.values(this.state.sessions)
      .filter((session) => projectIds.has(session.projectId))
      .sort((left, right) => Date.parse(right.lastActivityAt || 0) - Date.parse(left.lastActivityAt || 0))
      .slice(0, 400);
  }

  catalogHash() {
    return sha256(JSON.stringify({
      projects: this.projects.map((project) => ({ id: project.id, name: project.name, kind: project.kind, revision: project.revision, lastActivityAt: project.lastActivityAt, meta: project.meta })),
      sessions: this.snapshotSessions().map((session) => ({ runtimeSessionId: session.runtimeSessionId, projectId: session.projectId, title: session.title, titleQuality: session.titleQuality, status: session.status, revision: session.revision, lastActivityAt: session.lastActivityAt }))
    }));
  }

  async refreshLocalCatalog() {
    const discovered = await discoverRuntimeCatalog(this.config, {
      codexThreadProvider: this.codexHost ? (maximum) => this.codexHost.listInteractiveThreads(maximum) : null
    });
    let sources = mergeProjectSources(this.config.projects, discovered.projects, this.config.projectDiscovery?.maxProjects || 200);
    if (this.config.hostMode) {
      sources = (await Promise.all(sources.map(async (project) => {
        const actual = await realpath(project.path).catch(() => '');
        return actual && this.config.authorizedProjectRoots.some((root) => isPathWithinRoot(actual, root)) ? { ...project, path: actual } : null;
      }))).filter(Boolean);
    }
    this.projects = await buildProjectCatalog(sources, this.state.installationId, this.config.interactionKeyEnv);
    const previousSessions = { ...this.state.sessions };
    const hiddenRuntimeIds = new Set([
      ...await localOnlySessionIds(this.config.adapterCode),
      ...(this.state.localOnlyRuntimeIds || []),
      ...(Array.isArray(this.state.retiredCodexSessionIds) ? this.state.retiredCodexSessionIds : []),
      ...Object.values(this.state.sessionRelays || {}).map((relay) => String(relay && relay.runtimeSessionId || ''))
    ].filter(Boolean));
    this.state.localOnlyRuntimeIds = [...new Set([...(this.state.localOnlyRuntimeIds || []), ...await localOnlySessionIds(this.config.adapterCode)])];
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      if (session.runtimeDiscovered === true || hiddenRuntimeIds.has(session.runtimeSessionId || sessionId)) delete this.state.sessions[sessionId];
    }
    for (const session of bindDiscoveredSessions(discovered.sessions, this.projects)) {
      if (hiddenRuntimeIds.has(session.runtimeSessionId)) continue;
      const previous = previousSessions[session.runtimeSessionId];
      const managedRunning = [...this.runningTasks.values()].some((task) => task.runtimeSessionId === session.runtimeSessionId || task.sourceRuntimeSessionId === session.runtimeSessionId);
      const settledUntil = Number(this.managedSessionSettledUntil.get(session.runtimeSessionId) || 0);
      if (settledUntil && settledUntil <= Date.now()) this.managedSessionSettledUntil.delete(session.runtimeSessionId);
      this.state.sessions[session.runtimeSessionId] = {
        ...session,
        runtimeDiscovered: true,
        title: session.titleQuality === 'fallback' && previous?.title ? previous.title : session.title,
        status: reconciledRuntimeStatus(session.status, { managedRunning, settledUntil }),
        revision: Math.max(Number(previous?.revision || 0), Number(session.revision || 0)),
        lastActivityAt: previous?.lastActivityAt > session.lastActivityAt ? previous.lastActivityAt : session.lastActivityAt
      };
    }
    await this.persist();
    this.lastLocalCatalogAt = new Date().toISOString();
  }

  async sendSnapshot(commandId = '', options = {}) {
    return this.serializeMutation(async () => {
      if (options.refresh !== false) await this.refreshLocalCatalog();
      const privateIds = new Set([...(this.state.localOnlyRuntimeIds || []), ...await localOnlySessionIds(this.config.adapterCode)]);
      this.state.localOnlyRuntimeIds = [...privateIds];
      for (const [id, session] of Object.entries(this.state.sessions)) if (privateIds.has(session.runtimeSessionId || id)) delete this.state.sessions[id];
      const catalogHash = this.catalogHash();
      if (!commandId && options.onlyIfChanged && this.state.lastCatalogHash === catalogHash) return { skipped: true, stateRevision: this.state.stateRevision };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const body = publicSnapshotDocument(this.projects, this.snapshotSessions(), this.state.stateRevision, commandId);
        try {
          const response = await this.api.request('snapshot', {
            method: 'POST',
            idempotencyKey: `snapshot:${this.state.installationId}:${body.baseRevision}:${commandId || 'automatic'}`,
            body
          });
          this.updateRevision(response);
          this.state.lastCatalogHash = catalogHash;
          this.lastCatalogSyncAt = Date.now();
          await this.persist();
          return response;
        } catch (error) {
          if (!(error instanceof ConnectorApiError) || error.code !== 'revision_conflict' || attempt > 0) throw error;
          const revision = Number(error.payload && error.payload.stateRevision);
          if (!Number.isFinite(revision)) throw error;
          this.state.stateRevision = revision;
          await this.persist();
        }
      }
      throw new Error('状态快照同步失败');
    });
  }

  schedulePoll(delay = this.pollDelay()) {
    clearTimeout(this.pollTimer);
    if (!this.running || this.handoffPaused) return;
    this.pollTimer = setTimeout(async () => {
      try { await this.pollOnce(); }
      catch (error) { this.logger.error?.(`指令轮询失败：${error.message}`); }
      finally { this.schedulePoll(); }
    }, delay);
  }

  scheduleHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    if (!this.running || this.handoffFrozen) return;
    this.heartbeatTimer = setTimeout(async () => {
      try { await this.heartbeat(); }
      catch (error) { this.logger.error?.(`心跳失败：${error.message}`); }
      finally { this.scheduleHeartbeat(); }
    }, this.heartbeatDelay());
  }

  async pollOnce() {
    if (!this.running || this.pollBusy || this.handoffPaused) return;
    this.pollBusy = true;
    try {
      const activeBeforeRequest = this.syncIsActive();
      const response = await this.api.request(activeBeforeRequest ? 'commands' : 'sync_state', { method: 'GET', query: activeBeforeRequest ? { limit: 20 } : {} });
      this.updateRevision(response);
      const becameActive = this.applySyncDirective(response);
      if (becameActive || (activeBeforeRequest && !this.syncIsActive())) this.scheduleHeartbeat();
      if (becameActive) await this.sendSnapshot('', { onlyIfChanged: true }).catch((error) => this.logger.error?.(`激活状态同步失败：${error.message}`));
      const known = new Set(this.state.pendingCommands.map((command) => command.id));
      for (const command of response.commands || []) {
        if (!command || !command.id || known.has(command.id)) continue;
        this.state.pendingCommands.push({ ...command, payload: command.payload || {}, _localStatus: 'pending' });
        known.add(command.id);
      }
      await this.persist();
      await this.drainCommands();
      if (this.syncIsActive() && Date.now() - this.lastCatalogSyncAt >= this.syncCatalogAfterMs) {
        await this.sendSnapshot('', { onlyIfChanged: true }).catch((error) => this.logger.error?.(`本地状态同步失败：${error.message}`));
        this.lastCatalogSyncAt = Date.now();
      }
    } finally { this.pollBusy = false; }
  }

  async drainCommands() {
    if (this.commandDrainPromise) return this.commandDrainPromise;
    this.commandDrainPromise = this.drainCommandsOnce();
    try { await this.commandDrainPromise; }
    finally { this.commandDrainPromise = null; }
  }

  async drainCommandsOnce() {
    if (this.handoffPaused) return;
    const cancellations = this.state.pendingCommands.filter((command) => command.command_type === 'cancel_task' && command._localStatus !== 'running');
    for (const command of cancellations) await this.retrySyncCommand(command, () => this.handleCancelCommand(command));
    // Submit newly requested work before historical sync maintenance. Final
    // pending records still reserve their own session lane, never replay work.
    if (!this.draining) {
      const runnable = selectRunnableCommands(this.state.pendingCommands, this.runningTasks,
        runtimeTaskConcurrency(this.config?.adapterCode, this.config?.maxConcurrentTasks || 4), Date.now(), commandExecutionLane);
      for (const { command, laneKey } of runnable) void this.executeRunCommand(command, laneKey).catch(error => this.logger.error?.(`任务准备未完成：${error.message}`));
    }
    const finals = this.state.pendingCommands.filter((command) => command._localStatus === 'final_pending');
    for (const command of finals.filter(command => !(command._syncRetryAt > Date.now())).slice(0, 2)) await this.retrySyncCommand(command, () => this.flushFinal(command));
    const maintenance = this.state.pendingCommands.filter((command) => ['refresh_snapshot', 'refresh_session_history'].includes(command.command_type) && !['running', 'preparing', 'final_pending'].includes(command._localStatus));
    for (const command of maintenance.filter(command => !(command._syncRetryAt > Date.now())).slice(-3).reverse()) {
      await this.retrySyncCommand(command, async () => {
        if (command.command_type === 'refresh_snapshot') {
          await this.sendSnapshot(command.id);
          await this.removeCommand(command.id);
        } else await this.handleHistoryCommand(command);
      });
    }
    const unsupported = this.state.pendingCommands.filter((command) => !['run_task', 'cancel_task', 'refresh_snapshot', 'refresh_session_history'].includes(command.command_type));
    for (const command of unsupported) {
      this.logger.warn?.(`忽略不支持的指令类型：${String(command.command_type || 'unknown')}`);
      await this.removeCommand(command.id);
    }
  }

  async retrySyncCommand(command, operation) {
    if (Number(command._syncRetryAt || 0) > Date.now()) return;
    try { await operation(); }
    catch (error) {
      // Retain the exact command/result. Retry sync, never agent execution.
      const pending = this.findPendingCommand(command.id);
      if (pending) {
        pending._syncRetryCount = Math.min(10, Number(pending._syncRetryCount || 0) + 1);
        pending._syncRetryAt = Date.now() + Math.min(300000, 5000 * 2 ** pending._syncRetryCount);
        pending._syncError = { status: Number(error.status) || 0, code: /^[a-z0-9_]{1,80}$/i.test(error.code || '') ? error.code : 'sync_failed' };
        await this.persist();
      }
      this.logger.error?.(`旧记录同步暂缓，已保留并退避重试：${error.message}`);
    }
  }

  async removeCommand(commandId) {
    this.state.pendingCommands = this.state.pendingCommands.filter((command) => command.id !== commandId);
    await this.persist();
  }

  findPendingCommand(commandId) {
    return this.state.pendingCommands.find((command) => command.id === commandId);
  }

  resolveProject(command) {
    const requested = commandProjectId(command);
    return this.projects.find((project) => project.id === requested) || null;
  }

  resolveSession(command, project) {
    const requested = commandSessionId(command);
    if (!requested) return null;
    return Object.values(this.state.sessions).find((session) => session.projectId === project.id && ((session.runtimeSessionId || session.codexSessionId) === requested || session.serverSessionId === requested)) || null;
  }

  async handleHistoryCommand(command) {
    const local = this.findPendingCommand(command.id);
    if (!local || local._localStatus === 'running') return;
    local._localStatus = 'running';
    await this.persist();
    try {
      await this.refreshLocalCatalog();
      const project = this.resolveProject(command);
      let session = project ? this.resolveSession(command, project) : null;
      if (session && (await localOnlySessionIds(this.config.adapterCode)).has(session.runtimeSessionId)) session = null;
      const isDsh = this.config.adapterCode === 'deepseek-harness' && Boolean(session && project);
      const isCursor = this.config.adapterCode === 'cursor' && Boolean(session && project);
      const historyAvailable = isDsh || isCursor || Boolean(session?.historyPath) && ['codex', 'claude-code', 'qclaw', 'codebuddy'].includes(this.config.adapterCode);
      let messages = isCursor ? await cursorSessionHistory(this.config, project, session) : isDsh ? await readDshSessionHistory(this.config, project, session, 20) : historyAvailable ? await readRuntimeSessionHistory(session, this.config.adapterCode, 20) : [];
      if (session && (await localOnlySessionIds(this.config.adapterCode)).has(session.runtimeSessionId)) messages = [];
      const response = await this.serializeMutation(() => this.api.request('session_history', {
        method: 'POST',
        idempotencyKey: `session-history:${command.id}:${session?.revision || 0}`,
        body: {
          commandId: command.id,
          projectExternalId: commandProjectId(command),
          externalSessionId: commandSessionId(command),
          sourceRevision: Math.max(0, Number(session?.revision || 0)),
          status: historyAvailable ? 'available' : 'unavailable',
          messages
        }
      }));
      this.updateRevision(response);
      await this.removeCommand(command.id);
    } catch (error) {
      const pending = this.findPendingCommand(command.id);
      if (pending) pending._localStatus = 'pending';
      await this.persist();
      throw error;
    }
  }

  async reportTaskEvent(taskId, status, summary, progressPercent = null) {
    return this.serializeMutation(async () => {
      const body = { taskId, status, summary: boundedSummary(summary, `${this.profile.label} 正在处理任务`) };
      if (progressPercent !== null && progressPercent !== undefined) body.progressPercent = Math.max(0, Math.min(100, Number(progressPercent)));
      const response = await this.api.request('task_event', {
        method: 'POST',
        idempotencyKey: `task-event:${taskId}:${status}:${body.progressPercent ?? 'none'}:${sha256(body.summary).slice(0, 12)}`,
        body
      });
      this.updateRevision(response);
      await this.persist();
      return response;
    });
  }

  async reportTaskReply(taskId, final) {
    return this.serializeMutation(async () => {
      const response = await this.api.request('task_reply', {
        method: 'POST',
        idempotencyKey: `task-reply:${taskId}:${sha256(final.reply)}`,
        body: {
          taskId,
          status: final.status,
          reply: safeFinalReply(final.reply),
          summary: boundedSummary(final.summary, final.status === 'completed' ? `${this.profile.label} 已完成任务` : `${this.profile.label} 任务未完成`),
          ...(final.externalSessionId ? { externalSessionId: final.externalSessionId } : {}),
          ...(final.errorCode ? { errorCode: final.errorCode } : {})
        }
      });
      this.updateRevision(response);
      await this.persist();
      return response;
    });
  }

  async markFinalPending(command, final) {
    const local = this.findPendingCommand(command.id);
    if (!local) return;
    local._localStatus = 'final_pending';
    local._localFinal = final;
    await this.persist();
    await this.retrySyncCommand(local, () => this.flushFinal(local));
  }

  async flushFinal(command) {
    const taskId = taskIdOf(command);
    if (!taskId || !command._localFinal) return;
    if (this.flushingCommands.has(command.id)) return;
    this.flushingCommands.add(command.id);
    try {
      await this.sendSnapshot();
      await this.reportTaskReply(taskId, command._localFinal);
      await this.removeCommand(command.id);
    } finally { this.flushingCommands.delete(command.id); }
  }

  async rejectRunCommand(command, message, errorCode) {
    const taskId = taskIdOf(command);
    if (!taskId) { await this.removeCommand(command.id); return; }
    await this.reportTaskEvent(taskId, 'failed', message, null).catch(() => {});
    await this.markFinalPending(command, { status: 'failed', reply: message, summary: message, errorCode });
  }

  async waitRunCommand(command, taskId, summary, reason = 'runtime_busy') {
    const local = this.findPendingCommand(command.id);
    if (!local) return;
    local._localStatus = 'waiting_runtime';
    local._waitReason = reason;
    local._retryCount = Math.max(0, Number(local._retryCount || 0)) + 1;
    local._retryAt = Date.now() + Math.min(MAX_RUNTIME_WAIT_MS, 2000 + local._retryCount * 1000);
    await this.persist();
    const runtimeLabel = this.profile?.label || '智能体';
    const userSummary = reason === 'native_session_open'
      ? `网页消息已到本机 Skill 同步服务，但尚未进入 ${runtimeLabel} 对话：当前话题正被桌面端使用。话题释放后会自动提交，你也可以在网页取消。`
      : summary;
    await this.reportTaskEvent(taskId, 'delivered', userSummary, null).catch((error) => this.logger.error?.(`排队状态上报失败：${error.message}`));
  }

  async executeRunCommand(command, reservedLaneKey = '') {
    const operation = this.executeRunCommandInternal(command, reservedLaneKey);
    this.executionPromises.add(operation);
    try { return await operation; }
    finally { this.executionPromises.delete(operation); }
  }

  async executeRunCommandInternal(command, reservedLaneKey = '') {
    const taskId = taskIdOf(command);
    const local = this.findPendingCommand(command.id);
    if (!local || !taskId) { await this.removeCommand(command.id); return; }
    local._localStatus = 'preparing';
    await this.persist();
    let project = this.resolveProject(command);
    if (!project && this.projects.length === 0) {
      // A readiness heartbeat can activate polling before the first catalog
      // scan. Resolve against the authorized local roots before rejecting work.
      try { await this.refreshLocalCatalog(); }
      catch {
        await this.rejectRunCommand(command, '首次读取本机授权项目目录失败，尚未执行任务，请刷新后重试。', 'project_catalog_unavailable');
        return;
      }
      project = this.resolveProject(command);
    }
    if (!project) {
      await this.rejectRunCommand(command, '任务引用的项目不在本机显式白名单中，已拒绝执行。', 'project_not_allowlisted');
      return;
    }
    if (this.config.hostMode) {
      const actual = await realpath(project.path).catch(() => '');
      if (!actual || !this.config.authorizedProjectRoots.some((root) => isPathWithinRoot(actual, root))) {
        await this.rejectRunCommand(command, '项目路径已变更或超出用户授权目录，已拒绝执行。', 'project_not_allowlisted');
        return;
      }
      project.path = actual;
    }
    const payload = command.payload || {};
    const mode = payload.mode === 'continue_session' ? 'continue_session' : 'new_task';
    const session = mode === 'continue_session' ? this.resolveSession(command, project) : null;
    if (mode === 'continue_session' && !session) {
      await this.rejectRunCommand(command, `任务引用的 ${this.profile.label} 会话没有本地映射，已拒绝猜测或切换会话。`, 'session_mapping_missing');
      return;
    }
    const sourceRuntimeSessionId = session && (session.runtimeSessionId || session.codexSessionId) || '';
    const usesCodexRouter = this.config.adapterCode === 'codex' && Boolean(this.codexHost);
    const usesDesktopNative = this.config.adapterCode === 'codex' && Boolean(process.env.SHENLAN_DESKTOP_RUNNER) && Boolean(sourceRuntimeSessionId);
    const resumeSessionId = sourceRuntimeSessionId;
    const availability = await runtimeSessionAvailability(this.config.adapterCode, {
      resumeSessionId,
      runtimeHome: this.config.projectDiscovery?.runtimeHome || ''
    });
    if (!availability.available && !usesDesktopNative) {
      await this.waitRunCommand(
        command,
        taskId,
        `本机 ${this.profile.label} 正打开这个话题，任务已按提交顺序排队；话题释放后会自动继续。`,
        availability.reason
      );
      return;
    }
    const rawInstruction = String(payload.instruction || '').trim();
    const control = { taskId, child: null, cancelled: false, closed: false, desktopNative: usesDesktopNative };
    local._localStatus = 'running';
    local._retryAt = 0;
    await this.persist();
    const laneKey = reservedLaneKey || commandExecutionLane(command);
    this.runningTasks.set(taskId, { commandId: command.id, runtimeSessionId: resumeSessionId, sourceRuntimeSessionId, laneKey, control });
    let attachmentBundle = { root: '', files: [] };
    try {
      // Revalidate the runtime lease before receiving attachments, but keep the
      // user-visible task delivered until the actual agent process can start.
      await this.reportTaskEvent(taskId, 'delivered', '本机已接收任务，正在准备附件', 5);
      if (control.cancelled) throw new Error('任务在执行前已取消');
      let lastAttachmentProgress = '';
      const onAttachmentProgress = async (progress) => {
        if (control.cancelled || progress.summary === lastAttachmentProgress) return;
        lastAttachmentProgress = progress.summary;
        await this.reportTaskEvent(taskId, 'delivered', progress.summary, progress.progressPercent).catch((error) => this.logger.error?.(`附件进度上报失败：${error.message}`));
      };
      attachmentBundle = await downloadTaskAttachments({ api: this.api, taskId, attachments: payload.attachments || [], fetchImpl: this.api.fetchImpl, control, onProgress: onAttachmentProgress });
      for (const attachment of attachmentBundle.files) {
        await this.serializeMutation(() => this.api.request('attachment_received', { method: 'POST', body: { taskId, attachmentId: attachment.id, byteSize: attachment.byteSize, sha256: attachment.sha256 } }));
      }
      const instruction = usesCodexRouter ? attachmentInstruction(rawInstruction, attachmentBundle.files) : buildRuntimeInstruction(this.config.adapterCode, {
        instruction: rawInstruction,
        project,
        sandbox: this.config.sandbox,
        attachments: attachmentBundle.files
      });
      let lastProgress = '';
      const onProgress = async (progress) => {
        if (control.cancelled || progress.summary === lastProgress) return;
        lastProgress = progress.summary;
        await this.reportTaskEvent(taskId, 'running', progress.summary, progress.progressPercent).catch((error) => this.logger.error?.(`进度上报失败：${error.message}`));
      };
      // This acknowledgement is the final execution gate. A fenced, revoked or
      // offline Connector must fail here before the local agent is invoked.
      await this.reportTaskEvent(taskId, 'running', `${this.profile.label} 已确认本次任务执行权限`, 10);
      if (control.cancelled) throw new Error('任务在执行前已取消');
      const result = await this.runRuntimeTask(this.config.adapterCode, {
        runtimeRequestId: `${this.state.installationId}:${taskId}`,
        executable: this.config.runtimeExecutable,
        executableArgs: this.config.runtimeExecutableArgs,
        project,
        sandbox: this.config.sandbox,
        outputDirectory: path.dirname(this.config.stateFile),
        instruction,
        attachments: attachmentBundle.files,
        attachmentRoot: attachmentBundle.root,
        resumeSessionId,
        interactionKeyEnv: this.config.interactionKeyEnv,
        qclawStateDir: this.config.qclawStateDir,
        qclawConfigPath: this.config.qclawConfigPath,
        codexHost: this.codexHost,
        dshHost: this.config.dshHost,
        control,
        threadTitle: rawInstruction.split(/\r?\n/)[0].slice(0, 72),
        onProgress
      });

      if (result.desktopDelivery && result.exitCode !== 0) {
        await this.markFinalPending(command, { status: 'failed', reply: result.diagnostic, summary: '桌面原对话未确认完成；不会自动重发', errorCode: 'desktop_result_unconfirmed', externalSessionId: sourceRuntimeSessionId || '' });
        return;
      }
      if (result.cancelled) {
        const cancelledSessionId = result.sessionId || resumeSessionId;
        if (cancelledSessionId) this.managedSessionSettledUntil.set(cancelledSessionId, Date.now() + MANAGED_SESSION_SETTLE_MS);
        await this.reportTaskEvent(taskId, 'cancelled', `已在本机停止 ${this.profile.label} 任务`, null);
        await this.markFinalPending(command, { status: 'cancelled', reply: '任务已在运行 Skill 同步服务的电脑上停止。', summary: `已在本机停止 ${this.profile.label} 任务`, externalSessionId: sourceRuntimeSessionId || '' });
        return;
      }
      const runtimeSessionId = result.sessionId || resumeSessionId;
      const logicalSessionId = logicalRuntimeSessionId(mode, sourceRuntimeSessionId, runtimeSessionId);
      const failure = result.exitCode === 0 ? null : classifyRuntimeFailure(this.config.adapterCode, result);
      if (failure?.retryable) {
        await this.waitRunCommand(command, taskId, failure.userMessage, failure.code);
        return;
      }
      if (logicalSessionId) {
        if (result.exitCode === 0) this.managedSessionSettledUntil.set(runtimeSessionId, Date.now() + MANAGED_SESSION_SETTLE_MS);
        const previous = this.state.sessions[logicalSessionId];
        this.state.sessions[logicalSessionId] = {
          ...(previous || {}),
          runtimeSessionId: logicalSessionId,
          projectId: project.id,
          title: previous && previous.title || rawInstruction.split(/\r?\n/)[0].slice(0, 72) || `${project.name} · ${this.profile.sessionLabel}`,
          titleQuality: previous?.titleQuality || 'fallback',
          status: result.exitCode === 0 ? 'completed' : 'error',
          revision: Math.max(0, Number(previous && previous.revision || 0)) + 1,
          lastActivityAt: new Date().toISOString()
        };
        await this.persist();
      }
      if (result.exitCode === 0 && result.finalReply) {
        await this.markFinalPending(command, { status: 'completed', reply: result.finalReply, summary: `${this.profile.label} 已完成任务`, externalSessionId: logicalSessionId });
      } else {
        const detail = failure?.diagnostic ? `\n\n本机返回：${failure.diagnostic}` : '';
        const reply = result.finalReply || `${failure?.userMessage || `${this.profile.label} 本地执行失败（退出码 ${result.exitCode}）。`}${detail}`;
        await this.markFinalPending(command, { status: 'failed', reply, summary: failure?.userMessage || `${this.profile.label} 本地执行失败`, errorCode: failure?.code || 'agent_exec_failed', externalSessionId: logicalSessionId });
      }
    } catch (error) {
      if (control.cancelled || local._cancelRequested) {
        local._localStatus = 'waiting_runtime';
        local._waitReason = 'cancel_pending';
        local._retryAt = Date.now() + 250;
        await this.persist();
        return;
      }
      if (error instanceof ConnectorApiError && error.code === 'invalid_task_transition') {
        local._localStatus = 'waiting_runtime';
        local._waitReason = 'server_state_changed';
        local._retryAt = Date.now() + 1000;
        await this.persist();
        return;
      }
      if (error instanceof AttachmentTransferError) {
        await this.waitRunCommand(command, taskId, `${error.message}。附件没有上传到云端，请保持发送页打开后重试。`, error.code);
        return;
      }
      const failure = classifyRuntimeException(this.config.adapterCode, error);
      if (failure.code === 'native_session_open') {
        await this.waitRunCommand(command, taskId, failure.userMessage, failure.code);
        return;
      }
      local._transportRetryCount = Math.max(0, Number(local._transportRetryCount || 0));
      if (failure.retryable && local._transportRetryCount < 3) {
        local._transportRetryCount += 1;
        await this.waitRunCommand(command, taskId, `${failure.userMessage}（第 ${local._transportRetryCount}/3 次）`, failure.code);
        return;
      }
      const detail = failure.diagnostic ? `\n\n本机诊断：${failure.diagnostic}` : '';
      const reply = `${failure.userMessage} 请在运行 Skill 同步服务的电脑上检查安装、登录/网关状态和项目权限。${detail}`;
      this.logger.error?.(`本地 ${this.profile.label} 执行失败：${error.message}`);
      await this.markFinalPending(command, { status: 'failed', reply, summary: failure.userMessage, errorCode: failure.code }).catch(() => {});
    } finally {
      await cleanupTaskAttachments(attachmentBundle);
      this.runningTasks.delete(taskId);
      if (this.running) await this.sendSnapshot().catch((error) => this.logger.error?.(`本地完成状态同步失败：${error.message}`));
      await this.heartbeat().catch(() => {});
      if (this.running) await this.drainCommands().catch((error) => this.logger.error?.(`本地队列处理失败：${error.message}`));
    }
  }

  async handleCancelCommand(command) {
    const taskId = taskIdOf(command);
    const running = this.runningTasks.get(taskId);
    if (running) {
      if (running.control.desktopNative) {
        await this.reportTaskEvent(taskId, 'running', '桌面原对话仍在执行；当前需在 Codex 内停止，网页不会假报已经停止', null).catch(() => {});
        await this.removeCommand(command.id);
        return;
      }
      terminateAgent(running.control, this.config.cancelGraceMs);
      const runCommand = this.findPendingCommand(running.commandId);
      if (runCommand) runCommand._cancelRequested = true;
      command._localStatus = 'waiting_runtime';
      await this.persist();
      return;
    }
    const queued = this.state.pendingCommands.find((item) => item.command_type === 'run_task' && taskIdOf(item) === taskId && item._localStatus !== 'running');
    if (queued) {
      await this.reportTaskEvent(taskId, 'cancelled', '任务已在本机队列中取消', null).catch(() => {});
      await this.reportTaskReply(taskId, { status: 'cancelled', reply: '任务在开始执行前已从本地队列取消。', summary: '任务已在本机队列中取消' });
      await this.removeCommand(queued.id);
    }
    await this.removeCommand(command.id);
  }

  async prepareHandoff({ timeoutMs = 60000 } = {}) {
    if (this.handoffPromise) return this.handoffPromise;
    if (!this.running) throw new Error('同步服务尚未就绪，不能交接');
    const previousDraining = this.draining;
    this.handoffPreviousDraining = previousDraining;
    this.handoffPaused = true;
    this.draining = true;
    clearTimeout(this.pollTimer);
    this.handoffPromise = (async () => {
      const deadline = Date.now() + Math.max(1, Math.min(60000, timeoutMs));
      // Setting handoffPaused is synchronous. In-flight polling/maintenance is
      // allowed to finish, but cannot dispatch another run_task after this point.
      while (this.pollBusy || this.commandDrainPromise || this.runningTasks.size || this.executionPromises.size
        || this.state.pendingCommands.some(command => ['preparing', 'running'].includes(command._localStatus))) {
        if (Date.now() >= deadline) throw new Error('现有任务尚未结束，交接已取消；任务继续运行');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      this.handoffFrozen = true;
      clearTimeout(this.heartbeatTimer);
      await Promise.allSettled([...this.heartbeatPromises]);
      await this.mutationQueue;
      await this.persist();
      return { pendingCommands: this.state.pendingCommands.length };
    })();
    try { return await this.handoffPromise; }
    catch (error) {
      this.handoffPromise = null;
      this.handoffPaused = false;
      this.handoffFrozen = false;
      this.draining = previousDraining;
      if (this.running) { this.schedulePoll(0); this.scheduleHeartbeat(); }
      throw error;
    }
  }

  cancelPreparedHandoff() {
    if (!this.handoffPaused || !this.running) return;
    this.handoffPromise = null;
    this.handoffPaused = false;
    this.handoffFrozen = false;
    this.draining = Boolean(this.handoffPreviousDraining);
    this.schedulePoll(0);
    this.scheduleHeartbeat();
  }

  async stop() {
    if (!this.running && !this.state) return;
    this.running = false;
    clearTimeout(this.pollTimer);
    clearTimeout(this.heartbeatTimer);
    for (const { control } of this.runningTasks.values()) terminateAgent(control, this.config.cancelGraceMs);
    const deadline = Date.now() + this.config.cancelGraceMs + 500;
    while (this.runningTasks.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.codexHost) await this.codexHost.stop().catch((error) => this.logger.error?.(`Codex 同步宿主停止失败：${error.message}`));
    await shutdownRuntimeHosts().catch((error) => this.logger.error?.(`本机智能体宿主停止失败：${error.message}`));
    await this.mutationQueue.catch(() => {});
    if (!this.disconnectSent && this.state?.registered) {
      this.disconnectSent = true;
      await this.api.request('disconnect', {
        method: 'POST',
        idempotencyKey: `disconnect:${this.state.installationId}:${this.runtimeLease}`,
        body: {}
      }).then((response) => this.updateRevision(response)).catch((error) => this.logger.error?.(`离线状态上报失败：${error.message}`));
    }
    await this.persist().catch(() => {});
    this.resolveStopped?.();
  }

  waitUntilStopped() {
    return this.stoppedPromise;
  }
}
