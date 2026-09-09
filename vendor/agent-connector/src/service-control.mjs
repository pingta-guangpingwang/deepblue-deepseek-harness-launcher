import net from 'node:net';
import path from 'node:path';
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';

export const handoffMarkerPath = configPath => path.join(path.dirname(configPath), 'sync-service.handed-off.json');
const controlPath = configPath => path.join(path.dirname(configPath), 'sync-service.control.json');
const proofFor = (key, nonce) => createHmac('sha256', key).update(`handoff-v1\0${nonce}`).digest('hex');

// No HTTP port and no credential in the connection file. The caller must prove
// possession of the existing connector key; there is no arbitrary path/command.
export async function startServiceControl({ config, connector, stop }) {
  if (process.platform !== 'win32') return { close: async () => {} };
  const nonce = randomBytes(32).toString('hex');
  const endpoint = '\\\\.\\pipe\\shenlan-handoff-' + randomBytes(16).toString('hex');
  const file = controlPath(config.configPath);
  let transfer;
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.setTimeout(75000, () => socket.destroy());
    socket.on('error', () => {});
    let input = '', handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (input.length > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      handled = true;
      void (async () => {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        const expected = proofFor(config.interactionKey, nonce);
        if (request.action !== 'handoff' || !/^[a-f0-9]{64}$/.test(request.proof || '')
          || !timingSafeEqual(Buffer.from(request.proof), Buffer.from(expected))) throw new Error('交接认证失败');
        if (!transfer) transfer = (async () => {
          await connector.prepareHandoff();
          try {
            // A future logon/manual service launch must not reclaim the old
            // lease after the launcher has taken ownership. Kept for rollback.
            await writeFile(handoffMarkerPath(config.configPath), JSON.stringify({ version: 1, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
          } catch (error) { connector.cancelPreparedHandoff(); throw error; }
          await stop('launcher-handoff');
          const state = await readFile(config.stateFile);
          return { ok: true, status: 'stopped', sha256: createHash('sha256').update(state).digest('hex') };
        })().catch(error => { transfer = null; throw error; });
        socket.end(JSON.stringify(await transfer) + '\n');
      })().catch(error => socket.end(JSON.stringify({ ok: false, error: String(error.message).replaceAll(config.interactionKey, '[hidden]').slice(0, 300) }) + '\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  try { await writeFile(file, JSON.stringify({ protocol: 1, pid: process.pid, endpoint, nonce }), { mode: 0o600 }); }
  catch (error) { server.close(); throw error; }
  return { close: async () => {
    await new Promise(resolve => server.close(resolve));
    const current = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.nonce === nonce) await unlink(file).catch(() => {});
  } };
}

export async function requestServiceHandoff(configPath, interactionKey, expectedPid, timeoutMs = 70000) {
  const record = await readFile(controlPath(configPath), 'utf8').then(JSON.parse).catch(() => null);
  if (!record || record.protocol !== 1 || record.pid !== expectedPid || !/^[a-f0-9]{64}$/.test(record.nonce)
    || !/^\\\\\.\\pipe\\shenlan-handoff-[a-f0-9]{32}$/.test(record.endpoint)) {
    throw new Error('旧同步服务不支持安全交接，请先正常退出旧同步服务并更新连接器；不会强制结束任务');
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(record.endpoint);
    socket.setEncoding('utf8');
    let text = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('交接结果尚未确认，请检查服务状态后重试；不会自动重发任务')), timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify({ action: 'handoff', proof: proofFor(interactionKey, record.nonce) }) + '\n'));
    socket.once('error', () => finish(new Error('旧同步服务交接通道不可用')));
    socket.once('end', () => finish(new Error('旧同步服务交接结果未完整返回')));
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 4096) return finish(new Error('交接结果超出限制'));
      if (!text.includes('\n')) return;
      try {
        const result = JSON.parse(text.slice(0, text.indexOf('\n')));
        if (!result.ok || result.status !== 'stopped' || !/^[a-f0-9]{64}$/.test(result.sha256)) return finish(new Error(result.error || '旧同步服务未确认停止'));
        finish(null, result);
      } catch { finish(new Error('交接结果无效')); }
    });
  });
}
