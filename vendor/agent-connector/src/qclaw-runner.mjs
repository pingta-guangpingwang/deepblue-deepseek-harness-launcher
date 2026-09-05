import { randomUUID } from 'node:crypto';
import { containsForbiddenRuntimeArgument } from './config.mjs';
import { parseQClawResult, safeFinalReply } from './privacy.mjs';
import { attachControl, childEnvironmentWithoutSecret, closeControl, readBoundedProcessText, spawnRuntime, validateInstruction, waitForExit } from './runner-common.mjs';

export function buildQClawArguments({ executableArgs = [], project, instruction, resumeSessionId = '', timeoutSeconds = 600 }) {
  if (containsForbiddenRuntimeArgument(executableArgs)) throw new Error('拒绝启动包含外发或越权参数的 QClaw 命令');
  const prompt = validateInstruction(instruction);
  const agentId = String(project.runtimeAgentId || 'main').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(agentId)) throw new Error('QClaw Agent ID 无效');
  const session = resumeSessionId
    ? ['--session-id', resumeSessionId]
    : ['--session-key', `shenlan-${randomUUID()}`];
  return [...executableArgs, 'agent', '--agent', agentId, ...session, '--message', prompt, '--json', '--timeout', String(timeoutSeconds)];
}

async function readBounded(stream, maximum = 2 * 1024 * 1024) {
  let body = '';
  for await (const chunk of stream) {
    body += chunk.toString('utf8');
    if (body.length > maximum) throw new Error('QClaw 输出超过安全解析上限');
  }
  return body;
}

export async function runQClawTask({ executable, executableArgs = [], project, instruction, resumeSessionId = '', interactionKeyEnv, qclawStateDir = '', qclawConfigPath = '', onProgress = async () => {}, control = {} }) {
  const argumentsList = buildQClawArguments({ executableArgs, project, instruction, resumeSessionId });
  const additions = {};
  if (qclawStateDir) additions.OPENCLAW_STATE_DIR = qclawStateDir;
  if (qclawConfigPath) additions.OPENCLAW_CONFIG_PATH = qclawConfigPath;
  const child = spawnRuntime(executable, argumentsList, {
    cwd: project.path,
    env: childEnvironmentWithoutSecret(interactionKeyEnv, additions)
  });
  attachControl(control, child);
  await onProgress({ summary: 'QClaw 已通过本机网关开始处理', progressPercent: 35 });
  try {
    const [stdout, diagnostic, exit] = await Promise.all([readBounded(child.stdout), readBoundedProcessText(child.stderr), waitForExit(child)]);
    closeControl(control);
    const parsed = parseQClawResult(stdout);
    return {
      sessionId: parsed && parsed.sessionId || resumeSessionId,
      finalReply: safeFinalReply(parsed && parsed.finalReply || ''),
      diagnostic,
      resumeSessionId,
      exitCode: parsed && parsed.ok && exit.code === 0 ? 0 : exit.code || 1,
      signal: exit.signal,
      cancelled: Boolean(control.cancelled)
    };
  } finally { closeControl(control); }
}
