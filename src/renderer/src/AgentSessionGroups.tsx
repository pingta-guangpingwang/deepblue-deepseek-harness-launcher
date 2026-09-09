import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AtSign, Bot, CheckCircle2, CircleAlert, ClipboardList, LoaderCircle, MessageSquare, Pencil, Plus, RefreshCw, Send, Square, Trash2, Users, Wrench, X } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type { AgentRoomAccess, AgentRoomAction, AgentRoomDetail, AgentRoomMember, AgentRoomMemberInput, AgentRoomMessage, AgentRoomMessageSegment, AgentRoomRun, AgentRoomSummary, AgentWorkspaceRequest } from '../../shared/agent-host'
import './agent-session-groups.css'
import { AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION, launcherSupportsAgentSessionGroups } from './agent-session-groups-support'

type JsonRecord = Record<string, unknown>
interface CandidateProject { id: string; agentId: string; name: string }
interface CandidateAgent { id: string; name: string; adapter: string; status: string; canDispatch: boolean; statusMessage?: string; projects: CandidateProject[] }
interface CandidateCatalog { agents: CandidateAgent[]; truncated: { agents: boolean; projects: boolean }; limits: { agents: number; projects: number } }
interface RoomEditorState {
  roomId?: string
  name: string
  coordinatorMemberId: string
  maxSteps: number
  defaultAccess: AgentRoomAccess
  expectedDefinitionRevision?: string | number
  members: AgentRoomMemberInput[]
}
export interface RoomMentionToken { memberId: string; start: number; end: number; label: string }

const ACTIVE_RUNS = new Set(['queued', 'running', 'awaiting_approval', 'cancel_requested', 'unknown'])
const DOWNLOAD_URL = 'https://deepseek.ailishishu.com/'
const DEFAULT_MAX_STEPS = 12
const DEFAULT_ACCESS: AgentRoomAccess = 'workspace_write'
const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const rows = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const revision = (value: unknown): string | number => typeof value === 'number' && Number.isSafeInteger(value) ? value : text(value)
const field = (row: JsonRecord, ...keys: string[]): unknown => keys.map(key => row[key]).find(value => value !== undefined && value !== null)
const bool = (value: unknown): boolean => value === true || Number(value) === 1
const boundedSteps = (value: unknown): number => Math.max(1, Math.min(12, Number(value) || DEFAULT_MAX_STEPS))
const normalizedAccess = (_value: unknown): AgentRoomAccess => 'workspace_write'

export function roomStatusLabel(value: string): string {
  return ({
    active: '待命', idle: '待命', ready: '已就绪', online: '已在线', busy: '忙碌', working: '执行中', stopped: '已停止', offline: '等待连接',
    needs_login: '需要本机登录', unavailable: '暂不支持', pending: '会话待创建', broken: '会话需修复', queued: '排队中', running: '执行中',
    awaiting_approval: '等待你确认', approved: '已允许', reserved: '等待连接', cancel_requested: '取消中', unknown: '结果待确认', cancelled: '已取消', completed: '已完成', failed: '失败'
  } as Record<string, string>)[value] || value || '待检查'
}

export function roomRunActive(status: string): boolean { return ACTIVE_RUNS.has(status) }

export function normalizeRoomSummary(value: unknown): AgentRoomSummary {
  const row = object(value)
  return {
    id: text(field(row, 'id', 'room_id', 'roomId')),
    name: text(field(row, 'name', 'display_name', 'displayName')) || '未命名房间',
    coordinatorMemberId: text(field(row, 'coordinator_member_id', 'coordinatorMemberId')),
    maxSteps: boundedSteps(field(row, 'max_steps', 'maxSteps')),
    defaultAccess: normalizedAccess(field(row, 'default_access', 'defaultAccess')),
    definitionRevision: revision(field(row, 'definition_revision', 'definitionRevision')),
    stateRevision: revision(field(row, 'state_revision', 'stateRevision')),
    status: text(row.status) || 'active',
    activeRunId: text(field(row, 'active_run_id', 'activeRunId')) || undefined,
    latestRunStatus: text(field(row, 'latest_run_status', 'latestRunStatus')) || undefined,
    updatedAt: text(field(row, 'updated_at', 'updatedAt')) || undefined
  }
}

function normalizeMember(value: unknown): AgentRoomMember {
  const row = object(value)
  const sessionState = text(field(row, 'session_state', 'sessionState'))
  const nativeSessionId = text(field(row, 'native_session_id', 'nativeSessionId')) || undefined
  return {
    id: text(field(row, 'id', 'member_id', 'memberId')),
    displayName: text(field(row, 'display_name', 'displayName', 'name')) || '未命名成员',
    mentionHandle: text(field(row, 'mention_handle', 'mentionHandle')).replace(/^@/, ''),
    responsibility: text(field(row, 'responsibility', 'duty', 'description')),
    agentId: text(field(row, 'agent_id', 'agentId')),
    agentName: text(field(row, 'agent_name', 'agentName')) || '智能体',
    adapterCode: text(field(row, 'adapter_code', 'adapterCode')),
    projectId: text(field(row, 'project_id', 'projectId')),
    projectName: text(field(row, 'project_name', 'projectName')) || '未命名项目',
    sessionLabel: text(field(row, 'session_label', 'sessionLabel')) || '房间会话',
    nativeSessionId,
    sessionState: sessionState === 'ready' || sessionState === 'broken' ? sessionState : nativeSessionId ? 'ready' : 'pending',
    status: text(field(row, 'runtime_status', 'runtimeStatus', 'status')) || 'unknown',
    canDispatch: bool(field(row, 'can_dispatch', 'canDispatch')),
    dispatchErrorCode: text(field(row, 'dispatch_error_code', 'dispatchErrorCode')) || undefined,
    readinessSource: text(field(row, 'readiness_source', 'readinessSource')) || undefined,
    statusMessage: text(field(row, 'status_message', 'statusMessage')) || undefined
  }
}

function normalizeSegments(value: unknown, fallbackBody: string): AgentRoomMessageSegment[] {
  const segments = rows(value).flatMap((row): AgentRoomMessageSegment[] => {
    if (row.type === 'mention' && text(field(row, 'member_id', 'memberId'))) return [{ type: 'mention', memberId: text(field(row, 'member_id', 'memberId')) }]
    if (row.type === 'text' && typeof row.text === 'string') return [{ type: 'text', text: row.text }]
    return []
  })
  return segments.length ? segments : fallbackBody ? [{ type: 'text', text: fallbackBody }] : []
}

function normalizeMessage(value: unknown): AgentRoomMessage {
  const row = object(value)
  const body = text(field(row, 'body', 'body_text', 'bodyText'))
  const author = text(field(row, 'author_type', 'authorType'))
  return {
    id: text(field(row, 'id', 'message_id', 'messageId')),
    seq: Math.max(0, Number(field(row, 'seq', 'message_seq', 'messageSeq')) || 0),
    runId: text(field(row, 'run_id', 'runId')) || undefined,
    actionId: text(field(row, 'action_id', 'actionId')) || undefined,
    authorType: author === 'member' || author === 'system' ? author : 'user',
    authorMemberId: text(field(row, 'author_member_id', 'authorMemberId')) || undefined,
    authorName: text(field(row, 'author_name', 'authorName')) || undefined,
    messageType: text(field(row, 'message_type', 'messageType')) || 'chat',
    replyToMessageId: text(field(row, 'reply_to_message_id', 'replyToMessageId')) || undefined,
    body,
    segments: normalizeSegments(row.segments, body),
    mentions: rows(row.mentions).map(item => ({ memberId: text(field(item, 'member_id', 'memberId')), displayName: text(field(item, 'display_name', 'displayName')), mentionHandle: text(field(item, 'mention_handle', 'mentionHandle')).replace(/^@/, '') })).filter(item => item.memberId),
    createdAt: text(field(row, 'created_at', 'createdAt')) || undefined,
    contentAvailable: field(row, 'content_available', 'contentAvailable') !== false,
    contentPrunedAt: text(field(row, 'content_pruned_at', 'contentPrunedAt')) || undefined,
    truncated: bool(field(row, 'truncated', 'content_truncated', 'contentTruncated'))
  }
}

function normalizeRun(value: unknown): AgentRoomRun {
  const row = object(value)
  return {
    id: text(field(row, 'id', 'run_id', 'runId')),
    roomId: text(field(row, 'room_id', 'roomId')),
    rootMessageId: text(field(row, 'root_message_id', 'rootMessageId')),
    routingKind: text(field(row, 'routing_kind', 'routingKind')) || 'coordinator',
    coordinatorMemberId: text(field(row, 'coordinator_member_id', 'coordinatorMemberId')),
    targetMemberIds: Array.isArray(field(row, 'target_member_ids', 'targetMemberIds')) ? (field(row, 'target_member_ids', 'targetMemberIds') as unknown[]).map(text).filter(Boolean) : [],
    definitionRevision: revision(field(row, 'definition_revision', 'definitionRevision')),
    maxSteps: boundedSteps(field(row, 'max_steps', 'maxSteps')),
    status: text(row.status) || 'queued',
    stepCount: Math.max(0, Number(field(row, 'step_count', 'stepCount')) || 0),
    access: normalizedAccess(row.access),
    requiresApproval: bool(field(row, 'requires_approval', 'requiresApproval')),
    approvalId: text(field(row, 'approval_id', 'approvalId')) || undefined,
    approvedAt: text(field(row, 'approved_at', 'approvedAt')) || undefined,
    finalMessageId: text(field(row, 'final_message_id', 'finalMessageId')) || undefined,
    errorCode: text(field(row, 'error_code', 'errorCode')) || undefined,
    cancelRequestedAt: text(field(row, 'cancel_requested_at', 'cancelRequestedAt')) || undefined,
    deadlineAt: text(field(row, 'deadline_at', 'deadlineAt')) || undefined,
    createdAt: text(field(row, 'created_at', 'createdAt')) || undefined,
    startedAt: text(field(row, 'started_at', 'startedAt')) || undefined,
    completedAt: text(field(row, 'completed_at', 'completedAt')) || undefined,
    contentAvailable: field(row, 'content_available', 'contentAvailable') !== false,
    contentPrunedAt: text(field(row, 'content_pruned_at', 'contentPrunedAt')) || undefined,
    updatedAt: text(field(row, 'updated_at', 'updatedAt')) || undefined
  }
}

function normalizeAction(value: unknown): AgentRoomAction {
  const row = object(value)
  return {
    id: text(field(row, 'id', 'action_id', 'actionId')),
    runId: text(field(row, 'run_id', 'runId')),
    memberId: text(field(row, 'member_id', 'memberId')) || undefined,
    memberName: text(field(row, 'member_name', 'memberName')) || undefined,
    ordinal: Math.max(0, Number(row.ordinal) || 0),
    actionType: text(field(row, 'action_type', 'actionType', 'type')) || 'update',
    parentActionId: text(field(row, 'parent_action_id', 'parentActionId')) || undefined,
    triggerMessageId: text(field(row, 'trigger_message_id', 'triggerMessageId')) || undefined,
    assignmentMessageId: text(field(row, 'assignment_message_id', 'assignmentMessageId')) || undefined,
    reportMessageId: text(field(row, 'report_message_id', 'reportMessageId')) || undefined,
    taskId: text(field(row, 'task_id', 'taskId')) || undefined,
    sessionMode: text(field(row, 'session_mode', 'sessionMode')) || undefined,
    status: text(field(row, 'effective_status', 'effectiveStatus', 'status', 'task_status', 'taskStatus')) || 'queued',
    taskStatus: text(field(row, 'task_status', 'taskStatus')) || undefined,
    instruction: text(row.instruction) || undefined,
    summary: text(field(row, 'summary', 'latest_summary', 'latestSummary')),
    finalText: text(field(row, 'final_text', 'finalText')) || undefined,
    errorCode: text(field(row, 'error_code', 'errorCode')) || undefined,
    directiveType: text(field(row, 'directive_type', 'directiveType')) || undefined,
    contextThroughSeq: Math.max(0, Number(field(row, 'context_through_seq', 'contextThroughSeq')) || 0) || undefined,
    contentTruncated: bool(field(row, 'content_truncated', 'contentTruncated')),
    createdAt: text(field(row, 'created_at', 'createdAt')) || undefined,
    completedAt: text(field(row, 'completed_at', 'completedAt')) || undefined
  }
}

function sortRoomRuns(runs: AgentRoomRun[], messages: AgentRoomMessage[]): AgentRoomRun[] {
  const messageSeq = new Map(messages.map(message => [message.id, message.seq]))
  return [...runs].sort((left, right) => (messageSeq.get(right.rootMessageId) || 0) - (messageSeq.get(left.rootMessageId) || 0) || (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0))
}

export function normalizeRoomDetail(value: unknown): AgentRoomDetail {
  const response = object(value)
  const rawWindow = object(response.window)
  const messages = rows(response.messages).map(normalizeMessage).filter(message => message.id).sort((left, right) => left.seq - right.seq)
  const runs = sortRoomRuns(rows(response.runs).map(normalizeRun).filter(run => run.id), messages)
  return {
    room: normalizeRoomSummary(response.room),
    members: rows(response.members).map(normalizeMember).filter(member => member.id),
    messages,
    runs,
    actions: rows(response.actions).map(normalizeAction).filter(action => action.id).sort((left, right) => left.ordinal - right.ordinal),
    detailRevision: text(field(response, 'detail_revision', 'detailRevision')) || undefined,
    window: Object.keys(rawWindow).length ? {
      maxMessages: Math.max(0, Number(field(rawWindow, 'max_messages', 'maxMessages')) || 0),
      maxActions: Math.max(0, Number(field(rawWindow, 'max_actions', 'maxActions')) || 0),
      messageCount: Math.max(0, Number(field(rawWindow, 'message_count', 'messageCount')) || 0),
      actionCount: Math.max(0, Number(field(rawWindow, 'action_count', 'actionCount')) || 0),
      hasEarlierMessages: bool(field(rawWindow, 'has_earlier_messages', 'hasEarlierMessages')),
      hasLaterMessages: bool(field(rawWindow, 'has_later_messages', 'hasLaterMessages')),
      hasMoreActions: bool(field(rawWindow, 'has_more_actions', 'hasMoreActions'))
    } : undefined
  }
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) merged.set(item.id, item)
  return [...merged.values()]
}

export function mergeRoomDetail(current: AgentRoomDetail | undefined, incoming: AgentRoomDetail, preserveEarlierMessages = true): AgentRoomDetail {
  if (!current) return incoming
  if (current.room.id !== incoming.room.id) return current
  const window = incoming.window || current.window
  const messages = mergeById(current.messages, incoming.messages).sort((left, right) => left.seq - right.seq)
  const runs = sortRoomRuns(mergeById(current.runs, incoming.runs), messages)
  return {
    ...incoming,
    room: incoming.room.id ? incoming.room : current.room,
    members: incoming.members.length ? incoming.members : current.members,
    messages,
    runs,
    actions: mergeById(current.actions, incoming.actions).sort((left, right) => left.ordinal - right.ordinal),
    window: window && preserveEarlierMessages && current.window ? { ...window, hasEarlierMessages: current.window.hasEarlierMessages || window.hasEarlierMessages } : window
  }
}

function normalizeCandidates(value: unknown): CandidateCatalog | undefined {
  const catalog = object(value)
  if (!Array.isArray(catalog.agents) || !Array.isArray(catalog.projects)) return
  const projects = rows(catalog.projects).map(row => ({ id: text(row.id), agentId: text(field(row, 'agent_id', 'agentId')), name: text(field(row, 'source_name', 'sourceName', 'name')) || '未命名项目' })).filter(project => project.id && project.agentId)
  const agents = rows(catalog.agents).map(row => {
    const id = text(row.id)
    return { id, name: text(field(row, 'display_name', 'displayName', 'name')) || text(field(row, 'adapter_code', 'adapterCode')) || '智能体', adapter: text(field(row, 'adapter_code', 'adapterCode')), status: text(field(row, 'runtime_status', 'runtimeStatus', 'status')) || 'unknown', canDispatch: bool(field(row, 'can_dispatch', 'canDispatch')), statusMessage: text(field(row, 'status_message', 'statusMessage')) || undefined, projects: projects.filter(project => project.agentId === id) }
  }).filter(agent => agent.id)
  const truncated = object(catalog.truncated)
  const limits = object(catalog.limits)
  return { agents, truncated: { agents: bool(truncated.agents), projects: bool(truncated.projects) }, limits: { agents: Math.max(0, Number(limits.agents) || 0), projects: Math.max(0, Number(limits.projects) || 0) } }
}

function newMemberId(): string { return crypto.randomUUID().replaceAll('-', '') }
function blankMember(index: number): AgentRoomMemberInput { return { id: newMemberId(), displayName: '', mentionHandle: `agent-${index + 1}`, responsibility: '', agentId: '', projectId: '', sessionLabel: '' } }

export function validateRoomDraft(draft: RoomEditorState): string {
  if (!draft.name.trim() || [...draft.name.trim()].length > 80) return '房间名称需为 1–80 个字符。'
  if (draft.members.length < 2) return '请至少配置主控和一名协作成员。'
  const handles = new Set<string>()
  for (const member of draft.members) {
    if (!member.displayName.trim() || [...member.displayName.trim()].length > 60) return '每位成员都需要一个清晰的显示名称。'
    const handle = member.mentionHandle.trim().replace(/^@/, '').toLowerCase()
    if (!/^[\p{L}\p{N}_.-]{1,40}$/u.test(member.mentionHandle.trim().replace(/^@/, ''))) return `“${member.displayName.trim()}”的 @名称需为 1–40 位文字、数字、下划线、句点或短横线。`
    if (handles.has(handle)) return `@${handle} 已被其他成员使用。`
    handles.add(handle)
    if (!member.responsibility.trim() || [...member.responsibility.trim()].length > 500) return `请填写“${member.displayName.trim()}”的职责。`
    if (!member.agentId || !member.projectId) return `请为“${member.displayName.trim()}”选择已有智能体和授权项目。`
    if (!member.sessionLabel.trim() || [...member.sessionLabel.trim()].length > 80) return `请为“${member.displayName.trim()}”命名本房间的独立会话。`
  }
  if (!draft.members.some(member => member.id === draft.coordinatorMemberId)) return '请选择一位房间主控。'
  return ''
}

export function reconcileMentionTokens(previousText: string, nextText: string, tokens: RoomMentionToken[]): RoomMentionToken[] {
  if (previousText === nextText) return tokens
  let prefix = 0
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix += 1
  let suffix = 0
  while (suffix < previousText.length - prefix && suffix < nextText.length - prefix && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]) suffix += 1
  const oldEnd = previousText.length - suffix
  const delta = nextText.length - previousText.length
  return tokens.flatMap(token => token.end <= prefix ? [token] : token.start >= oldEnd ? [{ ...token, start: token.start + delta, end: token.end + delta }] : []).filter(token => nextText.slice(token.start, token.end) === token.label)
}

export function buildRoomMessageContent(value: string, tokens: RoomMentionToken[]): AgentRoomMessageSegment[] {
  const ordered = [...tokens].filter(token => token.start >= 0 && token.end > token.start && value.slice(token.start, token.end) === token.label).sort((left, right) => left.start - right.start)
  const content: AgentRoomMessageSegment[] = []
  let cursor = 0
  for (const token of ordered) {
    if (token.start < cursor) continue
    if (token.start > cursor) content.push({ type: 'text', text: value.slice(cursor, token.start) })
    content.push({ type: 'mention', memberId: token.memberId }); cursor = token.end
  }
  if (cursor < value.length) content.push({ type: 'text', text: value.slice(cursor) })
  return content.filter(segment => segment.type === 'mention' || segment.text.length > 0)
}

export function roomMessageSignature(value: { roomId: string; content: AgentRoomMessageSegment[]; replyToMessageId?: string; access: AgentRoomAccess; expectedDefinitionRevision: string | number }): string { return JSON.stringify(value) }

function timestamp(value?: string): string {
  if (!value) return '刚刚'
  const time = Date.parse(value)
  return time ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : value
}

function Status({ value }: { value: string }): React.JSX.Element {
  const tone = ['active', 'ready', 'completed', 'idle', 'approved'].includes(value) ? 'good' : ['failed', 'offline', 'needs_login', 'unavailable', 'unknown', 'broken'].includes(value) ? 'bad' : ['queued', 'running', 'awaiting_approval', 'cancel_requested', 'busy', 'pending', 'reserved'].includes(value) ? 'pending' : 'neutral'
  return <span className={`arm-status ${tone}`}><i aria-hidden="true" />{roomStatusLabel(value)}</span>
}

function MessageBody({ message, members }: { message: AgentRoomMessage; members: Map<string, AgentRoomMember> }): React.JSX.Element {
  if (!message.contentAvailable) return <span className="arm-pruned">这条正文已按保留策略清理。</span>
  return <>{message.segments.map((segment, index) => segment.type === 'text' ? <span key={`${message.id}-text-${index}`}>{segment.text}</span> : <span className="arm-inline-mention" key={`${message.id}-mention-${index}`}>@{members.get(segment.memberId)?.mentionHandle || message.mentions.find(mention => mention.memberId === segment.memberId)?.mentionHandle || '成员'}</span>)}{message.truncated && <small className="arm-truncated">内容过长，当前显示安全截断版本。</small>}</>
}

function TaskAction({ action, member, coordinator }: { action: AgentRoomAction; member?: AgentRoomMember; coordinator?: AgentRoomMember }): React.JSX.Element {
  const waitingForConnection = action.status === 'reserved' || (action.status === 'queued' && member && !member.canDispatch)
  const status = waitingForConnection ? 'reserved' : action.status
  const target = member ? `@${member.mentionHandle}` : action.memberName ? `@${action.memberName.replace(/^@/, '')}` : '成员'
  const route = action.actionType === 'direct' ? `你 → ${target}` : action.actionType === 'delegate' ? `@${coordinator?.mentionHandle || '主控'} → ${target}` : action.actionType === 'report' ? `${target} → @${coordinator?.mentionHandle || '主控'}` : `@${coordinator?.mentionHandle || '主控'} 接收/复核`
  return <li className="arm-action-row"><div><strong>{route}</strong><Status value={status} /></div><p>{action.summary || action.instruction || roomStatusLabel(action.status)}</p>{waitingForConnection && <small>消息已经进入公共聊天；成员连接后会继续领取。</small>}{action.errorCode && <code>{action.errorCode}</code>}</li>
}

export function AgentSessionGroups({ snapshot, onLogin }: { snapshot: LauncherSnapshot; onLogin(): void }): React.JSX.Element {
  const signedIn = snapshot.account.status === 'signed_in'
  const userId = snapshot.account.user?.id || ''
  const baseSupported = launcherSupportsAgentSessionGroups(snapshot.launcherVersion)
  const supported = baseSupported && Boolean(window.launcher?.agentWorkspaceRequest)
  const [rooms, setRooms] = useState<AgentRoomSummary[]>([])
  const [selectedRoomId, setSelectedRoomId] = useState('')
  const [detail, setDetail] = useState<AgentRoomDetail>()
  const [candidateCatalog, setCandidateCatalog] = useState<CandidateCatalog>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [mobilePane, setMobilePane] = useState<'chat' | 'tasks' | 'members'>('chat')
  const [membersOpen, setMembersOpen] = useState(false)
  const [editor, setEditor] = useState<RoomEditorState>()
  const [editorError, setEditorError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draft, setDraft] = useState('')
  const [mentionTokens, setMentionTokens] = useState<RoomMentionToken[]>([])
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string; active: number }>()
  const dialog = useRef<HTMLDialogElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const messageScroll = useRef<HTMLDivElement>(null)
  const accountEpoch = useRef(0)
  const selectedRoomRef = useRef('')
  const detailRevision = useRef('')
  const latestMessageSeq = useRef(0)
  const unchangedPolls = useRef(0)
  const lastDetailActive = useRef(false)
  const sending = useRef(false)
  const saving = useRef(false)
  const submission = useRef<{ signature: string; clientRequestId: string } | undefined>(undefined)
  const editorSubmission = useRef<{ signature: string; clientRequestId: string } | undefined>(undefined)
  const deleteSubmission = useRef<{ roomId: string; clientRequestId: string } | undefined>(undefined)

  async function request(value: AgentWorkspaceRequest): Promise<JsonRecord> {
    if (!window.launcher?.agentWorkspaceRequest) throw new Error('当前启动器内核缺少多智能会话接口，请检查更新。')
    const response = await window.launcher.agentWorkspaceRequest(value)
    if (response.ok === false) throw new Error(text(response.message) || text(response.error) || '多智能会话操作未完成，请稍后重试。')
    return response
  }

  useEffect(() => {
    accountEpoch.current += 1
    setRooms([]); setSelectedRoomId(''); selectedRoomRef.current = ''; setDetail(undefined); setCandidateCatalog(undefined); setError(''); setNotice(''); setDraft(''); setMentionTokens([]); setEditor(undefined); setMembersOpen(false)
    detailRevision.current = ''; latestMessageSeq.current = 0; unchangedPolls.current = 0; lastDetailActive.current = false; submission.current = undefined; editorSubmission.current = undefined; deleteSubmission.current = undefined
  }, [userId, signedIn])

  useEffect(() => {
    if (!supported || !signedIn) { setLoading(false); return }
    const epoch = accountEpoch.current
    let disposed = false
    async function load(): Promise<void> {
      setLoading(true)
      try {
        const response = await request({ scope: 'hub', method: 'GET', action: 'room_list' })
        if (disposed || epoch !== accountEpoch.current) return
        if (Number(response.contractVersion) !== 2) throw new Error('网站端尚未启用多智能房间 v2，请稍后更新。')
        const nextRooms = rows(response.rooms).map(normalizeRoomSummary).filter(room => room.id)
        setRooms(nextRooms); setCandidateCatalog(normalizeCandidates(response.candidates))
        setSelectedRoomId(previous => { const next = previous && nextRooms.some(room => room.id === previous) ? previous : nextRooms[0]?.id || ''; selectedRoomRef.current = next; return next })
        setError('')
      } catch (cause) { if (!disposed && epoch === accountEpoch.current) setError(cause instanceof Error ? cause.message : '无法读取多智能房间。') }
      finally { if (!disposed && epoch === accountEpoch.current) setLoading(false) }
    }
    void load()
    return () => { disposed = true }
  }, [supported, signedIn, userId, reload])

  useEffect(() => {
    if (!supported || !signedIn || !selectedRoomId) { setDetail(undefined); detailRevision.current = ''; latestMessageSeq.current = 0; unchangedPolls.current = 0; lastDetailActive.current = false; return }
    const epoch = accountEpoch.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function load(): Promise<void> {
      if (document.hidden) { timer = setTimeout(() => void load(), 4000); return }
      let nextDelay = lastDetailActive.current ? 3000 : Math.min(30000, 7000 * Math.pow(2, Math.max(0, unchangedPolls.current - 1)))
      try {
        const params: Record<string, string> = { roomId: selectedRoomId }
        if (detailRevision.current !== '') params.afterRevision = String(detailRevision.current)
        if (latestMessageSeq.current) params.afterMessageSeq = String(latestMessageSeq.current)
        const response = await request({ scope: 'hub', method: 'GET', action: 'room_detail', params })
        if (disposed || epoch !== accountEpoch.current || selectedRoomRef.current !== selectedRoomId) return
        if (Number(response.contractVersion) !== 2) throw new Error('房间详情合同版本不匹配，请更新网站端和启动器。')
        if (response.changed === false) { unchangedPolls.current = Math.min(4, unchangedPolls.current + 1); return }
        const incoming = normalizeRoomDetail(response)
        if (incoming.room.id !== selectedRoomId) throw new Error('返回的房间与当前选择不匹配，请刷新。')
        detailRevision.current = incoming.detailRevision ?? detailRevision.current
        latestMessageSeq.current = Math.max(latestMessageSeq.current, ...incoming.messages.map(message => message.seq), 0)
        unchangedPolls.current = 0
        if (incoming.runs.length) lastDetailActive.current = incoming.runs.some(run => roomRunActive(run.status))
        setDetail(previous => mergeRoomDetail(previous, incoming))
        setRooms(previous => previous.map(room => room.id === incoming.room.id ? { ...room, ...incoming.room } : room))
        nextDelay = lastDetailActive.current ? 3000 : 7000
        setError('')
      } catch (cause) { if (!disposed && epoch === accountEpoch.current && selectedRoomRef.current === selectedRoomId) setError(cause instanceof Error ? cause.message : '房间同步失败。') }
      finally { if (!disposed && epoch === accountEpoch.current) timer = setTimeout(() => void load(), nextDelay) }
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [supported, signedIn, userId, selectedRoomId, reload])

  useEffect(() => {
    if (editor && !dialog.current?.open) dialog.current?.showModal()
    if (!editor && dialog.current?.open) dialog.current.close()
  }, [Boolean(editor)])

  useEffect(() => {
    const node = messageScroll.current
    if (node) node.scrollTop = node.scrollHeight
  }, [detail?.messages.length, selectedRoomId])

  const membersById = useMemo(() => new Map((detail?.members || []).map(member => [member.id, member])), [detail?.members])
  const coordinator = detail?.members.find(member => member.id === detail.room.coordinatorMemberId)
  const activeRuns = detail?.runs.filter(run => roomRunActive(run.status)) || []
  const activeRunStatus = activeRuns[0]?.status
  const ledgerSummary = activeRunStatus === 'awaiting_approval' ? '整项任务尚未执行，仍可继续发消息' : activeRunStatus === 'cancel_requested' ? '正在停止已派发工作，仍可继续发消息' : activeRunStatus === 'unknown' ? '结果待确认，可取消对账或继续留言' : activeRunStatus === 'queued' ? '任务已排队，仍可继续发消息' : activeRunStatus === 'running' ? '主控正在推进，仍可继续发消息' : '分派、执行和完成都记录在这里'
  const mentionedMemberIds = [...new Set(mentionTokens.map(token => token.memberId).filter(memberId => membersById.has(memberId)))]
  const mentionedMembers = mentionedMemberIds.map(id => membersById.get(id)).filter((member): member is AgentRoomMember => Boolean(member))
  const routePreview = mentionedMembers.length ? `将通知 ${mentionedMembers.map(member => `@${member.mentionHandle}`).join('、')}` : coordinator ? `未 @，将交给 @${coordinator.mentionHandle}` : '请先为房间设置主控'
  const mentionOptions = (detail?.members || []).filter(member => {
    const query = mentionQuery?.query.toLocaleLowerCase() || ''
    return !query || member.mentionHandle.toLocaleLowerCase().includes(query) || member.displayName.toLocaleLowerCase().includes(query)
  })
  const editorValidation = editor ? validateRoomDraft(editor) : ''
  const candidateTruncation = candidateCatalog ? [candidateCatalog.truncated.agents ? `智能体最近 ${candidateCatalog.limits.agents || '有限'} 项` : '', candidateCatalog.truncated.projects ? `项目最近 ${candidateCatalog.limits.projects || '有限'} 项` : ''].filter(Boolean).join('、') : ''

  function chooseRoom(roomId: string): void {
    selectedRoomRef.current = roomId; setSelectedRoomId(roomId); setDetail(undefined); setError(''); setNotice(''); setDraft(''); setMentionTokens([]); setMentionQuery(undefined); setMobilePane('chat'); setMembersOpen(false)
    detailRevision.current = ''; latestMessageSeq.current = 0; unchangedPolls.current = 0; lastDetailActive.current = false; submission.current = undefined; deleteSubmission.current = undefined
  }

  function openCreate(): void {
    const members = [{ ...blankMember(0), displayName: '主控', mentionHandle: '主控', responsibility: '理解需求、分派任务、收集汇报并推进到完成', sessionLabel: '主控工作会话' }]
    setEditorError(''); setEditor({ name: '', coordinatorMemberId: members[0]!.id, maxSteps: DEFAULT_MAX_STEPS, defaultAccess: DEFAULT_ACCESS, members })
  }

  function openEdit(): void {
    if (!detail) return
    setEditorError('')
    setEditor({ roomId: detail.room.id, name: detail.room.name, coordinatorMemberId: detail.room.coordinatorMemberId, maxSteps: detail.room.maxSteps, defaultAccess: detail.room.defaultAccess, expectedDefinitionRevision: detail.room.definitionRevision, members: detail.members.map(member => ({ id: member.id, displayName: member.displayName, mentionHandle: member.mentionHandle, responsibility: member.responsibility, agentId: member.agentId, projectId: member.projectId, sessionLabel: member.sessionLabel })) })
  }

  function closeEditor(): void { if (!saving.current && !busy.startsWith('room_')) { setEditor(undefined); setEditorError('') } }
  function updateEditor(values: Partial<RoomEditorState>): void { setEditor(previous => previous ? { ...previous, ...values } : previous); setEditorError(''); editorSubmission.current = undefined }
  function updateMember(index: number, values: Partial<AgentRoomMemberInput>): void { setEditor(previous => previous ? { ...previous, members: previous.members.map((member, memberIndex) => memberIndex === index ? { ...member, ...values } : member) } : previous); setEditorError(''); editorSubmission.current = undefined }

  async function saveEditor(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!editor || saving.current || busy) return
    const validation = validateRoomDraft(editor)
    if (validation) { setEditorError(validation); return }
    const action = editor.roomId ? 'room_update' : 'room_create'
    const epoch = accountEpoch.current
    const members = editor.members.map(member => ({ ...member, displayName: member.displayName.trim(), mentionHandle: member.mentionHandle.trim().replace(/^@/, ''), responsibility: member.responsibility.trim(), sessionLabel: member.sessionLabel.trim() }))
    const body: Record<string, unknown> = { ...(editor.roomId ? { roomId: editor.roomId, expectedDefinitionRevision: editor.expectedDefinitionRevision } : {}), name: editor.name.trim(), coordinatorMemberId: editor.coordinatorMemberId, maxSteps: editor.maxSteps, defaultAccess: editor.defaultAccess, members }
    const signature = JSON.stringify(body)
    if (editorSubmission.current?.signature !== signature) editorSubmission.current = { signature, clientRequestId: crypto.randomUUID() }
    body.clientRequestId = editorSubmission.current.clientRequestId
    saving.current = true; setBusy(action); setEditorError(''); setError(''); setNotice('')
    try {
      const response = await request({ scope: 'hub', method: 'POST', action, body })
      if (epoch !== accountEpoch.current) return
      const roomId = text(response.roomId) || text(object(response.room).id) || editor.roomId || ''
      setEditor(undefined); editorSubmission.current = undefined
      setNotice(editor.roomId ? '房间设置已保存。新成员的独立会话会在首次需要时创建。' : '房间已创建。每位成员的独立会话将在首次参与时按需创建。')
      if (roomId) chooseRoom(roomId)
      setReload(value => value + 1)
    } catch (cause) { if (epoch === accountEpoch.current) setEditorError(cause instanceof Error ? cause.message : '保存失败，表单内容已保留。') }
    finally { saving.current = false; setBusy(current => current === action ? '' : current) }
  }

  async function deleteRoom(): Promise<void> {
    if (!detail || busy) return
    const targetRoomId = detail.room.id
    if (deleteSubmission.current?.roomId !== targetRoomId) deleteSubmission.current = { roomId: targetRoomId, clientRequestId: crypto.randomUUID() }
    setBusy('room_delete'); setError(''); setNotice('')
    try {
      await request({ scope: 'hub', method: 'POST', action: 'room_delete', body: { roomId: targetRoomId, clientRequestId: deleteSubmission.current.clientRequestId } })
      if (selectedRoomRef.current !== targetRoomId) return
      deleteSubmission.current = undefined
      selectedRoomRef.current = ''; setSelectedRoomId(''); setDetail(undefined); setConfirmDelete(false); setMembersOpen(false); setMobilePane('chat'); setNotice('房间已停用；不会删除智能体、授权项目或本机原生会话。'); setReload(value => value + 1)
    } catch (cause) { if (selectedRoomRef.current === targetRoomId) setError(cause instanceof Error ? cause.message : '停用房间失败，请重试。') }
    finally { setBusy(current => current === 'room_delete' ? '' : current) }
  }

  function detectMention(value: string, cursor: number): void {
    let start = cursor - 1
    while (start >= 0 && !/\s/.test(value[start]!)) start -= 1
    start += 1
    const candidate = value.slice(start, cursor)
    if (candidate.startsWith('@') && !candidate.slice(1).includes('@')) setMentionQuery({ start, query: candidate.slice(1), active: 0 })
    else setMentionQuery(undefined)
  }

  function changeDraft(value: string, cursor: number): void { setMentionTokens(previous => reconcileMentionTokens(draft, value, previous)); setDraft(value); submission.current = undefined; detectMention(value, cursor) }

  function selectMention(member: AgentRoomMember): void {
    if (!mentionQuery) return
    const cursor = textarea.current?.selectionStart ?? draft.length
    const label = `@${member.mentionHandle}`
    const next = `${draft.slice(0, mentionQuery.start)}${label} ${draft.slice(cursor)}`
    const reconciled = reconcileMentionTokens(draft, next, mentionTokens)
    const token = { memberId: member.id, start: mentionQuery.start, end: mentionQuery.start + label.length, label }
    setDraft(next); setMentionTokens([...reconciled.filter(item => item.end <= token.start || item.start >= token.end), token].sort((left, right) => left.start - right.start)); setMentionQuery(undefined); submission.current = undefined
    requestAnimationFrame(() => { const position = token.end + 1; textarea.current?.focus(); textarea.current?.setSelectionRange(position, position) })
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionQuery && event.key === 'Escape') { event.preventDefault(); setMentionQuery(undefined); return }
    if (mentionQuery && mentionOptions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMentionQuery(current => current ? { ...current, active: (current.active + (event.key === 'ArrowDown' ? 1 : mentionOptions.length - 1)) % mentionOptions.length } : current); return }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); selectMention(mentionOptions[mentionQuery.active] || mentionOptions[0]!); return }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
  }

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    if (!detail || sending.current || busy || !draft.trim() || !coordinator) return
    if (!signedIn) { onLogin(); return }
    const targetRoomId = detail.room.id
    const content = buildRoomMessageContent(draft, mentionTokens.filter(token => membersById.has(token.memberId)))
    const payload = { roomId: detail.room.id, content, access: 'workspace_write' as const, expectedDefinitionRevision: detail.room.definitionRevision }
    const signature = roomMessageSignature(payload)
    if (submission.current?.signature !== signature) submission.current = { signature, clientRequestId: crypto.randomUUID() }
    const clientRequestId = submission.current.clientRequestId
    sending.current = true; setBusy('room_send'); setError(''); setNotice('')
    try {
      const response = await request({ scope: 'hub', method: 'POST', action: 'room_send', body: { ...payload, clientRequestId } })
      if (selectedRoomRef.current !== targetRoomId) return
      const messageId = text(response.messageId)
      const runId = text(response.runId)
      if (!messageId) throw new Error('服务器未返回消息编号；请重试同一内容确认，系统会复用原请求编号。')
      const approvalId = text(response.approvalId)
      if (!runId || response.requiresApproval !== true || !approvalId) throw new Error('消息可能已经进入房间，但服务端未返回整项任务批准凭证。请刷新确认；Launcher 不会在未批准状态下启动本轮。')
      const status = 'awaiting_approval'
      const optimisticMessage: AgentRoomMessage = { id: messageId, seq: latestMessageSeq.current + 1, runId: runId || undefined, authorType: 'user', messageType: 'user', body: draft, segments: content, mentions: mentionedMembers.map(member => ({ memberId: member.id, displayName: member.displayName, mentionHandle: member.mentionHandle })), createdAt: new Date().toISOString(), contentAvailable: true }
      const optimisticRun: AgentRoomRun = { id: runId, roomId: detail.room.id, rootMessageId: messageId, routingKind: mentionedMemberIds.length ? 'direct' : 'coordinator', coordinatorMemberId: detail.room.coordinatorMemberId, targetMemberIds: mentionedMemberIds, definitionRevision: detail.room.definitionRevision, maxSteps: detail.room.maxSteps, status, stepCount: 0, access: 'workspace_write', requiresApproval: true, approvalId, createdAt: new Date().toISOString(), contentAvailable: true }
      lastDetailActive.current = roomRunActive(optimisticRun.status)
      latestMessageSeq.current = optimisticMessage.seq
      setDetail(previous => {
        if (previous?.room.id !== targetRoomId) return previous
        const messages = mergeById(previous.messages, [optimisticMessage]).sort((left, right) => left.seq - right.seq)
        return { ...previous, room: { ...previous.room, activeRunId: runId, latestRunStatus: status }, messages, runs: sortRoomRuns(mergeById(previous.runs, [optimisticRun]), messages) }
      })
      setDraft(''); setMentionTokens([]); setMentionQuery(undefined); submission.current = undefined
      setNotice(response.replayed === true ? '已找回同一条房间消息，没有重复创建。' : response.requiresApproval === true ? '消息已公开到房间；确认整项任务后主控才会开始执行。' : '消息已公开到房间并进入任务队列。'); setReload(value => value + 1)
    } catch (cause) { if (selectedRoomRef.current === targetRoomId) setError(cause instanceof Error ? cause.message : '发送结果未确认；内容和请求编号均已保留。') }
    finally { sending.current = false; setBusy(current => current === 'room_send' ? '' : current) }
  }

  async function approveRun(run: AgentRoomRun): Promise<void> {
    if (!detail || !run.approvalId || busy) return
    const targetRoomId = detail.room.id
    const operation = `room_approve:${run.id}`
    setBusy(operation); setError(''); setNotice('')
    try {
      await request({ scope: 'hub', method: 'POST', action: 'room_approve', body: { roomId: detail.room.id, runId: run.id, approvalId: run.approvalId } })
      if (selectedRoomRef.current !== targetRoomId) return
      setDetail(previous => previous?.room.id === targetRoomId ? { ...previous, room: { ...previous.room, activeRunId: run.id, latestRunStatus: 'queued' }, runs: previous.runs.map(item => item.id === run.id ? { ...item, status: 'queued', requiresApproval: false, approvedAt: new Date().toISOString() } : item) } : previous)
      lastDetailActive.current = true
      setNotice('已允许整项任务；主控会在冻结的成员与项目范围内继续推进。'); setReload(value => value + 1)
    } catch (cause) { if (selectedRoomRef.current === targetRoomId) setError(cause instanceof Error ? cause.message : '批准结果未确认，请刷新后重试。') }
    finally { setBusy(current => current === operation ? '' : current) }
  }

  async function cancelRun(runId: string): Promise<void> {
    if (!detail || busy) return
    const targetRoomId = detail.room.id
    const operation = `room_cancel:${runId}`
    setBusy(operation); setError(''); setNotice('')
    try {
      await request({ scope: 'hub', method: 'POST', action: 'room_cancel', body: { roomId: detail.room.id, runId } })
      if (selectedRoomRef.current !== targetRoomId) return
      setDetail(previous => previous?.room.id === targetRoomId ? { ...previous, room: { ...previous.room, activeRunId: runId, latestRunStatus: 'cancel_requested' }, runs: previous.runs.map(run => run.id === runId ? { ...run, status: 'cancel_requested', cancelRequestedAt: new Date().toISOString() } : run) } : previous)
      lastDetailActive.current = true
      setNotice('已请求停止整项任务；本机回执前保持“取消中”。'); setReload(value => value + 1)
    } catch (cause) { if (selectedRoomRef.current === targetRoomId) setError(cause instanceof Error ? cause.message : '取消请求未确认，请重试。') }
    finally { setBusy(current => current === operation ? '' : current) }
  }

  async function loadMessageWindow(direction: 'earlier' | 'later'): Promise<void> {
    if (!detail || busy) return
    const targetRoomId = detail.room.id
    const seqs = detail.messages.map(message => message.seq).filter(value => value > 0)
    if (!seqs.length) return
    const params: Record<string, string> = { roomId: detail.room.id }
    params[direction === 'earlier' ? 'beforeMessageSeq' : 'afterMessageSeq'] = String(direction === 'earlier' ? Math.min(...seqs) : Math.max(...seqs))
    const operation = `room_messages_${direction}`
    setBusy(operation); setError('')
    try {
      const response = await request({ scope: 'hub', method: 'GET', action: 'room_detail', params })
      if (selectedRoomRef.current !== targetRoomId) return
      if (Number(response.contractVersion) !== 2) throw new Error('房间详情合同版本不匹配，请更新网站端和启动器。')
      const incoming = normalizeRoomDetail(response)
      detailRevision.current = incoming.detailRevision ?? detailRevision.current
      latestMessageSeq.current = Math.max(latestMessageSeq.current, ...incoming.messages.map(message => message.seq), 0)
      setDetail(previous => previous?.room.id === targetRoomId ? mergeRoomDetail(previous, incoming, direction !== 'earlier') : previous)
    } catch (cause) { if (selectedRoomRef.current === targetRoomId) setError(cause instanceof Error ? cause.message : direction === 'earlier' ? '更早消息加载失败。' : '新消息追赶失败。') }
    finally { setBusy(current => current === operation ? '' : current) }
  }

  if (!baseSupported) return <div className="aw-unavailable"><CircleAlert size={36} /><h2>基础启动器需要更新</h2><p>多智能会话需要 {AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION} 或更高版本；当前为 {snapshot.launcherVersion || '未知版本'}。仅更新界面模块无法开启受控请求，请先升级基础启动器。</p><button className="primary-button" onClick={() => void window.launcher?.openExternal(DOWNLOAD_URL)}>下载新版启动器</button></div>
  if (!supported) return <div className="aw-unavailable"><Users size={36} /><h2>请升级启动器</h2><p>当前内核没有多智能房间通信接口，不能安全创建房间或派发任务。</p></div>
  if (!signedIn) return <div className="aw-login"><Users size={20} /><div><strong>登录后使用多智能会话</strong><p>房间共享公共聊天记录，每位成员保留自己的工作记忆和独立原生会话。</p></div><button className="primary-button" onClick={onLogin}>登录 AI历史书</button></div>

  return <section className="arm-workspace" data-mobile-pane={mobilePane} aria-label="多智能会话">
    <div className="arm-toolbar">
      <div><strong>多智能会话</strong><span>在同一房间公开沟通，由主控持续推进任务闭环</span></div>
      <button className="small-button" disabled={Boolean(busy)} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />刷新</button>
    </div>
    {error && <div className="aw-feedback error" role="alert"><CircleAlert size={16} /><span>{error}</span>{/登录|会话.*过期/.test(error) && <button onClick={onLogin}>重新登录</button>}<button onClick={() => { setError(''); setReload(value => value + 1) }}>重试</button></div>}
    {notice && <div className="aw-feedback" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button onClick={() => setNotice('')}>知道了</button></div>}
    <label className="arm-mobile-room-picker">当前房间<select value={selectedRoomId} onChange={event => chooseRoom(event.target.value)}><option value="">选择房间</option>{rooms.map(room => <option value={room.id} key={room.id}>{room.name}</option>)}</select></label>
    <nav className="arm-mobile-nav" aria-label="多智能会话视图">
      <button aria-current={mobilePane === 'chat' ? 'page' : undefined} onClick={() => setMobilePane('chat')}><MessageSquare size={15} />聊天</button>
      <button aria-current={mobilePane === 'tasks' ? 'page' : undefined} disabled={!detail} onClick={() => setMobilePane('tasks')}><ClipboardList size={15} />任务动态</button>
      <button aria-current={mobilePane === 'members' ? 'page' : undefined} disabled={!detail} onClick={() => setMobilePane('members')}><Users size={15} />成员</button>
    </nav>

    <div className="arm-stage">
      <div className="arm-panes">
        <aside className="arm-room-rail" aria-label="房间列表">
          <header><h2>房间</h2><button className="aw-icon-button" aria-label="新建房间" onClick={openCreate}><Plus size={17} /></button></header>
          <div className="arm-room-list">{rooms.map(room => <button className={`arm-room-row ${room.id === selectedRoomId ? 'selected' : ''}`} aria-pressed={room.id === selectedRoomId} key={room.id} onClick={() => chooseRoom(room.id)}><span className="arm-room-avatar" aria-hidden="true">{room.name.slice(0, 1)}</span><span><strong>{room.name}</strong><Status value={room.latestRunStatus || room.status} /></span></button>)}{!rooms.length && <div className="arm-inline-empty">{loading ? '正在读取房间…' : '还没有房间。创建一个，让主控和成员在公共聊天里协作。'}</div>}</div>
          <button className="arm-new-room" onClick={openCreate}><Plus size={14} />新建房间</button>
        </aside>

        <aside className="arm-task-ledger" aria-label="任务动态">
          <header><div><h2>任务动态</h2><p>{ledgerSummary}</p></div></header>
          <div className="arm-ledger-scroll">
            {detail?.window?.hasMoreActions && <p className="arm-window-note">当前显示最近 {detail.window.maxActions} 条动作，更早记录保留在服务端审计中。</p>}
            {detail?.runs.map(run => {
              const runActions = detail.actions.filter(action => action.runId === run.id)
              const sourceMessage = detail.messages.find(message => message.id === run.rootMessageId)
              return <article className="arm-run" key={run.id}>
                <header><div><strong>{sourceMessage?.body || '房间任务'}</strong><time>{timestamp(run.createdAt)}</time></div><Status value={run.status} /></header>
                {run.requiresApproval && run.approvalId && <div className="arm-run-approval" role="alert">
                  <strong>整项任务尚未执行</strong>
                  <p>允许后，@{coordinator?.mentionHandle || '主控'} 可在本房间已选成员与授权项目内分派、复核并汇总；本次无需逐条批准委派。</p>
                  <small>成员可修改各自授权项目；发布、发送、破坏性删除、扩大范围或读取凭据仍必须停下并另行询问。各本机运行时权限是最终技术边界。</small>
                  <div><button className="primary-button" disabled={Boolean(busy)} onClick={() => void approveRun(run)}>{busy === `room_approve:${run.id}` ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}允许整项任务</button><button className="small-button danger" disabled={Boolean(busy)} onClick={() => void cancelRun(run.id)}>拒绝并停止</button></div>
                </div>}
                {run.requiresApproval && !run.approvalId && <div className="arm-run-proof-error" role="alert"><CircleAlert size={14} /><span>批准凭证缺失，本轮保持未执行。请刷新；仍未恢复时停止本轮。</span></div>}
                {runActions.length > 0 && <ol className="arm-action-list">{runActions.map(action => <TaskAction action={action} member={action.memberId ? membersById.get(action.memberId) : undefined} coordinator={coordinator} key={action.id} />)}</ol>}
                {!runActions.length && !run.requiresApproval && <p className="arm-run-summary">{run.errorCode ? `任务未完成：${run.errorCode}` : roomStatusLabel(run.status)}</p>}
                {roomRunActive(run.status) && run.status !== 'cancel_requested' && !run.requiresApproval && <button className="aw-text-button" disabled={Boolean(busy)} onClick={() => void cancelRun(run.id)}><Square size={12} />停止整项任务</button>}
              </article>
            })}
            {detail && !detail.runs.length && <div className="arm-ledger-empty"><ClipboardList size={24} /><strong>尚无任务动态</strong><p>在右侧说出需求。未 @ 成员时，主控会先接手。</p></div>}
            {!detail && <div className="arm-ledger-empty"><ClipboardList size={24} /><strong>选择一个房间</strong><p>任务分派与完成结果会集中显示在这里。</p></div>}
          </div>
        </aside>

        <main className="arm-chat-pane" aria-label="公共聊天">
          <header className="arm-chat-heading">
            <div><h2>{detail?.room.name || '公共聊天'}</h2><p>{detail ? `未 @ 时由 @${coordinator?.mentionHandle || '主控'} 接手 · 公共记录对全部成员可见` : '选择房间后开始协作'}</p></div>
            {detail && <div><button className="small-button arm-task-button" onClick={() => setMobilePane('tasks')}><ClipboardList size={14} />任务动态</button><button className="small-button" aria-expanded={membersOpen} onClick={() => setMembersOpen(value => !value)}><Users size={14} />成员</button></div>}
          </header>
          <div className="arm-messages" ref={messageScroll} tabIndex={0} aria-label="房间公共聊天记录">
            {detail?.window?.hasEarlierMessages && <button className="arm-history-button" disabled={Boolean(busy)} onClick={() => void loadMessageWindow('earlier')}>{busy === 'room_messages_earlier' ? '加载中…' : '加载更早消息'}</button>}
            {detail?.window?.hasLaterMessages && <div className="arm-catchup" role="status"><span>新消息较多，当前按每批 {detail.window.maxMessages} 条安全追赶。</span><button className="small-button" disabled={Boolean(busy)} onClick={() => void loadMessageWindow('later')}>{busy === 'room_messages_later' ? '追赶中…' : '继续追上新消息'}</button></div>}
            {detail?.messages.map(message => {
              const author = message.authorMemberId ? membersById.get(message.authorMemberId) : undefined
              return <article className={`arm-message ${message.authorType}`} key={message.id}>
                <div className="arm-message-byline"><strong>{message.authorType === 'user' ? '你' : message.authorType === 'system' ? '房间系统' : author?.displayName || message.authorName || '房间成员'}</strong>{author && <span>@{author.mentionHandle}</span>}<time>{timestamp(message.createdAt)}</time></div>
                <div className="arm-message-body"><MessageBody message={message} members={membersById} /></div>
              </article>
            })}
            {detail && !detail.messages.length && <div className="arm-chat-empty"><MessageSquare size={26} /><strong>从一条公开消息开始</strong><p>直接说需求会交给主控；输入 @ 可指定成员。所有成员共享这里的记录，各自工作记忆仍独立保留。</p></div>}
            {!detail && <div className="arm-chat-empty"><Users size={26} /><strong>选择或新建一个房间</strong><p>每位成员会在首次参与时创建专属原生会话。</p></div>}
          </div>
          <form className="arm-composer" onSubmit={event => void send(event)}>
            {mentionQuery && <ul className="arm-mention-list" id="arm-mention-options" role="listbox" aria-label="选择要通知的成员">
              {mentionOptions.length ? mentionOptions.map((member, index) => <li id={`arm-mention-${member.id}`} role="option" aria-selected={index === mentionQuery.active} key={member.id} onMouseDown={event => { event.preventDefault(); selectMention(member) }}><Bot size={15} /><span><strong>@{member.mentionHandle}</strong><small>{member.displayName} · {roomStatusLabel(member.status)}</small></span></li>) : <li className="arm-mention-empty" role="option" aria-disabled="true">没有匹配的房间成员。继续输入会作为普通文字发送。</li>}
            </ul>}
            {detail && <div className="arm-route-preview"><AtSign size={14} /><span>{routePreview}</span>{mentionedMembers.some(member => !member.canDispatch) && <small>离线成员会先显示“等待连接”，不会阻止消息公开。</small>}</div>}
            <label className="aw-sr-only" htmlFor="arm-message-input">发到房间公共聊天</label>
            <textarea ref={textarea} id="arm-message-input" value={draft} maxLength={8000} disabled={!detail || busy === 'room_send'} placeholder="说出需求；输入 @ 指定成员…" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={Boolean(mentionQuery)} aria-controls={mentionQuery ? 'arm-mention-options' : undefined} aria-activedescendant={mentionQuery && mentionOptions[mentionQuery.active] ? `arm-mention-${mentionOptions[mentionQuery.active]!.id}` : undefined} onChange={event => changeDraft(event.target.value, event.target.selectionStart)} onKeyDown={composerKeyDown} />
            <div className="arm-composer-footer"><span>Enter 发送 · Shift + Enter 换行 · {draft.length}/8000</span><button type="submit" className="primary-button" disabled={!detail || Boolean(busy) || !draft.trim() || !coordinator}>{busy === 'room_send' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{busy === 'room_send' ? '发送中' : '发到房间'}</button></div>
          </form>
        </main>
      </div>

      {detail && (membersOpen || mobilePane === 'members') && <aside className="arm-member-drawer open" aria-label="房间成员">
        <header><div><h2>成员</h2><p>公共记录共享，工作记忆与原生会话彼此独立</p></div><button className="aw-icon-button arm-drawer-close" aria-label="关闭成员面板" onClick={() => { setMembersOpen(false); setMobilePane('chat') }}><X size={18} /></button></header>
        <div className="arm-member-list">{detail.members.map(member => <article className="arm-member" key={member.id}>
          <div className="arm-member-title"><span className="arm-member-avatar"><Bot size={16} /></span><div><strong>{member.displayName}</strong><small>@{member.mentionHandle}{member.id === detail.room.coordinatorMemberId ? ' · 主控' : ''}</small></div><Status value={member.sessionState === 'ready' ? member.status : member.sessionState} /></div>
          <p>{member.responsibility}</p><small>{member.agentName} · {member.projectName}</small><small>{member.sessionLabel}</small>{member.statusMessage && <small>{member.statusMessage}</small>}
          <div className="arm-session-state"><Wrench size={13} /><span>{member.sessionState === 'pending' ? '会话待创建：成员首次参与时自动准备' : member.sessionState === 'broken' ? '会话需修复：请检查本机智能体与项目授权' : '会话已就绪：独立工作记忆持续保留'}</span></div>
        </article>)}</div>
        <footer><button className="small-button" onClick={openEdit}><Pencil size={14} />编辑房间</button><button className="small-button danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />停用房间</button></footer>
        {confirmDelete && <div className="arm-delete-confirm" role="alert"><p>停用后不再接收新消息；不会删除智能体、授权项目或已创建的原生会话。</p><button className="small-button" onClick={() => setConfirmDelete(false)}>取消</button><button className="small-button danger" disabled={busy === 'room_delete'} onClick={() => void deleteRoom()}>{busy === 'room_delete' ? '停用中…' : '确认停用'}</button></div>}
      </aside>}
    </div>

    <dialog className="arm-editor" ref={dialog} aria-labelledby="arm-editor-title" onCancel={event => { event.preventDefault(); closeEditor() }}>
      {editor && <form onSubmit={event => void saveEditor(event)}>
        <header><div><h2 id="arm-editor-title">{editor.roomId ? '编辑房间' : '新建多智能房间'}</h2><p>选择已有智能体和授权项目；专属原生会话会在成员首次参与时创建。</p></div><button type="button" className="aw-icon-button" aria-label="关闭房间编辑" onClick={closeEditor}><X size={19} /></button></header>
        <div className="arm-editor-body">
          {editorError && <div className="aw-feedback error" role="alert"><CircleAlert size={16} /><span>{editorError}</span></div>}
          {candidateTruncation && <p className="arm-candidate-note" role="status">候选目录仅显示{candidateTruncation}；找不到项目时请先同步本机。</p>}
          <label className="arm-room-name">房间名称<input value={editor.name} maxLength={80} autoFocus placeholder="例如：新产品发布室" onChange={event => updateEditor({ name: event.target.value })} /></label>
          <div className="arm-editor-heading"><div><h3>成员与身份</h3><p>名称和 @名称只属于这个房间；同一智能体也可承担不同身份。</p></div><button type="button" className="small-button" onClick={() => updateEditor({ members: [...editor.members, blankMember(editor.members.length)] })}><Plus size={14} />添加成员</button></div>
          <div className="arm-member-editors">{editor.members.map((member, index) => {
            const agent = candidateCatalog?.agents.find(item => item.id === member.agentId)
            return <fieldset className="arm-member-editor" key={member.id}>
              <legend>{member.displayName.trim() || `新成员 ${index + 1}`}</legend>
              <div className="arm-member-editor-title"><label>显示名称<input value={member.displayName} maxLength={60} placeholder="例如：前端" onChange={event => updateMember(index, { displayName: event.target.value })} /></label><label>@名称<div className="arm-handle-input"><span>@</span><input value={member.mentionHandle} maxLength={40} placeholder={`agent-${index + 1}`} onChange={event => updateMember(index, { mentionHandle: event.target.value.replace(/^@/, '') })} /></div></label><button type="button" className="aw-icon-button danger" aria-label={`移除成员 ${member.displayName || index + 1}`} disabled={editor.members.length <= 1} onClick={() => { const members = editor.members.filter((_, memberIndex) => memberIndex !== index); updateEditor({ members, coordinatorMemberId: editor.coordinatorMemberId === member.id ? members[0]?.id || '' : editor.coordinatorMemberId }) }}><Trash2 size={15} /></button></div>
              <label>职责<textarea value={member.responsibility} maxLength={500} placeholder="说明这个身份负责什么、向谁汇报" onChange={event => updateMember(index, { responsibility: event.target.value })} /></label>
              <div className="arm-member-binding"><label>已有智能体<select value={member.agentId} onChange={event => updateMember(index, { agentId: event.target.value, projectId: '' })}><option value="">选择智能体</option>{candidateCatalog?.agents.map(item => <option value={item.id} key={item.id}>{item.name} · {roomStatusLabel(item.status)}</option>)}</select></label><label>授权项目<select value={member.projectId} disabled={!agent} onChange={event => updateMember(index, { projectId: event.target.value })}><option value="">选择项目</option>{agent?.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label>独立会话名称<input value={member.sessionLabel} maxLength={80} placeholder="例如：前端执行会话" onChange={event => updateMember(index, { sessionLabel: event.target.value })} /></label></div>
              <label className="arm-coordinator-choice"><input type="radio" name="coordinator" checked={editor.coordinatorMemberId === member.id} onChange={() => updateEditor({ coordinatorMemberId: member.id })} />设为主控：没有 @ 指定成员时，由此成员接手并继续分派</label>
              {agent?.statusMessage && <small>{agent.statusMessage}</small>}
            </fieldset>
          })}</div>
        </div>
        <footer><span className="arm-editor-guidance" data-error={Boolean(editorValidation)} aria-live="polite">{editorValidation || '保存不会扩大项目授权，也不会立即启动离线智能体。'}</span><button type="button" className="small-button" onClick={closeEditor}>取消</button><button type="submit" className="primary-button" disabled={Boolean(editorValidation) || Boolean(busy)}>{busy === 'room_create' || busy === 'room_update' ? <LoaderCircle size={15} className="spin" /> : null}{editor.roomId ? '保存房间' : '创建房间'}</button></footer>
      </form>}
    </dialog>
  </section>
}
