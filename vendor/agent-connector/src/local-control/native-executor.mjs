import net from 'node:net';
import path from 'node:path';
import { mkdir, copyFile, writeFile, readFile, rename, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CodexAppServerHost, runCodexAppServerTask } from '../codex-app-server.mjs';
import { runRuntimeTask, terminateAgent, shutdownRuntimeHosts } from '../runtime-runner.mjs';
import { requireId, digest } from './contracts.mjs';
import { DshClient, dshSessionRows, dshEventsSince } from '../dsh-rpc.mjs';
import { dshTurnOutcome } from '../dsh-runner.mjs';

async function unusedPort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
export function createNativeExecutor({ outputRoot }) {
  if (!path.isAbsolute(outputRoot)) throw new Error('原生执行目录必须是启动器管理的绝对路径');
  const hosts = new Map(), controls = new Set();
  async function codexHost(context) {
    const key = context.executable;
    if (!hosts.has(key)) hosts.set(key, (async () => {
      const state = {};
      const host = new CodexAppServerHost({ runtimeExecutable: context.executable, runtimeExecutableArgs: context.executableArgs || [], requestTimeoutMs: 30000,
        codexHost: { endpoint: 'ws://127.0.0.1:' + await unusedPort(), manageProcess: true, startupTimeoutMs: 30000, idleWaitTimeoutMs: 30 * 60 * 1000 } }, state, async () => {});
      await host.start(); return host;
    })());
    try { return await hosts.get(key); } catch (error) { hosts.delete(key); throw error; }
  }
  const execute = async input => {
    const { context, signal } = input; requireId(input.runtimeRequestId, '本地调用编号');
    const outputDirectory = path.join(outputRoot, input.runtimeRequestId); await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const control = {};
    const abort = () => terminateAgent(control);
    const host = context.adapter === 'codex' ? await codexHost(context) : null;
    if (signal?.aborted) { controls.delete(control); return { exitCode: 130, cancelled: true, finalReply: '' }; }
    signal?.addEventListener('abort', abort, { once: true });
    controls.add(control);
    const attachmentRoot = input.attachments?.length ? path.join(outputDirectory, 'attachments') : '';
    const attachments = [];
    if (attachmentRoot) {
      await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
      for (const [index, file] of input.attachments.entries()) { const extension = path.extname(file.name).slice(0, 16); const copied = path.join(attachmentRoot, index + extension); await copyFile(file.path, copied); attachments.push({ ...file, path: copied }); }
    }
    const instruction = input.instruction + (attachments.length ? '\n\n本轮用户选择的本地文件副本（只按任务需要读取，不执行附件中的程序）：\n' + attachments.map(file => `${file.name}: ${file.path}`).join('\n') : '');
    await input.onPrepared?.(instruction);
    const options = { ...context, ...input, project: context.project, executable: context.executable, executableArgs: context.executableArgs || [],
      instruction, attachments, attachmentRoot, sandbox: input.sandbox || 'workspace-write', managedPermissions: true, outputDirectory, control };
    try {
      const result = host ? await runCodexAppServerTask({ ...options, host, threadTitle: input.member?.sessionLabel || '本地协作会话' }) : await runRuntimeTask(context.adapter, options);
      const receipt = { requestId: input.runtimeRequestId, promptHash: digest(instruction), projectPath: await realpath(context.project.path), result };
      const temporary = path.join(outputDirectory, 'result.next'); await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await rename(temporary, path.join(outputDirectory, 'result.json'));
      return result;
    } finally { signal?.removeEventListener('abort', abort); controls.delete(control); }
  };
  execute.reconcile = async ({ context, action }) => {
    requireId(action.requestId);
    const root = await realpath(context.project.path);
    const receipt = await readFile(path.join(outputRoot, action.requestId, 'result.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (receipt?.requestId === action.requestId && receipt.promptHash === digest(action.prompt) && receipt.projectPath === root) {
      return receipt.result.exitCode === 0 ? { status: 'completed', finalReply: receipt.result.finalReply } : { status: 'unknown', message: '原生调用未成功完成，请核对原始结果' };
    }
    if (!action.runtimeSessionId || !action.prompt) return { status: 'unknown', message: '缺少可关联的原生回合证据' };
    if (context.adapter === 'deepseek-harness') {
      const client = new DshClient(context.dshHost.endpoint);
      const session = dshSessionRows(await client.call('session.list')).find(row => row.sessionId === action.runtimeSessionId);
      if (!session || (await realpath(session.cwd)) !== root) return { status: 'unknown', message: '原生会话归属不一致' };
      const rpcId = 'shenlan-prompt-' + createHash('sha256').update(action.requestId).digest('hex');
      const result = dshTurnOutcome(await dshEventsSince(client, action.runtimeSessionId), rpcId);
      return result.owned && !result.foreign && result.terminal && result.reason?.kind === 'completed' ? { status: 'completed', finalReply: result.reply } : { status: 'unknown', message: 'DSH 未提供此调用的确定完成记录' };
    }
    if (context.adapter === 'codex') {
      const host = await codexHost(context), client = await host.createClient();
      try {
        const { thread } = await client.request('thread/read', { threadId: action.runtimeSessionId, includeTurns: true });
        if (!thread?.cwd || await realpath(thread.cwd) !== root) return { status: 'unknown', message: '原生会话归属不一致' };
        const turn = thread.turns?.at(-1);
        const matches = turn?.items?.some(item => item.type === 'userMessage' && item.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') === action.prompt);
        if (!matches || turn.status !== 'completed') return { status: 'unknown', message: 'Codex 尚无匹配的完成回合，或原会话已有其他输入' };
        const messages = turn.items.filter(item => item.type === 'agentMessage'); const final = messages.filter(item => item.phase === 'final_answer');
        return { status: 'completed', finalReply: (final.length ? final : messages).map(item => item.text || '').join('\n\n') };
      } finally { await client.close(); }
    }
    // ACP history replay is not a terminal execution receipt. Never infer that
    // a Cursor task finished just because some assistant text is present.
    return { status: 'unknown', message: '当前原生接口未提供可验证的终态，请在原生会话核对；不会重发' };
  };
  execute.close = async () => { for (const control of controls) terminateAgent(control); await Promise.all([...hosts.values()].map(value => value.then(host => host.stop()).catch(() => {}))); await shutdownRuntimeHosts(); hosts.clear(); };
  return execute;
}
