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

export type AgentRoomAccess = 'workspace_write'
export type AgentRoomApprovalPolicy = 'bounded_run'
export type AgentRoomRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'unknown' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled'
export type AgentRoomSessionState = 'pending' | 'ready' | 'broken'
export type AgentRoomMessageSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; memberId: string }

export interface AgentRoomSummary {
  contractVersion: 2
  id: string
  name: string
  coordinatorMemberId: string
  maxSteps: number
  defaultAccess: AgentRoomAccess
  approvalPolicy: AgentRoomApprovalPolicy
  definitionRevision: string | number
  stateRevision: string | number
  status: string
  activeRunId?: string
  latestRunStatus?: AgentRoomRunStatus | string
  updatedAt?: string
}
export interface AgentRoomMember {
  id: string
  displayName: string
  mentionHandle: string
  responsibility: string
  agentId: string
  agentName: string
  adapterCode: string
  projectId: string
  projectName: string
  sessionLabel: string
  nativeSessionId?: string
  sessionState: AgentRoomSessionState
  status: string
  canDispatch: boolean
  dispatchErrorCode?: string
  readinessSource?: string
  statusMessage?: string
}
export interface AgentRoomMessage {
  id: string
  roomId: string
  seq: number
  runId?: string
  actionId?: string
  authorType: 'user' | 'member' | 'system'
  authorMemberId?: string
  authorName?: string
  messageType: string
  replyToMessageId?: string
  body: string
  segments: AgentRoomMessageSegment[]
  mentions: Array<{ memberId: string; displayName: string; mentionHandle: string }>
  createdAt?: string
  contentAvailable: boolean
  contentPrunedAt?: string
  truncated?: boolean
}
export interface AgentRoomRun {
  id: string
  roomId: string
  rootMessageId: string
  routingKind: string
  coordinatorMemberId: string
  targetMemberIds: string[]
  definitionRevision: string | number
  maxSteps: number
  approvalPolicy: AgentRoomApprovalPolicy
  status: AgentRoomRunStatus | string
  stepCount: number
  access: AgentRoomAccess
  requiresApproval: boolean
  approvalId?: string
  approvedAt?: string
  finalMessageId?: string
  errorCode?: string
  cancelRequestedAt?: string
  deadlineAt?: string
  createdAt?: string
  startedAt?: string
  completedAt?: string
  contentAvailable: boolean
  contentPrunedAt?: string
  updatedAt?: string
}
export interface AgentRoomAction {
  id: string
  runId: string
  memberId?: string
  memberName?: string
  ordinal: number
  actionType: string
  parentActionId?: string
  triggerMessageId?: string
  assignmentMessageId?: string
  reportMessageId?: string
  taskId?: string
  sessionMode?: string
  status: string
  taskStatus?: string
  instruction?: string
  summary: string
  finalText?: string
  errorCode?: string
  directiveType?: string
  contextThroughSeq?: number
  contentTruncated?: boolean
  createdAt?: string
  completedAt?: string
}
export interface AgentRoomDetailWindow {
  maxMessages: number
  maxActions: number
  messageCount: number
  actionCount: number
  hasEarlierMessages: boolean
  hasLaterMessages: boolean
  hasMoreActions: boolean
}
export interface AgentRoomDetail {
  room: AgentRoomSummary
  members: AgentRoomMember[]
  messages: AgentRoomMessage[]
  runs: AgentRoomRun[]
  actions: AgentRoomAction[]
  detailRevision?: string
  window?: AgentRoomDetailWindow
}
export interface AgentRoomMemberInput {
  id: string
  displayName: string
  mentionHandle: string
  responsibility: string
  agentId: string
  projectId: string
  sessionLabel: string
}
export interface AgentWorkspaceRequest {
  scope: 'hub' | 'devices' | 'checkin'
  method: 'GET' | 'POST'
  action?: string
  params?: Record<string, string>
  body?: Record<string, unknown>
}
