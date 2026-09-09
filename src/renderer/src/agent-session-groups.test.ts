import { describe, expect, it } from 'vitest'
import { buildRoomMessageContent, mergeRoomDetail, normalizeRoomDetail, normalizeRoomSendResponse, normalizeRoomSummary, reconcileMentionTokens, roomMessageSignature, roomRunActive, roomStatusLabel, validateRoomDraft } from './AgentSessionGroups'

const ROOM_ID = '1'.repeat(32)
const OTHER_ROOM_ID = '9'.repeat(32)
const MEMBER_ID = '2'.repeat(32)
const OTHER_MEMBER_ID = '3'.repeat(32)
const MESSAGE_ID = '4'.repeat(32)
const RUN_ID = '5'.repeat(32)
const APPROVAL_ID = '6'.repeat(32)
const DETAIL_REVISION = 'f'.repeat(64)

const room = (overrides: Record<string, unknown> = {}) => ({ contractVersion: 2, id: ROOM_ID, name: '发布协作室', coordinatorMemberId: MEMBER_ID, maxSteps: 12, defaultAccess: 'workspace_write', approvalPolicy: 'bounded_run', definitionRevision: 3, stateRevision: 0, status: 'active', latestRunStatus: 'awaiting_approval', ...overrides })
const publicMember = (overrides: Record<string, unknown> = {}) => ({ id: MEMBER_ID, displayName: '主控', mentionHandle: '总控', responsibility: '推进任务', agentId: 'agent-a', agentName: 'Codex', adapterCode: 'codex', projectId: 'project-a', projectName: '主站', sessionLabel: '总控会话', nativeSessionId: null, sessionState: 'pending', runtimeStatus: 'offline', canDispatch: false, readinessSource: 'host', statusMessage: '电脑连接后继续', ...overrides })
const pendingRun = (overrides: Record<string, unknown> = {}) => ({ id: RUN_ID, roomId: ROOM_ID, rootMessageId: MESSAGE_ID, routingKind: 'direct', coordinatorMemberId: MEMBER_ID, targetMemberIds: [MEMBER_ID], definitionRevision: 3, maxSteps: 12, approvalPolicy: 'bounded_run', access: 'workspace_write', status: 'awaiting_approval', stepCount: 0, requiresApproval: true, approvalId: APPROVAL_ID, approvedAt: null, contentAvailable: true, ...overrides })
const detail = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: 2,
  room: room(),
  members: [publicMember()],
  messages: [{ id: MESSAGE_ID, seq: 2, authorType: 'user', messageType: 'user', body: '@总控 检查发布', segments: [{ type: 'mention', memberId: MEMBER_ID }, { type: 'text', text: ' 检查发布' }], mentions: [{ memberId: MEMBER_ID, displayName: '主控', mentionHandle: '总控' }], contentAvailable: true }],
  runs: [pendingRun()],
  actions: [{ id: '7'.repeat(32), runId: RUN_ID, memberId: MEMBER_ID, memberName: '主控', ordinal: 1, actionType: 'dispatch', status: 'reserved', summary: '等待连接', contextThroughSeq: 2 }],
  detailRevision: DETAIL_REVISION,
  window: { maxMessages: 50, maxActions: 100, messageCount: 51, actionCount: 101, hasEarlierMessages: true, hasLaterMessages: false, hasMoreActions: true },
  ...overrides
})
const clone = <T>(value: T): any => structuredClone(value)

const editorMember = (overrides: Record<string, unknown> = {}) => ({ id: MEMBER_ID, displayName: '主控', mentionHandle: '主控', responsibility: '拆解、委派并汇总', agentId: 'agent-a', projectId: 'project-a', sessionLabel: '主控工作会话', ...overrides })

describe('multi-agent room contracts', () => {
  it('normalizes exact v2 scope, pagination, mentions and lazy sessions', () => {
    const normalized = normalizeRoomDetail(detail())
    expect(normalized.room).toMatchObject({ contractVersion: 2, id: ROOM_ID, maxSteps: 12, defaultAccess: 'workspace_write', approvalPolicy: 'bounded_run', definitionRevision: 3, stateRevision: 0, status: 'active' })
    expect(normalized.members[0]).toMatchObject({ id: MEMBER_ID, mentionHandle: '总控', sessionState: 'pending', readinessSource: 'host', statusMessage: '电脑连接后继续' })
    expect(normalized.messages[0]).toMatchObject({ id: MESSAGE_ID, mentions: [{ memberId: MEMBER_ID, displayName: '主控', mentionHandle: '总控' }] })
    expect(normalized.runs[0]).toMatchObject({ id: RUN_ID, roomId: ROOM_ID, rootMessageId: MESSAGE_ID, routingKind: 'direct', approvalPolicy: 'bounded_run', requiresApproval: true, approvalId: APPROVAL_ID })
    expect(normalized.actions[0]).toMatchObject({ memberName: '主控', status: 'reserved', contextThroughSeq: 2 })
    expect(normalized.window).toMatchObject({ maxActions: 100, actionCount: 101, hasMoreActions: true })
  })

  it('rejects malformed contract, room policy and bounded scope instead of coercing it', () => {
    const cases = [
      (() => { const value = clone(detail()); value.contractVersion = 1; return value })(),
      (() => { const value = clone(detail()); value.room.contractVersion = 1; return value })(),
      (() => { const value = clone(detail()); value.room.defaultAccess = 'read_only'; return value })(),
      (() => { const value = clone(detail()); value.room.approvalPolicy = 'per_action'; return value })(),
      (() => { const value = clone(detail()); value.room.maxSteps = 13; return value })(),
      (() => { const value = clone(detail()); value.room.maxSteps = 11.5; return value })(),
      (() => { const value = clone(detail()); value.room.stateRevision = '0'; return value })(),
      (() => { const value = clone(detail()); value.room.status = 'deleted'; return value })()
    ]
    for (const value of cases) expect(() => normalizeRoomDetail(value)).toThrow()
    expect(() => normalizeRoomSummary({ ...room(), maxSteps: 99 })).toThrow('安全步数')
  })

  it('rejects malformed run scope and inconsistent whole-run approval proof', () => {
    const withRun = (changes: Record<string, unknown>) => { const value = clone(detail()); value.runs = [{ ...value.runs[0], ...changes }]; return value }
    const invalid = [
      withRun({ roomId: OTHER_ROOM_ID }),
      withRun({ routingKind: 'broadcast' }),
      withRun({ coordinatorMemberId: OTHER_MEMBER_ID }),
      withRun({ targetMemberIds: [OTHER_MEMBER_ID] }),
      withRun({ definitionRevision: 2 }),
      withRun({ maxSteps: 11 }),
      withRun({ approvalPolicy: 'per_action' }),
      withRun({ access: 'read_only' }),
      withRun({ status: 'queued', requiresApproval: true }),
      withRun({ approvalId: null }),
      withRun({ status: 'awaiting_approval', requiresApproval: false }),
      withRun({ status: 'running', requiresApproval: false, approvalId: null, approvedAt: null })
    ]
    for (const value of invalid) expect(() => normalizeRoomDetail(value)).toThrow()

    const approvedWithoutRetainedId = withRun({ status: 'running', requiresApproval: false, approvalId: null, approvedAt: '2026-09-09T09:00:00+08:00' })
    expect(normalizeRoomDetail(approvedWithoutRetainedId).runs[0]).toMatchObject({ status: 'running', approvalId: undefined, approvedAt: '2026-09-09T09:00:00+08:00' })
  })

  it('accepts only exact v2 awaiting-approval send receipts with 32hex IDs', () => {
    const valid = { contractVersion: 2, status: 'awaiting_approval', requiresApproval: true, messageId: MESSAGE_ID, runId: RUN_ID, approvalId: APPROVAL_ID, replayed: false }
    expect(normalizeRoomSendResponse(valid)).toEqual({ messageId: MESSAGE_ID, runId: RUN_ID, approvalId: APPROVAL_ID, replayed: false })
    for (const invalid of [
      { ...valid, contractVersion: undefined },
      { ...valid, contractVersion: '2' },
      { ...valid, contractVersion: 1 },
      { ...valid, status: 'queued' },
      { ...valid, status: 'running' },
      { ...valid, requiresApproval: false },
      { ...valid, messageId: 'not-hex' },
      { ...valid, runId: 'A'.repeat(32) },
      { ...valid, approvalId: null },
      { ...valid, replayed: 0 }
    ]) expect(() => normalizeRoomSendResponse(invalid)).toThrow()
  })

  it('uses Unicode room handles and asks for another collaborator without publishing a fixed cap', () => {
    const one = { name: '发布室', coordinatorMemberId: MEMBER_ID, maxSteps: 12, defaultAccess: 'workspace_write' as const, members: [editorMember()] }
    expect(validateRoomDraft(one)).toContain('至少配置主控和一名协作成员')
    expect(validateRoomDraft({ ...one, members: [editorMember(), editorMember({ id: OTHER_MEMBER_ID, displayName: '前端复核', mentionHandle: '前端.复核', agentId: 'agent-b', projectId: 'project-b', sessionLabel: '前端复核会话' })] })).toBe('')
    expect(validateRoomDraft({ ...one, members: [editorMember(), editorMember({ id: OTHER_MEMBER_ID, displayName: '复核', mentionHandle: '主控', agentId: 'agent-b', projectId: 'project-b', sessionLabel: '复核会话' })] })).toContain('已被其他成员使用')
  })

  it('routes only suggestion-selected mentions by stable member id', () => {
    const raw = '@前端 检查界面'
    expect(buildRoomMessageContent(raw, [])).toEqual([{ type: 'text', text: raw }])
    const selected = '请 @前端 检查界面'
    const token = { memberId: OTHER_MEMBER_ID, start: 2, end: 5, label: '@前端' }
    expect(buildRoomMessageContent(selected, [token])).toEqual([{ type: 'text', text: '请 ' }, { type: 'mention', memberId: OTHER_MEMBER_ID }, { type: 'text', text: ' 检查界面' }])
    expect(roomMessageSignature({ roomId: ROOM_ID, content: buildRoomMessageContent(selected, [token]), access: 'workspace_write', expectedDefinitionRevision: 4 })).toContain(OTHER_MEMBER_ID)
  })

  it('invalidates an edited mention token and shifts untouched later mentions', () => {
    const original = '@前端 和 @复核'
    const tokens = [{ memberId: OTHER_MEMBER_ID, start: 0, end: 3, label: '@前端' }, { memberId: MEMBER_ID, start: 6, end: 9, label: '@复核' }]
    expect(reconcileMentionTokens(original, '@前台 和 @复核', tokens)).toEqual([{ memberId: MEMBER_ID, start: 6, end: 9, label: '@复核' }])
    expect(reconcileMentionTokens(original, `请 ${original}`, tokens)).toEqual([{ memberId: OTHER_MEMBER_ID, start: 2, end: 5, label: '@前端' }, { memberId: MEMBER_ID, start: 8, end: 11, label: '@复核' }])
  })

  it('merges bounded deltas, preserves history state and isolates rooms', () => {
    const base = normalizeRoomDetail({ ...detail(), runs: [] })
    const delta = normalizeRoomDetail({ ...detail(), messages: [{ id: '8'.repeat(32), seq: 3, authorType: 'system', messageType: 'system', body: '第二条', segments: [{ type: 'text', text: '第二条' }], mentions: [], contentAvailable: true }], runs: [], detailRevision: '2'.repeat(64), window: { ...detail().window, messageCount: 1, hasEarlierMessages: false, hasLaterMessages: true } })
    const afterMerge = mergeRoomDetail(base, delta)
    expect(afterMerge.messages.map(message => message.seq)).toEqual([2, 3])
    expect(afterMerge.window).toMatchObject({ hasEarlierMessages: true, hasLaterMessages: true })
    expect(mergeRoomDetail(afterMerge, { ...delta, window: { ...delta.window!, hasEarlierMessages: false, hasLaterMessages: false } }, false).window?.hasEarlierMessages).toBe(false)
    const other = normalizeRoomDetail({ ...detail(), room: room({ id: OTHER_ROOM_ID, coordinatorMemberId: OTHER_MEMBER_ID }), members: [publicMember({ id: OTHER_MEMBER_ID })], runs: [], messages: [], detailRevision: '3'.repeat(64) })
    expect(mergeRoomDetail(afterMerge, other)).toBe(afterMerge)
    expect(roomRunActive('unknown')).toBe(true)
    expect(roomStatusLabel('reserved')).toBe('等待连接')
  })

  it('orders same-second runs by public root-message sequence', () => {
    const firstMessage = { id: MESSAGE_ID, seq: 1, authorType: 'user', messageType: 'user', body: '先发', segments: [{ type: 'text', text: '先发' }], mentions: [], contentAvailable: true }
    const secondMessage = { ...firstMessage, id: '8'.repeat(32), seq: 2, body: '后发', segments: [{ type: 'text', text: '后发' }] }
    const approvedRun = (id: string, rootMessageId: string) => ({ ...pendingRun(), id, rootMessageId, status: 'queued', requiresApproval: false, approvalId: null, approvedAt: '2026-09-09T10:00:00+08:00', createdAt: '2026-09-09T10:00:00+08:00' })
    const normalized = normalizeRoomDetail({ ...detail(), messages: [firstMessage, secondMessage], runs: [approvedRun(RUN_ID, MESSAGE_ID), approvedRun('7'.repeat(32), secondMessage.id)] })
    expect(normalized.runs.map(item => item.rootMessageId)).toEqual([secondMessage.id, MESSAGE_ID])
  })
})
