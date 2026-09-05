import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { configTemplate, loadConfig } from './config.mjs';

const execFileAsync = promisify(execFile);
const SERVICE_VERSION = 1;
const SERVICE_FOLDER = 'AgentSync';

function safeAdapter(value) {
  const adapter = String(value || '').trim();
  if (!['codex', 'claude-code', 'qclaw', 'workbuddy', 'codebuddy', 'trae'].includes(adapter)) throw new Error('adapter 不在支持列表中');
  return adapter;
}

export async function registerIdeMcpServer(adapterCode, configPath, options = {}) {
  const adapter = safeAdapter(adapterCode);
  if (adapter !== 'trae') return { configured: false };
  const serverPath = fileURLToPath(new URL('./ide-mcp-server.mjs', import.meta.url));
  const callbackDirectory = path.join(path.dirname(path.resolve(configPath)), 'ide-callbacks');
  await mkdir(callbackDirectory, { recursive: true, mode: 0o700 });
  const environment = options.environment || process.env;
  const appData = String(environment.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  const userHome = String(environment.USERPROFILE || environment.HOME || os.homedir());
  const defaultFile = adapter === 'trae'
    ? path.join(appData, 'Trae CN', 'User', 'mcp.json')
    : path.join(userHome, '.codebuddy', '.mcp.json');
  const target = path.resolve(options.mcpConfigPath || defaultFile);
  let document = {};
  try { document = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`${adapter === 'trae' ? 'TRAE' : 'CodeBuddy'} MCP 配置不是有效 JSON，请先在产品设置里修复`);
  }
  const existing = document.mcpServers && typeof document.mcpServers === 'object' ? document.mcpServers : {};
  document.mcpServers = {
    ...existing,
    'shenlan-remote-office': {
      type: 'stdio', command: process.execPath, args: [serverPath],
      env: { SHENLAN_IDE_CALLBACK_DIR: callbackDirectory },
      description: '深蓝智能体工作台安全回传工具'
    }
  };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
  await restrictPrivateFile(target, options);
  return { configured: true, configFile: target };
}

function quoteWindowsArgument(value) {
  const text = String(value);
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function defaultServiceHome(adapterCode, environment = process.env, platform = process.platform) {
  const adapter = safeAdapter(adapterCode);
  const userHome = String(environment.USERPROFILE || environment.HOME || os.homedir()).trim();
  const base = platform === 'win32'
    ? String(environment.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'))
    : String(environment.XDG_STATE_HOME || path.join(userHome, '.local', 'state'));
  return path.resolve(base, 'ShenlanAI', SERVICE_FOLDER, adapter);
}

export function servicePaths(adapterCode, options = {}) {
  const base = path.resolve(options.home || defaultServiceHome(adapterCode, options.environment, options.platform));
  const instanceId = String(options.instanceId || '').trim();
  if (instanceId && !/^[A-Za-z0-9_-]{1,160}$/.test(instanceId)) throw new Error('instanceId 必须为字母数字、下划线或连字符');
  const home = instanceId ? path.join(base, `instance-${instanceId}`) : base;
  return {
    home,
    config: path.join(home, 'sync-service.json'),
    state: path.join(home, 'sync-state.json'),
    lock: path.join(home, 'sync-service.lock'),
    log: path.join(home, 'sync-service.log')
  };
}

async function restrictPrivateFile(filePath, options = {}) {
  await chmod(filePath, 0o600).catch(() => {});
  if ((options.platform || process.platform) !== 'win32' || options.skipAcl === true) return;
  const username = String((options.environment || process.env).USERNAME || '').trim();
  if (!username) return;
  await execFileAsync('icacls.exe', [filePath, '/inheritance:r', `/grant:r`, `${username}:(R,W)`], { windowsHide: true }).catch(() => {});
}

export function buildServiceConfig(options = {}) {
  const adapterCode = safeAdapter(options.adapterCode);
  const paths = servicePaths(adapterCode, options);
  const secret = String(options.secret || '').trim();
  if (!/^agh_live_[A-Za-z0-9_-]{32,}$/.test(secret)) throw new Error('一次性 Key 已失效或不完整');
  const template = configTemplate(adapterCode);
  const projects = [];
  const projectRoot = String(options.projectRoot || '').trim();
  if (projectRoot) {
    projects.push({
      name: String(options.projectName || path.basename(projectRoot) || '当前项目').slice(0, 160),
      path: path.resolve(projectRoot),
      runtimeAgentId: String(options.runtimeAgentId || 'main').slice(0, 120),
      enabled: true
    });
  }
  const discoveryRoots = [...new Set((options.discoveryRoots || []).map((item) => path.resolve(String(item))).filter(Boolean))];
  return {
    ...template,
    interactionKey: secret,
    runtimeLabel: String(options.runtimeLabel || `${adapterCode} · ${os.hostname()}`).slice(0, 120),
    stateFile: paths.state,
    runtimeExecutable: String(options.runtimeExecutable || template.runtimeExecutable),
    runtimeExecutableArgs: Array.isArray(options.runtimeExecutableArgs) ? options.runtimeExecutableArgs.map(String) : template.runtimeExecutableArgs,
    qclawStateDir: String(options.qclawStateDir || ''),
    qclawConfigPath: String(options.qclawConfigPath || ''),
    qclawAgentId: String(options.runtimeAgentId || 'main').slice(0, 120),
    projectDiscovery: {
      ...template.projectDiscovery,
      enabled: discoveryRoots.length > 0,
      roots: discoveryRoots,
      ...(options.runtimeHome ? { runtimeHome: path.resolve(String(options.runtimeHome)) } : {})
    },
    projects
  };
}

export async function writeServiceConfig(options = {}) {
  const config = buildServiceConfig(options);
  const paths = servicePaths(options.adapterCode, options);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await restrictPrivateFile(paths.config, options);
  return { paths, config };
}

export async function adoptServiceConfig(sourcePath, adapterCode, options = {}) {
  const adapter = safeAdapter(adapterCode);
  const source = await loadConfig(sourcePath, options.environment || process.env);
  if (source.adapterCode !== adapter) throw new Error(`旧配置属于 ${source.adapterCode}，不能迁移为 ${adapter}`);
  const paths = servicePaths(adapter, options);
  const config = {
    serverUrl: source.serverUrl,
    interactionKeyEnv: 'SHENLAN_AGENT_INTERACTION_KEY',
    interactionKey: source.interactionKey,
    adapterCode: source.adapterCode,
    runtimeLabel: source.runtimeLabel,
    stateFile: paths.state,
    runtimeExecutable: source.runtimeExecutable,
    runtimeExecutableArgs: source.runtimeExecutableArgs,
    codexHost: adapter === 'codex' ? { ...source.codexHost, enabled: true } : source.codexHost,
    qclawStateDir: source.qclawStateDir,
    qclawConfigPath: source.qclawConfigPath,
    qclawAgentId: source.qclawAgentId,
    sandbox: source.sandbox,
    pollIntervalMs: source.pollIntervalMs,
    heartbeatIntervalMs: source.heartbeatIntervalMs,
    idlePollIntervalMs: source.idlePollIntervalMs,
    idleHeartbeatIntervalMs: source.idleHeartbeatIntervalMs,
    catalogSyncIntervalMs: source.catalogSyncIntervalMs,
    requestTimeoutMs: source.requestTimeoutMs,
    cancelGraceMs: source.cancelGraceMs,
    projectDiscovery: {
      enabled: source.projectDiscovery.enabled,
      roots: source.projectDiscovery.roots,
      excludePaths: source.projectDiscovery.excludePaths,
      allowRootProjects: source.projectDiscovery.allowRootProjects,
      maxProjects: source.projectDiscovery.maxProjects,
      maxSessionsPerProject: source.projectDiscovery.maxSessionsPerProject,
      historyFileLimit: source.projectDiscovery.historyFileLimit,
      runtimeHome: source.projectDiscovery.runtimeHome
    },
    projects: source.projects.map((project) => ({
      name: project.name,
      path: project.path,
      branch: project.branch,
      worktreeName: project.worktreeName,
      runtimeAgentId: project.runtimeAgentId,
      enabled: true
    }))
  };
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await restrictPrivateFile(paths.config, options);
  return { paths, config };
}

export function windowsAutoStartSpec(configPath, cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)), nodePath = process.execPath) {
  const taskName = `ShenlanAI-AgentSync-${path.basename(path.dirname(configPath))}`;
  const taskCommand = [nodePath, cliPath, 'service', '--config', configPath].map(quoteWindowsArgument).join(' ');
  return {
    executable: 'schtasks.exe',
    args: ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', taskName, '/TR', taskCommand],
    taskName
  };
}

export function windowsStartupFallback(configPath, options = {}) {
  const environment = options.environment || process.env;
  const userHome = String(environment.USERPROFILE || environment.HOME || os.homedir()).trim();
  const roaming = String(environment.APPDATA || path.join(userHome, 'AppData', 'Roaming'));
  const startup = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const adapter = options.adapterCode ? safeAdapter(options.adapterCode) : path.basename(path.dirname(configPath));
  const suffix = path.basename(path.dirname(configPath)).startsWith('instance-')
    ? `-${createHash('sha256').update(path.resolve(configPath)).digest('hex').slice(0, 16)}` : '';
  const target = path.join(startup, `ShenlanAI-AgentSync-${adapter}${suffix}.vbs`);
  const cliPath = options.cliPath || fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const command = [options.nodePath || process.execPath, cliPath, 'service', '--config', configPath].map(quoteWindowsArgument).join(' ');
  const body = `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
  return { target, body };
}

export function launchAgentPlist(configPath, cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)), nodePath = process.execPath) {
  const label = `com.shenlanai.agent-sync.${path.basename(path.dirname(configPath))}`;
  const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = [nodePath, cliPath, 'service', '--config', configPath];
  return { label, body: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((item) => `<string>${escapeXml(item)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n` };
}

export function systemdUserUnit(configPath, cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)), nodePath = process.execPath) {
  const escape = (value) => String(value).replace(/([\\" ])/g, '\\$1');
  return `[Unit]\nDescription=Shenlan AI Agent Sync\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${[nodePath, cliPath, 'service', '--config', configPath].map(escape).join(' ')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

export async function registerAutoStart(configPath, options = {}) {
  const platform = options.platform || process.platform;
  if (options.dryRun === true) {
    if (platform === 'win32') return { platform, ...windowsAutoStartSpec(configPath, options.cliPath, options.nodePath) };
    if (platform === 'darwin') return { platform, ...launchAgentPlist(configPath, options.cliPath, options.nodePath) };
    return { platform, unit: systemdUserUnit(configPath, options.cliPath, options.nodePath) };
  }
  if (platform === 'win32') {
    const spec = windowsAutoStartSpec(configPath, options.cliPath, options.nodePath);
    try {
      await execFileAsync(spec.executable, spec.args, { windowsHide: true });
      return { platform, taskName: spec.taskName, method: 'scheduled-task' };
    } catch (error) {
      const fallback = windowsStartupFallback(configPath, options);
      await mkdir(path.dirname(fallback.target), { recursive: true });
      await writeFile(fallback.target, fallback.body, 'utf8');
      return { platform, target: fallback.target, method: 'startup-folder', scheduledTaskError: String(error.code || 'failed') };
    }
  }
  const userHome = os.homedir();
  if (platform === 'darwin') {
    const spec = launchAgentPlist(configPath, options.cliPath, options.nodePath);
    const target = path.join(userHome, 'Library', 'LaunchAgents', `${spec.label}.plist`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, spec.body, 'utf8');
    await execFileAsync('launchctl', ['bootstrap', `gui/${process.getuid()}`, target]).catch(async () => {
      await execFileAsync('launchctl', ['load', target]);
    });
    return { platform, target };
  }
  const unitName = `shenlan-agent-sync-${path.basename(path.dirname(configPath))}.service`;
  const target = path.join(userHome, '.config', 'systemd', 'user', unitName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, systemdUserUnit(configPath, options.cliPath, options.nodePath), 'utf8');
  await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  await execFileAsync('systemctl', ['--user', 'enable', '--now', unitName]);
  return { platform, target, unitName };
}

export async function acquireServiceLock(lockPath, options = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const tryCreate = async () => {
    const handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ version: SERVICE_VERSION, pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
    await handle.close();
  };
  try {
    await tryCreate();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let record = null;
    try { record = JSON.parse(await readFile(lockPath, 'utf8')); } catch {}
    const pid = Number(record?.pid);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch {}
    }
    if (alive) throw new Error(`同步服务已经在运行（PID ${pid}）`);
    await unlink(lockPath).catch(() => {});
    await tryCreate();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(lockPath).catch(() => {});
  };
}

export async function startDetachedService(configPath, options = {}) {
  const cliPath = options.cliPath || fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const logPath = path.join(path.dirname(configPath), 'sync-service.log');
  const logHandle = await open(logPath, 'a', 0o600);
  const child = spawn(options.nodePath || process.execPath, [cliPath, 'service', '--config', configPath], {
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    windowsHide: true,
    env: { ...process.env, SHENLAN_AGENT_INTERACTION_KEY: '' }
  });
  await logHandle.close();
  child.unref();
  const lockPath = path.join(path.dirname(configPath), 'sync-service.lock');
  const deadline = Date.now() + Number(options.startupTimeoutMs || 10000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = await readFile(lockPath, 'utf8').then((body) => JSON.parse(body)).catch(() => null);
    if (Number(record?.pid) === child.pid) {
      await new Promise((resolve) => setTimeout(resolve, Number(options.stabilityWaitMs || 2500)));
      try { process.kill(child.pid, 0); return child.pid; } catch { throw new Error('同步服务完成初始化前退出，请运行 status 查看脱敏日志'); }
    }
    if (child.exitCode !== null) throw new Error(`同步服务启动后立即退出（exit ${child.exitCode}）`);
  }
  throw new Error('同步服务未在 10 秒内进入运行状态');
}

export async function stopService(adapterCode, options = {}) {
  const paths = servicePaths(adapterCode, options);
  let record = null;
  try { record = JSON.parse(await readFile(paths.lock, 'utf8')); } catch {}
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    await unlink(paths.lock).catch(() => {});
    return false;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {
    await unlink(paths.lock).catch(() => {});
    return false;
  }
  const deadline = Date.now() + Number(options.timeoutMs || 5000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { process.kill(pid, 0); } catch { await unlink(paths.lock).catch(() => {}); return true; }
  }
  throw new Error('旧同步服务没有在 5 秒内停止，请先关闭对应 Node 进程后重试');
}

export async function serviceStatus(adapterCode, options = {}) {
  const paths = servicePaths(adapterCode, options);
  let record = null;
  try { record = JSON.parse(await readFile(paths.lock, 'utf8')); } catch {}
  const pid = Number(record?.pid);
  let running = false;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); running = true; } catch {}
  }
  const logText = await readFile(paths.log, 'utf8').catch(() => '');
  const lastLogLine = logText.trim().split(/\r?\n/).slice(-1)[0] || '';
  return { adapterCode: safeAdapter(adapterCode), configured: await readFile(paths.config, 'utf8').then(() => true).catch(() => false), running, pid: running ? pid : null, lastLogLine: lastLogLine.slice(0, 500), paths };
}

export async function removeServiceFiles(adapterCode, options = {}) {
  const paths = servicePaths(adapterCode, options);
  await rm(paths.home, { recursive: true, force: true });
}
