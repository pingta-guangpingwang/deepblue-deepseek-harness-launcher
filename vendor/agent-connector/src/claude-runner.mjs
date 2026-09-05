import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containsForbiddenRuntimeArgument } from './config.mjs';
import { parseClaudeJsonLine, safeFinalReply } from './privacy.mjs';
import { attachControl, childEnvironmentWithoutSecret, closeControl, readBoundedProcessText, spawnRuntime, validateInstruction, waitForExit } from './runner-common.mjs';

export function buildClaudeArguments({ executableArgs = [], sandbox = 'workspace-write', instruction, resumeSessionId = '', newSessionId = randomUUID(), attachmentRoot = '' }) {
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('拒绝不安全的 Claude Code 权限策略');
  if (containsForbiddenRuntimeArgument(executableArgs)) throw new Error('拒绝启动包含越权参数的 Claude Code 命令');
  const prompt = validateInstruction(instruction);
  const permissionMode = sandbox === 'read-only' ? 'dontAsk' : 'acceptEdits';
  const toolScope = sandbox === 'read-only' ? ['--tools', 'Read,Grep,Glob'] : [];
  const attachmentScope = attachmentRoot ? ['--add-dir', attachmentRoot] : [];
  const session = resumeSessionId ? ['--resume', resumeSessionId] : ['--session-id', newSessionId];
  return [...executableArgs, '-p', '--output-format', 'json', '--effort', 'medium', '--permission-mode', permissionMode, ...toolScope, ...attachmentScope, ...session, prompt];
}

const POWERSHELL_BRIDGE = [
  "$ErrorActionPreference='Stop'",
  "$specPath=$env:SHENLAN_CLAUDE_LAUNCH_SPEC",
  "if([string]::IsNullOrWhiteSpace($specPath)){throw 'missing launch spec'}",
  "$spec=Get-Content -Raw -Encoding UTF8 -LiteralPath $specPath | ConvertFrom-Json",
  "$exe=[string]$spec.executable",
  "if(-not [IO.Path]::IsPathRooted($exe) -or [IO.Path]::GetExtension($exe) -ne '.exe'){throw 'Claude executable must be an absolute .exe path'}",
  "Set-Location -LiteralPath ([string]$spec.cwd)",
  "$argv=@($spec.arguments | ForEach-Object {[string]$_})",
  "& $exe @argv",
  'exit $LASTEXITCODE'
].join(';');

async function spawnClaude(executable, argumentsList, options) {
  if (process.platform !== 'win32') return { child: spawnRuntime(executable, argumentsList, options), specPath: '' };
  if (!path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== '.exe') {
    throw new Error('Windows 上 runtimeExecutable 必须填写 Claude Code 原生 claude.exe 的绝对路径，不能使用 claude.cmd');
  }
  const directory = options.outputDirectory || os.tmpdir();
  await mkdir(directory, { recursive: true });
  const specPath = path.join(directory, `.claude-launch-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify({ executable, arguments: argumentsList, cwd: options.cwd }), { encoding: 'utf8', mode: 0o600 });
  const encoded = Buffer.from(POWERSHELL_BRIDGE, 'utf16le').toString('base64');
  const env = { ...options.env, SHENLAN_CLAUDE_LAUNCH_SPEC: specPath };
  const child = spawnRuntime('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd: options.cwd, env });
  return { child, specPath };
}

async function readClaudeResult(stream, maximum = 2 * 1024 * 1024) {
  let body = '';
  for await (const chunk of stream) {
    body += chunk.toString('utf8');
    if (body.length > maximum) throw new Error('Claude Code 输出超过安全解析上限');
  }
  return parseClaudeJsonLine(body.trim());
}

export async function runClaudeTask({ executable, executableArgs = [], project, sandbox, outputDirectory = '', instruction, resumeSessionId = '', interactionKeyEnv, attachmentRoot = '', onProgress = async () => {}, control = {} }) {
  const newSessionId = randomUUID();
  const argumentsList = buildClaudeArguments({ executableArgs, sandbox, instruction, resumeSessionId, newSessionId, attachmentRoot });
  const launched = await spawnClaude(executable, argumentsList, {
    cwd: project.path,
    env: childEnvironmentWithoutSecret(interactionKeyEnv),
    outputDirectory
  });
  const child = launched.child;
  attachControl(control, child);
  await onProgress({ summary: 'Claude Code 正在分析并执行任务', progressPercent: 35 });
  try {
    const [parsed, diagnostic, exit] = await Promise.all([readClaudeResult(child.stdout), readBoundedProcessText(child.stderr), waitForExit(child)]);
    closeControl(control);
    return {
      sessionId: parsed && parsed.sessionId || resumeSessionId || newSessionId,
      finalReply: safeFinalReply(parsed && parsed.finalReply || ''),
      diagnostic,
      resumeSessionId,
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: Boolean(control.cancelled)
    };
  } finally {
    closeControl(control);
    if (launched.specPath) await unlink(launched.specPath).catch(() => {});
  }
}
