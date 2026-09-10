import { chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateDshEndpoint } from './dsh-rpc.mjs';

const DEFAULT_CONFIG_NAME = 'agent-connector.local.json';
const KEY_PATTERN = /^agh_live_[A-Za-z0-9_-]{32,}$/;
const SUPPORTED_ADAPTERS = ['codex', 'claude-code', 'qclaw', 'workbuddy', 'codebuddy', 'trae', 'deepseek-harness', 'cursor'];
const FORBIDDEN_ARGUMENTS = [
  '--yolo',
  '--dangerously-bypass-approvals-and-sandbox',
  '--allow-dangerously-skip-permissions',
  '--dangerously-skip-permissions',
  '--sandbox=danger-full-access',
  'danger-full-access',
  '--deliver',
  '--reply-channel',
  '--reply-to'
];

const ADAPTER_DEFAULTS = {
  codex: { executable: 'codex', workspaceKind: 'project' },
  'claude-code': { executable: 'claude', workspaceKind: 'directory' },
  qclaw: { executable: 'openclaw', workspaceKind: 'workspace' },
  workbuddy: { executable: 'workbuddy', workspaceKind: 'project' },
  codebuddy: { executable: 'codebuddy', workspaceKind: 'project' },
  'deepseek-harness': { executable: 'dsh', workspaceKind: 'project' },
  cursor: { executable: 'cursor-agent', workspaceKind: 'project' },
  trae: { executable: 'trae-cn', workspaceKind: 'project' }
};

export function defaultConfigPath(cwd = process.cwd()) {
  return path.resolve(cwd, DEFAULT_CONFIG_NAME);
}

export function configTemplate(adapterCode = 'codex') {
  const normalizedAdapter = SUPPORTED_ADAPTERS.includes(adapterCode) ? adapterCode : 'codex';
  return {
    serverUrl: 'https://ailishishu.com/ailishishu-stats/api/agent-connector.php',
    interactionKeyEnv: 'SHENLAN_AGENT_INTERACTION_KEY',
    adapterCode: normalizedAdapter,
    runtimeLabel: '我的工作电脑',
    stateFile: './.agent-connector-state.json',
    runtimeExecutable: ADAPTER_DEFAULTS[normalizedAdapter].executable,
    runtimeExecutableArgs: [],
    ...(normalizedAdapter === 'deepseek-harness' ? { dshHost: { endpoint: 'http://127.0.0.1:3000', expectedVersion: '0.1.1-rc.2', expectedCwd: '' } } : {}),
    codexHost: {
      enabled: normalizedAdapter === 'codex',
      endpoint: 'ws://127.0.0.1:4500',
      manageProcess: true,
      startupTimeoutMs: 20000,
      idleWaitTimeoutMs: 43200000
    },
    qclawStateDir: '',
    qclawConfigPath: '',
    qclawAgentId: 'main',
    sandbox: 'workspace-write',
    pollIntervalMs: 2500,
    heartbeatIntervalMs: 30000,
    idlePollIntervalMs: 15000,
    idleHeartbeatIntervalMs: 120000,
    catalogSyncIntervalMs: 30000,
    requestTimeoutMs: 15000,
    maxConcurrentTasks: ['codebuddy', 'trae'].includes(normalizedAdapter) ? 1 : 4,
    projectDiscovery: {
      enabled: false,
      roots: [],
      excludePaths: [],
      allowRootProjects: false,
      maxProjects: 60,
      maxSessionsPerProject: 100,
      historyFileLimit: 2000
    },
    projects: []
  };
}

export async function initConfig(filePath, adapterCode = 'codex') {
  const resolved = path.resolve(filePath || defaultConfigPath());
  const body = `${JSON.stringify(configTemplate(adapterCode), null, 2)}\n`;
  await writeFile(resolved, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(resolved, 0o600);
  return resolved;
}

function numberInRange(value, fallback, minimum, maximum, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return Math.round(number);
}

function validateServerUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('serverUrl 必须是完整 URL'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('生产 serverUrl 必须使用 HTTPS；HTTP 只允许 localhost 测试');
  }
  if (url.username || url.password) throw new Error('serverUrl 不能包含用户名或密码');
  return url.href;
}

function validateWrapperArguments(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error('runtimeExecutableArgs 必须是字符串数组');
  }
  for (const argument of values) {
    const normalized = argument.toLowerCase();
    if (FORBIDDEN_ARGUMENTS.some((blocked) => normalized === blocked || normalized.includes(blocked))) {
      throw new Error('runtimeExecutableArgs 包含被禁止的越权、外发或绕过沙箱参数');
    }
  }
  return [...values];
}

function validateCodexHost(raw, adapterCode) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = adapterCode === 'codex' && source.enabled === true;
  const endpointText = String(source.endpoint || 'ws://127.0.0.1:4500').trim();
  let endpoint;
  try { endpoint = new URL(endpointText); }
  catch { throw new Error('codexHost.endpoint 必须是有效的 WebSocket 地址'); }
  if (endpoint.protocol !== 'ws:') throw new Error('codexHost.endpoint 当前只允许本机 ws:// 地址');
  if (!['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) {
    throw new Error('codexHost.endpoint 必须绑定本机回环地址，禁止把 Codex App Server 直接暴露到公网');
  }
  if (endpoint.username || endpoint.password || (endpoint.pathname && endpoint.pathname !== '/') || endpoint.search || endpoint.hash) {
    throw new Error('codexHost.endpoint 只能包含本机主机名与端口');
  }
  return {
    enabled,
    endpoint: endpoint.href.replace(/\/$/, ''),
    manageProcess: source.manageProcess !== false,
    startupTimeoutMs: numberInRange(source.startupTimeoutMs, 20000, 1000, 120000, 'codexHost.startupTimeoutMs'),
    idleWaitTimeoutMs: numberInRange(source.idleWaitTimeoutMs, 43200000, 1000, 86400000, 'codexHost.idleWaitTimeoutMs')
  };
}

async function validatePrivateConfig(filePath, hasInlineKey) {
  if (!hasInlineKey || process.platform === 'win32') return;
  const metadata = await stat(filePath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('包含 interactionKey 的配置文件权限过宽，请执行 chmod 600');
  }
}

export async function loadConfig(filePath, environment = process.env) {
  const resolvedPath = path.resolve(filePath || defaultConfigPath());
  let raw;
  try { raw = JSON.parse(await readFile(resolvedPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`配置文件不存在：${resolvedPath}`);
    throw new Error(`配置文件不是有效 JSON：${error.message}`);
  }
  await validatePrivateConfig(resolvedPath, Boolean(raw?.interactionKey));
  return loadConfigObject(raw, { configPath: resolvedPath, environment });
}

export async function loadConfigObject(raw, options = {}) {
  const environment = options.environment || process.env;
  const resolvedPath = path.resolve(options.configPath || path.join(options.baseDirectory || process.cwd(), DEFAULT_CONFIG_NAME));
  const configDirectory = path.dirname(resolvedPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置文件根节点必须是对象');

  const interactionKeyEnv = String(raw.interactionKeyEnv || 'SHENLAN_AGENT_INTERACTION_KEY').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(interactionKeyEnv)) throw new Error('interactionKeyEnv 不是有效环境变量名');
  const inlineKey = String(raw.interactionKey || '').trim();
  const interactionKey = String(environment[interactionKeyEnv] || inlineKey).trim();
  if (!KEY_PATTERN.test(interactionKey)) throw new Error(`请通过环境变量 ${interactionKeyEnv} 或本地私密配置提供有效交互密钥`);

  const adapterCode = String(raw.adapterCode || 'codex').trim();
  if (!SUPPORTED_ADAPTERS.includes(adapterCode)) throw new Error(`adapterCode 只允许 ${SUPPORTED_ADAPTERS.join('、')}`);
  const sandbox = String(raw.sandbox || 'workspace-write');
  if (!['read-only', 'workspace-write'].includes(sandbox)) {
    throw new Error('sandbox 只允许 read-only 或 workspace-write，禁止 danger-full-access / yolo');
  }
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const allowlist = [];
  for (const [index, project] of projects.entries()) {
    if (!project || typeof project !== 'object' || project.enabled !== true) continue;
    const name = String(project.name || '').trim();
    if (!name || name.length > 160) throw new Error(`projects[${index}].name 必须是 1 到 160 个字符`);
    if (!project.path) throw new Error(`projects[${index}].path 不能为空`);
    const requestedPath = path.resolve(configDirectory, String(project.path));
    const projectPath = await realpath(requestedPath).catch(() => requestedPath);
    const metadata = await stat(projectPath).catch(() => null);
    if (!metadata || !metadata.isDirectory()) throw new Error(`白名单项目目录不存在：${name}`);
    allowlist.push({
      name,
      path: projectPath,
      branch: String(project.branch || '').trim().slice(0, 160),
      worktreeName: String(project.worktreeName || '').trim().slice(0, 160),
      runtimeAgentId: String(project.runtimeAgentId || raw.qclawAgentId || 'main').trim().slice(0, 120),
      workspaceKind: ADAPTER_DEFAULTS[adapterCode].workspaceKind
    });
  }
  const uniquePaths = new Set(allowlist.map((project) => process.platform === 'win32' ? project.path.toLowerCase() : project.path));
  if (uniquePaths.size !== allowlist.length) throw new Error('projects 白名单中存在重复目录');

  const discoveryRaw = raw.projectDiscovery && typeof raw.projectDiscovery === 'object' && !Array.isArray(raw.projectDiscovery) ? raw.projectDiscovery : {};
  const discoveryEnabled = discoveryRaw.enabled === true;
  const discoveryRoots = [];
  for (const [index, value] of (Array.isArray(discoveryRaw.roots) ? discoveryRaw.roots : []).entries()) {
    const requestedRoot = path.resolve(configDirectory, String(value || ''));
    const root = await realpath(requestedRoot).catch(() => requestedRoot);
    const metadata = await stat(root).catch(() => null);
    if (!metadata?.isDirectory()) throw new Error(`projectDiscovery.roots[${index}] 不存在或不是目录`);
    if (path.parse(root).root === root) throw new Error('projectDiscovery.roots 不能直接授权整个磁盘根目录');
    discoveryRoots.push(root);
  }
  if (discoveryEnabled && !discoveryRoots.length && !allowlist.length) throw new Error('启用项目发现时至少要配置一个授权根目录或显式项目');
  let authorizedProjectRoots = null;
  if (options.hostMode === true) {
    if (!Array.isArray(options.authorizedProjectRoots) || !options.authorizedProjectRoots.length) throw new Error('托管模式必须选择授权项目目录');
    authorizedProjectRoots = [];
    for (const value of options.authorizedProjectRoots) {
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('授权项目目录必须为绝对路径');
      const root = await realpath(value);
      if (!(await stat(root)).isDirectory() || path.parse(root).root === root) throw new Error('不能授权整个磁盘或非目录路径');
      authorizedProjectRoots.push(root);
    }
    for (const target of [...allowlist.map((project) => project.path), ...discoveryRoots]) {
      if (!authorizedProjectRoots.some((root) => isPathWithinRoot(target, root))) throw new Error('项目或发现范围超出用户授权目录');
    }
  }
  const discoveryExclusions = [];
  for (const value of (Array.isArray(discoveryRaw.excludePaths) ? discoveryRaw.excludePaths : [])) {
    if (!value) continue;
    discoveryExclusions.push(path.resolve(configDirectory, String(value)));
  }
  const userHome = String(environment.USERPROFILE || environment.HOME || '').trim();
  const homeNames = { codex: '.codex', 'claude-code': '.claude', qclaw: '.qclaw', workbuddy: '.workbuddy', codebuddy: '.codebuddy', trae: '.trae-cn' };
  const runtimeHomeEnv = { codex: environment.CODEX_HOME, 'claude-code': environment.CLAUDE_CONFIG_DIR, qclaw: environment.OPENCLAW_STATE_DIR }[adapterCode];
  const defaultRuntimeHome = runtimeHomeEnv || path.join(userHome, homeNames[adapterCode] || `.${adapterCode}`);
  const runtimeHome = path.resolve(configDirectory, String(discoveryRaw.runtimeHome || defaultRuntimeHome));

  const stateFile = path.resolve(configDirectory, String(raw.stateFile || './.agent-connector-state.json'));
  const legacyExecutable = adapterCode === 'codex' ? raw.codexExecutable : '';
  const legacyArguments = adapterCode === 'codex' ? raw.codexExecutableArgs : null;
  const runtimeExecutable = String(raw.runtimeExecutable || legacyExecutable || ADAPTER_DEFAULTS[adapterCode].executable).trim();
  if (!runtimeExecutable) throw new Error('runtimeExecutable 不能为空');
  const runtimeExecutableArgs = validateWrapperArguments(raw.runtimeExecutableArgs || legacyArguments || []);
  const codexHost = validateCodexHost(raw.codexHost, adapterCode);
  const dshHost = adapterCode === 'deepseek-harness' ? {
    endpoint: validateDshEndpoint(raw.dshHost?.endpoint),
    expectedVersion: String(raw.dshHost?.expectedVersion || '0.1.1-rc.2'),
    expectedCwd: raw.dshHost?.expectedCwd ? path.resolve(configDirectory, String(raw.dshHost.expectedCwd)) : ''
  } : undefined;
  const qclawStateDir = raw.qclawStateDir ? path.resolve(configDirectory, String(raw.qclawStateDir)) : '';
  const qclawConfigPath = raw.qclawConfigPath ? path.resolve(configDirectory, String(raw.qclawConfigPath)) : '';
  if (adapterCode === 'qclaw') {
    if (qclawStateDir) {
      const metadata = await stat(qclawStateDir).catch(() => null);
      if (!metadata || !metadata.isDirectory()) throw new Error('qclawStateDir 不存在或不是目录');
    }
    if (qclawConfigPath) {
      const metadata = await stat(qclawConfigPath).catch(() => null);
      if (!metadata || !metadata.isFile()) throw new Error('qclawConfigPath 不存在或不是文件');
    }
  }

  return {
    configPath: resolvedPath,
    ...(authorizedProjectRoots ? { hostMode: true, authorizedProjectRoots } : {}),
    serverUrl: validateServerUrl(raw.serverUrl),
    interactionKeyEnv,
    interactionKey,
    adapterCode,
    runtimeLabel: String(raw.runtimeLabel || '我的工作电脑').trim().slice(0, 120),
    stateFile,
    runtimeExecutable,
    runtimeExecutableArgs,
    codexHost,
    dshHost,
    qclawStateDir,
    qclawConfigPath,
    qclawAgentId: String(raw.qclawAgentId || 'main').trim().slice(0, 120) || 'main',
    sandbox,
    pollIntervalMs: numberInRange(raw.pollIntervalMs, 2500, 10, 60000, 'pollIntervalMs'),
    heartbeatIntervalMs: numberInRange(raw.heartbeatIntervalMs, 30000, 100, 300000, 'heartbeatIntervalMs'),
    idlePollIntervalMs: numberInRange(raw.idlePollIntervalMs, 15000, 1000, 300000, 'idlePollIntervalMs'),
    idleHeartbeatIntervalMs: numberInRange(raw.idleHeartbeatIntervalMs, 120000, 1000, 600000, 'idleHeartbeatIntervalMs'),
    catalogSyncIntervalMs: numberInRange(raw.catalogSyncIntervalMs, 30000, 1000, 300000, 'catalogSyncIntervalMs'),
    requestTimeoutMs: numberInRange(raw.requestTimeoutMs, 15000, 100, 120000, 'requestTimeoutMs'),
    maxConcurrentTasks: numberInRange(raw.maxConcurrentTasks, 4, 1, 12, 'maxConcurrentTasks'),
    cancelGraceMs: numberInRange(raw.cancelGraceMs, 1500, 10, 10000, 'cancelGraceMs'),
    projectDiscovery: {
      enabled: discoveryEnabled,
      roots: discoveryRoots,
      excludePaths: discoveryExclusions,
      allowRootProjects: discoveryRaw.allowRootProjects === true,
      maxProjects: numberInRange(discoveryRaw.maxProjects, 60, 1, 200, 'projectDiscovery.maxProjects'),
      maxSessionsPerProject: numberInRange(discoveryRaw.maxSessionsPerProject, 100, 1, 100, 'projectDiscovery.maxSessionsPerProject'),
      historyFileLimit: numberInRange(discoveryRaw.historyFileLimit, 2000, 10, 10000, 'projectDiscovery.historyFileLimit'),
      runtimeHome
    },
    projects: allowlist
  };
}

export function isPathWithinRoot(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function containsForbiddenRuntimeArgument(argumentsList) {
  return argumentsList.some((argument) => {
    const normalized = String(argument).toLowerCase();
    return FORBIDDEN_ARGUMENTS.some((blocked) => normalized === blocked || normalized.includes(blocked));
  });
}

export const containsForbiddenCodexArgument = containsForbiddenRuntimeArgument;
export const supportedAdapters = Object.freeze([...SUPPORTED_ADAPTERS]);
