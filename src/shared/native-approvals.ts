export interface NativeApproval {
  id: string; requestHash: string; turnId: string; itemId: string
  kind: 'command' | 'file' | 'permissions' | 'network' | 'unsupported'
  title: string; reason: string; command?: string; cwd?: string; paths: string[]; details?: string
  state: 'pending' | 'submitted' | 'confirmed' | 'resolved' | 'unconfirmed' | 'expired'
  canApprove: boolean; canReject: boolean; expiresAt: number; approved?: boolean
}
export interface NativeApprovalSnapshot {
  sessionId: string; status: 'ready' | 'unavailable' | 'offline'; message: string
  readAt: string; requests: NativeApproval[]
}
