import type { AgentAdapter, AgentHostSnapshot } from './agent-host'

// Connection inventory and native-history reader coverage are different facts.
export const AGENT_CATALOG: ReadonlyArray<{ id: AgentAdapter; name: string; nativeHistory: boolean; execution: boolean }> = [
  { id: 'codex', name: 'Codex', nativeHistory: true, execution: true },
  { id: 'claude-code', name: 'Claude Code', nativeHistory: true, execution: true },
  { id: 'cursor', name: 'Cursor', nativeHistory: false, execution: true },
  { id: 'qclaw', name: 'QClaw / OpenClaw', nativeHistory: true, execution: true },
  { id: 'workbuddy', name: 'WorkBuddy', nativeHistory: false, execution: true },
  { id: 'codebuddy', name: 'CodeBuddy', nativeHistory: false, execution: true },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', nativeHistory: false, execution: true },
  { id: 'trae', name: 'TRAE', nativeHistory: false, execution: false }
]
export const agentName = (id: string): string => AGENT_CATALOG.find(agent => agent.id === id)?.name || id || '智能体'
export function localAgentStatus(adapter: AgentAdapter, host?: AgentHostSnapshot): string {
  if (adapter === 'trae') return '暂不支持执行'
  const binding = host?.agents.find(agent => agent.adapter === adapter)
  if (binding?.busy) return '执行中'
  if (binding?.status === 'online' && binding.runtimeStatus === 'ready') return '执行就绪'
  if (binding) return binding.status === 'failed' ? '连接失败' : '已关联 · 未就绪'
  if (host?.associations?.some(item => item.adapter === adapter && item.status === 'verified')) return '接口已验证'
  if (host?.discovered.some(item => item.adapter === adapter && item.available)) return '已检测到接口'
  if (host?.localCatalog?.projects.some(project => project.adapter === adapter)) return '本机记录可读'
  return '未关联'
}
