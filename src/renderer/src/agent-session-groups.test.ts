import { describe, expect, it } from 'vitest'
import { buildRoomMessageContent, mergeRoomDetail, normalizeRoomDetail, normalizeRoomSummary, reconcileMentionTokens, roomMessageSignature, roomRunActive, roomStatusLabel, validateRoomDraft } from './AgentSessionGroups'

const member = (overrides: Record<string, unknown> = {}) => ({ id: 'member-a', displayName: '主控', mentionHandle: '主控', responsibility: '拆解、委派并汇总', agentId: 'agent-a', projectId: 'project-a', sessionLabel: '主控工作会话', ...overrides })

describe('multi-agent room contracts', () => {
  it('normalizes numeric revisions, stable mentions, readiness copy and lazy sessions', () => {
    const detail = normalizeRoomDetail({
      room: { id: 'room-a', name: '发布协作室', coordinator_member_id: 'member-a', max_steps: 8, default_access: 'workspace_write', definition_revision: 7, state_revision: 13, status: 'active', latest_run_status: 'running' },
      members: [{ id: 'member-a', display_name: '主控', mention_handle: '总控', responsibility: '推进任务', agent_id: 'agent-a', agent_name: 'Codex', adapter_code: 'codex', project_id: 'project-a', project_name: '主站', session_label: '总控会话', native_session_id: null, session_state: 'pending', runtime_status: 'offline', can_dispatch: false, readiness_source: 'host', status_message: '电脑连接后继续' }],
      messages: [{ id: 'message-a', seq: 2, author_type: 'user', message_type: 'user', body: '@总控 检查发布', segments: [{ type: 'mention', memberId: 'member-a' }, { type: 'text', text: ' 检查发布' }], mentions: [{ memberId: 'member-a', displayName: '主控', mentionHandle: '总控' }], content_available: true }],
      runs: [{ id: 'run-a', room_id: 'room-a', root_message_id: 'message-a', routing_kind: 'direct', coordinator_member_id: 'member-a', target_member_ids: ['member-a'], definition_revision: 7, max_steps: 8, access: 'workspace_write', status: 'awaiting_approval', step_count: 0, requires_approval: true, approval_id: 'approval-a', content_available: true }],
      actions: [{ id: 'action-a', run_id: 'run-a', member_id: 'member-a', member_name: '主控', ordinal: 1, action_type: 'dispatch', status: 'reserved', summary: '等待连接', context_through_seq: 2 }],
      detail_revision: 'f'.repeat(64),
      window: { max_messages: 50, max_actions: 100, message_count: 51, action_count: 1, has_earlier_messages: true, has_later_messages: false, has_more_actions: false }
    })

    expect(detail.room).toMatchObject({ id: 'room-a', definitionRevision: 7, stateRevision: 13, status: 'active', latestRunStatus: 'running' })
    expect(detail.members[0]).toMatchObject({ mentionHandle: '总控', sessionState: 'pending', readinessSource: 'host', statusMessage: '电脑连接后继续' })
    expect(detail.messages[0]).toMatchObject({ id: 'message-a', mentions: [{ memberId: 'member-a', displayName: '主控', mentionHandle: '总控' }] })
    expect(detail.runs[0]).toMatchObject({ rootMessageId: 'message-a', routingKind: 'direct', definitionRevision: 7, requiresApproval: true, approvalId: 'approval-a' })
    expect(detail.actions[0]).toMatchObject({ memberName: '主控', status: 'reserved', contextThroughSeq: 2 })
    expect(detail).toMatchObject({ detailRevision: 'f'.repeat(64), window: { maxMessages: 50, hasEarlierMessages: true, hasLaterMessages: false } })
  })

  it('uses Unicode room handles and asks for another collaborator without publishing a fixed cap', () => {
    const one = { name: '发布室', coordinatorMemberId: 'member-a', maxSteps: 8, defaultAccess: 'workspace_write' as const, members: [member()] }
    expect(validateRoomDraft(one)).toContain('至少配置主控和一名协作成员')
    expect(validateRoomDraft({ ...one, members: [member(), member({ id: 'member-b', displayName: '前端复核', mentionHandle: '前端.复核', agentId: 'agent-b', projectId: 'project-b', sessionLabel: '前端复核会话' })] })).toBe('')
    expect(validateRoomDraft({ ...one, members: [member(), member({ id: 'member-b', displayName: '复核', mentionHandle: '主控', agentId: 'agent-b', projectId: 'project-b', sessionLabel: '复核会话' })] })).toContain('已被其他成员使用')
  })

  it('routes only suggestion-selected mentions by stable member id', () => {
    const raw = '@前端 检查界面'
    expect(buildRoomMessageContent(raw, [])).toEqual([{ type: 'text', text: raw }])

    const selected = '请 @前端 检查界面'
    const token = { memberId: 'member-front', start: 2, end: 5, label: '@前端' }
    expect(buildRoomMessageContent(selected, [token])).toEqual([
      { type: 'text', text: '请 ' },
      { type: 'mention', memberId: 'member-front' },
      { type: 'text', text: ' 检查界面' }
    ])
    expect(roomMessageSignature({ roomId: 'room-a', content: buildRoomMessageContent(selected, [token]), access: 'workspace_write', expectedDefinitionRevision: 4 })).toContain('member-front')
  })

  it('invalidates an edited mention token and shifts untouched later mentions', () => {
    const original = '@前端 和 @复核'
    const tokens = [{ memberId: 'front', start: 0, end: 3, label: '@前端' }, { memberId: 'review', start: 6, end: 9, label: '@复核' }]
    expect(reconcileMentionTokens(original, '@前台 和 @复核', tokens)).toEqual([{ memberId: 'review', start: 6, end: 9, label: '@复核' }])
    expect(reconcileMentionTokens(original, `请 ${original}`, tokens)).toEqual([{ memberId: 'front', start: 2, end: 5, label: '@前端' }, { memberId: 'review', start: 8, end: 11, label: '@复核' }])
  })

  it('merges bounded message deltas without losing earlier public chat', () => {
    const base = normalizeRoomDetail({ room: { id: 'room-a', coordinatorMemberId: 'member-a', definitionRevision: 1, stateRevision: 1 }, members: [], messages: [{ id: 'm1', seq: 1, authorType: 'user', body: '第一条' }], runs: [], actions: [], window: { maxMessages: 50, maxActions: 100, messageCount: 51, actionCount: 0, hasEarlierMessages: true, hasLaterMessages: false, hasMoreActions: false } })
    const delta = normalizeRoomDetail({ room: { id: 'room-a', coordinatorMemberId: 'member-a', definitionRevision: 1, stateRevision: 2 }, members: [], messages: [{ id: 'm2', seq: 2, authorType: 'system', body: '第二条' }], runs: [], actions: [], detailRevision: '2'.padStart(64, '0'), window: { maxMessages: 50, maxActions: 100, messageCount: 1, actionCount: 0, hasEarlierMessages: false, hasLaterMessages: true, hasMoreActions: false } })
    const afterMerge = mergeRoomDetail(base, delta)
    expect(afterMerge.messages.map(message => message.id)).toEqual(['m1', 'm2'])
    expect(afterMerge.window).toMatchObject({ hasEarlierMessages: true, hasLaterMessages: true })
    expect(mergeRoomDetail(afterMerge, { ...delta, window: { ...delta.window!, hasEarlierMessages: false, hasLaterMessages: false } }, false).window?.hasEarlierMessages).toBe(false)
    const otherRoom = normalizeRoomDetail({ room: { id: 'room-b', coordinatorMemberId: 'member-b', definitionRevision: 1, stateRevision: 1 }, members: [], messages: [{ id: 'wrong', seq: 9, authorType: 'system', body: '不应注入' }], runs: [], actions: [] })
    expect(mergeRoomDetail(afterMerge, otherRoom)).toBe(afterMerge)
    expect(normalizeRoomSummary({ id: 'room-a', status: 'active', latestRunStatus: 'unknown' })).toMatchObject({ status: 'active', latestRunStatus: 'unknown' })
    expect(normalizeRoomSummary({ id: 'room-a', maxSteps: 99 }).maxSteps).toBe(12)
    expect(normalizeRoomSummary({ id: 'room-a', defaultAccess: 'read_only' }).defaultAccess).toBe('workspace_write')
    expect(roomRunActive('unknown')).toBe(true)
    expect(roomStatusLabel('offline')).toBe('等待连接')
    expect(roomStatusLabel('reserved')).toBe('等待连接')
  })

  it('orders same-second task runs by their public root-message sequence', () => {
    const run = (id: string, rootMessageId: string) => ({ id, roomId: 'room-a', rootMessageId, routingKind: 'coordinator', coordinatorMemberId: 'member-a', targetMemberIds: [], definitionRevision: 1, maxSteps: 12, access: 'workspace_write', status: 'queued', stepCount: 0, requiresApproval: true, approvalId: `approval-${id}`, contentAvailable: true, createdAt: '2026-09-09T10:00:00+08:00' })
    const detail = normalizeRoomDetail({ room: { id: 'room-a' }, members: [], messages: [{ id: 'm1', seq: 1, body: '先发' }, { id: 'm2', seq: 2, body: '后发' }], runs: [run('run-1', 'm1'), run('run-2', 'm2')], actions: [] })
    expect(detail.runs.map(item => item.id)).toEqual(['run-2', 'run-1'])
  })
})
