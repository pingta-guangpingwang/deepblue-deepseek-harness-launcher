import type { AgentAdapter, AgentHostSnapshot } from './agent-host'

// Connection inventory and native-history reader coverage are different facts.
export type AgentAssociationMode = 'self_register' | 'built_in' | 'unavailable'
export const AGENT_CATALOG: ReadonlyArray<{ id: AgentAdapter; name: string; nativeHistory: boolean; execution: boolean; associationMode: AgentAssociationMode }> = [
  { id: 'codex', name: 'Codex', nativeHistory: true, execution: true, associationMode: 'self_register' },
  { id: 'claude-code', name: 'Claude Code', nativeHistory: true, execution: true, associationMode: 'self_register' },
  { id: 'cursor', name: 'Cursor', nativeHistory: false, execution: true, associationMode: 'self_register' },
  { id: 'qclaw', name: 'QClaw / OpenClaw', nativeHistory: true, execution: true, associationMode: 'self_register' },
  { id: 'workbuddy', name: 'WorkBuddy', nativeHistory: false, execution: true, associationMode: 'self_register' },
  { id: 'codebuddy', name: 'CodeBuddy', nativeHistory: false, execution: true, associationMode: 'self_register' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', nativeHistory: false, execution: true, associationMode: 'built_in' },
  { id: 'trae', name: 'TRAE', nativeHistory: false, execution: false, associationMode: 'unavailable' }
]
export const agentName = (id: string): string => AGENT_CATALOG.find(agent => agent.id === id)?.name || id || '智能体'
export const agentAssociationMode = (id: AgentAdapter): AgentAssociationMode => AGENT_CATALOG.find(agent => agent.id === id)?.associationMode || 'unavailable'
export function localAgentStatus(adapter: AgentAdapter, host?: AgentHostSnapshot): string {
  if (agentAssociationMode(adapter) === 'unavailable') return '暂未打通'
  const binding = host?.agents.find(agent => agent.adapter === adapter)
  if (binding?.busy) return '执行中'
  if (binding?.status === 'online' && binding.runtimeStatus === 'ready') return '执行就绪'
  if (binding) return binding.status === 'failed' ? '连接失败' : '已关联 · 未就绪'
  if (host?.associations?.some(item => item.adapter === adapter && item.status === 'verified')) return '接口已验证'
  if (host?.discovered.some(item => item.adapter === adapter && item.available)) return '已检测到接口'
  if (host?.localCatalog?.projects.some(project => project.adapter === adapter)) return '本机记录可读'
  return '未关联'
}
