import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { runRuntimeTask, terminateAgent, attachmentInstruction } from './runtime-runner.mjs';
import { safeRuntimeDiagnostic } from './runtime-diagnostics.mjs';

export function localTaskOutputDirectory(outputDirectory, allowedRoot = process.env.SHENLAN_LOCAL_TASK_ROOT) {
  if (!path.isAbsolute(String(outputDirectory || '')) || !path.isAbsolute(String(allowedRoot || ''))) throw new Error('本机任务目录未授权');
  const root = path.resolve(String(allowedRoot));
  const target = path.resolve(String(outputDirectory));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative.includes(path.sep) || !/^[a-f0-9-]{36}$/i.test(relative)) throw new Error('本机任务目录超出启动器授权范围');
  return target;
}

export async function runLocalTask(message, onProgress, control = {}) {
  const root = localTaskOutputDirectory(message.outputDirectory);
  const attachmentsRoot = path.join(root, 'attachments');
  await mkdir(attachmentsRoot, { recursive: true });
  const attachments = [];
  try {
    for (const [index, file] of (message.files || []).entries()) {
      const target = path.join(attachmentsRoot, `${index}-${path.basename(file.path)}`);
      await copyFile(file.path, target);
      attachments.push({ ...file, path: target });
    }
    return await runRuntimeTask(message.adapter, {
      executable: message.executable, executableArgs: [...message.executableArgs, ...(message.model ? ['--model', message.model] : [])],
      project: message.project, sandbox: 'workspace-write', outputDirectory: root,
      instruction: attachmentInstruction(message.instruction, attachments), attachments,
      attachmentRoot: attachments.length ? attachmentsRoot : '', resumeSessionId: message.resumeSessionId || '', onProgress, control
    });
  } finally {
    // Only this invocation's generated attachment directory is removed.
    await rm(attachmentsRoot, { recursive: true, force: true });
  }
}
export function runLocalChild() {
  if (!process.send) throw new Error('本机执行仅允许本地 IPC');
  const control = {};
  let started = false;
  process.on('message', message => {
    if (message?.type === 'cancel') { terminateAgent(control); return; }
    if (message?.type !== 'start' || started) return;
    started = true;
    const send = data => { if (process.connected) process.send(data); };
    void runLocalTask(message, async progress => send({ type: 'progress', progress }), control)
      .then(result => send({ type: 'result', result: { ...result, diagnostic: safeRuntimeDiagnostic(result.diagnostic || '', 600) } }))
      .catch(error => send({ type: 'result', result: { exitCode: 1, diagnostic: safeRuntimeDiagnostic(error.message, 600) } }))
      .finally(() => { if (process.connected) process.disconnect(); });
  });
  process.on('disconnect', () => { terminateAgent(control); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runLocalChild();
