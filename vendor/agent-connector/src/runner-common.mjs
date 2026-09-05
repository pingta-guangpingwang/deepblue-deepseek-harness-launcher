import { spawn } from 'node:child_process';

const DEFAULT_DIAGNOSTIC_BYTES = 64 * 1024;

export function validateInstruction(value) {
  const instruction = String(value || '').trim();
  if (!instruction || instruction.length > 16000 || instruction.includes('\0')) {
    throw new Error('任务内容不能为空且合成后的安全提示最多 16000 个字符');
  }
  return instruction;
}

export function childEnvironmentWithoutSecret(interactionKeyEnv, additions = {}) {
  const environment = { ...process.env, ...additions };
  if (interactionKeyEnv) delete environment[interactionKeyEnv];
  delete environment.SHENLAN_AGENT_INTERACTION_KEY;
  return environment;
}

export function spawnRuntime(executable, argumentsList, options) {
  return spawn(executable, argumentsList, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? -1, signal: signal || '' }));
  });
}

export async function readBoundedProcessText(stream, maximumBytes = DEFAULT_DIAGNOSTIC_BYTES) {
  let body = '';
  const maximum = Math.max(1024, Number(maximumBytes) || DEFAULT_DIAGNOSTIC_BYTES);
  for await (const chunk of stream) {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body, 'utf8') > maximum) {
      body = Buffer.from(body, 'utf8').subarray(-maximum).toString('utf8');
      const firstNewline = body.indexOf('\n');
      if (firstNewline >= 0) body = body.slice(firstNewline + 1);
    }
  }
  return body;
}

export function terminateRuntime(control, graceMs = 1500) {
  if (!control || control.closed || control.cancelled) return false;
  control.cancelled = true;
  if (typeof control.cancel === 'function') {
    Promise.resolve(control.cancel()).catch(() => {});
    return true;
  }
  if (!control.child) return false;
  if (process.platform === 'win32' && Number.isInteger(control.child.pid)) {
    const killer = spawn('taskkill.exe', ['/pid', String(control.child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.unref?.();
  } else control.child.kill('SIGTERM');
  control.forceTimer = setTimeout(() => {
    if (!control.closed) control.child.kill('SIGKILL');
  }, graceMs);
  control.forceTimer.unref?.();
  return true;
}

export function attachControl(control, child) {
  control.child = child;
  control.closed = false;
  control.cancelled = false;
}

export function closeControl(control) {
  control.closed = true;
  if (control.forceTimer) clearTimeout(control.forceTimer);
}
