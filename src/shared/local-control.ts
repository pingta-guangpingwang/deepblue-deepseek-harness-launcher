export type LocalPermissionMode = 'ask' | 'assist' | 'full'
export interface LocalRuntimeDescriptor {
  id: string; name: string; adapter: string
  projects: Array<{ id: string; name: string; path: string; cloudAllowed?: boolean }>
  capabilities: { approvalControl: boolean; richEvents: boolean; localExecution: boolean }
  runtime?: Record<string, unknown>
}
export interface LocalRoomMember { id: string; displayName: string; mentionHandle: string; responsibility?: string; agentId: string; projectId: string; projectPath?: string; adapter?: string; sessionLabel?: string; runtimeSessionId?: string; sessionState?: string }
export interface LocalFileMetadata { id: string; roomId: string; name: string; byteSize: number; sha256: string; mime: string; previewKind: string; cloudStatus: string }
export interface LocalControlSnapshot {
  collaborationSafety?: number
  emptyProjectCreation?: boolean
  onlineConnected?: boolean
  supported: boolean; protocol: number; version: number; replicaId?: string; busy: boolean; error?: string
  rooms: Array<{ id: string; name: string; permissionMode: LocalPermissionMode; permissionRevision: number; memberCount: number; cloudSync: boolean; syncState?: string; syncError?: string; lastSyncedAt?: string; status: string; pendingApprovals: number }>
  catalog: LocalRuntimeDescriptor[]
  fileProgress?: { fileId: string; phase: string; bytes: number; total: number }
  lastResult?: Record<string, unknown>
}
export interface LocalControlEvent { id: string; roomId: string; seq: number; kind: string; payload: Record<string, any>; createdAt: string }
export interface LocalRoomDetail {
  room: { id: string; name: string; members: LocalRoomMember[]; coordinatorMemberId: string; permissionMode: LocalPermissionMode; permissionRevision: number; cloudSync: boolean; syncState?: string; syncError?: string; lastSyncedAt?: string; maxSteps: number; workspaceMode?: 'shared' | 'worktree'; workspaces?: Array<{ id: string; path: string; sourcePath: string; branch: string; preflight?: { status: string; message: string; conflictPaths?: string[] } }> }
  history: { items: LocalControlEvent[]; total: number; hasEarlier: boolean; hasLater: boolean; latestSeq?: number }
  runs: Array<{ id: string; status: string; phase?: string; validationStatus?: string; instruction: string; summary?: string; stepCount: number; maxSteps: number }>
  approvals: Array<{ id: string; memberId: string; requestHash: string; reason?: string; stage?: string; proposal: { kind: string; command?: string; paths?: string[]; reason?: string }; status: string }>
  files: LocalFileMetadata[]
}
export type LocalControlCommand = 'snapshot' | 'create_room' | 'read_room' | 'read_event' | 'send_room' | 'cancel_run' | 'reconcile_run' | 'accept_run' | 'preflight_merge' | 'set_permission' | 'decide_approval' | 'choose_files' | 'preview_file' | 'open_file' | 'save_file' | 'set_cloud_sync' | 'refresh_catalog' | 'authorize_project'
