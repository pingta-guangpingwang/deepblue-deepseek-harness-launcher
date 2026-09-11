import { describe, expect, it } from 'vitest'
import { buildRoomMessageContent, deriveRoomProjectMode, mergeRoomDetail, normalizeRoomApproveResponse, normalizeRoomCancelResponse, normalizeRoomDeleteResponse, normalizeRoomDetail, normalizeRoomSaveResponse, normalizeRoomSendResponse, normalizeRoomSummary, reconcileMentionTokens, resolveSharedProjects, roomMessageSignature, roomRunActive, roomRunCanApprove, roomStatusLabel, sharedFolderOptions, validateRoomDraft } from './AgentSessionGroups'

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
  messages: [{ id: MESSAGE_ID, roomId: ROOM_ID, seq: 2, authorType: 'user', messageType: 'user', body: '@总控 检查发布', segments: [{ type: 'mention', memberId: MEMBER_ID }, { type: 'text', text: ' 检查发布' }], mentions: [{ memberId: MEMBER_ID, displayName: '主控', mentionHandle: '总控' }], contentAvailable: true }],
  runs: [pendingRun()],
  actions: [{ id: '7'.repeat(32), runId: RUN_ID, memberId: MEMBER_ID, memberName: '主控', ordinal: 1, actionType: 'dispatch', status: 'reserved', summary: '等待连接', contextThroughSeq: 2 }],
  detailRevision: DETAIL_REVISION,
  window: { maxMessages: 50, maxActions: 100, messageCount: 1, actionCount: 1, hasEarlierMessages: true, hasLaterMessages: false, hasMoreActions: true },
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
    expect(normalized.window).toMatchObject({ maxActions: 100, actionCount: 1, hasMoreActions: true })
  })

  it('requires bounded window counts to match every returned array exactly', () => {
    for (const invalid of [
      { ...detail().window, messageCount: 0 },
      { ...detail().window, actionCount: 0 },
      { ...detail().window, messageCount: 51 },
      { ...detail().window, actionCount: 101 },
      { ...detail().window, maxMessages: 51 },
      { ...detail().window, maxActions: 101 }
    ]) expect(() => normalizeRoomDetail({ ...detail(), window: invalid })).toThrow()

    const missingActionId = clone(detail())
    missingActionId.actions[0].id = ''
    expect(() => normalizeRoomDetail(missingActionId)).toThrow('任务动态编号')
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
      withRun({ routingKind: 'coordinator', targetMemberIds: [] }),
      withRun({ routingKind: 'coordinator', targetMemberIds: [MEMBER_ID, OTHER_MEMBER_ID] }),
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

    const tooManyDirectTargets = clone(detail())
    tooManyDirectTargets.room.maxSteps = 1
    tooManyDirectTargets.members.push(publicMember({ id: OTHER_MEMBER_ID }))
    tooManyDirectTargets.runs = [{ ...tooManyDirectTargets.runs[0], maxSteps: 1, targetMemberIds: [MEMBER_ID, OTHER_MEMBER_ID] }]
    expect(() => normalizeRoomDetail(tooManyDirectTargets)).toThrow('目标成员超过安全步数')

    expect(normalizeRoomDetail(withRun({ routingKind: 'coordinator', targetMemberIds: [MEMBER_ID] })).runs[0]?.routingKind).toBe('coordinator')

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

  it('strictly validates approve, cancel and delete mutation receipts', () => {
    const approvedAt = '2026-09-09T09:00:00+08:00'
    const approve = { contractVersion: 2, roomId: ROOM_ID, runId: RUN_ID, approvalId: APPROVAL_ID, status: 'queued', approvedAt, replayed: false }
    expect(normalizeRoomApproveResponse(approve, ROOM_ID, RUN_ID, APPROVAL_ID)).toEqual({ status: 'queued', approvedAt, replayed: false })
    expect(() => normalizeRoomApproveResponse({ ...approve, approvalId: '7'.repeat(32) }, ROOM_ID, RUN_ID, APPROVAL_ID)).toThrow('凭证与当前任务不匹配')
    expect(() => normalizeRoomApproveResponse({ ...approve, approvedAt: '' }, ROOM_ID, RUN_ID, APPROVAL_ID)).toThrow('批准时间')

    const cancel = { contractVersion: 2, roomId: ROOM_ID, runId: RUN_ID, status: 'completed', cancelRequestedAt: approvedAt, replayed: true }
    expect(normalizeRoomCancelResponse(cancel, ROOM_ID, RUN_ID)).toMatchObject({ status: 'completed', replayed: true })
    expect(() => normalizeRoomCancelResponse({ ...cancel, status: 'running' }, ROOM_ID, RUN_ID)).toThrow('取消状态')

    expect(normalizeRoomDeleteResponse({ contractVersion: 2, roomId: ROOM_ID, status: 'deleted', replayed: false }, ROOM_ID)).toEqual({ replayed: false })
    expect(() => normalizeRoomDeleteResponse({ contractVersion: 2, roomId: ROOM_ID, status: 'active', replayed: false }, ROOM_ID)).toThrow('未确认永久清理')
  })

  it('strictly validates create and update full-detail receipts', () => {
    const valid = { ...detail(), replayed: false }
    expect(normalizeRoomSaveResponse(valid, ROOM_ID)).toMatchObject({ roomId: ROOM_ID, replayed: false, detail: { room: { id: ROOM_ID } } })
    expect(normalizeRoomSaveResponse({ ...valid, replayed: true })).toMatchObject({ roomId: ROOM_ID, replayed: true })
    expect(() => normalizeRoomSaveResponse({ ...valid, replayed: undefined }, ROOM_ID)).toThrow('保存回执合同')
    expect(() => normalizeRoomSaveResponse(valid, OTHER_ROOM_ID)).toThrow('目标房间不匹配')
    expect(() => normalizeRoomSaveResponse({ ...valid, messages: undefined }, ROOM_ID)).toThrow('列表不完整')
  })

  it('rejects wrong-room, non-integer and duplicate message cursors', () => {
    const mutateMessages = (messages: unknown[]) => ({ ...detail(), messages, window: { ...detail().window, messageCount: messages.length } })
    expect(() => normalizeRoomDetail(mutateMessages([{ ...detail().messages[0], roomId: OTHER_ROOM_ID }]))).toThrow('消息作用域')
    expect(() => normalizeRoomDetail(mutateMessages([{ ...detail().messages[0], id: 'not-hex' }]))).toThrow('消息编号')
    expect(() => normalizeRoomDetail(mutateMessages([{ ...detail().messages[0], seq: Number.MAX_SAFE_INTEGER + 1 }]))).toThrow('消息序号')
    expect(() => normalizeRoomDetail(mutateMessages([detail().messages[0], { ...detail().messages[0] }]))).toThrow('重复')
    expect(() => normalizeRoomDetail(mutateMessages([detail().messages[0], { ...detail().messages[0], id: '8'.repeat(32) }]))).toThrow('重复')
  })

  it('keeps terminal history readable after a room definition changes but never re-approves it', () => {
    const currentMessageId = '8'.repeat(32)
    const currentRunId = '9'.repeat(32)
    const currentApprovalId = 'a'.repeat(32)
    const currentRoom = room({ coordinatorMemberId: OTHER_MEMBER_ID, maxSteps: 8, definitionRevision: 4, stateRevision: 9, latestRunStatus: 'awaiting_approval', activeRunId: currentRunId })
    const historicalRun = { ...pendingRun(), status: 'completed', requiresApproval: false, approvalId: null, approvedAt: '2026-09-09T08:00:00+08:00', completedAt: '2026-09-09T08:10:00+08:00' }
    const currentRun = { ...pendingRun(), id: currentRunId, rootMessageId: currentMessageId, coordinatorMemberId: OTHER_MEMBER_ID, targetMemberIds: [OTHER_MEMBER_ID], definitionRevision: 4, maxSteps: 8, approvalId: currentApprovalId }
    const normalized = normalizeRoomDetail({
      ...detail(), room: currentRoom, members: [publicMember({ id: OTHER_MEMBER_ID })],
      messages: [detail().messages[0], { ...detail().messages[0], id: currentMessageId, seq: 3, body: '当前任务' }],
      runs: [currentRun, historicalRun], window: { ...detail().window, messageCount: 2 }
    })
    expect(normalized.runs.map(run => run.id)).toEqual([currentRunId, RUN_ID])
    expect(roomRunCanApprove(normalized.runs[0]!, normalized.room)).toBe(true)
    expect(roomRunCanApprove(normalized.runs[1]!, normalized.room)).toBe(false)
    expect(() => normalizeRoomDetail({ ...detail(), room: currentRoom, members: [publicMember({ id: OTHER_MEMBER_ID })], runs: [{ ...historicalRun, status: 'awaiting_approval', requiresApproval: true, approvalId: APPROVAL_ID, approvedAt: null }] })).toThrow('当前任务的成员或房间作用域已变化')
  })

  it('uses Unicode room handles and asks for another collaborator without publishing a fixed cap', () => {
    const one = { name: '发布室', coordinatorMemberId: MEMBER_ID, maxSteps: 12, defaultAccess: 'workspace_write' as const, members: [editorMember()] }
    expect(validateRoomDraft(one)).toContain('至少配置主控和一名协作成员')
    expect(validateRoomDraft({ ...one, members: [editorMember(), editorMember({ id: OTHER_MEMBER_ID, displayName: '前端复核', mentionHandle: '前端.复核', agentId: 'agent-b', projectId: 'project-b', sessionLabel: '前端复核会话' })] })).toBe('')
    expect(validateRoomDraft({ ...one, members: [editorMember(), editorMember({ id: OTHER_MEMBER_ID, displayName: '复核', mentionHandle: '主控', agentId: 'agent-b', projectId: 'project-b', sessionLabel: '复核会话' })] })).toContain('已被其他成员使用')
  })

  it('groups candidate projects into shared folders by directory fingerprint and resolves per-member projects', () => {
    const FOLDER_A = 'a'.repeat(64)
    const FOLDER_B = 'b'.repeat(64)
    const catalog = { agents: [
      { id: 'agent-a', name: 'Codex', adapter: 'codex', status: 'online', canDispatch: true, projects: [{ id: 'project-a1', agentId: 'agent-a', name: '发布室', pathKey: FOLDER_A }, { id: 'project-a2', agentId: 'agent-a', name: '资料库', pathKey: FOLDER_B }] },
      { id: 'agent-b', name: 'Claude', adapter: 'claude-code', status: 'online', canDispatch: true, projects: [{ id: 'project-b1', agentId: 'agent-b', name: '发布室副本', pathKey: FOLDER_A }, { id: 'project-b2', agentId: 'agent-b', name: '无指纹项目' }] }
    ], truncated: { agents: false, projects: false }, limits: { candidateAgents: 12, projects: 600, maxMembers: 6 } }
    const folders = sharedFolderOptions(catalog)
    expect(folders.map(folder => folder.pathKey)).toEqual([FOLDER_A, FOLDER_B])
    expect(folders[0]).toMatchObject({ name: '发布室', agentIds: ['agent-a', 'agent-b'] })
    const members = [editorMember(), editorMember({ id: OTHER_MEMBER_ID, agentId: 'agent-b' })]
    const resolved = resolveSharedProjects(catalog, FOLDER_A, members)
    expect(resolved.get(MEMBER_ID)?.id).toBe('project-a1')
    expect(resolved.get(OTHER_MEMBER_ID)?.id).toBe('project-b1')
    expect(resolveSharedProjects(catalog, FOLDER_B, members).has(OTHER_MEMBER_ID)).toBe(false)
  })

  it('validates shared-folder mode through the catalog and keeps separate mode unchanged', () => {
    const FOLDER_A = 'a'.repeat(64)
    const catalog = { agents: [{ id: 'agent-a', name: 'Codex', adapter: 'codex', status: 'online', canDispatch: true, projects: [{ id: 'project-a1', agentId: 'agent-a', name: '发布室', pathKey: FOLDER_A }] }, { id: 'agent-b', name: 'Claude', adapter: 'claude-code', status: 'online', canDispatch: true, projects: [{ id: 'project-b1', agentId: 'agent-b', name: '发布室', pathKey: FOLDER_A }] }], truncated: { agents: false, projects: false }, limits: { candidateAgents: 12, projects: 600, maxMembers: 6 } }
    const member = (overrides: Record<string, unknown> = {}) => editorMember({ id: OTHER_MEMBER_ID, displayName: '前端复核', mentionHandle: '复核', agentId: 'agent-b', projectId: '', ...overrides })
    const base = { name: '发布室', coordinatorMemberId: MEMBER_ID, maxSteps: 12, defaultAccess: 'workspace_write' as const, projectMode: 'shared' as const, sharedPathKey: FOLDER_A, members: [editorMember({ projectId: '' }), member()] }
    expect(validateRoomDraft(base, catalog)).toBe('')
    expect(validateRoomDraft({ ...base, sharedPathKey: '' }, catalog)).toContain('选择共用项目文件夹')
    expect(validateRoomDraft(base)).toContain('候选目录尚未同步')
    expect(validateRoomDraft({ ...base, members: [editorMember({ projectId: '' }), member({ agentId: 'agent-c' })] }, catalog)).toContain('共用文件夹下还没有授权项目')
    expect(validateRoomDraft({ ...base, members: [editorMember({ projectId: '' }), member()], projectMode: 'separate' })).toContain('选择授权项目')
  })

  it('derives editor project mode from uniform member directory fingerprints', () => {
    const FOLDER_A = 'a'.repeat(64)
    const withKey = (key?: string): { projectPathKey?: string } => ({ projectPathKey: key })
    expect(deriveRoomProjectMode([withKey(FOLDER_A), withKey(FOLDER_A)])).toEqual({ projectMode: 'shared', sharedPathKey: FOLDER_A })
    expect(deriveRoomProjectMode([withKey(), withKey(FOLDER_A)])).toEqual({ projectMode: 'separate', sharedPathKey: '' })
    expect(deriveRoomProjectMode([withKey(FOLDER_A), withKey('b'.repeat(64))]).projectMode).toBe('separate')
  })

  it('reads directory fingerprints only as strict hex64 in members and candidates', () => {
    const FOLDER_A = 'a'.repeat(64)
    const normalized = normalizeRoomDetail(detail({ members: [publicMember({ projectPathKey: FOLDER_A })] }))
    expect(normalized.members[0]!.projectPathKey).toBe(FOLDER_A)
    const malformed = normalizeRoomDetail(detail({ members: [publicMember({ projectPathKey: 'not-hex' })] }))
    expect(malformed.members[0]!.projectPathKey).toBeUndefined()
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

  it('merges only message pages while replacing bounded run and action windows', () => {
    const base = normalizeRoomDetail(detail())
    const replacementAction = { ...detail().actions[0], id: '8'.repeat(32), summary: '新的权威动作窗口' }
    const delta = normalizeRoomDetail({ ...detail(), messages: [{ id: '9'.repeat(32), roomId: ROOM_ID, seq: 3, authorType: 'system', messageType: 'system', body: '第二条', segments: [{ type: 'text', text: '第二条' }], mentions: [], contentAvailable: true }], runs: [], actions: [replacementAction], detailRevision: '2'.repeat(64), window: { ...detail().window, messageCount: 1, actionCount: 1, hasEarlierMessages: false, hasLaterMessages: true } })
    const afterMerge = mergeRoomDetail(base, delta)
    expect(afterMerge.messages.map(message => message.seq)).toEqual([2, 3])
    expect(afterMerge.runs).toEqual([])
    expect(afterMerge.actions.map(action => action.id)).toEqual([replacementAction.id])
    expect(afterMerge.window).toMatchObject({ hasEarlierMessages: true, hasLaterMessages: true })
    expect(mergeRoomDetail(afterMerge, { ...delta, window: { ...delta.window!, hasEarlierMessages: false, hasLaterMessages: false } }, false).window?.hasEarlierMessages).toBe(false)
    const other = normalizeRoomDetail({ ...detail(), room: room({ id: OTHER_ROOM_ID, coordinatorMemberId: OTHER_MEMBER_ID }), members: [publicMember({ id: OTHER_MEMBER_ID })], runs: [], messages: [], actions: [], detailRevision: '3'.repeat(64), window: { ...detail().window, messageCount: 0, actionCount: 0 } })
    expect(mergeRoomDetail(afterMerge, other)).toBe(afterMerge)
    expect(roomRunActive('unknown')).toBe(true)
    expect(roomStatusLabel('reserved')).toBe('等待连接')
  })

  it('orders same-second runs by public root-message sequence', () => {
    const firstMessage = { id: MESSAGE_ID, roomId: ROOM_ID, seq: 1, authorType: 'user', messageType: 'user', body: '先发', segments: [{ type: 'text', text: '先发' }], mentions: [], contentAvailable: true }
    const secondMessage = { ...firstMessage, id: '8'.repeat(32), seq: 2, body: '后发', segments: [{ type: 'text', text: '后发' }] }
    const approvedRun = (id: string, rootMessageId: string) => ({ ...pendingRun(), id, rootMessageId, status: 'queued', requiresApproval: false, approvalId: null, approvedAt: '2026-09-09T10:00:00+08:00', createdAt: '2026-09-09T10:00:00+08:00' })
    const normalized = normalizeRoomDetail({ ...detail(), messages: [firstMessage, secondMessage], runs: [approvedRun(RUN_ID, MESSAGE_ID), approvedRun('7'.repeat(32), secondMessage.id)], window: { ...detail().window, messageCount: 2 } })
    expect(normalized.runs.map(item => item.rootMessageId)).toEqual([secondMessage.id, MESSAGE_ID])
  })
})
