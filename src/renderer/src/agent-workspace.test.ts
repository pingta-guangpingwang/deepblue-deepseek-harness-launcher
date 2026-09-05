import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceAgent, normalizeWorkspaceData, normalizeWorkspaceHistory, workspaceEnterSends, workspaceHostManagement, workspaceNearBottom, workspaceStatusLabel, workspaceTime, workspaceTimeline, type WorkspaceTask } from './AgentWorkspacePage'

const task = (overrides: Partial<WorkspaceTask> = {}): WorkspaceTask => ({ id: 'task-1', projectId: 'project-1', sessionId: 'native-session-1', clientRequestId: 'stable-retry-id', status: 'completed', request: '检查代码', reply: '检查完成', summary: '', createdAt: '2026-09-05 12:00:00', ...overrides })

describe('native agent workspace website contract', () => {
  it('keeps website IDs and snake-case source fields intact', () => {
    const result = normalizeWorkspaceData({ agent: { id: 'agent-native-1', display_name: '我的 Codex', adapter_code: 'codex', status: 'online' }, projects: [{ id: 'project-native-1', source_name: '产品项目', external_project_id: 'do-not-use-as-cloud-id' }], sessions: [{ id: 'session-native-1', project_id: 'project-native-1', source_title: '保留原生会话', source_status: 'idle' }], tasks: [{ id: 'task-1', project_id: 'project-native-1', session_id: 'session-native-1', request_text: '继续开发', final_text: '', status: 'running', progress_percent: 48 }], access: { canDispatchToday: false } })
    expect(result.agent).toEqual({ id: 'agent-native-1', name: '我的 Codex', adapter: 'codex', status: 'online' })
    expect(result.projects[0]?.id).toBe('project-native-1')
    expect(result.sessions[0]?.id).toBe('session-native-1')
    expect(result.tasks[0]?.progress).toBe(48)
    expect(result.canDispatch).toBe(false)
  })
  it('ignores malformed lists without inventing available agents or data', () => {
    expect(normalizeWorkspaceData(null).projects).toEqual([])
    expect(normalizeWorkspaceHistory([{ message_role: 'system', body_text: 'not visible' }, { message_role: 'tool', body_text: 'not visible' }])).toEqual([])
    expect(normalizeWorkspaceAgent({}).id).toBe('')
  })
  it('reads visible user and assistant messages, never tool/private roles', () => {
    expect(normalizeWorkspaceHistory([{ external_message_id: 'native-message-1', message_role: 'assistant', body_text: '<script>visible text only</script>', occurred_at: '2026-09-05 12:00:00' }])).toEqual([{ id: 'native-message-1', role: 'assistant', text: '<script>visible text only</script>', occurredAt: '2026-09-05 12:00:00' }])
  })
  it('orders oldest to newest, then leaves the latest visible at the bottom', () => {
    const timeline = workspaceTimeline([], [task({ id: 'later', createdAt: '2026-09-05 13:00:00' }), task({ id: 'earlier' })])
    expect(timeline.map(row => row.id)).toEqual(['earlier:request', 'earlier:reply', 'later:request', 'later:reply'])
    expect(workspaceTime('2026-09-05 12:00:00')).toBe(Date.parse('2026-09-05T04:00:00Z'))
  })
  it('deduplicates completed native messages by role and text, not text alone', () => {
    const history = [{ id: 'h1', role: 'assistant' as const, text: '检查代码', occurredAt: '2026-09-05 12:00:00' }, { id: 'h2', role: 'assistant' as const, text: '检查完成', occurredAt: '2026-09-05 12:00:00' }]
    expect(workspaceTimeline(history, [task()]).map(row => row.id)).toEqual(['history:h1', 'history:h2', 'task-1:request'])
  })
  it('keeps active progress and approvals visible even when texts resemble history', () => {
    const active = task({ status: 'awaiting_approval', reply: '', summary: '等待目录权限', progress: 40 })
    const timeline = workspaceTimeline([], [active])
    expect(timeline[1]?.task?.status).toBe('awaiting_approval')
    expect(workspaceStatusLabel('awaiting_approval')).toBe('等待本机确认')
  })
})

describe('workspace scroll and composition interaction', () => {
  it('exposes revoked device recovery, prevents resume loops, and keeps unbind available', () => {
    expect(workspaceHostManagement({ connection: 'revoked', deviceId: 'device-1' }, false, false)).toEqual({ revoked: true, visible: true, toggleDisabled: true, unbindDisabled: false })
    expect(workspaceHostManagement({ connection: 'revoked', deviceId: 'device-1' }, false, true).unbindDisabled).toBe(true)
    expect(workspaceHostManagement({ connection: 'online', deviceId: 'device-1' }, false, false)).toEqual({ revoked: false, visible: false, toggleDisabled: false, unbindDisabled: false })
    expect(workspaceHostManagement({ connection: 'offline', deviceId: 'device-1' }, true, false).toggleDisabled).toBe(false)
    expect(workspaceHostManagement({ connection: 'unbound' }, false, false).visible).toBe(true)
    expect(workspaceHostManagement(undefined, false, false).visible).toBe(false)
  })
  it('only sticks to the latest messages while already near the bottom', () => {
    expect(workspaceNearBottom(1000, 560, 400)).toBe(true)
    expect(workspaceNearBottom(1000, 200, 400)).toBe(false)
  })
  it('sends with Enter but not Shift+Enter or Chinese IME confirmation', () => {
    expect(workspaceEnterSends({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false } as KeyboardEvent })).toBe(true)
    expect(workspaceEnterSends({ key: 'Enter', shiftKey: true, nativeEvent: { isComposing: false } as KeyboardEvent })).toBe(false)
    expect(workspaceEnterSends({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } as KeyboardEvent })).toBe(false)
  })
})
