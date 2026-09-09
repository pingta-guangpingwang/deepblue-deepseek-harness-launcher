// Test-only synthetic transport. Never imported by the production entry point.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { AgentWorkspacePage } from './AgentWorkspacePage'
import { mockSnapshot } from './mock'
import type { LauncherApi } from '../../shared/types'
import type { AgentHostAction, AgentHostSnapshot, AgentWorkspaceRequest } from '../../shared/agent-host'
import './styles.css'

const GROUP_ID = '1'.repeat(32)
const PLAN_ROLE_ID = '2'.repeat(32)
const REVIEW_ROLE_ID = '3'.repeat(32)
const COMPLETE_RUN_ID = '4'.repeat(32)
const COMPLETE_ACTION_ID = '5'.repeat(32)
const UNKNOWN_RUN_ID = '8'.repeat(32)
const UNKNOWN_ACTION_ID = '9'.repeat(32)
const PRUNED_RUN_ID = 'a'.repeat(32)
const host: AgentHostSnapshot = { supported: true, enabled: true, deviceId: 'qa-device', deviceName: '创作电脑 · UI 测试数据', ownerUserId: 'qa-user', connection: 'online', lastHeartbeatAt: new Date().toISOString(), agents: [
  { id: 'qa-codex', name: 'Codex · 网站开发', adapter: 'codex', projectRoots: ['E:/authorized/project'], autoStart: true, status: 'online', runtimeStatus: 'ready', busy: false },
  { id: 'qa-claude', name: 'Claude Code', adapter: 'claude-code', projectRoots: ['D:/authorized/docs'], autoStart: false, status: 'stopped', runtimeStatus: 'stopped', busy: false }
], discovered: [{ adapter: 'codex', name: 'Codex', available: true, message: '命令可用，登录状态由运行环境确认' }, { adapter: 'claude-code', name: 'Claude Code', available: true, message: '本机已安装' }, { adapter: 'qclaw', name: 'QClaw', available: false, message: '尚未检测到' }] }
const tasks: Array<Record<string, unknown>> = []
const calls: AgentWorkspaceRequest[] = []
const actions: AgentHostAction[] = []
let expired = false
let delay = 0
let failNextSend = false
let failNextGroupSend = false
let groupSendDelay = 0
let activeReads = 0
let maxActiveReads = 0
const history = Array.from({ length: 20 }, (_, index) => ({ external_message_id: `native-${index}`, message_role: index % 2 ? 'assistant' : 'user', body_text: index % 2 ? `第 ${index + 1} 条原生回复：已检查该项目，改动仅发生在授权目录内。任务状态会同步到 AI历史书工作台。\n这是一条明确标记的界面测试内容，不代表真实模型执行。` : `第 ${index + 1} 条消息：请检查项目的连接状态与会话同步。`, occurred_at: `2026-09-05 12:${String(index).padStart(2, '0')}:00` }))
const qaGroups: Array<Record<string, unknown>> = [{ id: GROUP_ID, name: '发布协作组', mode: 'manual', max_turns: 6, coordinator_role_id: null, role_count: 2, active_run_count: 1, active_run_id: UNKNOWN_RUN_ID, latest_run_status: 'unknown', status: 'active', updated_at: '2026-09-09T08:30:00+08:00' }]
const qaGroupDetails = new Map<string, { group: Record<string, unknown>; roles: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>>; actions: Array<Record<string, unknown>> }>([[GROUP_ID, {
  group: qaGroups[0]!,
  roles: [
    { id: PLAN_ROLE_ID, role_name: '规划', responsibility: '拆解目标并明确验收边界', agent_id: 'qa-codex', agent_name: 'Codex · 网站开发', project_id: 'qa-project', project_name: 'AI历史书网站', native_session_id: 'qa-session', native_session_title: '修复连接并同步原生会话', runtime_status: 'ready' },
    { id: REVIEW_ROLE_ID, role_name: '复核', responsibility: '检查结果与发布门禁', agent_id: 'qa-claude', agent_name: 'Claude Code', project_id: 'qa-project', project_name: 'AI历史书网站', native_session_id: 'qa-session-2', native_session_title: '检查网页工作台布局', runtime_status: 'offline', message: '请先在本机启动并登录' }
  ],
  runs: [{ id: UNKNOWN_RUN_ID, instruction: '确认中断后的任务结果', status: 'unknown', latest_summary: 'worker 返回前连接中断，需要取消并对账', client_request_id: 'qa-unknown-request', target_role_ids: [PLAN_ROLE_ID], mode: 'manual', max_turns: 6, content_available: true, created_at: '2026-09-09T08:40:00+08:00' }, { id: COMPLETE_RUN_ID, instruction: '核对昨日发布记录', status: 'completed', latest_summary: '规划与复核均已完成', final_text: '合成验收结果：发布记录完整。', client_request_id: 'qa-old-request', target_role_ids: [PLAN_ROLE_ID], mode: 'manual', max_turns: 6, content_available: true, created_at: '2026-09-09T08:35:00+08:00' }, { id: PRUNED_RUN_ID, instruction: null, final_text: null, status: 'completed', content_available: false, content_pruned_at: '2026-09-09T08:00:00+08:00', target_role_ids: [PLAN_ROLE_ID], mode: 'manual', max_turns: 6, created_at: '2026-09-08T08:00:00+08:00' }],
  actions: [{ id: UNKNOWN_ACTION_ID, run_id: UNKNOWN_RUN_ID, role_id: PLAN_ROLE_ID, ordinal: 1, action_type: 'delegate', effective_status: 'unknown', task_status: 'unknown', instruction: '确认中断后的任务结果', latest_summary: '执行结果尚未确认', error_code: 'dispatch_uncertain', created_at: '2026-09-09T08:41:00+08:00' }, { id: COMPLETE_ACTION_ID, run_id: COMPLETE_RUN_ID, role_id: PLAN_ROLE_ID, ordinal: 1, action_type: 'delegate', effective_status: 'completed', task_status: 'completed', instruction: '核对发布记录', latest_summary: '完成发布记录核对', final_text: '角色最终结果：发布记录完整', created_at: '2026-09-09T08:36:00+08:00' }]
}]])
const qaGroupRequests = new Map<string, string>()
const qaGroupCandidates = {
  agents: host.agents.map(agent => ({ id: agent.id, display_name: agent.name, adapter_code: agent.adapter, runtime_status: agent.runtimeStatus })),
  projects: host.agents.map(agent => ({ id: `${agent.id}-project`, agent_id: agent.id, source_name: agent.id === 'qa-codex' ? 'AI历史书网站' : '技术说明文档' })),
  sessions: host.agents.flatMap(agent => [{ id: `${agent.id}-session-a`, agent_id: agent.id, project_id: `${agent.id}-project`, source_title: `${agent.name} · 规划会话` }, { id: `${agent.id}-session-b`, agent_id: agent.id, project_id: `${agent.id}-project`, source_title: `${agent.name} · 复核会话` }]),
  truncated: { agents: false, projects: false, sessions: true },
  limits: { agents: 12, projects: 60, sessions: 100 }
}
let renderWorkspace = () => {}
let mountVersion = 0
let manageRequest = 0
let initialSource: 'local' | 'cloud' | undefined
const fixture = {
  calls, actions,
  setExpired(value: boolean) { expired = value },
  setDelay(value: number) { delay = value },
  setGroupSendDelay(value: number) { groupSendDelay = value },
  failSend() { failNextSend = true },
  failGroupSend() { failNextGroupSend = true },
  get maxActiveReads() { return maxActiveReads },
  appendHistory() { history.push({ external_message_id: `native-${history.length}`, message_role: 'assistant', body_text: `新增界面验收消息 ${history.length}`, occurred_at: '2026-09-05 14:00:00' }) },
  disconnect() { host.connection = 'offline'; host.agents[0]!.status = 'failed'; host.agents[0]!.runtimeStatus = 'failed' },
  settleCreatedGroupRun() { const detail = qaGroupDetails.get('6'.repeat(32)); const run = detail?.runs.find(item => item.id === '7'.repeat(32)); if (detail && run) { run.status = 'cancelled'; run.latest_summary = '本机已确认取消'; detail.group.active_run_count = 0; detail.group.active_run_id = null; detail.group.latest_run_status = 'cancelled' } },
  requestManage() { initialSource = 'cloud'; manageRequest += 1; renderWorkspace() },
  remount() { mountVersion += 1; renderWorkspace() }
}
Object.assign(window, { workspaceQa: fixture })
const state = (id: string) => ({ agent: { id, display_name: id === 'qa-codex' ? 'Codex · 网站开发' : 'Claude Code', adapter_code: id === 'qa-codex' ? 'codex' : 'claude-code', status: id === 'qa-codex' ? host.agents[0]!.status : host.agents[1]!.status }, projects: [{ id: 'qa-project', source_name: 'AI历史书网站' }, { id: 'qa-docs', source_name: '技术说明文档' }], sessions: [{ id: 'qa-session', project_id: 'qa-project', source_title: '修复连接并同步原生会话', source_status: 'idle' }, { id: 'qa-session-2', project_id: 'qa-project', source_title: '检查网页工作台布局', source_status: 'idle' }], tasks, access: { canDispatchToday: true } })
const parameters = new URL(location.href).searchParams
window.launcher = parameters.has('legacy') ? undefined : {
  agentHostState: async () => structuredClone(host),
  agentHostAction: async (action: AgentHostAction) => { actions.push(action); if ('agentId' in action) { const agent = host.agents.find(item => item.id === action.agentId); if (agent && action.action === 'start') { agent.status = 'online'; agent.runtimeStatus = 'ready' } } return structuredClone(host) },
  agentWorkspaceRequest: async (request: AgentWorkspaceRequest) => {
    calls.push(structuredClone(request))
    activeReads += 1; maxActiveReads = Math.max(maxActiveReads, activeReads)
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (expired) throw new Error('登录已过期，请重新登录 AI历史书。')
      if (request.action === 'bootstrap') return { ok: true, agents: host.agents.map(agent => ({ id: agent.id, display_name: agent.name, adapter_code: agent.adapter, status: agent.status })) }
      if (request.action === 'agent_state') return { ok: true, state: state(request.params?.agentId || 'qa-codex') }
      if (request.action === 'session_history') return { ok: true, messages: structuredClone(history) }
      if (request.action === 'group_list') return { ok: true, groups: structuredClone(qaGroups), candidates: structuredClone(qaGroupCandidates) }
      if (request.action === 'group_detail') {
        const detail = qaGroupDetails.get(request.params?.groupId || '')
        return detail ? { ok: true, ...structuredClone(detail) } : { ok: false, message: '会话群不存在' }
      }
      if (request.action === 'group_create' || request.action === 'group_update') {
        const body = request.body || {}
        const roleInput = Array.isArray(body.roles) ? body.roles : []
        if (roleInput.some(value => !/^[a-f0-9]{32}$/.test(String((value as Record<string, unknown>).id || '')))) return { ok: false, message: '角色编号必须为 32 位小写十六进制' }
        const groupId = request.action === 'group_create' ? '6'.repeat(32) : String(body.groupId || '')
        const group = { id: groupId, name: body.name, mode: body.mode, max_turns: body.maxTurns, coordinator_role_id: body.coordinatorRoleId, role_count: Array.isArray(body.roles) ? body.roles.length : 0, active_run_count: 0, status: 'active', updated_at: new Date().toISOString() }
        const roleRows = roleInput.map(value => {
          const role = value as Record<string, unknown>
          const agent = host.agents.find(item => item.id === role.agentId)
          const project = qaGroupCandidates.projects.find(item => item.id === role.projectId)
          const session = qaGroupCandidates.sessions.find(item => item.id === role.nativeSessionId)
          return { id: role.id, role_name: role.name, responsibility: role.responsibility, agent_id: role.agentId, agent_name: agent?.name || '智能体', project_id: role.projectId, project_name: project?.source_name || '项目', native_session_id: role.nativeSessionId, native_session_title: session?.source_title || '原生会话', runtime_status: agent?.runtimeStatus || 'unknown' }
        })
        const previous = qaGroupDetails.get(groupId)
        const next = { group, roles: roleRows, runs: previous?.runs || [], actions: previous?.actions || [] }
        qaGroupDetails.set(groupId, next)
        const index = qaGroups.findIndex(item => item.id === groupId)
        if (index >= 0) qaGroups[index] = group; else qaGroups.push(group)
        return { ok: true, groupId, group: structuredClone(group) }
      }
      if (request.action === 'group_delete') {
        const groupId = String(request.body?.groupId || '')
        const index = qaGroups.findIndex(item => item.id === groupId)
        if (index >= 0) qaGroups.splice(index, 1)
        qaGroupDetails.delete(groupId)
        return { ok: true, groupId }
      }
      if (request.action === 'group_send') {
        if (groupSendDelay) await new Promise(resolve => setTimeout(resolve, groupSendDelay))
        if (failNextGroupSend) { failNextGroupSend = false; throw new Error('网络中断，群任务发送结果尚未确认；内容已保留。') }
        const body = request.body || {}
        const clientRequestId = String(body.clientRequestId || '')
        const existing = qaGroupRequests.get(clientRequestId)
        if (existing) return { ok: true, runId: existing, status: 'queued', replayed: true }
        const groupId = String(body.groupId || '')
        const detail = qaGroupDetails.get(groupId)
        if (!detail) return { ok: false, message: '会话群不存在' }
        const runId = '7'.repeat(32)
        qaGroupRequests.set(clientRequestId, runId)
        detail.group.status = 'active'; detail.group.active_run_count = 1; detail.group.active_run_id = runId; detail.group.latest_run_status = 'queued'
        detail.runs.unshift({ id: runId, instruction: body.instruction, status: 'queued', latest_summary: '已进入合成测试队列', client_request_id: clientRequestId, target_role_ids: body.targetRoleIds, mode: body.mode, coordinator_role_id: body.coordinatorRoleId, max_turns: body.maxTurns, created_at: new Date().toISOString() })
        return { ok: true, runId, status: 'queued', replayed: false }
      }
      if (request.action === 'group_cancel') {
        const groupId = String(request.body?.groupId || '')
        const runId = String(request.body?.runId || '')
        const detail = qaGroupDetails.get(groupId)
        const run = detail?.runs.find(item => item.id === runId)
        if (run) { run.status = 'cancel_requested'; run.latest_summary = '等待本机停止确认'; if (detail) { detail.group.status = 'active'; detail.group.active_run_count = 1; detail.group.latest_run_status = 'cancel_requested' } }
        return { ok: true, runId, status: 'cancel_requested' }
      }
      if (request.action === 'send_task') {
        if (failNextSend) { failNextSend = false; throw new Error('网络中断，发送结果尚未确认；内容已保留。') }
        const task = { id: 'qa-task', project_id: request.body?.projectId, session_id: request.body?.sessionId, client_request_id: request.body?.clientRequestId, request_text: request.body?.instruction, status: 'queued', latest_summary: '已进入测试队列', created_at: '2026-09-05 14:05:00' }
        tasks.push(task); return { ok: true, taskId: 'qa-task', status: 'queued' }
      }
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
