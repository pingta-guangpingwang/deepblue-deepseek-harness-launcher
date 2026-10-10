import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const METHODS = new Set(['host.describe', 'workspace.list', 'session.list', 'session.create', 'session.history', 'session.models', 'session.prompt', 'session.cancel', 'session.rename', 'commands/list', 'commands/execute']);
const REMOTE_METHODS = new Set(['session/list', 'session/create', 'session/modelCatalog', 'session/prompt', 'session/cancel', 'session/rename', 'session/page', 'commands/list', 'commands/execute', '$events/result', 'llm/listConfigurableProviders', 'settings/describe', 'credentials/describe', 'account/getState']);
export function validateDshEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('DSH 本机服务地址无效'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('DSH 只允许无凭据、无路径的 127.0.0.1 本机服务地址');
  }
  return url.origin;
}

/** A deliberately narrow, dependency-free client for the shipped 0.1.1 RPC. */
export class DshClient {
  constructor(endpoint, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, maximumBytes = 8 * 1024 * 1024, expectedVersion = '0.1.1-rc.2', authFile, authRoot, expectedCwd } = {}) {
    this.endpoint = validateDshEndpoint(endpoint);
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.maximumBytes = maximumBytes;
    if (!['0.1.1-rc.2', '0.2.1-alpha.2'].includes(expectedVersion)) throw new Error('DSH 核心版本尚未通过协议验证');
    this.version = expectedVersion; this.authFile = authFile; this.authRoot = authRoot; this.expectedCwd = expectedCwd;
    this.historyCuts = new Map();
  }
  async localCookie() {
    if (this.version !== '0.2.1-alpha.2') return '';
    if (!this.cookiePromise) this.cookiePromise = (async () => {
      if (!path.isAbsolute(this.authFile || '') || !path.isAbsolute(this.authRoot || '') || path.basename(this.authFile) !== 'process-auth.json') throw new Error('DSH 本机认证尚未就绪');
      const [root, file, metadata, rootMetadata, directoryMetadata] = await Promise.all([realpath(this.authRoot), realpath(this.authFile), lstat(this.authFile), lstat(this.authRoot), lstat(path.dirname(this.authFile))]);
      const relative = path.relative(root, file);
      if (relative !== path.join('launcher', 'process-auth.json') || !metadata.isFile() || metadata.isSymbolicLink() || rootMetadata.isSymbolicLink() || directoryMetadata.isSymbolicLink() || metadata.size > 8192) throw new Error('DSH 认证文件不属于当前启动器');
      let auth; try { auth = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('DSH 本机认证文件格式无效'); }
      if (auth.version !== this.version || !Number.isSafeInteger(auth.pid) || auth.pid <= 0) throw new Error('DSH 本机认证版本无效');
      try { process.kill(auth.pid, 0); } catch { throw new Error('DSH 本机进程已退出'); }
      let url; try { url = new URL(auth.url); } catch { throw new Error('DSH 本机认证入口无效'); }
      if (url.origin !== this.endpoint || url.pathname !== '/' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1 || !/^[A-Za-z0-9_-]{20,512}$/.test(url.searchParams.get('token'))) throw new Error('DSH 本机认证入口无效');
      const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (this.expectedCwd && pathKey(await realpath(auth.cwd)) !== pathKey(await realpath(this.expectedCwd))) throw new Error('DSH 认证工作区不匹配');
      const response = await this.fetch(url.href, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(this.timeoutMs) });
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      if (response.status !== 303 || !cookie) throw new Error('DSH 本机认证交换失败');
      return cookie;
    })();
    return this.cookiePromise;
  }
  async remoteCall(method, args, { rpcId = randomUUID(), signal } = {}) {
    if (!REMOTE_METHODS.has(method)) throw new Error('DSH 方法不在远程任务许可范围内');
    if (method === 'commands/execute' && (!['/permission', '/permission read-only', '/permission workspace-write'].includes(args?.line) || args.submittedAttachments?.length)) throw new Error('DSH 只允许设置当前会话的受限权限');
    if (method === '$events/result' && !(['next'].includes(args?.outcome?.kind) || args?.outcome?.kind === 'result' && ['allowed-once', 'rejected'].includes(args.outcome.value))) throw new Error('DSH 审批结果不在许可范围内');
    return this.request(method, { args }, { rpcId, signal });
  }
  async call(method, payload = {}, { rpcId = randomUUID(), signal } = {}) {
    if (!METHODS.has(method)) throw new Error('DSH 方法不在远程任务许可范围内');
    if (method === 'commands/execute' && !['/permission', '/permission read-only', '/permission workspace-write'].includes(payload?.args?.line)) throw new Error('DSH 只允许查询或设置当前会话的受限权限');
    if (this.version === '0.2.1-alpha.2') {
      if (method === 'session.history') return this.remoteHistory(payload);
      const names = { 'session.list': 'session/list', 'session.models': 'session/modelCatalog', 'session.create': 'session/create', 'session.prompt': 'session/prompt', 'session.cancel': 'session/cancel', 'session.rename': 'session/rename' };
      if (method === 'host.describe') {
        const catalog = await this.remoteCall('session/modelCatalog', {}, { rpcId, signal });
        const selected = catalog.default;
        let routeConfigured = false;
        if (selected && catalog.routableProviders?.includes(selected.provider) && catalog.groups?.some(group => group.id === selected.provider && group.models?.some(model => model.id === selected.model))) {
          if (selected.provider === 'deepseek-account') routeConfigured = (await this.remoteCall('account/getState', {})).status === 'credential-stored';
          else {
            const directory = await this.remoteCall('llm/listConfigurableProviders', {});
            const route = directory.find(item => item.provider === selected.provider);
            if (route) {
              const settings = await this.remoteCall('settings/describe', {});
              let profile = settings.namespaces?.find(item => item.ns === route.settingsNs)?.value;
              for (const part of route.settingsPath || []) profile = profile?.[part];
              const ref = profile?.apiKeyEnv;
              if (typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) routeConfigured = (await this.remoteCall('credentials/describe', { refs: [ref] }))[ref]?.configured === true;
            }
          }
        }
        return { version: this.version, cwd: this.expectedCwd, provider: selected?.provider, model: selected?.model, routeConfigured, attachedSessions: 0 };
      }
      if (method === 'commands/execute') return this.remoteCall(method, { agentId: payload.args.agentId, line: payload.args.line, submittedAttachments: [] }, { rpcId, signal });
      if (method === 'commands/list') return this.remoteCall(method, { agentId: payload.agentId || payload.args?.agentId }, { rpcId, signal });
      const mapped = names[method];
      if (!mapped) throw new Error('当前 DSH 没有兼容的远程接口');
      const args = method === 'session.list' ? { _request: {} } : method === 'session.models' ? {} : { request: method === 'session.prompt' ? { ...payload, requestId: rpcId } : payload };
      return this.remoteCall(mapped, args, { rpcId, signal });
    }
    return this.request(method, payload, { rpcId, signal });
  }
  async request(method, payload, { rpcId, signal }) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const cookie = await this.localCookie();
    const response = await this.fetch(`${this.endpoint}/api/${method}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: requestSignal,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie, origin: this.endpoint } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload })
    });
    if (!response.ok) throw new Error(`DSH 本机接口 HTTP ${response.status}；请在启动器首页启动 Harness`);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('端口未返回 DSH JSON 协议');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > this.maximumBytes) throw new Error('DSH 返回超过安全解析上限');
      chunks.push(Buffer.from(chunk));
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') throw new Error('DSH 响应协议或请求编号不匹配');
    if (!envelope.result.ok) {
      // Do not relay arbitrary provider errors or credentials to the cloud.
      const code = String(envelope.result.error?.code || 'unknown').replace(/[^a-z0-9-]/gi, '').slice(0, 80);
      throw new Error(`DSH 拒绝请求：${code}`);
    }
    return envelope.result.value;
  }
  async openRemoteStream(endpoint, args, onValue = async () => {}) {
    if (this.version !== '0.2.1-alpha.2' || !['session/follow', '$events'].includes(endpoint)) throw new Error('DSH 流不在许可范围内');
    const cookie = await this.localCookie(), streamId = randomUUID(), abort = new AbortController();
    const socket = new WebSocket(this.endpoint.replace('http:', 'ws:') + '/api/remote.mux', { origin: this.endpoint, headers: { cookie }, maxPayload: this.maximumBytes });
    let failure, closed = false, first;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = () => { failure ||= new Error('DSH 原生事件连接中断'); rejectReady(failure); socket.terminate(); };
    const timer = setTimeout(fail, Math.min(this.timeoutMs, 8000));
    socket.once('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })));
    socket.on('message', (bytes, binary) => {
      try {
        if (binary) throw Error('binary');
        const frame = JSON.parse(bytes.toString());
        if (frame.streamId !== streamId || !['item', 'end', 'error'].includes(frame.type)) throw Error('stream envelope');
        if (frame.type !== 'item') { if (!closed) fail(); return; }
        first ??= frame.value;
        clearTimeout(timer); resolveReady(first);
        Promise.resolve(onValue(frame.value, abort.signal)).catch(fail);
      } catch { fail(); }
    });
    socket.on('error', fail); socket.once('close', () => { clearTimeout(timer); if (!closed) fail(); });
    const close = async () => { if (closed) return; closed = true; clearTimeout(timer); abort.abort(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.terminate(); };
    try { await ready; } catch(error) { await close(); throw error; }
    return { first, get failure() { return failure; }, close };
  }
  async remoteHistory({ sessionId, maxMessages = 64, beforeSeq }) {
    let value;
    if (beforeSeq === undefined) {
      const stream = await this.openRemoteStream('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages } });
      try { value = stream.first; } finally { await stream.close(); }
      if (value?.type !== 'snapshot' || value.header?.id !== sessionId || !Number.isSafeInteger(value.cursor)) throw new Error('DSH 历史 opening 不匹配');
      this.historyCuts.set(sessionId, value.cursor);
    } else {
      const throughSeq = this.historyCuts.get(sessionId);
      if (!Number.isSafeInteger(throughSeq)) throw new Error('DSH 历史缺少确定的日志位置');
      value = await this.remoteCall('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages } });
    }
    return { hasMore: value.hasMore, events: value.records };
  }
}

export function dshSessionRows(value) {
  if (!Array.isArray(value?.items)) throw new Error('DSH 会话目录格式无效');
  return value.items.filter(row => row && typeof row.sessionId === 'string' && row.sessionId.length <= 191 && typeof row.cwd === 'string' && !row.parentSessionId && row.origin !== 'subagent' && typeof row.running === 'boolean');
}

export async function dshEventsSince(client, sessionId, baseline = -1) {
  const events = new Map(); let beforeSeq;
  for (let page = 0; page < 32; page++) {
    const result = await client.call('session.history', { sessionId, maxMessages: 64, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    if (!Array.isArray(result?.events) || typeof result.hasMore !== 'boolean') throw new Error('DSH 会话历史格式无效');
    let earliest = Infinity;
    for (const entry of result.events) {
      const event = entry?.event;
      if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || typeof event.type !== 'string') throw new Error('DSH 会话事件格式无效');
      earliest = Math.min(earliest, event.seq);
      if (event.seq > baseline) events.set(event.seq, event);
    }
    if (events.size > 20000) throw new Error('DSH 本轮事件超过安全解析上限');
    if (!result.hasMore || earliest <= baseline + 1) return [...events.values()].sort((a, b) => a.seq - b.seq);
    if (!Number.isFinite(earliest) || (beforeSeq !== undefined && earliest >= beforeSeq)) throw new Error('DSH 历史分页没有推进');
    beforeSeq = earliest;
  }
  throw new Error('DSH 历史分页超过安全上限，不能确认本轮结果');
}
