export interface ConversationTarget {
  kind: 'local-room' | 'local-session' | 'cloud-session' | 'legacy-room'
  roomId?: string
  agentId?: string
  projectId?: string
  sessionId?: string
  conversationId?: string
  title: string
}
const identifier = /^[A-Za-z0-9._:-]{1,191}$/
export function normalizeConversationTarget(value: unknown): ConversationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话窗口参数无效')
  const input = value as Record<string, unknown>
  if (!['local-room', 'local-session', 'cloud-session', 'legacy-room'].includes(String(input.kind))) throw new Error('会话类型无效')
  const result: ConversationTarget = { kind: input.kind as ConversationTarget['kind'], title: typeof input.title === 'string' ? input.title.replace(/[\x00-\x1f]/g, '').slice(0, 120) || '独立对话' : '独立对话' }
  for (const key of ['roomId','agentId','projectId','sessionId','conversationId'] as const) if (input[key] !== undefined && input[key] !== '') {
    if (typeof input[key] !== 'string' || !identifier.test(input[key])) throw new Error('会话标识无效')
    result[key] = input[key]
  }
  if (result.kind.endsWith('room') && !result.roomId || result.kind === 'local-session' && !result.projectId || result.kind === 'cloud-session' && (!result.agentId || !result.projectId)) throw new Error('请先选择要打开的会话')
  return result
}
export function conversationKey(target: ConversationTarget, owner = ''): string { return JSON.stringify([owner,target.kind,target.roomId,target.agentId,target.projectId,target.sessionId,target.conversationId]) }
