import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ensureQClawGateway, qclawGatewayReady, validateLocalGateway } from './qclaw-gateway.mjs';
import { spawnRuntime, childEnvironmentWithoutSecret, waitForExit, readBoundedProcessText } from './runner-common.mjs';
import { probeWorkBuddyRuntime } from './workbuddy-runner.mjs';
import { probeDshHost } from './dsh-runner.mjs';
import { cursorNativeCatalog } from './cursor-runner.mjs';

export function runtimeReadiness(result, error = null) {
  if (error) {
    const code = String(error.code || '');
    if (code === 'ENOENT') return { status: 'not_installed', code: 'runtime_not_found', message: '未找到智能体程序，请检查安装位置或重新关联程序。' };
    if (['ECONNREFUSED','ENOTFOUND'].includes(code)) return { status: 'error', code: 'gateway_unreachable', message: '本机智能体服务不可达，请打开对应应用并检查本机网关。' };
    if (['ETIMEDOUT','ABORT_ERR'].includes(code) || error.name === 'AbortError') return { status: 'error', code: 'probe_timeout', message: '智能体自检超时，连接器将继续检查；无需重复授权。' };
    if (Number(error.status) === 401) return { status: 'needs_login', code: 'runtime_login_required', message: '智能体返回未登录，请在原应用内完成登录。' };
    return { status: 'error', code: 'runtime_probe_failed', message: '智能体自检失败，连接器在线不代表原应用可执行任务。' };
  }
  if (result && typeof result === 'object' && ['ready','busy','needs_login','not_installed','unavailable','error','unknown'].includes(result.status)) return result;
  return result === true ? { status: 'ready', code: '', message: '' }
    : result === false ? { status: 'error', code: 'runtime_not_ready', message: '智能体未通过就绪检查，请检查原应用登录、模型配置和本机服务。' }
      : { status: 'unknown', code: 'readiness_unknown', message: '尚未确认智能体是否就绪。' };
}

export async function probeRuntimeReadiness(config, connector, operations = {}) {
  try {
    const result = await probeRuntimeHealth(config, connector, operations);
    if (result === false && config.adapterCode === 'deepseek-harness') return { status: 'error', code: 'dsh_model_route_not_ready', message: 'DSH 未提供可用模型路由，请检查模型与供应商配置；仅网页服务启动还不够。' };
    return runtimeReadiness(result);
  } catch (error) { return runtimeReadiness(null, error); }
}

export async function probeRuntimeHealth(config, connector, operations = {}) {
  if (config.adapterCode === 'cursor') return Array.isArray(await (operations.cursorNativeCatalog || cursorNativeCatalog)(config));
  if (config.adapterCode === 'deepseek-harness') {
    const host = await (operations.probeDshHost || probeDshHost)(config);
    return Boolean(host?.provider && host?.model); // Running web server alone is not a configured model route.
  }
  if (connector.codexHost?.isReady) return connector.codexHost.isReady();
  if (config.adapterCode === 'codex' && process.env.SHENLAN_DESKTOP_RUNNER) {
    const module = process.env.SHENLAN_DESKTOP_RUNNER;
    if (!path.isAbsolute(module) || path.basename(module) !== 'native-task-runner.mjs') return false;
    const native = await import(pathToFileURL(module).href);
    return native.probeNativeDesktop();
  }
  const project = config.projects?.[0];
  if (!project || !config.runtimeExecutable) return null;
  if (['workbuddy', 'codebuddy'].includes(config.adapterCode)) {
    return probeWorkBuddyRuntime({ project, executable: config.runtimeExecutable, interactionKeyEnv: config.interactionKeyEnv });
  }
  if (config.adapterCode === 'qclaw') {
    if (!config.qclawConfigPath) return false;
    validateLocalGateway(JSON.parse(await readFile(config.qclawConfigPath, 'utf8')));
    const options = { ...config, executable: config.runtimeExecutable, executableArgs: config.runtimeExecutableArgs, project };
    // A HostChild exists only after the user explicitly starts this binding.
    // Start the authenticated loopback gateway here so readiness does not
    // deadlock behind a task that the website refuses to dispatch.
    await (operations.ensureQClawGateway || ensureQClawGateway)(options);
    return (operations.qclawGatewayReady || qclawGatewayReady)(options);
  }
  if (config.adapterCode === 'claude-code') {
    const child = spawnRuntime(config.runtimeExecutable, [...(config.runtimeExecutableArgs || []), 'auth', 'status'], { cwd: project.path, env: childEnvironmentWithoutSecret(config.interactionKeyEnv) });
    const timeout = setTimeout(() => child.kill(), 7000);
    try {
      const [stdout, , exit] = await Promise.all([readBoundedProcessText(child.stdout), readBoundedProcessText(child.stderr), waitForExit(child)]);
      if (exit.code !== 0) return false;
      return JSON.parse(stdout).loggedIn === true;
    } finally { clearTimeout(timeout); }
  }
  return null;
}
