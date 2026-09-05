export type AgentAdapter = 'codex' | 'claude-code' | 'qclaw'
export interface LocalAgentBinding {
  id: string
  name: string
  adapter: AgentAdapter
  projectRoots: string[]
  autoStart: boolean
  status: 'stopped' | 'starting' | 'online' | 'reconnecting' | 'failed'
  runtimeStatus: string
  busy: boolean
  message?: string
}
export interface AgentHostSnapshot {
  supported: boolean
  enabled: boolean
  deviceId?: string
  deviceName: string
  ownerUserId?: string
  connection: 'unbound' | 'connecting' | 'online' | 'offline' | 'revoked'
  lastHeartbeatAt?: string
  message?: string
  agents: LocalAgentBinding[]
  discovered: Array<{ adapter: AgentAdapter; name: string; available: boolean; message: string }>
}
export type AgentHostAction =
  | { action: 'discover' | 'bind_device' | 'pause' | 'resume' | 'revoke_device' }
  | { action: 'add_agent'; adapter: AgentAdapter; name?: string }
  | { action: 'start' | 'stop' | 'restart' | 'remove_agent' | 'add_project'; agentId: string }
export interface AgentWorkspaceRequest {
  scope: 'hub' | 'devices' | 'checkin'
  method: 'GET' | 'POST'
  action?: string
  params?: Record<string, string>
  body?: Record<string, unknown>
}
