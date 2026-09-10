import { createHash, randomUUID } from 'node:crypto';

export const LOCAL_CONTROL_VERSION = 1;
export const ROOM_CONTRACT_VERSION = 3;
export const PERMISSION_MODES = Object.freeze(['ask', 'assist', 'full']);
export const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'awaiting_approval', 'cancel_requested', 'unknown']);
export const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);
export const newId = () => randomUUID().replaceAll('-', '');
export function requireId(value, label = '编号') {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error(`${label}无效`);
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('不能保存非有限数值');
  return JSON.stringify(value ?? null);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function text(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label}无效`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maximum) throw new Error(`${label}超出允许长度`);
  return result;
}
export function permissionMode(value = 'assist') {
  if (!PERMISSION_MODES.includes(value)) throw new Error('审批模式必须是请求批准、帮我批准或完全批准');
  return value;
}
export function normalizeRoom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('房间定义无效');
  if (input.contractVersion !== undefined && input.contractVersion !== ROOM_CONTRACT_VERSION) throw new Error('旧云端房间不能由本地引擎直接接管');
  if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 8) throw new Error('本地房间需要 1—8 位成员');
  const ids = new Set(), handles = new Set();
  const members = input.members.map(member => {
    const id = member.id || newId(); requireId(id, '成员编号');
    const mentionHandle = text(member.mentionHandle, '@称呼', 32).normalize('NFKC');
    if (!/^[\p{L}\p{N}_-]+$/u.test(mentionHandle)) throw new Error('@称呼只能包含文字、数字、下划线或横线');
    const handleKey = mentionHandle.toLocaleLowerCase('en-US');
    if (ids.has(id) || handles.has(handleKey)) throw new Error('成员编号和 @称呼不能重复');
    ids.add(id); handles.add(handleKey);
    return { id, displayName: text(member.displayName, '成员名称', 80), mentionHandle,
      agentId: text(member.agentId, '智能体编号', 191), projectId: text(member.projectId, '项目编号', 191),
      responsibility: text(member.responsibility || '', '成员职责', 4000, true),
      sessionLabel: text(member.sessionLabel || member.displayName + '工作会话', '会话名称', 180),
      runtimeSessionId: '', sessionState: 'pending' };
  });
  const coordinatorMemberId = input.coordinatorMemberId || members[0].id;
  if (!ids.has(coordinatorMemberId)) throw new Error('主控必须是当前房间成员');
  const maxSteps = input.maxSteps ?? 16;
  if (input.workspaceMode !== undefined && !['shared', 'worktree'].includes(input.workspaceMode)) throw new Error('项目模式无效');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 64) throw new Error('每轮安全步数需要在 1—64 之间');
  return { contractVersion: ROOM_CONTRACT_VERSION, id: input.id ? requireId(input.id, '房间编号') : newId(),
    name: text(input.name, '房间名称', 100), coordinatorMemberId, members,
    permissionMode: permissionMode(input.permissionMode), permissionRevision: 1, maxSteps,
    workspaceMode: input.workspaceMode || 'shared', revision: 1, status: 'active', executionLocation: 'local', cloudSync: false, cloudOwnerId: null };
}
export function normalizeMessage(input, room) {
  const body = text(input.body, '消息', 1024 * 1024);
  const mentions = input.targetMemberIds ?? [];
  if (!Array.isArray(mentions) || mentions.length > 8 || new Set(mentions).size !== mentions.length || mentions.some(id => !room.members.some(member => member.id === id))) throw new Error('点名成员不属于本房间');
  // Plain @ text is display-only. Only explicit member IDs route work.
  return { body, targetMemberIds: [...mentions], fileIds: (input.fileIds || []).map(id => requireId(id, '附件编号')) };
}
export function parseDirective(reply, room) {
  let result; try { result = JSON.parse(reply.trim()); } catch { throw new Error('主控没有返回合法的协调指令'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('主控协调指令无效');
  // Structured output uses a fixed object with null inactive fields. Keep the
  // legacy two variants strict, and never recover JSON using substring guesses.
  if (result.type === 'delegate' && result.message === null) delete result.message;
  if (result.type === 'finish' && result.memberId === null && result.instruction === null) { delete result.memberId; delete result.instruction; }
  if (result.type === 'delegate' && Object.keys(result).every(key => ['type', 'memberId', 'instruction'].includes(key))) {
    if (result.memberId === room.coordinatorMemberId || !room.members.some(member => member.id === result.memberId)) throw new Error('主控不能向自己或房间外的成员派发');
    return { type: 'delegate', memberId: result.memberId, instruction: text(result.instruction, '分派任务', 128 * 1024) };
  }
  if (result.type === 'finish' && Object.keys(result).every(key => ['type', 'message'].includes(key))) return { type: 'finish', message: text(result.message, '最终结果', 1024 * 1024) };
  throw new Error('主控指令只能是 delegate 或 finish');
}
export function coordinatorOutputSchema(room) {
  const members = room.members.filter(member => member.id !== room.coordinatorMemberId).map(member => member.id);
  return { type: 'object', additionalProperties: false, required: ['type', 'memberId', 'instruction', 'message'], properties: {
    type: { type: 'string', enum: members.length ? ['delegate', 'finish'] : ['finish'] },
    memberId: members.length ? { type: ['string', 'null'], enum: [...members, null] } : { type: 'null' },
    instruction: { type: ['string', 'null'] }, message: { type: ['string', 'null'] }
  } };
}
