// Test-only synthetic transport. Never imported by the production entry point.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { AgentWorkspacePage } from './AgentWorkspacePage'
import { mockSnapshot } from './mock'
import type { LauncherApi } from '../../shared/types'
import type { AgentHostAction, AgentHostSnapshot, AgentWorkspaceRequest } from '../../shared/agent-host'
import './styles.css'

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
let activeReads = 0
let maxActiveReads = 0
const history = Array.from({ length: 20 }, (_, index) => ({ external_message_id: `native-${index}`, message_role: index % 2 ? 'assistant' : 'user', body_text: index % 2 ? `第 ${index + 1} 条原生回复：已检查该项目，改动仅发生在授权目录内。任务状态会同步到 AI历史书工作台。\n这是一条明确标记的界面测试内容，不代表真实模型执行。` : `第 ${index + 1} 条消息：请检查项目的连接状态与会话同步。`, occurred_at: `2026-09-05 12:${String(index).padStart(2, '0')}:00` }))
const fixture = {
  calls, actions,
  setExpired(value: boolean) { expired = value },
  setDelay(value: number) { delay = value },
  failSend() { failNextSend = true },
  get maxActiveReads() { return maxActiveReads },
  appendHistory() { history.push({ external_message_id: `native-${history.length}`, message_role: 'assistant', body_text: `新增界面验收消息 ${history.length}`, occurred_at: '2026-09-05 14:00:00' }) },
  disconnect() { host.connection = 'offline'; host.agents[0]!.status = 'failed'; host.agents[0]!.runtimeStatus = 'failed' }
}
Object.assign(window, { workspaceQa: fixture })
const state = (id: string) => ({ agent: { id, display_name: id === 'qa-codex' ? 'Codex · 网站开发' : 'Claude Code', adapter_code: id === 'qa-codex' ? 'codex' : 'claude-code', status: id === 'qa-codex' ? host.agents[0]!.status : host.agents[1]!.status }, projects: [{ id: 'qa-project', source_name: 'AI历史书网站' }, { id: 'qa-docs', source_name: '技术说明文档' }], sessions: [{ id: 'qa-session', project_id: 'qa-project', source_title: '修复连接并同步原生会话', source_status: 'idle' }, { id: 'qa-session-2', project_id: 'qa-project', source_title: '检查网页工作台布局', source_status: 'idle' }], tasks, access: { canDispatchToday: true } })
window.launcher = new URL(location.href).searchParams.has('legacy') ? undefined : {
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
const snapshot = { ...mockSnapshot, account }
createRoot(document.getElementById('root')!).render(<div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}><header style={{ padding: '12px 18px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}><strong>智能体工作台</strong><span style={{ marginLeft: 12, color: 'var(--text-secondary)', fontSize: 12 }}>合成数据界面验收 · 不访问真实账号</span></header><div className="page-scroll agent-workspace-fixed-page"><AgentWorkspacePage snapshot={snapshot} onLogin={() => { expired = false }} /></div></div>)
