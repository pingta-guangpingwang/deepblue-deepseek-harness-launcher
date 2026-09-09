import { describe, expect, it } from 'vitest'
import { groupRoleReady, groupRunActive, groupStatusLabel, groupSubmissionSignature, newSessionGroupRoleId, normalizeSessionGroupDetail, normalizeSessionGroupSummary, validateSessionGroupDraft } from './AgentSessionGroups'

const role = (overrides: Record<string, string> = {}) => ({ id: 'role-a', name: '规划', responsibility: '拆解任务', agentId: 'agent-a', projectId: 'project-a', nativeSessionId: 'session-a', ...overrides })

describe('agent session group contracts', () => {
  it('normalizes snake-case group detail without inventing completion', () => {
    const detail = normalizeSessionGroupDetail({
      group: { id: 'group-a', name: '发布协作组', control_mode: 'coordinator', coordinator_role_id: 'role-a', max_turns: 8, role_count: 2, status: 'running' },
      roles: [{ id: 'role-a', role_name: '规划', responsibility: '拆解任务', agent_id: 'agent-a', agent_name: 'Codex', project_id: 'project-a', project_name: '主站', native_session_id: 'session-a', native_session_title: '发布计划', runtime_status: 'ready' }],
      runs: [{ id: 'run-a', request_text: null, final_text: null, content_available: false, content_pruned_at: '2026-09-09T09:00:00+08:00', status: 'cancel_requested', latest_summary: '等待本机停止', client_request_id: 'request-a', target_role_ids: ['role-a'], max_turns: 8 }],
      actions: [{ id: 'action-b', run_id: 'run-a', role_id: 'role-a', ordinal: 2, action_type: 'finish', status: 'completed', task_status: 'completed', instruction: '给出结论', latest_summary: '核对完成', final_text: '发布门禁全部通过' }, { id: 'action-a', run_id: 'run-a', role_id: 'role-a', ordinal: 1, action_type: 'delegate', effective_status: 'failed', task_status: 'unknown', latest_summary: '派发失败', error_code: 'agent_offline' }]
    })
    expect(detail.group).toMatchObject({ id: 'group-a', mode: 'coordinator', coordinatorRoleId: 'role-a', maxTurns: 8, status: 'running' })
    expect(detail.roles[0]).toMatchObject({ name: '规划', agentName: 'Codex', nativeSessionId: 'session-a', status: 'ready' })
    expect(detail.runs[0]).toMatchObject({ id: 'run-a', status: 'cancel_requested', clientRequestId: 'request-a', contentAvailable: false, contentPrunedAt: '2026-09-09T09:00:00+08:00' })
    expect(detail.actions[0]).toMatchObject({ id: 'action-a', ordinal: 1, runId: 'run-a', actionType: 'delegate', status: 'failed', taskStatus: 'unknown', errorCode: 'agent_offline' })
    expect(detail.actions[1]).toMatchObject({ id: 'action-b', ordinal: 2, instruction: '给出结论', finalText: '发布门禁全部通过' })
    expect(groupRunActive(detail.runs[0]!.status)).toBe(true)
  })

  it('accepts one agent in two roles only when native sessions differ', () => {
    const valid = { name: '同智能体复核组', mode: 'manual' as const, coordinatorRoleId: '', maxTurns: 6, roles: [role(), role({ id: 'role-b', name: '复核', responsibility: '复核结果', nativeSessionId: 'session-b' })] }
    expect(validateSessionGroupDraft(valid)).toBe('')
    expect(validateSessionGroupDraft({ ...valid, roles: [role(), role({ id: 'role-b', name: '复核', responsibility: '复核结果' })] })).toContain('不同的原生会话')
  })

  it('requires 2–6 complete roles and a valid coordinator', () => {
    const draft = { name: '主控组', mode: 'coordinator' as const, coordinatorRoleId: '', maxTurns: 13, roles: [role(), role({ id: 'role-b', name: '执行', responsibility: '完成任务', agentId: 'agent-b', nativeSessionId: 'session-b' })] }
    expect(validateSessionGroupDraft(draft)).toContain('1–12')
    expect(validateSessionGroupDraft({ ...draft, maxTurns: 6 })).toContain('选择一个现有角色')
    expect(validateSessionGroupDraft({ ...draft, maxTurns: 6, coordinatorRoleId: 'role-a' })).toBe('')
    expect(validateSessionGroupDraft({ ...draft, maxTurns: 6, coordinatorRoleId: 'role-a', roles: [role()] })).toContain('2–6')
  })

  it('uses a deterministic payload signature and honest state labels', () => {
    const base = { groupId: 'group-a', instruction: '检查发布', mode: 'manual' as const, maxTurns: 6 }
    expect(groupSubmissionSignature({ ...base, targetRoleIds: ['role-b', 'role-a'] })).toBe(groupSubmissionSignature({ ...base, targetRoleIds: ['role-a', 'role-b'] }))
    expect(groupStatusLabel('cancel_requested')).toBe('取消中')
    expect(groupStatusLabel('unknown')).toBe('结果待确认')
    expect(groupStatusLabel('failed')).toBe('失败')
    expect(groupStatusLabel('completed')).toBe('已完成')
    expect(groupRoleReady('ready')).toBe(true)
    expect(groupRoleReady('offline')).toBe(false)
    expect(groupRunActive('unknown')).toBe(true)
    expect(normalizeSessionGroupSummary({ id: 'g', maxTurns: 99 }).maxTurns).toBe(12)
    expect(normalizeSessionGroupSummary({ id: 'g', status: 'active', activeRunCount: 2, latestRunStatus: 'unknown' }).status).toBe('unknown')
    expect(normalizeSessionGroupSummary({ id: 'g', status: 'active', activeRunCount: 2 }).status).toBe('running')
    expect(normalizeSessionGroupSummary({ id: 'g', status: 'active', activeRunCount: 0 }).status).toBe('idle')
    expect(newSessionGroupRoleId()).toMatch(/^[a-f0-9]{32}$/)
  })
})
