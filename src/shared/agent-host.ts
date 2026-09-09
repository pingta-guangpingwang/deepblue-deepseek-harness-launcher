export type AgentAdapter = 'codex' | 'claude-code' | 'qclaw' | 'workbuddy' | 'codebuddy' | 'trae'
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
  accountConnection?: { status: 'signed_out' | 'checking' | 'connected' | 'failed'; checkedAt?: string; message?: string }
  cloudAgents?: Array<{ id: string; name: string; adapter: string; reportedStatus: string }>
  legacyCandidates?: Array<{ adapter: AgentAdapter; available: boolean; projectRoots: string[]; message: string }>
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
  | { action: 'rename_device'; name: string }
  | { action: 'check_connection' }
  | { action: 'discover_existing' }
  | { action: 'import_existing'; agentId: string }
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

export type AgentSessionGroupMode = 'manual' | 'coordinator'
export type AgentSessionGroupRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'unknown' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled'
export interface AgentSessionGroupSummary {
  id: string
  name: string
  mode: AgentSessionGroupMode
  maxTurns: number
  coordinatorRoleId?: string
  roleCount: number
  activeRunCount: number
  latestRunStatus?: AgentSessionGroupRunStatus | string
  status: string
  activeRunId?: string
  updatedAt?: string
}
export interface AgentSessionGroupRole {
  id: string
  name: string
  responsibility: string
  agentId: string
  agentName: string
  projectId: string
  projectName: string
  nativeSessionId: string
  nativeSessionTitle: string
  status: string
  readinessSource?: 'host' | 'standalone' | string
  message?: string
}
export interface AgentSessionGroupRun {
  id: string
  instruction: string
  status: AgentSessionGroupRunStatus | string
  summary: string
  finalText?: string
  clientRequestId?: string
  targetRoleIds: string[]
  mode: AgentSessionGroupMode
  coordinatorRoleId?: string
  maxTurns: number
  createdAt?: string
  completedAt?: string
  contentAvailable: boolean
  contentTruncated?: boolean
  contentPrunedAt?: string
}
export interface AgentSessionGroupAction {
  id: string
  runId: string
  roleId?: string
  ordinal: number
  actionType: string
  status: string
  taskStatus?: string
  instruction?: string
  summary: string
  finalText?: string
  errorCode?: string
  approvalRequired?: boolean
  approvalReason?: string
  approvedAt?: string
  contentTruncated?: boolean
  createdAt?: string
}
export interface AgentSessionGroupDetailWindow {
  maxRuns: number
  maxActions: number
  runCount: number
  actionCount: number
  hasMoreRuns: boolean
  hasMoreActions: boolean
  maxRunBodyChars: number
  maxActionInstructionChars: number
  maxActionResultChars: number
}
export interface AgentSessionGroupDetail {
  group: AgentSessionGroupSummary
  roles: AgentSessionGroupRole[]
  runs: AgentSessionGroupRun[]
  actions: AgentSessionGroupAction[]
  detailRevision?: string
  window?: AgentSessionGroupDetailWindow
}
export interface AgentSessionGroupRoleInput {
  id: string
  name: string
  responsibility: string
  agentId: string
  projectId: string
  nativeSessionId: string
}
export interface AgentWorkspaceRequest {
  scope: 'hub' | 'devices' | 'checkin'
  method: 'GET' | 'POST'
  action?: string
  params?: Record<string, string>
  body?: Record<string, unknown>
}
