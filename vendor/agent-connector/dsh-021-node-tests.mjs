import test from 'node:test';
// Kept outside Vitest's *.test.mjs discovery; this suite uses the native Node runner.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DshClient } from './src/dsh-rpc.mjs';

test('DSH new Remote preserves identity, uses only the local Cookie and restricts commands', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-remote-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'launcher'));
  const authFile = path.join(root, 'launcher/process-auth.json');
  await writeFile(authFile, JSON.stringify({ pid: process.pid, version: '0.2.1-alpha.2', cwd: root, url: 'http://127.0.0.1:3080/?token=SYNTHETIC_LOCAL_PROCESS_TOKEN_ONLY' }));
  const calls = [];
  const client = new DshClient('http://127.0.0.1:3080', { expectedVersion: '0.2.1-alpha.2', authFile, authRoot: root, expectedCwd: root, fetch: async (url, options) => {
    calls.push({ url, options });
    if (options.redirect === 'manual') return new Response(null, { status: 303, headers: { 'set-cookie': 'local-fixture=synthetic; HttpOnly; SameSite=Strict' } });
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }), { headers: { 'content-type': 'application/json' } });
  } });
  await client.call('session.prompt', { sessionId: 'ours', mode: 'queue', content: [{ type: 'text', text: 'synthetic' }] }, { rpcId: 'exact-request-id' });
  const message = JSON.parse(calls[1].options.body);
  assert.equal(message.method, 'session/prompt');
  assert.equal(message.payload.args.request.requestId, 'exact-request-id');
  assert.equal(calls[1].options.headers.cookie, 'local-fixture=synthetic');
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.ok(!calls[1].options.body.includes('SYNTHETIC_LOCAL_PROCESS_TOKEN_ONLY'));
  await assert.rejects(client.remoteCall('credentials/set', {}), /许可范围/);
  await assert.rejects(client.remoteCall('commands/execute', { line: '/permission danger-full-access', submittedAttachments: [] }), /受限权限/);
  assert.throws(() => new DshClient('http://127.0.0.1:3080', { expectedVersion: '0.2.2' }), /版本/);
});

test('DSH history keeps the snapshot cut when paging and closes the opening stream', async () => {
  const client = new DshClient('http://127.0.0.1:3080', { expectedVersion: '0.2.1-alpha.2' });
  let closed = false, page;
  client.openRemoteStream = async () => ({ first: { type: 'snapshot', header: { id: 'ours' }, cursor: 42, hasMore: true, records: [{ event: { seq: 40 } }] }, close: async () => { closed = true } });
  client.remoteCall = async (method, args) => { page = { method, args }; return { records: [], hasMore: false } };
  assert.equal((await client.call('session.history', { sessionId: 'ours' })).hasMore, true);
  assert.equal(closed, true);
  await client.call('session.history', { sessionId: 'ours', beforeSeq: 40 });
  assert.equal(page.method, 'session/page'); assert.equal(page.args.request.throughSeq, 42);
});

test('DSH refuses a local token minted for a different endpoint before any exchange', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-invalid-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'launcher'));
  const authFile = path.join(root, 'launcher/process-auth.json');
  await writeFile(authFile, JSON.stringify({ pid: process.pid, version: '0.2.1-alpha.2', cwd: root, url: 'http://127.0.0.1:3081/?token=SYNTHETIC_LOCAL_PROCESS_TOKEN_ONLY' }));
  let called = false;
  const client = new DshClient('http://127.0.0.1:3080', { expectedVersion: '0.2.1-alpha.2', authFile, authRoot: root, expectedCwd: root, fetch: async () => { called = true } });
  await assert.rejects(client.call('session.list'), /认证入口/); assert.equal(called, false);
});
