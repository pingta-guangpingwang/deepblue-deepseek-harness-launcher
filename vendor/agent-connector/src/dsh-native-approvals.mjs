// Reuses the exact installed DSH API client's schema-checked SSE and response
// protocol. Only the owning session's approval frames are handled here.
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { validateDshEndpoint } from './dsh-rpc.mjs';

// The shipped browser uses a downlink WebSocket; the exported native client
// consumes the same envelopes over SSE. Adapt the carrier, not the protocol.
function websocketAsSse(endpoint, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/events.mux', endpoint); url.protocol = 'ws:';
    const socket = new WebSocket(url, { origin: endpoint, maxPayload: 8 * 1024 * 1024 });
    let controller, ended = false;
    const finish = error => { if (ended) return; ended = true; if (!controller) reject(new Error('DSH 原生事件连接失败')); else if (error) controller.error(new Error('DSH 原生事件连接中断')); else controller.close(); };
    const abort = () => { socket.terminate(); finish(); };
    socket.once('open', () => {
      const body = new ReadableStream({ start(value) { controller = value; }, pull() { socket.resume(); }, cancel() { socket.close(); } }, { highWaterMark: 1024 * 1024, size: chunk => chunk.byteLength });
      resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    });
    socket.on('message', (bytes, binary) => {
      if (ended || !controller) return;
      if (binary) { socket.terminate(); finish(new Error('binary frame')); return; }
      controller.enqueue(new TextEncoder().encode('data: ' + bytes.toString('utf8') + '\n\n'));
      if (controller.desiredSize <= 0) socket.pause();
    });
    socket.on('error', finish); socket.once('close', () => { signal?.removeEventListener('abort', abort); finish(); });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

export function dshApprovalProposal(frame, events, projectRoot) {
  const call = events.findLast(event => event.type === 'tool/call' && event.data?.callId === frame.callId)?.data;
  let args = {}; try { args = JSON.parse(call?.arguments || '{}'); } catch {}
  const name = String(call?.name || frame.toolName || '').toLowerCase();
  const kind = /bash|shell|exec|pwsh|terminal/.test(name) ? 'execute' : /delete|remove/.test(name) ? 'delete' : /move|rename/.test(name) ? 'move' : /write|edit|patch/.test(name) ? 'edit' : /read|glob|grep|search/.test(name) ? 'read' : /fetch|http|web/.test(name) ? 'network' : 'other';
  const paths = [args.path, args.file_path, args.filePath, args.source, args.destination].filter(value => typeof value === 'string').map(value => path.isAbsolute(value) ? value : path.resolve(projectRoot, value));
  return { nativeId: frame.approvalId, kind, paths, command: typeof args.command === 'string' ? args.command : '', destination: typeof args.url === 'string' ? args.url : '', title: frame.toolName || '', reason: frame.reason || '' };
}
export async function openDshApprovalBridge({ nativeClientModule, nativeClientRoot, endpoint, projectRoot, sessionId, readEvents, isOwned, onApproval, onProgress = async () => {} }) {
  if (!path.isAbsolute(nativeClientModule || '') || !path.isAbsolute(nativeClientRoot || '')) throw new Error('DSH 原生审批客户端尚未就绪');
  const [moduleFile, root] = await Promise.all([realpath(nativeClientModule), realpath(nativeClientRoot)]);
  const relative = path.relative(root, moduleFile);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || path.basename(moduleFile) !== 'index.js' || path.basename(path.dirname(path.dirname(moduleFile))) !== 'dsh-host-apiproxy') throw new Error('DSH 审批客户端不属于当前签名核心');
  const { InProcessApiClient } = await import(pathToFileURL(moduleFile).href);
  if (typeof InProcessApiClient !== 'function') throw new Error('当前 DSH 未提供受支持的审批客户端');
  endpoint = validateDshEndpoint(endpoint);
  const api = new InProcessApiClient({ fetch: (input, init = {}) => {
    const requested = new URL(String(input));
    if (!['/api/events.mux', '/api/respond'].includes(requested.pathname) || requested.search) throw new Error('DSH 审批客户端只能访问审批通道');
    if (requested.pathname === '/api/events.mux') return websocketAsSse(endpoint, init.signal);
    return fetch(new URL(requested.pathname, endpoint), { ...init, redirect: 'error', credentials: 'omit' });
  } }, 15000);
  const abort = new AbortController(), active = new Set(); let openedResolve, openedReject;
  const opened = new Promise((resolve, reject) => { openedResolve = resolve; openedReject = reject; });
  const timer = setTimeout(() => { abort.abort(); openedReject(new Error('DSH 审批通道连接超时')); }, 8000);
  const stream = (async () => {
    for await (const message of api.events.mux({}, abort.signal, () => { clearTimeout(timer); openedResolve(); })) {
      const frame = message.payload;
      if (frame?.type !== 'approval/requested' || frame.sessionId !== sessionId || active.has(frame.approvalId)) continue;
      const events = await readEvents();
      if (!isOwned(events) || !events.some(event => event.type === 'approval/asked' && event.data?.id === frame.approvalId)) continue;
      active.add(frame.approvalId);
      const decision = await onApproval(dshApprovalProposal(frame, events, projectRoot), abort.signal);
      const latest = await readEvents();
      if (!isOwned(latest) || latest.some(event => event.type === 'approval/decided' && event.data?.id === frame.approvalId)) continue;
      const result = await api.respond({ type: 'client-response', rpcId: message.rpcId, result: { ok: true, value: { sessionId, approvalId: frame.approvalId, outcome: decision?.approved === true ? 'allowed-once' : 'rejected' } } }, abort.signal);
      await onProgress({ summary: result.accepted ? (decision?.approved ? '主控已批准 DSH 本次操作' : 'DSH 本次操作未获批准') : 'DSH 原生审批已由其他界面处理', progressPercent: 50 });
    }
    if (!abort.signal.aborted) throw new Error('DSH 审批通道已关闭');
  })().catch(error => { clearTimeout(timer); openedReject(new Error('DSH 审批通道不可用')); if (!abort.signal.aborted) throw error; });
  // Do not leave a rejected stream unobserved while the model is working.
  let failure; const done = stream.catch(error => { failure = error; });
  await opened;
  return { get failure() { return failure; }, close: async () => { abort.abort(); await done; } };
}
