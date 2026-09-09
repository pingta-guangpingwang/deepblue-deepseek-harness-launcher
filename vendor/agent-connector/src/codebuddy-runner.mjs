import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containsForbiddenRuntimeArgument } from './config.mjs';
import { parseCodeBuddyResult, safeFinalReply } from './privacy.mjs';
import { attachControl, childEnvironmentWithoutSecret, closeControl, readBoundedProcessText, spawnRuntime, validateInstruction, waitForExit } from './runner-common.mjs';

const POWERSHELL_BRIDGE = [
  "$ErrorActionPreference='Stop'",
  "$spec=Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SHENLAN_CODEBUDDY_LAUNCH_SPEC|ConvertFrom-Json",
  "Set-Location -LiteralPath ([string]$spec.cwd)",
  "$argv=@($spec.arguments|ForEach-Object{[string]$_})",
  "& ([string]$spec.executable) @argv",
  'exit $LASTEXITCODE'
].join(';');

export function buildCodeBuddyArguments({ executableArgs = [], sandbox = 'workspace-write', instruction, resumeSessionId = '', newSessionId = randomUUID(), attachmentRoot = '' }) {
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('拒绝不安全的 CodeBuddy 权限策略');
  if (containsForbiddenRuntimeArgument(executableArgs)) throw new Error('拒绝启动包含越权参数的 CodeBuddy 命令');
  const permission = sandbox === 'read-only'
    ? ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob']
    : ['--permission-mode', 'acceptEdits'];
  const attachmentScope = attachmentRoot ? ['--add-dir', attachmentRoot] : [];
  const session = resumeSessionId ? ['--resume', resumeSessionId] : ['--session-id', newSessionId];
  // PowerShell invokes the official Windows .cmd shim. Raw CR/LF inside the
  // final argument is interpreted by cmd.exe as another command line, which
  // silently drops the actual task after the first line. Preserve the full
  // prompt as visible escaped newlines for CodeBuddy to interpret.
  const prompt = validateInstruction(instruction).replace(/\r\n?|\n/g, '\\n');
  return [...executableArgs, '-p', '--output-format', 'json', '--effort', 'medium', ...permission, ...attachmentScope, ...session, prompt];
}

export async function spawnCodeBuddy(executable, argumentsList, options) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { child: spawnRuntime(executable, argumentsList, options), specPath: '' };
  }
  const directory = options.outputDirectory || os.tmpdir();
  await mkdir(directory, { recursive: true });
  const specPath = path.join(directory, `.codebuddy-launch-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify({ executable: path.resolve(executable), arguments: argumentsList, cwd: options.cwd }), { encoding: 'utf8', mode: 0o600 });
  const encoded = Buffer.from(POWERSHELL_BRIDGE, 'utf16le').toString('base64');
  const child = spawnRuntime('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd: options.cwd, env: { ...options.env, SHENLAN_CODEBUDDY_LAUNCH_SPEC: specPath }
  });
  return { child, specPath };
}

async function readResult(stream, maximum = 2 * 1024 * 1024) {
  let body = '';
  for await (const chunk of stream) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body, 'utf8') > maximum) throw new Error('CodeBuddy 输出超过安全解析上限');
  }
  return { parsed: parseCodeBuddyResult(body), raw: body.trim().slice(0, 4000) };
}

export async function runCodeBuddyTask({ executable, executableArgs = [], project, sandbox, outputDirectory = '', instruction, resumeSessionId = '', interactionKeyEnv, attachmentRoot = '', onProgress = async () => {}, control = {} }) {
  const newSessionId = randomUUID();
  const argumentsList = buildCodeBuddyArguments({ executableArgs, sandbox, instruction, resumeSessionId, newSessionId, attachmentRoot });
  const launched = await spawnCodeBuddy(executable, argumentsList, {
    cwd: project.path, env: childEnvironmentWithoutSecret(interactionKeyEnv), outputDirectory
  });
  attachControl(control, launched.child);
  await onProgress({ summary: 'CodeBuddy 正在分析并执行任务', progressPercent: 35 });
  try {
    const [output, stderr, exit] = await Promise.all([readResult(launched.child.stdout), readBoundedProcessText(launched.child.stderr), waitForExit(launched.child)]);
    const authentication = /authentication required|\/login|not logged in|请.*登录/i.test(`${output.raw}\n${stderr}`);
    const diagnostic = authentication
      ? 'CodeBuddy 官方 CLI 尚未登录，请在本机运行 codebuddy 后输入 /login 完成一次性登录'
      : [stderr, output.parsed ? '' : output.raw].filter(Boolean).join('\n').slice(0, 64000);
    return {
      sessionId: output.parsed?.sessionId || resumeSessionId || newSessionId,
      finalReply: safeFinalReply(output.parsed?.finalReply || ''), diagnostic, resumeSessionId,
      exitCode: authentication ? 1 : exit.code, signal: exit.signal, cancelled: Boolean(control.cancelled)
    };
  } finally {
    closeControl(control);
    if (launched.specPath) await unlink(launched.specPath).catch(() => {});
  }
}
