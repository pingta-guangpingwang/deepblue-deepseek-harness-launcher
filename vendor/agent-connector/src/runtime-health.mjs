import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ensureQClawGateway, qclawGatewayReady, validateLocalGateway } from './qclaw-gateway.mjs';
import { spawnRuntime, childEnvironmentWithoutSecret, waitForExit, readBoundedProcessText } from './runner-common.mjs';
import { probeWorkBuddyRuntime } from './workbuddy-runner.mjs';
import { probeDshHost } from './dsh-runner.mjs';
import { cursorNativeCatalog } from './cursor-runner.mjs';

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
