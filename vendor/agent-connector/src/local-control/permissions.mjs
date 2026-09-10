import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { digest, newId, permissionMode } from './contracts.mjs';

const comparison = value => process.platform === 'win32' ? value.toLowerCase() : value;
export async function canonicalInside(candidate, allowedRoot) {
  if (!path.isAbsolute(candidate || '') || !path.isAbsolute(allowedRoot || '')) return false;
  const root = await realpath(allowedRoot).catch(() => ''); if (!root) return false;
  let current = path.resolve(candidate);
  for (;;) {
    const actual = await realpath(current).catch(() => '');
    if (actual) { const relative = path.relative(comparison(root), comparison(actual)); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
    const parent = path.dirname(current); if (parent === current) return false; current = parent;
  }
}
export function protectedPath(file) {
  const parts = String(file).replaceAll('\\', '/').toLowerCase().split('/');
  return parts.some(part => ['.ssh', '.aws', '.azure', '.gnupg', '.codex', 'credentials', 'cookies', 'login data'].includes(part)) || parts.some(part => /^\.env(?:$|\.)/.test(part) && !['.env.example', '.env.sample', '.env.template'].includes(part));
}
export async function checkProposalScope(proposal, projectRoot, sandbox = 'workspace-write') {
  if (!proposal || typeof proposal !== 'object' || !['read', 'search', 'edit', 'execute', 'network', 'delete', 'move', 'other'].includes(proposal.kind)) return { allowed: false, reason: '原生操作类型未识别' };
  const paths = proposal.paths ?? [];
  if (!Array.isArray(paths) || paths.length > 100 || paths.some(file => typeof file !== 'string' || file.includes('\0') || protectedPath(file))) return { allowed: false, reason: '操作涉及受保护的凭据或权限配置' };
  if (['read', 'search', 'edit', 'delete', 'move'].includes(proposal.kind) && !paths.length) return { allowed: false, reason: '原生操作没有提供可验证的文件范围' };
  if (!(await Promise.all(paths.map(file => canonicalInside(file, projectRoot)))).every(Boolean)) return { allowed: false, reason: '操作超出当前成员的授权项目' };
  if (sandbox === 'read-only' && !['read', 'search'].includes(proposal.kind)) return { allowed: false, reason: '审核会话只能只读，不能执行写入或外部操作' };
  if (proposal.kind === 'execute') {
    if (typeof proposal.command !== 'string' || !proposal.command.trim() || proposal.command.length > 16000) return { allowed: false, reason: '原生命令不完整，不能代审' };
    if (/(?:\b(?:diskpart|format\s+[a-z]:|shutdown|bcdedit)\b|(?:\.ssh|\.aws|\.gnupg|login data|cookies)\b|(?:disable|set-mpPreference).*?(?:defender|realtime)|(?:rm\s+-[^\n]*r[^\n]*\s+\/\s*$))/i.test(proposal.command)) return { allowed: false, reason: '命令涉及系统破坏、凭据读取或安全设置修改' };
  }
  if (proposal.kind === 'network') {
    try { const url = new URL(proposal.destination); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return { allowed: false, reason: '网络目标无效或包含凭据' }; }
    catch { return { allowed: false, reason: '网络操作没有提供明确目标' }; }
  }
  if (proposal.kind === 'other') return { allowed: false, reason: '未识别操作不能自动批准，请使用原生界面核对' };
  return { allowed: true, routine: ['read', 'search', 'edit'].includes(proposal.kind), reason: '位于当前成员的已授权项目内' };
}

export class PermissionBroker {
  constructor({ store, getRoom, review, onChange = () => {}, timeoutMs = 5 * 60 * 1000 }) { Object.assign(this, { store, getRoom, review, onChange, timeoutMs }); this.pending = new Map(); }
  async request({ roomId, runId, memberId, projectRoot, proposal, sandbox = 'workspace-write', signal }) {
    const room = this.getRoom(roomId); if (!room || signal?.aborted) return { approved: false, reason: '当前任务已停止' };
    const expectedRoot = room.members?.find(member => member.id === memberId)?.projectPath;
    if (expectedRoot && comparison(await realpath(projectRoot).catch(() => '')) !== comparison(expectedRoot)) return { approved: false, reason: '授权项目路径已变化，不能沿用旧批准' };
    const mode = permissionMode(room.permissionMode), scope = await checkProposalScope(proposal, projectRoot, sandbox);
    const envelope = { roomId, runId, memberId, projectRoot, permissionRevision: room.permissionRevision, proposal };
    const requestHash = digest(envelope);
    const existing = this.store.list('approval', roomId).find(row => row.requestHash === requestHash && row.status !== 'pending');
    if (existing) return { approved: false, reason: '此原生审批请求已处理，不会再次使用批准结果' };
    const approval = { id: newId(), ...envelope, requestHash, mode, status: 'pending', stage: mode === 'assist' ? 'reviewing' : 'awaiting_user', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() };
    this.store.put('approval', approval); this.store.append(roomId, 'approval.requested', approval); this.onChange();
    if (!scope.allowed) return this.finish(approval, false, scope.reason, 'policy');
    if (scope.routine || mode === 'full') return this.finish(approval, true, scope.reason, mode === 'full' ? 'full-within-scope' : 'existing-project-grant');
    if (mode === 'assist') {
      try {
        const reviewed = await this.review({ room, approval, sandbox: 'read-only', signal });
        if (reviewed?.decision === 'approve') return this.finish(approval, true, reviewed.reason || '主控审核通过', 'coordinator-review');
        if (reviewed?.decision === 'deny') return this.finish(approval, false, reviewed.reason || '主控审核拒绝', 'coordinator-review');
        approval.reason = reviewed?.reason || '主控需要用户补充授权';
      } catch { approval.reason = '主控审核未完成，没有自动批准；请在本机核对'; }
    } else approval.reason = '当前为请求批准模式，请由用户确认';
    if (signal?.aborted || this.getRoom(roomId)?.permissionRevision !== approval.permissionRevision) return this.finish(approval, false, '任务或权限已变化', 'policy');
    approval.stage = 'awaiting_user'; this.store.put('approval', approval); this.store.append(roomId, 'approval.awaiting_user', { id: approval.id, reason: approval.reason }); this.onChange();
    return new Promise(resolve => {
      const abort = () => this.decide(approval.id, false, '任务已取消，审批作废', approval.requestHash).catch(() => {});
      const timer = setTimeout(() => this.decide(approval.id, false, '审批超时，没有执行此操作', approval.requestHash).catch(() => {}), this.timeoutMs);
      timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(approval.id, { resolve, timer, signal, abort, approval });
      if (signal?.aborted) abort();
    });
  }
  async finish(approval, approved, reason, reviewer) {
    if (approved) {
      const current = this.getRoom(approval.roomId), scope = await checkProposalScope(approval.proposal, approval.projectRoot);
      const expectedRoot = current?.members?.find(member => member.id === approval.memberId)?.projectPath;
      if (!current || current.permissionRevision !== approval.permissionRevision || !scope.allowed || expectedRoot && comparison(await realpath(approval.projectRoot).catch(() => '')) !== comparison(expectedRoot)) { approved = false; reason = '权限或文件范围已经变化，旧批准不再有效'; }
    }
    const saved = this.store.get('approval', approval.id);
    if (saved && saved.status !== 'pending') return { approved: false, reason: '审批已消费或失效' };
    const decision = { ...approval, status: approved ? 'approved' : 'denied', reason: String(reason).slice(0, 4000), reviewer, decidedAt: new Date().toISOString() };
    this.store.transaction(() => { this.store.put('approval', decision); this.store.append(approval.roomId, 'approval.decided', decision); }); this.onChange();
    return { approved, reason: decision.reason, approvalId: approval.id, requestHash: approval.requestHash };
  }
  async decide(id, approved, reason, expectedHash) {
    const pending = this.pending.get(id);
    if (!pending || expectedHash !== pending.approval.requestHash) throw new Error('审批已失效或请求内容不匹配');
    this.pending.delete(id); clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort);
    const result = await this.finish(pending.approval, approved === true, reason || (approved ? '用户批准一次' : '用户拒绝'), 'user'); pending.resolve(result); return result;
  }
  async close() { await Promise.all([...this.pending].map(([id, value]) => this.decide(id, false, '本地总控停止，原生审批已失效', value.approval.requestHash))); }
}
