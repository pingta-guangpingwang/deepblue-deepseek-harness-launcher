// Test-only synthetic transport. Never imported by the production entry point.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { AgentWorkspacePage } from './AgentWorkspacePage'
import { mockSnapshot } from './mock'
import type { LauncherApi } from '../../shared/types'
import type { AgentHostAction, AgentHostSnapshot, AgentWorkspaceRequest } from '../../shared/agent-host'
import './styles.css'

const ROOM_ID = '1'.repeat(32)
const SECOND_ROOM_ID = 'e'.repeat(32)
const COORDINATOR_ID = '2'.repeat(32)
const FRONTEND_ID = '3'.repeat(32)
const REVIEW_ID = '4'.repeat(32)
const COMPLETE_RUN_ID = '5'.repeat(32)
const UNKNOWN_RUN_ID = '8'.repeat(32)
const APPROVAL_ID = 'a'.repeat(32)
const host: AgentHostSnapshot = {
  supported: true, enabled: true, deviceId: 'qa-device', deviceName: '创作电脑 · 合成测试数据', ownerUserId: 'qa-user', connection: 'online', lastHeartbeatAt: new Date().toISOString(),
  agents: [
    { id: 'qa-codex', name: 'Codex · 网站开发', adapter: 'codex', projectRoots: ['E:/authorized/site'], autoStart: true, status: 'online', runtimeStatus: 'ready', busy: false },
    { id: 'qa-qclaw', name: 'QClaw · 启动器', adapter: 'qclaw', projectRoots: ['E:/authorized/launcher'], autoStart: true, status: 'online', runtimeStatus: 'ready', busy: false },
    { id: 'qa-claude', name: 'Claude Code · 复核', adapter: 'claude-code', projectRoots: ['D:/authorized/docs'], autoStart: false, status: 'stopped', runtimeStatus: 'stopped', busy: false }
  ],
  discovered: [
    { adapter: 'codex', name: 'Codex', available: true, message: '命令可用，登录状态由运行环境确认' },
    { adapter: 'claude-code', name: 'Claude Code', available: true, message: '本机已安装' },
    { adapter: 'qclaw', name: 'QClaw', available: true, message: '本机已安装' }
  ]
}
const calls: AgentWorkspaceRequest[] = []
const actions: AgentHostAction[] = []
const tasks: Array<Record<string, unknown>> = []
const history = Array.from({ length: 8 }, (_, index) => ({ external_message_id: `native-${index}`, message_role: index % 2 ? 'assistant' : 'user', body_text: index % 2 ? `第 ${index + 1} 条合成回复，不代表真实模型执行。` : `第 ${index + 1} 条合成任务。`, occurred_at: `2026-09-09 08:${String(index).padStart(2, '0')}:00` }))
let expired = false
let delay = 0
let roomSendDelay = 0
let failNextSend = false
let failNextRoomSend = false
let failNextRoomDelete = false
let omitNextRoomApproval = false
let activeReads = 0
let maxActiveReads = 0
let roomSequence = 6
let runSequence = 0
let catchupRemaining = 0
let renderWorkspace = () => {}
let mountVersion = 0
let manageRequest = 0
let initialSource: 'local' | 'cloud' | 'groups' | undefined

interface RoomFixtureDetail {
  room: Record<string, unknown>
  members: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  actions: Array<Record<string, unknown>>
  window: Record<string, unknown>
}

const qaRooms: Array<Record<string, unknown>> = [{ id: ROOM_ID, name: '产品发布室', coordinator_member_id: COORDINATOR_ID, max_steps: 12, default_access: 'workspace_write', definition_revision: 3, state_revision: 12, status: 'active', active_run_id: UNKNOWN_RUN_ID, latest_run_status: 'unknown', updated_at: '2026-09-09T08:40:00+08:00' }]
const qaRoomDetails = new Map<string, RoomFixtureDetail>([[ROOM_ID, {
  room: qaRooms[0]!,
  members: [
    { id: COORDINATOR_ID, display_name: '主控', mention_handle: '总控', responsibility: '理解目标、持续委派、复核并汇总', agent_id: 'qa-codex', agent_name: 'Codex · 网站开发', adapter_code: 'codex', project_id: 'qa-codex-project', project_name: 'AI历史书网站', session_label: '发布主控会话', native_session_id: 'native-control', session_state: 'ready', runtime_status: 'ready', can_dispatch: true, readiness_source: 'host' },
    { id: FRONTEND_ID, display_name: '前端', mention_handle: '前端', responsibility: '实现界面并向主控汇报', agent_id: 'qa-qclaw', agent_name: 'QClaw · 启动器', adapter_code: 'qclaw', project_id: 'qa-qclaw-project', project_name: '启动器界面', session_label: '前端执行会话', native_session_id: 'native-frontend', session_state: 'ready', runtime_status: 'ready', can_dispatch: true, readiness_source: 'host' },
    { id: REVIEW_ID, display_name: '复核', mention_handle: '复核', responsibility: '检查证据与发布门禁并向主控汇报', agent_id: 'qa-claude', agent_name: 'Claude Code · 复核', adapter_code: 'claude-code', project_id: 'qa-claude-project', project_name: '技术说明文档', session_label: '发布复核会话', native_session_id: null, session_state: 'pending', runtime_status: 'offline', can_dispatch: false, readiness_source: 'host', status_message: '电脑连接后自动创建专属会话' }
  ],
  messages: [
    { id: 'message-1', seq: 1, run_id: COMPLETE_RUN_ID, author_type: 'user', message_type: 'user', body: '请完成发布准备并给出可核验结论。', segments: [{ type: 'text', text: '请完成发布准备并给出可核验结论。' }], mentions: [], content_available: true, created_at: '2026-09-09T08:31:00+08:00' },
    { id: 'message-2', seq: 2, run_id: COMPLETE_RUN_ID, author_type: 'member', author_member_id: COORDINATOR_ID, author_name: '主控', message_type: 'coordinator', body: '我已拆分界面实现与发布复核，两项结果都会回到这里。', segments: [{ type: 'text', text: '我已拆分界面实现与发布复核，两项结果都会回到这里。' }], mentions: [], content_available: true, created_at: '2026-09-09T08:32:00+08:00' },
    { id: 'message-3', seq: 3, run_id: COMPLETE_RUN_ID, author_type: 'member', author_member_id: FRONTEND_ID, author_name: '前端', message_type: 'report', body: '@总控 界面已完成，桌面与手机布局均通过。', segments: [{ type: 'mention', memberId: COORDINATOR_ID }, { type: 'text', text: ' 界面已完成，桌面与手机布局均通过。' }], mentions: [{ memberId: COORDINATOR_ID, displayName: '主控', mentionHandle: '总控' }], content_available: true, created_at: '2026-09-09T08:34:00+08:00' },
    { id: 'message-4', seq: 4, run_id: COMPLETE_RUN_ID, author_type: 'member', author_member_id: COORDINATOR_ID, author_name: '主控', message_type: 'final', body: '发布准备已闭环；真实环境门禁仍单独列出。', segments: [{ type: 'text', text: '发布准备已闭环；真实环境门禁仍单独列出。' }], mentions: [], content_available: true, created_at: '2026-09-09T08:36:00+08:00' },
    { id: 'message-5', seq: 5, run_id: UNKNOWN_RUN_ID, author_type: 'user', message_type: 'user', body: '@复核 请确认中断后的任务结果。', segments: [{ type: 'mention', memberId: REVIEW_ID }, { type: 'text', text: ' 请确认中断后的任务结果。' }], mentions: [{ memberId: REVIEW_ID, displayName: '复核', mentionHandle: '复核' }], content_available: true, created_at: '2026-09-09T08:40:00+08:00' }
  ],
  runs: [
    { id: UNKNOWN_RUN_ID, room_id: ROOM_ID, root_message_id: 'message-5', routing_kind: 'direct', coordinator_member_id: COORDINATOR_ID, target_member_ids: [REVIEW_ID], definition_revision: 3, max_steps: 12, access: 'workspace_write', status: 'unknown', step_count: 1, requires_approval: false, error_code: 'dispatch_uncertain', content_available: true, created_at: '2026-09-09T08:40:00+08:00' },
    { id: COMPLETE_RUN_ID, room_id: ROOM_ID, root_message_id: 'message-1', routing_kind: 'coordinator', coordinator_member_id: COORDINATOR_ID, target_member_ids: [], definition_revision: 3, max_steps: 12, access: 'workspace_write', status: 'completed', step_count: 4, requires_approval: false, final_message_id: 'message-4', content_available: true, created_at: '2026-09-09T08:31:00+08:00', completed_at: '2026-09-09T08:36:00+08:00' }
  ],
  actions: [
    { id: 'action-unknown', run_id: UNKNOWN_RUN_ID, member_id: REVIEW_ID, member_name: '复核', ordinal: 1, action_type: 'direct', status: 'unknown', task_status: 'unknown', instruction: '请确认中断后的任务结果。', summary: '执行结果尚未确认', error_code: 'dispatch_uncertain', context_through_seq: 5, created_at: '2026-09-09T08:41:00+08:00' },
    { id: 'action-control', run_id: COMPLETE_RUN_ID, member_id: COORDINATOR_ID, member_name: '主控', ordinal: 1, action_type: 'coordinate', status: 'completed', task_status: 'completed', summary: '拆解任务并收齐公开汇报', context_through_seq: 4, created_at: '2026-09-09T08:32:00+08:00' },
    { id: 'action-front', run_id: COMPLETE_RUN_ID, member_id: FRONTEND_ID, member_name: '前端', ordinal: 2, action_type: 'delegate', status: 'completed', task_status: 'completed', summary: '界面实现已完成', context_through_seq: 4, created_at: '2026-09-09T08:33:00+08:00' },
    { id: 'action-review', run_id: COMPLETE_RUN_ID, member_id: REVIEW_ID, member_name: '复核', ordinal: 3, action_type: 'delegate', status: 'reserved', task_status: 'queued', summary: '等待成员连接后复核发布证据', context_through_seq: 4, created_at: '2026-09-09T08:33:30+08:00' }
  ],
  window: { max_messages: 50, max_actions: 100, message_count: 55, action_count: 4, has_earlier_messages: true, has_later_messages: false, has_more_actions: false }
}]])
const secondRoom = { id: SECOND_ROOM_ID, name: '内容复盘室', coordinator_member_id: COORDINATOR_ID, max_steps: 12, default_access: 'workspace_write', definition_revision: 1, state_revision: 1, status: 'active', latest_run_status: 'idle', updated_at: '2026-09-09T09:00:00+08:00' }
qaRooms.push(secondRoom)
qaRoomDetails.set(SECOND_ROOM_ID, {
  room: secondRoom,
  members: [
    { id: COORDINATOR_ID, display_name: '主控', mention_handle: '总控', responsibility: '推进内容复盘', agent_id: 'qa-codex', agent_name: 'Codex · 网站开发', adapter_code: 'codex', project_id: 'qa-codex-project', project_name: 'AI历史书网站', session_label: '内容复盘主控', native_session_id: 'native-retro-control', session_state: 'ready', runtime_status: 'ready', can_dispatch: true, readiness_source: 'host' },
    { id: FRONTEND_ID, display_name: '整理', mention_handle: '整理', responsibility: '整理公共记录', agent_id: 'qa-qclaw', agent_name: 'QClaw · 启动器', adapter_code: 'qclaw', project_id: 'qa-qclaw-project', project_name: '启动器界面', session_label: '内容整理会话', native_session_id: 'native-retro-editor', session_state: 'ready', runtime_status: 'ready', can_dispatch: true, readiness_source: 'host' }
  ],
  messages: [{ id: 'second-message-1', seq: 1, author_type: 'system', message_type: 'system', body: '这是第二个合成房间。', segments: [{ type: 'text', text: '这是第二个合成房间。' }], mentions: [], content_available: true, created_at: '2026-09-09T09:00:00+08:00' }],
  runs: [], actions: [], window: { max_messages: 50, max_actions: 100, message_count: 1, action_count: 0, has_earlier_messages: false, has_later_messages: false, has_more_actions: false }
})
const roomRequests = new Map<string, { messageId: string; runId: string }>()
const roomRevisions = new Map<string, number>([[ROOM_ID, 12], [SECOND_ROOM_ID, 1]])
const roomRevision = (roomId: string): number => roomRevisions.get(roomId) || 0
const roomDetailRevision = (roomId: string): string => roomRevision(roomId).toString(16).padStart(64, '0')
const bumpRoom = (roomId: string): void => { roomRevisions.set(roomId, roomRevision(roomId) + 1); const item = qaRoomDetails.get(roomId); if (item) item.room.state_revision = roomRevision(roomId) }
const candidates = {
  agents: host.agents.map(agent => ({ id: agent.id, display_name: agent.name, adapter_code: agent.adapter, runtime_status: agent.runtimeStatus, can_dispatch: ['ready', 'busy'].includes(agent.runtimeStatus), readiness_source: 'host' })),
  projects: host.agents.map(agent => ({ id: `${agent.id}-project`, agent_id: agent.id, source_name: agent.id === 'qa-codex' ? 'AI历史书网站' : agent.id === 'qa-qclaw' ? '启动器界面' : '技术说明文档' })),
  truncated: { agents: false, projects: false }, limits: { agents: 12, projects: 60 }
}

function memberHandle(detail: RoomFixtureDetail, memberId: string): string { return String(detail.members.find(member => member.id === memberId)?.mention_handle || '成员') }
function roomBody(detail: RoomFixtureDetail, content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(segment => {
    const item = segment as Record<string, unknown>
    return item.type === 'mention' ? `@${memberHandle(detail, String(item.memberId || ''))}` : String(item.text || '')
  }).join('')
}

const fixture = {
  calls, actions,
  setExpired(value: boolean) { expired = value },
  setDelay(value: number) { delay = value },
  setRoomSendDelay(value: number) { roomSendDelay = value },
  failSend() { failNextSend = true },
  failRoomSend() { failNextRoomSend = true },
  failRoomDelete() { failNextRoomDelete = true },
  omitRoomApprovalOnce() { omitNextRoomApproval = true },
  get maxActiveReads() { return maxActiveReads },
  appendHistory() { history.push({ external_message_id: `native-${history.length}`, message_role: 'assistant', body_text: `新增合成消息 ${history.length}`, occurred_at: '2026-09-09 10:00:00' }) },
  disconnect() { host.connection = 'offline'; host.agents[0]!.status = 'failed'; host.agents[0]!.runtimeStatus = 'failed' },
  settleLatestRun() { const detail = qaRoomDetails.get(ROOM_ID); const run = detail?.runs[0]; if (detail && run) { run.status = 'cancelled'; run.requires_approval = false; detail.room.latest_run_status = 'cancelled'; detail.room.active_run_id = null; bumpRoom(ROOM_ID) } },
  queueCatchup() { const detail = qaRoomDetails.get(ROOM_ID); if (detail) { catchupRemaining = 2; detail.window.has_later_messages = true; bumpRoom(ROOM_ID) } },
  requestManage() { initialSource = 'cloud'; manageRequest += 1; renderWorkspace() },
  remount() { mountVersion += 1; renderWorkspace() }
}
Object.assign(window, { workspaceQa: fixture })

const cloudState = (id: string) => ({ agent: { id, display_name: id, adapter_code: 'codex', status: 'online' }, projects: [{ id: 'qa-project', source_name: 'AI历史书网站' }], sessions: [{ id: 'qa-session', project_id: 'qa-project', source_title: '合成原生会话', source_status: 'idle' }], tasks, access: { canDispatchToday: true } })
const parameters = new URL(location.href).searchParams
if (parameters.has('oldBase')) initialSource = 'groups'
window.launcher = parameters.has('legacy') ? undefined : {
  agentHostState: async () => structuredClone(host),
  agentHostAction: async (action: AgentHostAction) => { actions.push(action); return structuredClone(host) },
  agentWorkspaceRequest: async (request: AgentWorkspaceRequest) => {
    calls.push(structuredClone(request)); activeReads += 1; maxActiveReads = Math.max(maxActiveReads, activeReads)
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (expired) throw new Error('登录已过期，请重新登录 AI历史书。')
      if (request.action === 'bootstrap') return { ok: true, agents: host.agents.map(agent => ({ id: agent.id, display_name: agent.name, adapter_code: agent.adapter, status: agent.status })) }
      if (request.action === 'agent_state') return { ok: true, state: cloudState(request.params?.agentId || 'qa-codex') }
      if (request.action === 'session_history') return { ok: true, messages: structuredClone(history) }
      if (request.action === 'room_list') return { ok: true, contractVersion: 2, rooms: structuredClone(qaRooms), candidates: structuredClone(candidates) }
      if (request.action === 'room_detail') {
        const roomId = request.params?.roomId || ''
        const detail = qaRoomDetails.get(roomId)
        if (!detail) return { ok: false, message: '房间不存在' }
        const after = Number(request.params?.afterMessageSeq || 0)
        const before = Number(request.params?.beforeMessageSeq || 0)
        if (before) {
          const old = { id: 'message-0', seq: 0, author_type: 'system', message_type: 'system', body: '更早记录已按需加载。', segments: [{ type: 'text', text: '更早记录已按需加载。' }], mentions: [], content_available: true, created_at: '2026-09-09T08:00:00+08:00' }
          const window = { ...detail.window, has_earlier_messages: false }
          return { ok: true, contractVersion: 2, changed: true, detailRevision: roomDetailRevision(roomId), room: structuredClone(detail.room), members: [], messages: [old], runs: [], actions: [], window: structuredClone(window) }
        }
        if (after) {
          if (detail.window.has_later_messages === true && catchupRemaining > 0) {
            const next = { id: `message-${after + 1}`, seq: after + 1, author_type: 'member', author_member_id: COORDINATOR_ID, author_name: '主控', message_type: 'progress', body: '已追上下一批公开进度。', segments: [{ type: 'text', text: '已追上下一批公开进度。' }], mentions: [], content_available: true, created_at: new Date().toISOString() }
            detail.messages.push(next); catchupRemaining -= 1; detail.window.has_later_messages = catchupRemaining > 0; bumpRoom(roomId)
            return { ok: true, contractVersion: 2, changed: true, detailRevision: roomDetailRevision(roomId), room: structuredClone(detail.room), members: [], messages: [next], runs: [], actions: [], window: structuredClone(detail.window) }
          }
          if (String(request.params?.afterRevision || '') === roomDetailRevision(roomId)) return { ok: true, contractVersion: 2, changed: false, detailRevision: roomDetailRevision(roomId) }
        }
        return { ok: true, contractVersion: 2, changed: true, detailRevision: roomDetailRevision(roomId), ...structuredClone(detail) }
      }
      if (request.action === 'room_create' || request.action === 'room_update') {
        const body = request.body || {}
        const input = Array.isArray(body.members) ? body.members as Array<Record<string, unknown>> : []
        if (input.some(member => !/^[a-f0-9]{32}$/.test(String(member.id || '')))) return { ok: false, message: '成员编号必须为 32 位小写十六进制' }
        const roomId = request.action === 'room_create' ? String(roomSequence++).repeat(32).slice(0, 32) : String(body.roomId || '')
        const definition = request.action === 'room_create' ? 1 : Number(qaRoomDetails.get(roomId)?.room.definition_revision || 0) + 1
        const room = { id: roomId, name: body.name, coordinator_member_id: body.coordinatorMemberId, max_steps: body.maxSteps, default_access: body.defaultAccess, definition_revision: definition, state_revision: 1, status: 'active', updated_at: new Date().toISOString() }
        const members = input.map(item => { const agent = host.agents.find(candidate => candidate.id === item.agentId); const project = candidates.projects.find(candidate => candidate.id === item.projectId); return { id: item.id, display_name: item.displayName, mention_handle: item.mentionHandle, responsibility: item.responsibility, agent_id: item.agentId, agent_name: agent?.name || '智能体', adapter_code: agent?.adapter || '', project_id: item.projectId, project_name: project?.source_name || '项目', session_label: item.sessionLabel, native_session_id: null, session_state: 'pending', runtime_status: agent?.runtimeStatus || 'unknown', can_dispatch: ['ready', 'busy'].includes(agent?.runtimeStatus || ''), readiness_source: 'host' } })
        const previous = qaRoomDetails.get(roomId)
        qaRoomDetails.set(roomId, { room, members, messages: previous?.messages || [], runs: previous?.runs || [], actions: previous?.actions || [], window: previous?.window || { max_messages: 50, max_actions: 100, message_count: 0, action_count: 0, has_earlier_messages: false, has_later_messages: false, has_more_actions: false } })
        roomRevisions.set(roomId, 1)
        const index = qaRooms.findIndex(item => item.id === roomId); if (index >= 0) qaRooms[index] = room; else qaRooms.push(room)
        return { ok: true, roomId, room: structuredClone(room) }
      }
      if (request.action === 'room_delete') { if (failNextRoomDelete) { failNextRoomDelete = false; throw new Error('网络中断，房间停用结果尚未确认。') }; const roomId = String(request.body?.roomId || ''); const index = qaRooms.findIndex(item => item.id === roomId); if (index >= 0) qaRooms.splice(index, 1); qaRoomDetails.delete(roomId); return { ok: true, roomId } }
      if (request.action === 'room_send') {
        if (roomSendDelay) await new Promise(resolve => setTimeout(resolve, roomSendDelay))
        if (failNextRoomSend) { failNextRoomSend = false; throw new Error('网络中断，房间消息发送结果尚未确认；内容已保留。') }
        if (omitNextRoomApproval) { omitNextRoomApproval = false; return { ok: true, messageId: 'unsafe-message', runId: 'unsafe-run', status: 'queued', requiresApproval: false, replayed: false } }
        const body = request.body || {}; const clientRequestId = String(body.clientRequestId || '')
        const replay = roomRequests.get(clientRequestId); if (replay) return { ok: true, ...replay, status: 'awaiting_approval', requiresApproval: true, approvalId: APPROVAL_ID, replayed: true }
        const roomId = String(body.roomId || ''); const detail = qaRoomDetails.get(roomId); if (!detail) return { ok: false, message: '房间不存在' }
        const messageId = `sent-message-${++runSequence}`; const runId = `sent-run-${runSequence}`; const content = Array.isArray(body.content) ? body.content as Array<Record<string, unknown>> : []
        const targetIds = content.filter(item => item.type === 'mention').map(item => String(item.memberId || '')).filter(Boolean)
        const message = { id: messageId, seq: Math.max(...detail.messages.map(item => Number(item.seq) || 0), 0) + 1, run_id: runId, author_type: 'user', message_type: 'user', body: roomBody(detail, content), segments: structuredClone(content), mentions: targetIds.map(memberId => { const target = detail.members.find(member => member.id === memberId); return { memberId, displayName: target?.display_name, mentionHandle: target?.mention_handle } }), content_available: true, created_at: new Date().toISOString() }
        const run = { id: runId, room_id: roomId, root_message_id: messageId, routing_kind: targetIds.length ? 'direct' : 'coordinator', coordinator_member_id: detail.room.coordinator_member_id, target_member_ids: targetIds, definition_revision: detail.room.definition_revision, max_steps: detail.room.max_steps, access: body.access, status: 'awaiting_approval', step_count: 0, requires_approval: true, approval_id: APPROVAL_ID, content_available: true, created_at: new Date().toISOString() }
        detail.messages.push(message); detail.runs.unshift(run); detail.room.active_run_id = runId; detail.room.latest_run_status = 'awaiting_approval'; detail.window.message_count = Number(detail.window.message_count || 0) + 1; bumpRoom(roomId); roomRequests.set(clientRequestId, { messageId, runId })
        return { ok: true, messageId, runId, status: 'awaiting_approval', requiresApproval: true, approvalId: APPROVAL_ID, replayed: false }
      }
      if (request.action === 'room_approve') {
        const roomId = String(request.body?.roomId || ''); const runId = String(request.body?.runId || ''); const detail = qaRoomDetails.get(roomId); const run = detail?.runs.find(item => item.id === runId)
        if (!detail || !run || run.approval_id !== request.body?.approvalId) return { ok: false, message: '待批准任务不存在或状态已变化' }
        run.status = 'queued'; run.requires_approval = false; run.approved_at = new Date().toISOString(); detail.room.latest_run_status = 'queued'
        const targets = (run.target_member_ids as string[]).length ? run.target_member_ids as string[] : [String(run.coordinator_member_id)]
        targets.forEach((memberId, index) => detail.actions.unshift({ id: `approved-action-${runSequence}-${index}`, run_id: runId, member_id: memberId, ordinal: index + 1, action_type: index ? 'direct' : 'coordinate', status: 'queued', task_status: 'queued', summary: detail.members.find(member => member.id === memberId)?.can_dispatch ? '等待领取' : '等待连接', created_at: new Date().toISOString() }))
        bumpRoom(roomId); return { ok: true, runId, status: 'queued' }
      }
      if (request.action === 'room_cancel') { const roomId = String(request.body?.roomId || ''); const runId = String(request.body?.runId || ''); const detail = qaRoomDetails.get(roomId); const run = detail?.runs.find(item => item.id === runId); if (detail && run) { run.status = 'cancel_requested'; run.cancel_requested_at = new Date().toISOString(); detail.room.latest_run_status = 'cancel_requested'; bumpRoom(roomId) } return { ok: true, runId, status: 'cancel_requested' } }
      if (request.action === 'send_task') { if (failNextSend) { failNextSend = false; throw new Error('网络中断，发送结果尚未确认；内容已保留。') }; const task = { id: 'qa-task', project_id: request.body?.projectId, session_id: request.body?.sessionId, client_request_id: request.body?.clientRequestId, request_text: request.body?.instruction, status: 'queued', created_at: new Date().toISOString() }; tasks.push(task); return { ok: true, taskId: 'qa-task', status: 'queued' } }
      return { ok: true }
    } finally { activeReads -= 1 }
  },
  openExternal: async () => undefined
} as unknown as LauncherApi

const account = { status: 'signed_in' as const, user: { id: 'qa-user', name: '界面测试账号' }, sessionRemembered: true }
const snapshot = { ...mockSnapshot, launcherVersion: parameters.has('oldBase') ? '0.10.34' : '0.10.35', account }
const root = createRoot(document.getElementById('root')!)
renderWorkspace = () => root.render(<div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}><header style={{ padding: '12px 18px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}><strong>智能体工作台</strong><span style={{ marginLeft: 12, color: 'var(--text-secondary)', fontSize: 12 }}>合成数据界面验收 · 不访问真实账号</span></header><div className="page-scroll agent-workspace-fixed-page"><AgentWorkspacePage key={mountVersion} snapshot={snapshot} onLogin={() => { expired = false }} initialSource={initialSource} manageRequest={manageRequest || undefined} onManageRequestHandled={request => { if (manageRequest === request) manageRequest = 0 }} /></div></div>)
renderWorkspace()
