#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentConnector } from './connector.mjs';
import { defaultConfigPath, initConfig, loadConfig, supportedAdapters } from './config.mjs';
import { LocalStateStore } from './state.mjs';
import { CodexAppServerHost } from './codex-app-server.mjs';
import { acquireServiceLock, adoptServiceConfig, registerAutoStart, registerIdeMcpServer, servicePaths, serviceStatus, startDetachedService, stopService, writeServiceConfig } from './service-manager.mjs';

function usage() {
  return [
    '深蓝智能体同步服务（通常由 Skill 自动管理）',
    '',
    '普通用户：',
    '  shenlan-agent setup --adapter codex|claude-code|qclaw|workbuddy|codebuddy|trae [--project-root <目录>] [--discovery-root <目录>]',
    '  shenlan-agent status --adapter <智能体代码>',
    '  shenlan-agent codex [--config <自动生成的配置路径>]',
    '',
    'Skill 内部：',
    '  shenlan-agent service --config <私有配置路径>',
    '  shenlan-agent stop --adapter <智能体代码>',
    '  shenlan-agent adopt --adapter <智能体代码> --from-config <旧版私有配置>',
    '',
    '兼容旧版：init 与 run 仍保留。setup 会读取当前进程的 SHENLAN_AGENT_INTERACTION_KEY，',
    '自动生成私有配置、注册登录自启、启动无界面同步服务；密钥不会进入命令行。'
  ].join('\n');
}

function parseArguments(argumentsList) {
  const values = [...argumentsList];
  const command = values.shift() || 'help';
  const result = { command, configPath: '', fromConfigPath: '', adapterCode: 'codex', projectRoot: '', discoveryRoots: [], runtimeLabel: '', runtimeAgentId: 'main', runtimeExecutable: '', runtimeExecutableArgs: [], runtimeHome: '', qclawStateDir: '', qclawConfigPath: '', noAutoStart: false };
  while (values.length) {
    const option = values.shift();
    const take = () => {
      const value = values.shift();
      if (!value) throw new Error(`${option} 需要参数值`);
      return value;
    };
    if (option === '--config' || option === '-c') result.configPath = take();
    else if (option === '--from-config') result.fromConfigPath = take();
    else if (option === '--adapter' || option === '-a') result.adapterCode = take();
    else if (option === '--project-root') result.projectRoot = take();
    else if (option === '--discovery-root') result.discoveryRoots.push(take());
    else if (option === '--runtime-label') result.runtimeLabel = take();
    else if (option === '--runtime-agent-id') result.runtimeAgentId = take();
    else if (option === '--runtime-executable') result.runtimeExecutable = take();
    else if (option === '--runtime-executable-arg') result.runtimeExecutableArgs.push(take());
    else if (option === '--runtime-home') result.runtimeHome = take();
    else if (option === '--qclaw-state-dir') result.qclawStateDir = take();
    else if (option === '--qclaw-config-path') result.qclawConfigPath = take();
    else if (option === '--no-autostart') result.noAutoStart = true;
    else throw new Error(`不支持的参数：${option}`);
  }
  if (!supportedAdapters.includes(result.adapterCode)) throw new Error(`adapter 只允许 ${supportedAdapters.join('、')}`);
  return result;
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) throw new Error('深蓝智能体同步服务需要 Node.js 20 或更高版本');
}

async function runService(configPath) {
  const config = await loadConfig(configPath);
  const paths = servicePaths(config.adapterCode, { home: path.dirname(config.configPath) });
  const releaseLock = await acquireServiceLock(paths.lock);
  const connector = new AgentConnector(config);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n收到 ${signal}，正在安全停止同步服务…\n`);
    await connector.stop().catch(() => {});
    await releaseLock();
  };
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  try {
    await connector.start();
    process.stdout.write(`深蓝同步服务已上线；${config.adapterCode} 已同步 ${config.projects.length} 个显式项目。\n`);
    await connector.waitUntilStopped();
  } finally {
    await connector.stop().catch(() => {});
    await releaseLock();
  }
  return 0;
}

export async function main(argumentsList = process.argv.slice(2)) {
  assertNodeVersion();
  const args = parseArguments(argumentsList);
  if (['help', '--help', '-h'].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.command === 'setup') {
    const secret = String(process.env.SHENLAN_AGENT_INTERACTION_KEY || '').trim();
    const current = await serviceStatus(args.adapterCode);
    if (current.running) await stopService(args.adapterCode);
    const result = await writeServiceConfig({
      adapterCode: args.adapterCode,
      secret,
      projectRoot: args.projectRoot,
      discoveryRoots: args.discoveryRoots,
      runtimeLabel: args.runtimeLabel,
      runtimeAgentId: args.runtimeAgentId,
      runtimeExecutable: args.runtimeExecutable,
      runtimeExecutableArgs: args.runtimeExecutableArgs,
      runtimeHome: args.runtimeHome,
      qclawStateDir: args.qclawStateDir || process.env.SHENLAN_QCLAW_STATE_DIR || '',
      qclawConfigPath: args.qclawConfigPath || process.env.SHENLAN_QCLAW_CONFIG_PATH || ''
    });
    await registerIdeMcpServer(args.adapterCode, result.paths.config, { runtimeExecutable: result.config.runtimeExecutable });
    if (!args.noAutoStart) await registerAutoStart(result.paths.config);
    const pid = await startDetachedService(result.paths.config);
    process.stdout.write(`深蓝同步 Skill 已配置并启动（PID ${pid}）。\n配置位置：${result.paths.config}\n登录自启：${args.noAutoStart ? '未启用' : '已启用'}\n`);
    return 0;
  }
  if (args.command === 'adopt') {
    if (!args.fromConfigPath) throw new Error('adopt 需要 --from-config <旧版私有配置>');
    const current = await serviceStatus(args.adapterCode);
    if (current.running) await stopService(args.adapterCode);
    const result = await adoptServiceConfig(args.fromConfigPath, args.adapterCode);
    if (!args.noAutoStart) await registerAutoStart(result.paths.config);
    const pid = await startDetachedService(result.paths.config);
    process.stdout.write(`旧版连接已安全迁移到 Skill 同步服务（PID ${pid}）。\n配置位置：${result.paths.config}\n登录自启：${args.noAutoStart ? '未启用' : '已启用'}\n`);
    return 0;
  }
  if (args.command === 'status') {
    const status = await serviceStatus(args.adapterCode);
    process.stdout.write(`${JSON.stringify({ adapterCode: status.adapterCode, configured: status.configured, running: status.running, pid: status.pid, lastLogLine: status.lastLogLine }, null, 2)}\n`);
    return status.running ? 0 : 1;
  }
  if (args.command === 'stop') {
    const stopped = await stopService(args.adapterCode);
    process.stdout.write(stopped ? '同步服务已停止。\n' : '同步服务当前未运行。\n');
    return 0;
  }
  if (args.command === 'init') {
    const created = await initConfig(args.configPath || defaultConfigPath(), args.adapterCode);
    process.stdout.write(`已创建高级配置：${created}\n`);
    return 0;
  }
  const configPath = args.configPath || (args.command === 'run' ? defaultConfigPath() : servicePaths(args.adapterCode).config);
  if (args.command === 'codex') {
    const config = await loadConfig(configPath);
    if (config.adapterCode !== 'codex' || !config.codexHost?.enabled) throw new Error('当前配置没有启用 Codex 同步宿主模式');
    const store = new LocalStateStore(config.stateFile);
    const state = await store.load();
    const host = new CodexAppServerHost(config, state, () => store.save(state));
    await host.start();
    process.stdout.write('正在连接深蓝 Codex 同步宿主；此窗口与手机 H5 使用同一会话所有者。\n');
    const result = await host.launchLocalClient();
    await host.stop().catch(() => {});
    return result.code === 0 ? 0 : 1;
  }
  if (!['run', 'service'].includes(args.command)) throw new Error(`不支持的命令：${args.command}\n\n${usage()}`);
  return runService(configPath);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`深蓝同步服务启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
