import { randomUUID } from 'node:crypto';

const METHODS = new Set(['host.describe', 'workspace.list', 'session.list', 'session.create', 'session.history', 'session.models', 'session.prompt', 'session.cancel', 'session.rename', 'commands/list', 'commands/execute']);
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
  constructor(endpoint, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, maximumBytes = 8 * 1024 * 1024 } = {}) {
    this.endpoint = validateDshEndpoint(endpoint);
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.maximumBytes = maximumBytes;
  }
  async call(method, payload = {}, { rpcId = randomUUID(), signal } = {}) {
    if (!METHODS.has(method)) throw new Error('DSH 方法不在远程任务许可范围内');
    if (method === 'commands/execute' && !['/permission', '/permission read-only', '/permission workspace-write'].includes(payload?.args?.line)) throw new Error('DSH 只允许查询或设置当前会话的受限权限');
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetch(`${this.endpoint}/api/${method}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: requestSignal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
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
