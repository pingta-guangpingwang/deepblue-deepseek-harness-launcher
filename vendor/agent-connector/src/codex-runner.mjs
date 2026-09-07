import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { containsForbiddenCodexArgument } from './config.mjs';
import { parseCodexJsonLine, safeFinalReply } from './privacy.mjs';
import { readBoundedProcessText } from './runner-common.mjs';

function validateInstruction(value) {
  const instruction = String(value || '').trim();
  if (!instruction || instruction.length > 16000 || instruction.includes('\0')) {
    throw new Error('任务内容不能为空且合成后的安全提示最多 16000 个字符');
  }
  return instruction;
}

export function buildCodexArguments({ executableArgs = [], projectPath, sandbox = 'workspace-write', outputPath, instruction, resumeSessionId = '', attachments = [], attachmentRoot = '' }) {
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('拒绝不安全的 Codex 沙箱策略');
  const prompt = validateInstruction(instruction);
  const attachmentAccess = attachmentRoot ? ['--add-dir', attachmentRoot] : [];
  const imageInputs = attachments.filter((item) => item.mediaKind === 'image').flatMap((item) => ['--image', item.path]);
  const safety = ['--json', '--output-last-message', outputPath, '--cd', projectPath, '--sandbox', sandbox, ...attachmentAccess, ...imageInputs];
  const taskArguments = resumeSessionId
    ? ['--ask-for-approval', 'never', 'exec', ...safety, 'resume', resumeSessionId, prompt]
    : ['--ask-for-approval', 'never', 'exec', ...safety, prompt];
  const argumentsList = [...executableArgs, ...taskArguments];
  if (containsForbiddenCodexArgument(executableArgs)) throw new Error('拒绝启动包含 yolo 或 danger-full-access 的 Codex 命令');
  return argumentsList;
}

async function consumeJsonLines(stream, onProgress) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = '';
  let lastSummary = '';
  let runtimeError = '';
  for await (const line of lines) {
    try { const event = JSON.parse(line); if (event.type === 'error' || event.type === 'turn.failed') runtimeError = String(event.message || event.error?.message || '').slice(-1200); } catch {}
    const parsed = parseCodexJsonLine(line);
    if (!parsed) continue;
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.progress && parsed.progress.summary !== lastSummary) {
      lastSummary = parsed.progress.summary;
      await onProgress(parsed.progress);
    }
  }
  return { sessionId, runtimeError };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? -1, signal: signal || '' }));
  });
}

export function terminateCodex(control, graceMs = 1500) {
  if (!control || !control.child || control.closed || control.cancelled) return false;
  control.cancelled = true;
  control.child.kill('SIGTERM');
  control.forceTimer = setTimeout(() => {
    if (!control.closed) control.child.kill('SIGKILL');
  }, graceMs);
  control.forceTimer.unref?.();
  return true;
}

export async function runCodexTask({
  executable,
  executableArgs = [],
  project,
  sandbox,
  outputDirectory,
  instruction,
  resumeSessionId = '',
  attachments = [],
  attachmentRoot = '',
  interactionKeyEnv,
  onProgress = async () => {},
  control = {}
}) {
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `.codex-final-${randomUUID()}.txt`);
  const argumentsList = buildCodexArguments({
    executableArgs,
    projectPath: project.path,
    sandbox,
    outputPath,
    instruction,
    resumeSessionId,
    attachments,
    attachmentRoot
  });
  const childEnvironment = { ...process.env };
  if (interactionKeyEnv) delete childEnvironment[interactionKeyEnv];
  delete childEnvironment.SHENLAN_AGENT_INTERACTION_KEY;
  const child = spawn(executable, argumentsList, {
    cwd: project.path,
    env: childEnvironment,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  control.child = child;
  control.closed = false;
  control.cancelled = false;
  try {
    const [events, diagnostic, exit] = await Promise.all([
      consumeJsonLines(child.stdout, onProgress),
      readBoundedProcessText(child.stderr),
      waitForExit(child)
    ]);
    control.closed = true;
    if (control.forceTimer) clearTimeout(control.forceTimer);
    let finalReply = '';
    try { finalReply = safeFinalReply(await readFile(outputPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { sessionId: events.sessionId || resumeSessionId, finalReply, diagnostic: [events.runtimeError, diagnostic].filter(Boolean).join('\n'), resumeSessionId, exitCode: exit.code, signal: exit.signal, cancelled: Boolean(control.cancelled) };
  } finally {
    control.closed = true;
    if (control.forceTimer) clearTimeout(control.forceTimer);
    await unlink(outputPath).catch(() => {});
  }
}
