import { readFile } from 'node:fs/promises';
import { childEnvironmentWithoutSecret, spawnRuntime, readBoundedProcessText, waitForExit } from './runner-common.mjs';

const managed = new Map();
async function stopGateway(host) {
  if (!host?.child || host.child.exitCode !== null) return;
  const stopped = new Promise(resolve => host.child.once('close', resolve));
  host.child.kill();
  let timer;
  try {
    await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 7000); })]);
    if (host.child.exitCode === null) {
      host.child.kill('SIGKILL');
      await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    }
  } finally { clearTimeout(timer); }
}
function environment(options) {
  return childEnvironmentWithoutSecret(options.interactionKeyEnv, {
    ...(options.qclawStateDir ? { OPENCLAW_STATE_DIR: options.qclawStateDir } : {}),
    ...(options.qclawConfigPath ? { OPENCLAW_CONFIG_PATH: options.qclawConfigPath } : {})
  });
}
export function validateLocalGateway(config) {
  const gateway = config?.gateway;
  if (gateway?.mode !== 'local' || !['loopback', undefined].includes(gateway?.bind)) throw new Error('QClaw 必须先在本机配置 loopback 网关');
  if (!['token', 'password'].includes(gateway?.auth?.mode)) throw new Error('QClaw 网关必须启用令牌或密码认证');
  if (!gateway.auth[gateway.auth.mode]) throw new Error('QClaw 网关尚未配置有效认证，请在 QClaw 中完成设置');
  if (gateway?.remote?.url) throw new Error('当前绑定指向远程 QClaw 网关，请先在 QClaw 中切换为本机网关');
}
export async function qclawGatewayReady(options) {
  const child = spawnRuntime(options.executable, [...(options.executableArgs || []), 'gateway', 'health', '--json', '--timeout', '2500'], { cwd: options.project.path, env: environment(options) });
  const timeout = setTimeout(() => child.kill(), 7000);
  try {
    const [stdout, , exit] = await Promise.all([readBoundedProcessText(child.stdout), readBoundedProcessText(child.stderr), waitForExit(child)]);
    // Health requires the configured WebSocket authentication, not just TCP.
    return exit.code === 0 && /"ok"\s*:\s*true/.test(stdout);
  } catch { return false; }
  finally { clearTimeout(timeout); }
}
export async function ensureQClawGateway(options) {
  if (!options.qclawConfigPath) throw new Error('缺少 QClaw 本机配置，请先授权已有 QClaw 实例');
  validateLocalGateway(JSON.parse(await readFile(options.qclawConfigPath, 'utf8')));
  if (await qclawGatewayReady(options)) return;
  const key = options.qclawConfigPath;
  let host = managed.get(key);
  if (!host || host.child.exitCode !== null) {
    const child = spawnRuntime(options.executable, [...(options.executableArgs || []), 'gateway', 'run', '--bind', 'loopback'], { cwd: options.project.path, env: environment(options) });
    host = { child, error: false };
    managed.set(key, host);
    child.once('error', () => { host.error = true; });
    // Consume logs but never persist or expose configuration values from them.
    child.stdout.resume(); child.stderr.resume();
    child.once('close', () => { if (managed.get(key) === host) managed.delete(key); });
  }
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (host.error || host.child.exitCode !== null) throw new Error('QClaw 本机网关启动失败，请在 QClaw 中检查登录与配置');
    if (await qclawGatewayReady(options)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (managed.get(key) === host) { managed.delete(key); await stopGateway(host); }
  throw new Error('QClaw 网关启动后未通过认证健康检查，请检查 QClaw 登录状态');
}
export async function shutdownQClawGateways() {
  const hosts = [...managed.values()]; managed.clear();
  await Promise.all(hosts.map(stopGateway));
}
