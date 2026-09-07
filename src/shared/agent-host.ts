export type AgentAdapter = 'codex' | 'claude-code' | 'qclaw'
export interface LocalCatalog {
  scannedAt: string
  projects: Array<{ id: string; adapter: AgentAdapter; name: string; path: string; lastActivityAt: string }>
  sessions: Array<{ id: string; projectId: string; adapter: AgentAdapter; runtimeSessionId: string; title: string; lastActivityAt: string; status: string }>
  errors: string[]
  models?: Array<{ id: string; name: string; adapter: AgentAdapter }>
}
export interface LocalTask { id: string; projectId: string; sessionId?: string; requestId: string; status: 'running' | 'delivered' | 'unconfirmed' | 'completed' | 'failed' | 'cancelled'; instruction: string; summary: string; reply?: string; startedAt: string; backend?: 'desktop'; baselineTurnId?: string; baselineItemIds?: string[]; deliveryTurnId?: string; deliveryPrompt?: string }
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
  lastCatalogAt?: string
  lastSyncedAt?: string
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
  localCatalog?: LocalCatalog
  desktopRelay?: { ready: boolean; message: string }
  localFiles?: Array<{ id: string; name: string; byteSize: number; mediaKind: string }>
  localTasks?: LocalTask[]
  localHistory?: { sessionId: string; readAt: string; messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; occurredAt: string }> }
  discovered: Array<{ adapter: AgentAdapter; name: string; available: boolean; message: string }>
}
export type AgentHostAction =
  | { action: 'scan_local' }
  | { action: 'refresh_local_models' }
  | { action: 'read_local_history'; sessionId: string }
  | { action: 'bind_local_project'; projectId: string }
  | { action: 'choose_local_files' }
  | { action: 'send_local'; projectId: string; sessionId?: string; instruction: string; requestId: string; model?: string; fileIds?: string[] }
  | { action: 'cancel_local'; taskId: string }
  | { action: 'discover' | 'bind_device' | 'pause' | 'resume' | 'revoke_device' }
  | { action: 'add_agent'; adapter: AgentAdapter; name?: string }
  | { action: 'start' | 'stop' | 'restart' | 'remove_agent' | 'add_project' | 'refresh'; agentId: string }
export interface AgentWorkspaceRequest {
  scope: 'hub' | 'devices' | 'checkin'
  method: 'GET' | 'POST'
  action?: string
  params?: Record<string, string>
  body?: Record<string, unknown>
}
