import { randomUUID } from 'node:crypto';

export class ConnectorApiError extends Error {
  constructor(message, status, code, payload) {
    super(message);
    this.name = 'ConnectorApiError';
    this.status = status;
    this.code = code || '';
    this.payload = payload || {};
  }
}

function shouldRetry(error, status) {
  if (error && error.name === 'AbortError') return true;
  if (error && !(error instanceof ConnectorApiError)) return true;
  return status === 408 || status === 429 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ConnectorApi {
  constructor({ serverUrl, interactionKey, requestTimeoutMs = 15000, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') throw new Error('Node.js 20 fetch 不可用');
    this.serverUrl = serverUrl;
    this.interactionKey = interactionKey;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.runtimeFingerprint = '';
    this.runtimeLease = '';
    this.previousRuntimeLease = '';
  }

  setRuntimeIdentity(runtimeFingerprint, runtimeLease, previousRuntimeLease = '') {
    this.runtimeFingerprint = String(runtimeFingerprint || '');
    this.runtimeLease = String(runtimeLease || '');
    this.previousRuntimeLease = String(previousRuntimeLease || '');
  }

  async request(action, options = {}) {
    const method = options.method || 'POST';
    const idempotencyKey = options.idempotencyKey || randomUUID();
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const url = new URL(this.serverUrl);
        const headers = {
          accept: 'application/json',
          authorization: `Bearer ${this.interactionKey}`,
          'x-agent-runtime-fingerprint': this.runtimeFingerprint,
          'x-agent-runtime-lease': this.runtimeLease,
          'user-agent': 'shenlan-agent-connector/0.10.7'
        };
        if (/^[a-f0-9]{64}$/.test(this.previousRuntimeLease)) headers['x-agent-previous-runtime-lease'] = this.previousRuntimeLease;
        const init = { method, headers, signal: controller.signal };
        if (method === 'GET') {
          url.searchParams.set('action', action);
          for (const [key, value] of Object.entries(options.query || {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
          }
        } else {
          headers['content-type'] = 'application/json';
          headers['idempotency-key'] = idempotencyKey;
          init.body = JSON.stringify({ action, ...(options.body || {}) });
        }
        const response = await this.fetchImpl(url, init);
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; }
        catch { throw new ConnectorApiError('服务器返回了无法解析的响应', response.status, 'invalid_server_response', {}); }
        if (!response.ok || payload.ok !== true) {
          throw new ConnectorApiError(payload.message || payload.error || `HTTP ${response.status}`, response.status, payload.error, payload);
        }
        return payload;
      } catch (error) {
        lastError = error;
        const status = error instanceof ConnectorApiError ? error.status : 0;
        if (attempt >= 2 || !shouldRetry(error, status)) throw error;
        await wait(100 * (2 ** attempt));
      } finally { clearTimeout(timeout); }
    }
    throw lastError;
  }
}
