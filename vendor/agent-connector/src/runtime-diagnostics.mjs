import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const TOKEN_PATTERNS = [
  /\bagh_live_[A-Za-z0-9_-]+\b/g,
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  /\bghp_[A-Za-z0-9]+\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi
];

export function safeRuntimeDiagnostic(value, maximumCharacters = 1200) {
  let text = String(value || '').replace(/\u0000/g, '').replace(/\r/g, '').trim();
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[凭据已隐藏]');
  text = text.replace(/((?:password|passwd|密码)\s*[:=：]\s*)[^\s,，;；]{6,}/gi, '$1[已隐藏]');
  const home = String(os.homedir() || '').trim();
  if (home) text = text.split(home).join('<用户目录>');
  return text.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, Math.max(200, Number(maximumCharacters) || 1200));
}

export function classifyRuntimeFailure(adapterCode, result = {}) {
  const diagnostic = safeRuntimeDiagnostic(result.diagnostic || '');
  const source = `${diagnostic}\n${String(result.finalReply || '')}`.toLowerCase();
  const resumed = Boolean(result.resumeSessionId);
  if (resumed && /(?:writer|thread|session|conversation).{0,80}(?:lock|locked|busy|in use|already active|already running)|(?:lock|locked|busy).{0,80}(?:thread|session|conversation)|另一个.*(?:会话|进程)|正在.*(?:使用|运行)/i.test(source)) {
    return {
      code: 'session_busy',
      retryable: true,
      userMessage: `本机 ${runtimeName(adapterCode)} 正在使用这个话题，远程任务已保留在队列中，空闲后会自动继续。`,
      diagnostic
    };
  }
  if (/(?:not logged in|login required|authentication|unauthorized|invalid.*(?:token|credential)|请.*登录|未登录)/i.test(source)) {
    return { code: 'runtime_auth_required', retryable: false, userMessage: '本机智能体登录状态已失效，请在运行 Skill 同步服务的电脑上重新登录后再试。', diagnostic };
  }
  if (/(?:rate.?limit|too many requests|quota|usage limit|限流|额度不足)/i.test(source)) {
    return { code: 'runtime_rate_limited', retryable: false, userMessage: '智能体服务当前触发了用量或频率限制，请稍后再试。', diagnostic };
  }
  if (/(?:permission denied|access denied|operation not permitted|权限不足|拒绝访问)/i.test(source)) {
    return { code: 'runtime_permission_denied', retryable: false, userMessage: '本机智能体没有完成该操作所需的项目权限。', diagnostic };
  }
  return {
    code: 'agent_exec_failed',
    retryable: false,
    userMessage: `本机智能体执行失败（退出码 ${Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : '未知'}）。`,
    diagnostic
  };
}

export function classifyRuntimeException(adapterCode, error) {
  const diagnostic = safeRuntimeDiagnostic(error && error.message || String(error || ''));
  const source = diagnostic.toLowerCase();
  const runtime = runtimeName(adapterCode);
  if (error?.taskMayHaveExecuted) {
    return {
      code: 'runtime_result_unconfirmed',
      retryable: false,
      userMessage: `${runtime} 已接收或可能已接收本次任务，但连接中断，暂时无法确认结果。为避免重复修改项目，不会自动重放；请检查原生会话后再继续。`,
      diagnostic
    };
  }
  if (adapterCode === 'codex' && /(?:thread\s+[0-9a-f-]+\s+)?already has an active writer|active writer.{0,80}(?:thread|session)|(?:thread|session).{0,80}active writer/i.test(source)) {
    return {
      code: 'native_session_open',
      retryable: true,
      userMessage: '本机 Codex 正在写入这个话题，网页任务已保留在队列中；当前写入结束并释放话题后会自动继续。',
      diagnostic
    };
  }
  if (/(?:econnreset|econnrefused|epipe|socket hang up|websocket|connection.{0,30}closed|not connected|request.{0,20}timeout|连接已关闭|尚未连接|请求超时)/i.test(source)) {
    return {
      code: 'runtime_transport_interrupted',
      retryable: true,
      userMessage: `${runtime} 本机通信刚刚中断，任务仍保留在队列中，正在自动重连重试。`,
      diagnostic
    };
  }
  if (/(?:enoent|not found|cannot find|找不到).{0,100}(?:codex|claude|qclaw|executable|程序|文件)/i.test(source)) {
    return {
      code: 'runtime_executable_missing',
      retryable: false,
      userMessage: `没有找到本机 ${runtime} 可执行程序，请重新运行对应 Skill 的安装或自检。`,
      diagnostic
    };
  }
  return {
    code: 'agent_spawn_failed',
    retryable: false,
    userMessage: `${runtime} 本地执行进程没有成功启动。`,
    diagnostic
  };
}

function runtimeName(adapterCode) {
  return ({ codex: 'Codex', 'claude-code': 'Claude Code', qclaw: 'QClaw', workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy', trae: 'TRAE' })[adapterCode] || '智能体';
}

function waitForProbe(child) {
  return new Promise((resolve) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.once('error', () => resolve('unknown'));
    child.once('close', () => resolve(stdout.trim()));
  });
}

export async function runtimeSessionAvailability(adapterCode, { resumeSessionId = '', runtimeHome = '' } = {}) {
  if (adapterCode !== 'codex' || process.platform !== 'win32' || !/^[0-9a-f-]{36}$/i.test(String(resumeSessionId || ''))) {
    return { available: true, reason: '' };
  }
  const codexHome = path.resolve(String(runtimeHome || path.join(os.homedir(), '.codex')));
  const lockPath = path.join(codexHome, 'thread-writer-locks', `${resumeSessionId}.lock`);
  const script = [
    "$p=$env:SHENLAN_CODEX_THREAD_LOCK",
    "if(-not (Test-Path -LiteralPath $p)){Write-Output 'available';exit 0}",
    "try{$s=[System.IO.File]::Open($p,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);$s.Dispose();Write-Output 'available'}catch [System.IO.IOException]{Write-Output 'busy'}catch{Write-Output 'unknown'}"
  ].join(';');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, SHENLAN_CODEX_THREAD_LOCK: lockPath }
  });
  const result = await waitForProbe(child);
  if (result === 'busy') return { available: false, reason: 'native_session_open' };
  return { available: true, reason: result === 'unknown' ? 'probe_unavailable' : '' };
}
