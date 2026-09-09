import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentConnector } from './connector.mjs';
import { ConnectorApi } from './api.mjs';
import { loadConfigObject } from './config.mjs';
import { safeRuntimeDiagnostic } from './runtime-diagnostics.mjs';
import { acquireServiceLock } from './service-manager.mjs';
import { probeRuntimeHealth } from './runtime-health.mjs';

// Local parent IPC is the only configuration input. No credential-bearing file,
// command-line flag or inherited environment variable is needed for host mode.
export class HostChildController {
  constructor(options = {}) {
    this.send = options.send || (() => {});
    this.createConnector = options.createConnector || ((config, connectorOptions) => new AgentConnector(config, connectorOptions));
    this.createApi = options.createApi || ((config) => new ConnectorApi(config));
    this.loadConfig = options.loadConfig || loadConfigObject;
    this.lock = options.lock || acquireServiceLock;
    this.now = options.now || Date.now;
    this.probeRuntime = options.probeRuntime || probeRuntimeHealth;
    this.connector = null;
    this.phase = 'stopped';
    this.instanceId = '';
    this.secrets = [];
    this.localPaths = [];
    this.lastHeartbeatAt = 0;
    this.lastTransportFailure = false;
    this.transportError = '';
    this.lastSnapshot = '';
    this.error = '';
    this.releaseLock = null;
    this.stopPromise = null;
    this.startPromise = null;
    this.stopRequested = false;
    this.runtimeReady = null;
    this.healthBusy = false;
    this.lastHealthAt = 0;
  }

  redact(value) {
    let text = String(value || '');
    for (const secret of this.secrets) if (secret) text = text.split(secret).join('[凭据已隐藏]');
    for (const localPath of this.localPaths) if (localPath) text = text.split(localPath).join('[本地路径]');
    return safeRuntimeDiagnostic(text, 600).slice(0, 600);
  }

  emitStatus(force = false) {
    const config = this.connector?.config;
    const runningTasks = this.connector?.runningTasks?.size || 0;
    const pending = this.connector?.state?.pendingCommands || [];
    const phase = this.phase === 'ready' && runningTasks ? 'busy' : this.phase;
    const connected = ['starting', 'ready', 'stopping'].includes(this.phase) && this.lastHeartbeatAt > 0 && !this.lastTransportFailure
      && this.now() - this.lastHeartbeatAt < (config?.idleHeartbeatIntervalMs || 120000) + (config?.requestTimeoutMs || 15000) * 3;
    const message = {
      type: 'status', instanceId: this.instanceId, phase, connected, runningTasks,
      pendingCommands: pending.filter((command) => !['running', 'final_pending'].includes(command._localStatus)).length,
      // A responsive website endpoint is not proof that every CLI is logged in.
      runtimeReady: ['stopped', 'failed'].includes(phase) ? false : this.runtimeReady,
      lastCatalogAt: this.connector?.lastLocalCatalogAt || null,
      lastSyncedAt: this.connector?.lastCatalogSyncAt ? new Date(this.connector.lastCatalogSyncAt).toISOString() : null,
      ...(this.error || this.transportError ? { error: this.error || this.transportError } : {})
    };
    const serialized = JSON.stringify(message);
    if (force || serialized !== this.lastSnapshot) { this.lastSnapshot = serialized; this.send(message); }
    return message;
  }

  async tick() {
    if (!this.healthBusy && this.phase === 'ready' && this.connector && this.now() - this.lastHealthAt >= 30000) {
      this.healthBusy = true;
      try {
        try { this.runtimeReady = await this.probeRuntime(this.connector.config, this.connector); }
        catch { this.runtimeReady = false; }
        if (this.phase !== 'ready' || this.stopRequested || !this.connector) return;
        this.connector.setRuntimeStatus?.(this.runtimeReady === true ? 'ready' : this.runtimeReady === false ? 'error' : 'unknown');
        await this.connector.heartbeat({ synchronizeIfActivated: false }).catch(() => {});
      } finally { this.lastHealthAt = this.now(); this.healthBusy = false; }
    }
    this.emitStatus();
  }
  async refresh(requestId) {
    try {
      if (this.phase !== 'ready' || !this.connector) throw new Error('本机同步服务尚未就绪');
      await this.connector.sendSnapshot('', { onlyIfChanged: true });
      await this.connector.heartbeat({ synchronizeIfActivated: false });
      this.emitStatus(true);
      this.send({ type: 'refresh_result', requestId });
    } catch (error) { this.send({ type: 'refresh_result', requestId, error: this.redact(error.message) }); }
  }

  async start(message) {
    if (this.startPromise || this.connector || this.phase !== 'stopped') throw new Error('托管子进程已经启动，不能覆盖正在使用的实例');
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(message.instanceId || ''))) throw new Error('无效的实例标识');
    this.instanceId = message.instanceId;
    this.secrets = [String(message.config?.interactionKey || '')];
    this.localPaths = [...(message.authorizedProjectRoots || []), message.config?.stateFile, message.config?.runtimeExecutable, message.config?.projectDiscovery?.runtimeHome].filter((value) => typeof value === 'string' && path.isAbsolute(value)).sort((a, b) => b.length - a.length);
    this.phase = 'starting';
    this.emitStatus(true);
    this.startPromise = this.startInternal(message);
    try { await this.startPromise; }
    catch (error) {
      this.error = this.redact(error?.message || error);
      this.phase = 'failed';
      await this.connector?.stop().catch(() => {});
      await this.releaseLock?.();
      this.releaseLock = null;
      this.emitStatus(true);
      throw error;
    } finally { this.startPromise = null; }
  }

  async startInternal(message) {
    if (!path.isAbsolute(String(message.config?.stateFile || ''))) throw new Error('托管状态文件必须为独立的绝对路径');
    const config = await this.loadConfig(message.config, {
      baseDirectory: path.dirname(message.config.stateFile),
      environment: { ...process.env, [String(message.config.interactionKeyEnv || 'SHENLAN_AGENT_INTERACTION_KEY')]: '' },
      hostMode: true, authorizedProjectRoots: message.authorizedProjectRoots
    });
    this.releaseLock = await this.lock(`${config.stateFile}.host.lock`);
    const api = this.createApi(config);
    const request = api.request.bind(api);
    api.request = async (...args) => {
      try {
        const response = await request(...args);
        if (['register', 'heartbeat', 'commands', 'sync_state'].includes(args[0])) {
          this.lastTransportFailure = false; this.transportError = '';
        }
        if (args[0] === 'heartbeat') this.lastHeartbeatAt = this.now();
        this.emitStatus();
        return response;
      } catch (error) {
        // A rejected historical task receipt does not mean the device went
        // offline. Only control-plane availability determines connectivity.
        if (['register', 'heartbeat', 'commands', 'sync_state'].includes(args[0]) || error.status === 401 || error.status === 403) {
          this.lastTransportFailure = true;
          this.transportError = this.redact(error.message);
        }
        this.emitStatus(); throw error;
      }
    };
    const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (value) => this.send({ type: 'log', instanceId: this.instanceId, level, message: this.redact(value) })]));
    this.connector = this.createConnector(config, { api, logger, runtimeMode: 'launcher_hosted' });
    await this.connector.start();
    try { this.runtimeReady = await this.probeRuntime(config, this.connector); }
    catch { this.runtimeReady = false; }
    if(!this.stopRequested){
      this.connector.setRuntimeStatus?.(this.runtimeReady === true ? 'ready' : this.runtimeReady === false ? 'error' : 'unknown');
      await this.connector.heartbeat({ synchronizeIfActivated: false }).catch(() => {});
    }
    this.lastHealthAt = this.now();
    this.phase = this.stopRequested ? 'stopping' : 'ready';
    this.emitStatus(true);
  }

  stop(force = false) {
    this.stopRequested = true;
    if (force) this.forceStop = true;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  async stopInternal() {
    if (this.startPromise) await this.startPromise.catch(() => {});
    this.phase = 'stopping';
    if (this.connector) this.connector.draining = true;
    this.emitStatus(true);
    while (!this.forceStop && (this.connector?.runningTasks?.size || this.connector?.state?.pendingCommands?.some((command) => ['preparing', 'running'].includes(command._localStatus)))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.emitStatus();
    }
    try { await this.connector?.stop(); }
    finally {
      await this.releaseLock?.();
      this.releaseLock = null;
      this.phase = 'stopped';
      this.emitStatus(true);
      this.secrets = [];
    }
  }
}

export function runHostChild() {
  if (typeof process.send !== 'function') throw new Error('托管子进程只能由启动器通过本机 IPC 启动');
  const send = (message) => { if (process.connected) process.send(message, () => {}); };
  const host = new HostChildController({ send });
  const interval = setInterval(() => { void host.tick(); }, 1000);
  const exit = async (force) => {
    await host.stop(force).catch(() => {});
    clearInterval(interval);
    if (process.connected) process.disconnect();
  };
  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'start') void host.start(message).catch((error) => { send({ type: 'log', level: 'error', message: host.redact(error.message) }); clearInterval(interval); process.exitCode = 1; if (process.connected) process.disconnect(); });
    else if (message.type === 'status') host.emitStatus(true);
    else if (message.type === 'refresh') void host.refresh(message.requestId);
    else if (message.type === 'stop') void exit(message.force === true);
  });
  process.once('disconnect', () => { void exit(true); });
  process.once('SIGTERM', () => { void exit(true); });
  process.once('SIGINT', () => { void exit(true); });
  send({ type: 'ready', protocolVersion: 1 });
  return host;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runHostChild();
