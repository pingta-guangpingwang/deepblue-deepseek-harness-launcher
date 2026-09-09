import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { childEnvironmentWithoutSecret, terminateRuntime, waitForExit } from './runner-common.mjs';
import { safeFinalReply } from './privacy.mjs';
import { safeRuntimeDiagnostic } from './runtime-diagnostics.mjs';

const CLIENT_VERSION = '0.10.7';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedTail(current, chunk, maximum = 64 * 1024) {
  const next = `${current}${chunk.toString('utf8')}`;
  if (Buffer.byteLength(next, 'utf8') <= maximum) return next;
  return Buffer.from(next, 'utf8').subarray(-maximum).toString('utf8');
}

function healthUrl(endpoint) {
  const url = new URL(endpoint);
  url.protocol = 'http:';
  url.pathname = '/readyz';
  return url.href;
}

function sandboxPolicy(sandbox, projectPath, attachmentRoot = '') {
  if (sandbox === 'read-only') return { type: 'readOnly', access: { type: 'fullAccess' } };
  return { type: 'workspaceWrite', writableRoots: [projectPath, attachmentRoot].filter(Boolean), networkAccess: true };
}

function appServerSandbox(sandbox) {
  return sandbox === 'read-only' ? 'read-only' : 'workspace-write';
}

function threadStatusType(thread) {
  return String(thread && thread.status && thread.status.type || 'notLoaded');
}

function latestActiveTurn(thread) {
  const turns = Array.isArray(thread && thread.turns) ? thread.turns : [];
  return [...turns].reverse().find((turn) => turn && turn.status === 'inProgress') || null;
}

function finalAgentText(thread, turnId) {
  const turns = Array.isArray(thread && thread.turns) ? thread.turns : [];
  const turn = turns.find((item) => item && item.id === turnId) || turns.at(-1);
  const messages = [];
  for (const item of Array.isArray(turn && turn.items) ? turn.items : []) {
    if (item && item.type === 'agentMessage' && item.text) messages.push(String(item.text));
  }
  return safeFinalReply(messages.join('\n\n'));
}

function isActiveWriterConflict(error) {
  return /already has an active writer|active writer/i.test(String(error && error.message || error || ''));
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ endpoint, token, WebSocketImpl = WebSocket, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    super();
    this.endpoint = endpoint;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.notifications = [];
    this.closed = false;
    this.closeError = null;
  }

  async connect() {
    if (this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) return this;
    const socket = new this.WebSocketImpl(this.endpoint, {
      headers: { authorization: `Bearer ${this.token}` }
    });
    this.socket = socket;
    this.closed = false;
    this.closeError = null;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.terminate?.();
        reject(new Error('Codex App Server 连接超时'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error('Codex App Server 连接在握手时关闭')); };
      const cleanup = () => { clearTimeout(timer); socket.off('open', onOpen); socket.off('error', onError); socket.off('close', onClose); };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
    socket.on('message', (body) => this.handleMessage(body));
    socket.on('close', () => this.handleClose(new Error('Codex App Server 连接已关闭')));
    socket.on('error', (error) => this.emit('transportError', error));
    await this.request('initialize', {
      clientInfo: {
        name: 'shenlan_remote_office',
        title: '深蓝智能体远程办公',
        version: CLIENT_VERSION
      }
    });
    this.notify('initialized', {});
    return this;
  }

  handleMessage(body) {
    let message;
    try { message = JSON.parse(body.toString('utf8')); }
    catch { return; }
    if (message && message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message && message.method && message.id !== undefined) {
      this.emit('serverRequest', message);
      this.send({ id: message.id, error: { code: -32601, message: '深蓝同步服务不代替用户处理交互式审批' } });
      return;
    }
    if (!message || !message.method) return;
    this.notifications.push(message);
    if (this.notifications.length > 500) this.notifications.splice(0, this.notifications.length - 500);
    this.emit('notification', message);
    this.emit(message.method, message.params || {});
  }

  handleClose(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) throw new Error('Codex App Server 尚未连接');
    this.socket.send(JSON.stringify(message));
  }

  notify(method, params) {
    this.send({ method, params });
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ method, id, params }); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitForNotification(predicate, timeoutMs) {
    const existingIndex = this.notifications.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(this.notifications.splice(existingIndex, 1)[0]);
    if (this.closed) return Promise.reject(this.closeError || new Error('Codex App Server 连接已关闭'));
    return new Promise((resolve, reject) => {
      const onNotification = (message) => {
        try { if (!predicate(message)) return; }
        catch (error) { cleanup(); reject(error); return; }
        cleanup();
        const index = this.notifications.indexOf(message);
        if (index >= 0) this.notifications.splice(index, 1);
        resolve(message);
      };
      const onClosed = (error) => { cleanup(); reject(error || new Error('Codex App Server 连接已关闭')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('等待 Codex 会话事件超时')); }, timeoutMs);
      timeout.unref?.();
      const cleanup = () => { clearTimeout(timeout); this.off('notification', onNotification); this.off('closed', onClosed); };
      this.on('notification', onNotification);
      this.once('closed', onClosed);
    });
  }

  async close() {
    this.handleClose(new Error('Codex App Server 连接已关闭'));
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === this.WebSocketImpl.CLOSED) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      socket.close();
    });
  }
}

export class CodexAppServerHost {
  constructor(config, state, persistState, options = {}) {
    this.config = config;
    this.state = state;
    this.persistState = persistState;
    this.logger = options.logger || console;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.child = null;
    this.childControl = null;
    this.diagnostic = '';
  }

  async ensureToken() {
    if (!this.state.codexHostToken) {
      this.state.codexHostToken = randomBytes(32).toString('base64url');
      await this.persistState();
    }
    return this.state.codexHostToken;
  }

  async isReady() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1200);
      const response = await this.fetchImpl(healthUrl(this.config.codexHost.endpoint), { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch { return false; }
  }

  async start() {
    const token = await this.ensureToken();
    if (!await this.isReady()) {
      if (!this.config.codexHost.manageProcess) throw new Error('Codex 同步宿主未运行；请先启动已配置的 App Server');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const args = [
        ...this.config.runtimeExecutableArgs,
        'app-server',
        '--listen', this.config.codexHost.endpoint,
        '--ws-auth', 'capability-token',
        '--ws-token-sha256', tokenHash
      ];
      const environment = childEnvironmentWithoutSecret(this.config.interactionKeyEnv);
      const child = spawn(this.config.runtimeExecutable, args, {
        cwd: process.cwd(),
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.child = child;
      this.childControl = { child, cancelled: false, closed: false };
      child.stdout.on('data', (chunk) => { this.diagnostic = boundedTail(this.diagnostic, chunk); });
      child.stderr.on('data', (chunk) => { this.diagnostic = boundedTail(this.diagnostic, chunk); });
      child.once('close', () => { if (this.childControl) this.childControl.closed = true; });
      child.once('error', (error) => { this.diagnostic = boundedTail(this.diagnostic, Buffer.from(error.message)); });
      const deadline = Date.now() + this.config.codexHost.startupTimeoutMs;
      while (Date.now() < deadline && !await this.isReady()) {
        if (child.exitCode !== null) break;
        await sleep(200);
      }
      if (!await this.isReady()) {
        terminateRuntime(this.childControl, 500);
        throw new Error(`Codex 同步宿主启动失败：${safeRuntimeDiagnostic(this.diagnostic || '本机端口未就绪')}`);
      }
    }
    const probe = await this.createClient();
    await probe.close();
    return { endpoint: this.config.codexHost.endpoint };
  }

  async createClient() {
    const token = await this.ensureToken();
    const client = new CodexAppServerClient({
      endpoint: this.config.codexHost.endpoint,
      token,
      WebSocketImpl: this.WebSocketImpl,
      requestTimeoutMs: this.config.requestTimeoutMs
    });
    await client.connect();
    return client;
  }

  async archiveThread(threadId) {
    const id = String(threadId || '').trim();
    if (!id) return false;
    const client = await this.createClient();
    try {
      await client.request('thread/archive', { threadId: id });
      return true;
    } finally {
      await client.close().catch(() => {});
    }
  }

  async listInteractiveThreads(maximum = 2000) {
    const limit = Math.max(1, Math.min(10000, Number(maximum) || 2000));
    const client = await this.createClient();
    const threads = [];
    let cursor = null;
    try {
      do {
        const response = await client.request('thread/list', {
          archived: false,
          cursor,
          limit: Math.min(100, limit - threads.length),
          sortKey: 'updated_at',
          sortDirection: 'desc'
        });
        threads.push(...(Array.isArray(response?.data) ? response.data : []));
        cursor = response?.nextCursor || null;
      } while (cursor && threads.length < limit);
      return threads.slice(0, limit);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async stop() {
    if (!this.childControl || this.childControl.closed) return;
    terminateRuntime(this.childControl, 1000);
    await Promise.race([waitForExit(this.child).catch(() => {}), sleep(1800)]);
    this.child = null;
    this.childControl = null;
  }

  async launchLocalClient() {
    const token = await this.ensureToken();
    const environmentName = 'SHENLAN_CODEX_HOST_TOKEN';
    const environment = childEnvironmentWithoutSecret(this.config.interactionKeyEnv, { [environmentName]: token });
    const args = [
      ...this.config.runtimeExecutableArgs,
      '--remote', this.config.codexHost.endpoint,
      '--remote-auth-token-env', environmentName
    ];
    const child = spawn(this.config.runtimeExecutable, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      windowsHide: false,
      stdio: 'inherit'
    });
    return waitForExit(child);
  }
}

async function readThread(client, threadId) {
  const result = await client.request('thread/read', { threadId, includeTurns: true });
  return result && result.thread || null;
}

async function waitUntilIdle(client, threadId, control, timeoutMs, onProgress) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (control.cancelled) return false;
    const thread = await readThread(client, threadId);
    if (threadStatusType(thread) !== 'active') return true;
    if (!announced) {
      announced = true;
      await onProgress({ summary: '本机正在处理上一条消息；网页任务已进入同一话题队列', progressPercent: 5 });
    }
    await Promise.race([
      client.waitForNotification((message) => message.method === 'thread/status/changed' && message.params && message.params.threadId === threadId && message.params.status && message.params.status.type !== 'active', 5000).catch(() => null),
      sleep(1000)
    ]);
  }
  throw new Error('等待本机 Codex 话题空闲超时');
}

function progressForNotification(message) {
  if (!message || !message.method) return null;
  const item = message.params && message.params.item;
  if (message.method === 'turn/plan/updated') return { summary: 'Codex 已更新执行计划', progressPercent: 25 };
  if (message.method !== 'item/started' && message.method !== 'item/completed') return null;
  const completed = message.method === 'item/completed';
  if (item && item.type === 'commandExecution') return { summary: completed ? 'Codex 已完成一项本地命令' : 'Codex 正在运行本地命令', progressPercent: completed ? 65 : 40 };
  if (item && item.type === 'fileChange') return { summary: completed ? 'Codex 已整理文件修改' : 'Codex 正在修改项目文件', progressPercent: completed ? 80 : 60 };
  if (item && (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall')) return { summary: completed ? 'Codex 已完成工具调用' : 'Codex 正在调用工具', progressPercent: completed ? 70 : 45 };
  return null;
}

export async function runCodexAppServerTask({
  host,
  project,
  sandbox,
  instruction,
  resumeSessionId = '',
  attachments = [],
  attachmentRoot = '',
  threadTitle = '',
  onProgress = async () => {},
  control = {}
}) {
  const client = await host.createClient();
  control.closed = false;
  control.cancelled = false;
  control.child = null;
  let threadId = resumeSessionId;
  let turnId = '';
  let threadCreated = false;
  let turnSubmissionAttempted = false;
  let lastProgress = '';
  const onNotification = (message) => {
    const progress = progressForNotification(message);
    if (!progress || progress.summary === lastProgress) return;
    lastProgress = progress.summary;
    Promise.resolve(onProgress(progress)).catch(() => {});
  };
  client.on('notification', onNotification);
  control.cancel = async () => {
    if (turnId && threadId) await client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  };
  try {
    if (resumeSessionId) {
      try {
        const resumed = await client.request('thread/resume', { threadId: resumeSessionId, cwd: project.path });
        threadId = resumed && resumed.thread && resumed.thread.id || resumeSessionId;
        const idle = await waitUntilIdle(client, threadId, control, host.config.codexHost.idleWaitTimeoutMs, onProgress);
        if (!idle) return { sessionId: threadId, finalReply: '', diagnostic: '', resumeSessionId, exitCode: 130, signal: '', cancelled: true };
      } catch (error) {
        if (isActiveWriterConflict(error)) throw new Error(`选中的 Codex 原生话题正在被桌面端写入：${error.message}`);
        throw error;
      }
    } else {
      const started = await client.request('thread/start', {
        cwd: project.path,
        approvalPolicy: 'never',
        sandbox: appServerSandbox(sandbox),
        serviceName: 'shenlan_remote_office_user'
      });
      threadId = started && started.thread && started.thread.id || '';
      if (!threadId) throw new Error('Codex App Server 没有返回新话题 ID');
      threadCreated = true;
      const title = String(threadTitle || instruction || '网页新话题').trim().split(/\r?\n/)[0].slice(0, 72);
      await client.request('thread/name/set', { threadId, name: title || '网页新话题' }).catch(() => {});
      await onProgress({ summary: 'Codex 已创建新的原生项目话题', progressPercent: 8 });
    }
    if (!threadId) throw new Error('Codex App Server 没有返回会话 ID');
    const nativeInputs = [{ type: 'text', text: instruction }];
    for (const attachment of attachments) {
      if (attachment.mediaKind === 'image') nativeInputs.push({ type: 'localImage', path: attachment.path });
      else if (attachment.mediaKind === 'audio') nativeInputs.push({ type: 'localAudio', path: attachment.path });
    }
    turnSubmissionAttempted = true;
    const startedTurn = await client.request('turn/start', {
      threadId,
      input: nativeInputs,
      cwd: project.path,
      approvalPolicy: 'never',
      sandboxPolicy: sandboxPolicy(sandbox, project.path, attachmentRoot)
    });
    turnId = startedTurn && startedTurn.turn && startedTurn.turn.id || '';
    if (!turnId) throw new Error('Codex App Server 没有返回任务 ID');
    await onProgress({ summary: threadCreated ? '网页消息已写入新建的 Codex 原生话题' : '网页消息已写入所选 Codex 原生话题', progressPercent: 10 });
    const completed = await client.waitForNotification(
      (message) => message.method === 'turn/completed' && message.params && message.params.turn && message.params.turn.id === turnId,
      host.config.codexHost.idleWaitTimeoutMs
    );
    const turn = completed.params.turn || {};
    const thread = await readThread(client, threadId);
    const finalReply = finalAgentText(thread, turnId);
    const status = String(turn.status || 'failed');
    const diagnostic = turn.error && (turn.error.message || JSON.stringify(turn.error)) || '';
    return {
      sessionId: threadId,
      finalReply,
      diagnostic,
      resumeSessionId,
      threadCreated,
      exitCode: status === 'completed' ? 0 : status === 'interrupted' ? 130 : 1,
      signal: '',
      cancelled: control.cancelled || status === 'interrupted'
    };
  } catch (error) {
    // Once turn/start has gone on the wire, a lost reply is not proof that the
    // native agent did nothing. Never replay a potentially mutating turn.
    if (turnSubmissionAttempted) {
      error.taskMayHaveExecuted = true;
      error.runtimeSessionId = threadId;
    }
    throw error;
  } finally {
    control.closed = true;
    control.cancel = null;
    client.off('notification', onNotification);
    await client.close().catch(() => {});
  }
}

export function activeTurnId(thread) {
  return latestActiveTurn(thread)?.id || '';
}
