import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Bot, CheckCircle2, CircleAlert, LoaderCircle, MessageSquare, Pencil, Plus, RefreshCw, Send, Square, Trash2, Users, X } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type {
  AgentSessionGroupAction,
  AgentSessionGroupDetail,
  AgentSessionGroupMode,
  AgentSessionGroupRole,
  AgentSessionGroupRoleInput,
  AgentSessionGroupRun,
  AgentSessionGroupSummary,
  AgentWorkspaceRequest
} from '../../shared/agent-host'
import './agent-session-groups.css'
import { AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION, launcherSupportsAgentSessionGroups } from './agent-session-groups-support'

type JsonRecord = Record<string, unknown>
interface CandidateSession { id: string; projectId: string; title: string }
interface CandidateProject { id: string; name: string; sessions: CandidateSession[] }
interface CandidateAgent { id: string; name: string; adapter: string; status: string; projects: CandidateProject[]; message?: string }
interface CandidateCatalog { agents: CandidateAgent[]; truncated: { agents: boolean; projects: boolean; sessions: boolean }; limits: { agents: number; projects: number; sessions: number } }
interface GroupEditorState {
  groupId?: string
  name: string
  mode: AgentSessionGroupMode
  coordinatorRoleId: string
  maxTurns: number
  roles: AgentSessionGroupRoleInput[]
}

const ACTIVE_RUNS = new Set(['queued', 'running', 'awaiting_approval', 'cancel_requested', 'unknown'])
const DOWNLOAD_URL = 'https://deepseek.ailishishu.com/'
const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const rows = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const field = (row: JsonRecord, ...keys: string[]): unknown => keys.map(key => row[key]).find(value => value !== undefined && value !== null)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const boundedTurns = (value: unknown): number => Math.max(1, Math.min(12, Number(value) || 6))
const normalizedMode = (value: unknown): AgentSessionGroupMode => ['coordinator', 'orchestrated'].includes(text(value)) ? 'coordinator' : 'manual'

export function groupStatusLabel(value: string): string {
  return ({
    idle: '待命', ready: '已就绪', online: '已在线', busy: '忙碌', working: '执行中', stopped: '已停止', offline: '成员离线',
    needs_login: '需要本机登录', unavailable: '暂不支持', queued: '排队中', running: '执行中',
    awaiting_approval: '等待本机确认', cancel_requested: '取消中', unknown: '结果待确认', cancelled: '已取消', completed: '已完成', failed: '失败'
  } as Record<string, string>)[value] || value || '待检查'
}

export function groupRoleReady(status: string): boolean { return ['ready', 'online', 'busy', 'working'].includes(status) }
export function groupRunActive(status: string): boolean { return ACTIVE_RUNS.has(status) }

export function normalizeSessionGroupSummary(value: unknown): AgentSessionGroupSummary {
  const row = object(value)
  const activeRunCount = Math.max(0, Number(field(row, 'active_run_count', 'activeRunCount')) || 0)
  const sourceStatus = text(field(row, 'status', 'run_status', 'runStatus')) || 'idle'
  const latestRunStatus = text(field(row, 'latest_run_status', 'latestRunStatus')) || undefined
  return {
    id: text(field(row, 'id', 'group_id', 'groupId')),
    name: text(field(row, 'name', 'display_name', 'displayName')) || '未命名会话群',
    mode: normalizedMode(field(row, 'mode', 'control_mode', 'controlMode')),
    maxTurns: boundedTurns(field(row, 'max_turns', 'maxTurns')),
    coordinatorRoleId: text(field(row, 'coordinator_role_id', 'coordinatorRoleId')) || undefined,
    roleCount: Math.max(0, Number(field(row, 'role_count', 'roleCount')) || rows(row.roles).length),
    activeRunCount,
    latestRunStatus,
    status: sourceStatus === 'active' ? latestRunStatus || (activeRunCount > 0 ? 'running' : 'idle') : sourceStatus,
    activeRunId: text(field(row, 'active_run_id', 'activeRunId')) || undefined,
    updatedAt: text(field(row, 'updated_at', 'updatedAt')) || undefined
  }
}

function normalizeRole(value: unknown): AgentSessionGroupRole {
  const row = object(value)
  return {
    id: text(field(row, 'id', 'role_id', 'roleId')),
    name: text(field(row, 'name', 'role_name', 'roleName')) || '未命名角色',
    responsibility: text(field(row, 'responsibility', 'duty', 'description')),
    agentId: text(field(row, 'agent_id', 'agentId')),
    agentName: text(field(row, 'agent_name', 'agentName')) || '智能体',
    projectId: text(field(row, 'project_id', 'projectId')),
    projectName: text(field(row, 'project_name', 'projectName')) || '未命名项目',
    nativeSessionId: text(field(row, 'native_session_id', 'nativeSessionId', 'session_id', 'sessionId')),
    nativeSessionTitle: text(field(row, 'native_session_title', 'nativeSessionTitle', 'session_title', 'sessionTitle')) || '原生会话',
    status: text(field(row, 'runtime_status', 'runtimeStatus', 'status', 'agent_status', 'agentStatus')) || 'unknown',
    message: text(field(row, 'message', 'status_message', 'statusMessage')) || undefined
  }
}

function normalizeRun(value: unknown): AgentSessionGroupRun {
  const row = object(value)
  const contentAvailable = field(row, 'content_available', 'contentAvailable') !== false
  return {
    id: text(field(row, 'id', 'run_id', 'runId')),
    instruction: text(field(row, 'instruction', 'request_text', 'requestText')),
    status: text(row.status) || 'queued',
    summary: text(field(row, 'summary', 'latest_summary', 'latestSummary')),
    finalText: text(field(row, 'final_text', 'finalText')) || undefined,
    clientRequestId: text(field(row, 'client_request_id', 'clientRequestId')) || undefined,
    targetRoleIds: strings(field(row, 'target_role_ids', 'targetRoleIds')),
    mode: normalizedMode(field(row, 'mode', 'control_mode', 'controlMode')),
    coordinatorRoleId: text(field(row, 'coordinator_role_id', 'coordinatorRoleId')) || undefined,
    maxTurns: boundedTurns(field(row, 'max_turns', 'maxTurns')),
    createdAt: text(field(row, 'created_at', 'createdAt')) || undefined,
    completedAt: text(field(row, 'completed_at', 'completedAt')) || undefined,
    contentAvailable,
    contentPrunedAt: text(field(row, 'content_pruned_at', 'contentPrunedAt')) || undefined
  }
}

function normalizeAction(value: unknown): AgentSessionGroupAction {
  const row = object(value)
  return {
    id: text(field(row, 'id', 'action_id', 'actionId')),
    runId: text(field(row, 'run_id', 'runId')),
    roleId: text(field(row, 'role_id', 'roleId')) || undefined,
    ordinal: Math.max(0, Number(row.ordinal) || 0),
    actionType: text(field(row, 'action_type', 'actionType', 'type')) || 'update',
    status: text(field(row, 'effective_status', 'effectiveStatus', 'status', 'task_status', 'taskStatus')) || 'queued',
    taskStatus: text(field(row, 'task_status', 'taskStatus')) || undefined,
    instruction: text(row.instruction) || undefined,
    summary: text(field(row, 'summary', 'latest_summary', 'latestSummary')),
    finalText: text(field(row, 'final_text', 'finalText')) || undefined,
    errorCode: text(field(row, 'error_code', 'errorCode')) || undefined,
    createdAt: text(field(row, 'created_at', 'createdAt')) || undefined
  }
}

export function normalizeSessionGroupDetail(value: unknown): AgentSessionGroupDetail {
  const response = object(value)
  return {
    group: normalizeSessionGroupSummary(response.group),
    roles: rows(response.roles).map(normalizeRole).filter(role => role.id),
    runs: rows(response.runs).map(normalizeRun).filter(run => run.id).sort((left, right) => (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0)),
    actions: rows(response.actions).map(normalizeAction).filter(action => action.id).sort((left, right) => left.ordinal - right.ordinal)
  }
}

export function validateSessionGroupDraft(draft: Pick<GroupEditorState, 'name' | 'mode' | 'coordinatorRoleId' | 'maxTurns' | 'roles'>): string {
  if (!draft.name.trim() || [...draft.name.trim()].length > 80) return '群名称需为 1–80 个字符。'
  if (!Number.isInteger(draft.maxTurns) || draft.maxTurns < 1 || draft.maxTurns > 12) return '最大执行次数需为 1–12。'
  if (draft.roles.length < 2 || draft.roles.length > 6) return '每个会话群需配置 2–6 个角色。'
  for (const role of draft.roles) {
    if (!role.name.trim() || [...role.name.trim()].length > 60) return '每个角色都需要 1–60 个字符的名称。'
    if (!role.responsibility.trim() || [...role.responsibility.trim()].length > 500) return `请填写“${role.name.trim()}”的职责，最多 500 个字符。`
    if (!role.agentId || !role.projectId || !role.nativeSessionId) return `请为“${role.name.trim()}”选择智能体、项目和原生会话。`
  }
  const assignments = new Set<string>()
  for (const role of draft.roles) {
    const assignment = `${role.agentId}\0${role.nativeSessionId}`
    if (assignments.has(assignment)) return '同一个智能体担任多个角色时，必须选择不同的原生会话。'
    assignments.add(assignment)
  }
  if (draft.mode === 'coordinator' && !draft.roles.some(role => role.id === draft.coordinatorRoleId)) return '主控协调模式需要选择一个现有角色作为主控。'
  return ''
}

export function groupSubmissionSignature(value: { groupId: string; instruction: string; targetRoleIds: string[]; mode: AgentSessionGroupMode; coordinatorRoleId?: string; maxTurns: number }): string {
  return JSON.stringify({ ...value, targetRoleIds: [...value.targetRoleIds].sort() })
}

export function newSessionGroupRoleId(): string { return crypto.randomUUID().replaceAll('-', '') }

function normalizeFlattenedCandidates(value: unknown): CandidateCatalog | undefined {
  const catalog = object(value)
  if (!Array.isArray(catalog.agents) || !Array.isArray(catalog.projects) || !Array.isArray(catalog.sessions)) return
  const sourceSessions = rows(catalog.sessions).map(row => ({ id: text(row.id), agentId: text(field(row, 'agent_id', 'agentId')), projectId: text(field(row, 'project_id', 'projectId')), title: text(field(row, 'source_title', 'sourceTitle', 'title')) || '未命名会话' })).filter(session => session.id && session.projectId)
  const sourceProjects = rows(catalog.projects).map(row => ({ id: text(row.id), agentId: text(field(row, 'agent_id', 'agentId')), name: text(field(row, 'source_name', 'sourceName', 'name')) || '未命名项目' })).filter(project => project.id && project.agentId)
  const agents = rows(catalog.agents).map(row => {
    const id = text(row.id)
    const projects = sourceProjects.filter(project => project.agentId === id).map(project => ({ id: project.id, name: project.name, sessions: sourceSessions.filter(session => session.projectId === project.id && (!session.agentId || session.agentId === id)).map(({ id: sessionId, projectId, title }) => ({ id: sessionId, projectId, title })) }))
    return { id, name: text(field(row, 'display_name', 'displayName', 'name')) || text(field(row, 'adapter_code', 'adapterCode')) || '智能体', adapter: text(field(row, 'adapter_code', 'adapterCode')), status: text(field(row, 'runtime_status', 'runtimeStatus', 'status')) || 'unknown', projects }
  }).filter(agent => agent.id)
  const truncated = object(catalog.truncated)
  const limits = object(catalog.limits)
  return {
    agents,
    truncated: { agents: truncated.agents === true, projects: truncated.projects === true, sessions: truncated.sessions === true },
    limits: { agents: Math.max(0, Number(limits.agents) || 0), projects: Math.max(0, Number(limits.projects) || 0), sessions: Math.max(0, Number(limits.sessions) || 0) }
  }
}

function blankRole(): AgentSessionGroupRoleInput {
  return { id: newSessionGroupRoleId(), name: '', responsibility: '', agentId: '', projectId: '', nativeSessionId: '' }
}

function timestamp(value?: string): string {
  if (!value) return '刚刚'
  const time = Date.parse(value)
  return time ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : value
}

function Status({ value }: { value: string }): React.JSX.Element {
  const tone = ['ready', 'online', 'completed', 'idle'].includes(value) ? 'good' : ['failed', 'offline', 'needs_login', 'unavailable', 'unknown'].includes(value) ? 'bad' : ['queued', 'running', 'awaiting_approval', 'cancel_requested', 'busy'].includes(value) ? 'pending' : 'neutral'
  return <span className={`asg-status ${tone}`}><i aria-hidden="true" />{groupStatusLabel(value)}</span>
}

function ActionRecord({ action, roleName }: { action: AgentSessionGroupAction; roleName: string }): React.JSX.Element {
  const hasCopy = Boolean(action.instruction || action.summary || action.finalText || action.errorCode)
  return <div className="asg-action"><span>{roleName}</span><div className="asg-action-copy">{action.instruction && <p><strong>任务：</strong>{action.instruction}</p>}{action.summary && <p>{action.summary}</p>}{action.finalText && <p><strong>结果：</strong>{action.finalText}</p>}{action.errorCode && <code>错误：{action.errorCode}</code>}{!hasCopy && <p>{action.actionType}</p>}</div><Status value={action.status} /></div>
}

export function AgentSessionGroups({ snapshot, onLogin }: { snapshot: LauncherSnapshot; onLogin(): void }): React.JSX.Element {
  const signedIn = snapshot.account.status === 'signed_in'
  const userId = snapshot.account.user?.id || ''
  const baseSupported = launcherSupportsAgentSessionGroups(snapshot.launcherVersion)
  const supported = baseSupported && Boolean(window.launcher?.agentWorkspaceRequest)
  const [groups, setGroups] = useState<AgentSessionGroupSummary[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [detail, setDetail] = useState<AgentSessionGroupDetail>()
  const [candidates, setCandidates] = useState<CandidateAgent[]>([])
  const [candidateCatalog, setCandidateCatalog] = useState<CandidateCatalog>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [mobilePane, setMobilePane] = useState<'groups' | 'roles' | 'activity'>('groups')
  const [editor, setEditor] = useState<GroupEditorState>()
  const [editorError, setEditorError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [dispatchMode, setDispatchMode] = useState<AgentSessionGroupMode>('manual')
  const [targetRoleIds, setTargetRoleIds] = useState<string[]>([])
  const [coordinatorRoleId, setCoordinatorRoleId] = useState('')
  const [maxTurns, setMaxTurns] = useState(6)
  const [composerReset, setComposerReset] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const accountEpoch = useRef(0)
  const sending = useRef(false)
  const saving = useRef(false)
  const submission = useRef<{ signature: string; clientRequestId: string } | undefined>(undefined)
  const configuredGroup = useRef('')

  async function request(value: AgentWorkspaceRequest): Promise<JsonRecord> {
    if (!window.launcher?.agentWorkspaceRequest) throw new Error('当前启动器内核缺少会话群接口，请检查更新。')
    const response = await window.launcher.agentWorkspaceRequest(value)
    if (response.ok === false) throw new Error(text(response.message) || text(response.error) || '会话群操作未完成，请稍后重试。')
    return response
  }

  useEffect(() => {
    accountEpoch.current += 1
    setGroups([]); setSelectedGroupId(''); setDetail(undefined); setCandidates([]); setCandidateCatalog(undefined); setError(''); setSyncError(''); setNotice(''); setInstruction(''); setEditor(undefined)
    submission.current = undefined; configuredGroup.current = ''
  }, [userId, signedIn])

  useEffect(() => {
    if (!supported || !signedIn) { setLoading(false); return }
    const epoch = accountEpoch.current
    let disposed = false
    const current = (): boolean => !disposed && epoch === accountEpoch.current
    async function load(): Promise<void> {
      setLoading(true)
      try {
        const list = await request({ scope: 'hub', method: 'GET', action: 'group_list' })
        if (!current()) return
        const nextGroups = rows(list.groups).map(normalizeSessionGroupSummary).filter(group => group.id)
        const flattened = normalizeFlattenedCandidates(list.candidates)
        let nextCandidates = flattened?.agents
        if (!nextCandidates) {
          const bootstrap = await request({ scope: 'hub', method: 'GET', action: 'bootstrap' })
          const agents = rows(bootstrap.agents).map(row => ({ id: text(row.id), name: text(field(row, 'display_name', 'displayName', 'name')) || text(field(row, 'adapter_code', 'adapterCode')) || '智能体', adapter: text(field(row, 'adapter_code', 'adapterCode')), status: text(row.status) || 'unknown' })).filter(agent => agent.id)
          nextCandidates = await Promise.all(agents.map(async agent => {
            try {
              const response = await request({ scope: 'hub', method: 'GET', action: 'agent_state', params: { agentId: agent.id } })
              const state = object(response.state)
              const sessions = rows(state.sessions).map(row => ({ id: text(row.id), projectId: text(field(row, 'project_id', 'projectId')), title: text(field(row, 'source_title', 'sourceTitle', 'title')) || '未命名会话' })).filter(session => session.id && session.projectId)
              const projects = rows(state.projects).map(row => { const id = text(row.id); return { id, name: text(field(row, 'source_name', 'sourceName', 'name')) || '未命名项目', sessions: sessions.filter(session => session.projectId === id) } }).filter(project => project.id)
              return { ...agent, projects }
            } catch (cause) {
              return { ...agent, projects: [], message: cause instanceof Error ? cause.message : '项目与会话暂不可读' }
            }
          }))
        }
        if (!current()) return
        setGroups(nextGroups); setCandidates(nextCandidates); setCandidateCatalog(flattened)
        setSelectedGroupId(previous => previous && nextGroups.some(group => group.id === previous) ? previous : nextGroups[0]?.id || '')
        setSyncError('')
      } catch (cause) { if (current()) setSyncError(cause instanceof Error ? cause.message : '无法读取会话群。') }
      finally { if (current()) setLoading(false) }
    }
    void load()
    return () => { disposed = true }
  }, [supported, signedIn, userId, reload])

  useEffect(() => {
    if (!supported || !signedIn || !selectedGroupId) { setDetail(undefined); return }
    const epoch = accountEpoch.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const current = (): boolean => !disposed && epoch === accountEpoch.current
    async function load(): Promise<void> {
      if (document.hidden) { timer = setTimeout(() => void load(), 4000); return }
      try {
        const response = await request({ scope: 'hub', method: 'GET', action: 'group_detail', params: { groupId: selectedGroupId } })
        if (!current()) return
        const next = normalizeSessionGroupDetail(response)
        if (next.group.id !== selectedGroupId) throw new Error('返回的会话群不匹配，请重新刷新。')
        const activeRuns = next.runs.filter(run => groupRunActive(run.status))
        const latestRun = next.runs[0]
        const group = { ...next.group, activeRunCount: activeRuns.length, activeRunId: activeRuns[0]?.id, latestRunStatus: latestRun?.status, status: activeRuns[0]?.status || latestRun?.status || next.group.status }
        const merged = { ...next, group }
        setDetail(previous => JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged)
        setGroups(previous => previous.map(item => item.id === group.id ? { ...item, ...group } : item))
        setSyncError('')
      } catch (cause) { if (current()) setSyncError(cause instanceof Error ? cause.message : '会话群同步失败。') }
      finally { if (current()) timer = setTimeout(() => void load(), 4000) }
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [supported, signedIn, userId, selectedGroupId, reload])

  const composerDefaultsKey = detail ? JSON.stringify({ id: detail.group.id, mode: detail.group.mode, coordinatorRoleId: detail.group.coordinatorRoleId || '', maxTurns: detail.group.maxTurns, roles: detail.roles.map(role => role.id) }) : ''
  useEffect(() => {
    if (!detail) return
    const changedGroup = configuredGroup.current !== detail.group.id
    configuredGroup.current = detail.group.id
    setDispatchMode(detail.group.mode); setCoordinatorRoleId(detail.group.coordinatorRoleId || ''); setMaxTurns(detail.group.maxTurns)
    setTargetRoleIds([]); if (changedGroup) setInstruction(''); submission.current = undefined; setConfirmDelete(false)
  }, [composerDefaultsKey, composerReset])

  useEffect(() => {
    if (editor && !dialog.current?.open) dialog.current?.showModal()
    if (!editor && dialog.current?.open) dialog.current.close()
  }, [Boolean(editor)])

  const activeRun = detail?.runs.find(run => groupRunActive(run.status))
  const roleById = useMemo(() => new Map((detail?.roles || []).map(role => [role.id, role])), [detail?.roles])
  const editorValidation = editor ? validateSessionGroupDraft(editor) : ''
  const coordinator = detail?.roles.find(role => role.id === coordinatorRoleId)
  const manualTargetsReady = targetRoleIds.length > 0 && targetRoleIds.every(id => groupRoleReady(roleById.get(id)?.status || 'offline'))
  const manualTargetsWithinLimit = targetRoleIds.length <= maxTurns
  const coordinatorOfflineRoles = detail?.roles.filter(role => !groupRoleReady(role.status)) || []
  const coordinatorReady = Boolean(coordinator && groupRoleReady(coordinator.status) && coordinatorOfflineRoles.length === 0)
  const sendReady = dispatchMode === 'manual' ? manualTargetsReady && manualTargetsWithinLimit : coordinatorReady
  const candidateTruncation = candidateCatalog ? (['agents', 'projects', 'sessions'] as const).filter(key => candidateCatalog.truncated[key]).map(key => `${{ agents: '智能体', projects: '项目', sessions: '会话' }[key]}最近 ${candidateCatalog.limits[key] || '有限'} 项`).join('、') : ''

  function chooseGroup(id: string): void {
    setSelectedGroupId(id); setDetail(undefined); setError(''); setNotice(''); setMobilePane('roles'); configuredGroup.current = ''; submission.current = undefined
  }
  function openCreate(): void {
    setEditorError(''); setEditor({ name: '', mode: 'manual', coordinatorRoleId: '', maxTurns: 6, roles: [blankRole(), blankRole()] })
  }
  function openEdit(): void {
    if (!detail) return
    setEditorError(''); setEditor({ groupId: detail.group.id, name: detail.group.name, mode: detail.group.mode, coordinatorRoleId: detail.group.coordinatorRoleId || '', maxTurns: detail.group.maxTurns, roles: detail.roles.map(role => ({ id: role.id, name: role.name, responsibility: role.responsibility, agentId: role.agentId, projectId: role.projectId, nativeSessionId: role.nativeSessionId })) })
  }
  function closeEditor(): void { if (!saving.current && !busy.startsWith('group_')) { setEditor(undefined); setEditorError('') } }
  function updateEditor(values: Partial<GroupEditorState>): void { setEditor(previous => previous ? { ...previous, ...values } : previous); setEditorError('') }
  function updateRole(index: number, values: Partial<AgentSessionGroupRoleInput>): void {
    setEditor(previous => previous ? { ...previous, roles: previous.roles.map((role, roleIndex) => roleIndex === index ? { ...role, ...values } : role) } : previous)
    setEditorError('')
  }
  async function saveEditor(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!editor || saving.current || busy) return
    const validation = validateSessionGroupDraft(editor)
    if (validation) { setEditorError(validation); return }
    const action = editor.groupId ? 'group_update' : 'group_create'
    const editingExisting = Boolean(editor.groupId)
    saving.current = true
    setBusy(action); setEditorError(''); setError(''); setNotice('')
    try {
      const body = { ...(editor.groupId ? { groupId: editor.groupId } : {}), name: editor.name.trim(), mode: editor.mode, coordinatorRoleId: editor.mode === 'coordinator' ? editor.coordinatorRoleId : null, maxTurns: editor.maxTurns, roles: editor.roles.map(role => ({ ...role, name: role.name.trim(), responsibility: role.responsibility.trim() })) }
      const response = await request({ scope: 'hub', method: 'POST', action, body })
      const groupId = text(response.groupId) || text(object(response.group).id) || editor.groupId || ''
      setEditor(undefined); setNotice(editor.groupId ? '会话群设置已保存。' : '会话群已创建；成员不会因此自动启动或扩大目录授权。')
      if (groupId) { setSelectedGroupId(groupId); setMobilePane('roles') }
      if (editingExisting) { setDetail(undefined); setTargetRoleIds([]); submission.current = undefined; setComposerReset(value => value + 1) }
      setReload(value => value + 1)
    } catch (cause) { setEditorError(cause instanceof Error ? cause.message : '保存失败，表单内容已保留。') }
    finally { saving.current = false; setBusy('') }
  }
  async function deleteGroup(): Promise<void> {
    if (!detail || busy) return
    setBusy('group_delete'); setError(''); setNotice('')
    try {
      await request({ scope: 'hub', method: 'POST', action: 'group_delete', body: { groupId: detail.group.id } })
      setSelectedGroupId(''); setDetail(undefined); setConfirmDelete(false); setNotice('会话群已停用并从列表移除；必要审计记录已保留。'); setMobilePane('groups'); setReload(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '停用失败，请重试。') }
    finally { setBusy('') }
  }
  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    if (!detail || sending.current || busy || activeRun || !instruction.trim() || !sendReady) return
    const targets = dispatchMode === 'manual' ? targetRoleIds : detail.roles.map(role => role.id)
    const payload = { groupId: detail.group.id, instruction: instruction.trim(), targetRoleIds: targets, mode: dispatchMode, coordinatorRoleId: dispatchMode === 'coordinator' ? coordinatorRoleId : undefined, maxTurns }
    const signature = groupSubmissionSignature(payload)
    if (submission.current?.signature !== signature) submission.current = { signature, clientRequestId: crypto.randomUUID() }
    const clientRequestId = submission.current.clientRequestId
    sending.current = true; setBusy('group_send'); setError(''); setNotice('')
    try {
      const response = await request({ scope: 'hub', method: 'POST', action: 'group_send', body: { ...payload, clientRequestId } })
      const runId = text(response.runId)
      if (!runId) throw new Error('服务器未返回群任务编号；请重试同一内容确认，系统会复用原请求编号。')
      const status = text(response.status) || 'queued'
      setDetail(previous => previous && previous.group.id === payload.groupId ? { ...previous, group: { ...previous.group, status, activeRunId: groupRunActive(status) ? runId : undefined }, runs: previous.runs.some(run => run.id === runId) ? previous.runs : [{ id: runId, instruction: payload.instruction, status, summary: '服务器已确认，等待角色执行', clientRequestId, targetRoleIds: targets, mode: dispatchMode, coordinatorRoleId: payload.coordinatorRoleId, maxTurns, createdAt: new Date().toISOString(), contentAvailable: true }, ...previous.runs] } : previous)
      setInstruction(''); submission.current = undefined
      setNotice(response.replayed === true ? '已找回同一请求的群任务，没有重复创建。' : '群任务已进入队列；关闭页面不会终止已提交任务。')
      setReload(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发送结果未确认；内容和请求编号均已保留。') }
    finally { sending.current = false; setBusy('') }
  }
  async function cancelRun(runId: string): Promise<void> {
    if (!detail || busy) return
    setBusy(`group_cancel:${runId}`); setError(''); setNotice('')
    try {
      await request({ scope: 'hub', method: 'POST', action: 'group_cancel', body: { groupId: detail.group.id, runId } })
      setDetail(previous => previous ? { ...previous, group: { ...previous.group, status: 'cancel_requested' }, runs: previous.runs.map(run => run.id === runId ? { ...run, status: 'cancel_requested', summary: '已停止后续派发，等待本机确认已创建任务的停止结果' } : run) } : previous)
      setNotice('已请求取消。收到本机停止回执前会保持“取消中”。'); setReload(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '取消请求未确认，请重试。') }
    finally { setBusy('') }
  }

  if (!baseSupported) return <div className="aw-unavailable"><CircleAlert size={36} /><h2>基础启动器需要更新</h2><p>会话群需要 {AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION} 或更高版本；当前为 {snapshot.launcherVersion || '未知版本'}。仅更新界面模块无法开启受控请求，请先升级基础启动器。</p><button className="primary-button" onClick={() => void window.launcher?.openExternal(DOWNLOAD_URL)}>下载新版启动器</button></div>
  if (!supported) return <div className="aw-unavailable"><Users size={36} /><h2>请升级启动器</h2><p>当前内核没有会话群通信接口，不能安全创建或派发群任务。</p></div>
  if (!signedIn) return <div className="aw-login"><Users size={20} /><div><strong>登录后使用智能体会话群</strong><p>会话群只组合当前账号已有的智能体、授权项目和原生会话。</p></div><button className="primary-button" onClick={onLogin}>登录 AI历史书</button></div>

  return <section className="asg-workspace" data-mobile-pane={mobilePane} aria-label="智能体会话群">
    <div className="asg-toolbar"><div><strong>会话群</strong><span>复用原实例协作，不新增目录授权</span></div><button className="small-button" disabled={Boolean(busy)} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />刷新</button></div>
    {(error || syncError) && <div className="aw-feedback error" role="alert"><CircleAlert size={16} /><span>{error || syncError}</span><button onClick={() => { setError(''); setSyncError(''); setReload(value => value + 1) }}>重试</button></div>}
    {notice && <div className="aw-feedback" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button onClick={() => setNotice('')}>知道了</button></div>}
    <nav className="asg-mobile-nav" aria-label="会话群分栏"><button aria-current={mobilePane === 'groups' ? 'page' : undefined} onClick={() => setMobilePane('groups')}>群</button><button aria-current={mobilePane === 'roles' ? 'page' : undefined} disabled={!selectedGroupId} onClick={() => setMobilePane('roles')}>成员</button><button aria-current={mobilePane === 'activity' ? 'page' : undefined} disabled={!selectedGroupId} onClick={() => setMobilePane('activity')}>任务</button></nav>
    <div className="asg-panes">
      <aside className="asg-pane asg-group-pane">
        <header className="asg-pane-heading"><h2>我的会话群</h2><button className="aw-icon-button" aria-label="新建会话群" onClick={openCreate}><Plus size={17} /></button></header>
        <div className="asg-list">{groups.map(group => <button className={`asg-group-row ${selectedGroupId === group.id ? 'selected' : ''}`} key={group.id} aria-pressed={selectedGroupId === group.id} onClick={() => chooseGroup(group.id)}><Users size={18} /><span><strong>{group.name}</strong><small>{group.roleCount} 个角色 · {group.mode === 'coordinator' ? '主控协调' : '我来指挥'}</small><Status value={group.status} /></span></button>)}{!groups.length && <div className="aw-inline-empty">{loading ? '正在读取会话群…' : '还没有会话群。先选择 2–6 个已有角色创建一个。'}</div>}</div>
        <div className="asg-pane-foot"><button className="small-button" onClick={openCreate}><Plus size={14} />新建会话群</button></div>
      </aside>
      <aside className="asg-pane asg-role-pane">
        <header className="asg-pane-heading"><button className="asg-back aw-icon-button" aria-label="返回会话群列表" onClick={() => setMobilePane('groups')}><ArrowLeft size={17} /></button><h2>成员与角色</h2>{detail && <button className="aw-icon-button" aria-label="编辑会话群" onClick={openEdit}><Pencil size={16} /></button>}</header>
        {!detail ? <div className="aw-inline-empty">{selectedGroupId ? '正在读取成员…' : '选择一个会话群查看成员与原生会话。'}</div> : <>
          <div className="asg-group-meta"><strong>{detail.group.name}</strong><span>{detail.group.mode === 'coordinator' ? '主控协调' : '我来指挥'} · 最多 {detail.group.maxTurns} 次角色调用</span></div>
          <div className="asg-role-list">{detail.roles.map(role => <article className="asg-role-row" key={role.id}><Bot size={18} /><div><div className="asg-role-title"><strong>{role.name}</strong><Status value={role.status} /></div><p>{role.responsibility || '尚未填写职责'}</p><small>{role.agentName} · {role.projectName}</small><small>{role.nativeSessionTitle}</small>{role.message && <small>{role.message}</small>}</div></article>)}</div>
          <div className="asg-role-actions"><button className="small-button" onClick={openEdit}><Pencil size={14} />编辑群与角色</button><button className="small-button danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />停用并移除</button><button className="primary-button asg-mobile-next" onClick={() => setMobilePane('activity')}>查看群任务</button></div>
          {confirmDelete && <div className="asg-delete-confirm" role="alert"><p>会话群将从列表移除并停用，角色、运行和动作会保留必要审计；不会删除原生项目、会话或智能体。</p><button className="small-button" onClick={() => setConfirmDelete(false)}>取消</button><button className="small-button danger" disabled={busy === 'group_delete'} onClick={() => void deleteGroup()}>{busy === 'group_delete' ? '停用中…' : '确认停用'}</button></div>}
        </>}
      </aside>
      <main className="asg-pane asg-activity-pane">
        <header className="asg-activity-heading"><button className="asg-back aw-icon-button" aria-label="返回成员列表" onClick={() => setMobilePane('roles')}><ArrowLeft size={17} /></button><div><h2>{detail?.group.name || '群任务'}</h2><p>{detail ? `${detail.roles.length} 个角色 · ${activeRun ? groupStatusLabel(activeRun.status) : '暂无进行中任务'}` : '选择会话群后开始'}</p></div>{detail && <Status value={activeRun?.status || detail.group.status} />}</header>
        <div className="asg-activity" tabIndex={0} aria-label="会话群任务与动作记录">{detail?.runs.map(run => <article className="asg-run" key={run.id}><header><div><strong>{run.contentAvailable ? run.instruction || '群任务' : '历史群任务（正文已清理）'}</strong><time>{timestamp(run.createdAt)}</time></div><Status value={run.status} /></header><p>{run.contentAvailable ? run.finalText || run.summary || groupStatusLabel(run.status) : `正文已按最近 10 次保留策略清理${run.contentPrunedAt ? ` · ${timestamp(run.contentPrunedAt)}` : ''}`}</p><div className="asg-run-meta"><span>{run.mode === 'coordinator' ? '主控协调' : `发送给 ${run.targetRoleIds.length || '所选'} 个角色`}</span><span>上限 {run.maxTurns} 次</span></div>{detail.actions.filter(action => action.runId === run.id).map(action => <ActionRecord action={action} roleName={action.roleId ? roleById.get(action.roleId)?.name || '角色' : '群编排'} key={action.id} />)}{groupRunActive(run.status) && run.status !== 'cancel_requested' && <button className="aw-text-button" disabled={Boolean(busy)} onClick={() => void cancelRun(run.id)}><Square size={12} />取消群任务</button>}</article>)}{detail && !detail.runs.length && <div className="asg-empty"><MessageSquare size={25} /><strong>还没有群任务</strong><p>选择角色并发送一条明确任务。系统会保留原生会话边界和执行上限。</p></div>}{!detail && <div className="asg-empty"><Users size={25} /><strong>选择一个会话群</strong><p>任务、角色动作和最终结果会显示在这里。</p></div>}</div>
        <form className="asg-composer" onSubmit={event => void send(event)}>
          {detail && <div className="asg-dispatch-options"><label>运行方式<select value={dispatchMode} onChange={event => { setDispatchMode(event.target.value as AgentSessionGroupMode); submission.current = undefined }}><option value="manual">我来指挥</option><option value="coordinator">主控协调</option></select></label>{dispatchMode === 'coordinator' && <label>主控角色<select value={coordinatorRoleId} onChange={event => { setCoordinatorRoleId(event.target.value); submission.current = undefined }}><option value="">请选择主控</option>{detail.roles.map(role => <option value={role.id} key={role.id}>{role.name} · {groupStatusLabel(role.status)}</option>)}</select></label>}<label>最多调用<input type="number" min={1} max={12} value={maxTurns} onChange={event => { setMaxTurns(boundedTurns(event.target.value)); submission.current = undefined }} /></label></div>}
          {detail && dispatchMode === 'manual' && <fieldset className="asg-targets"><legend>发送给角色</legend>{detail.roles.map(role => <label key={role.id} data-ready={groupRoleReady(role.status)}><input type="checkbox" checked={targetRoleIds.includes(role.id)} disabled={!groupRoleReady(role.status)} onChange={event => { setTargetRoleIds(previous => event.target.checked ? [...previous, role.id] : previous.filter(id => id !== role.id)); submission.current = undefined }} /><span>{role.name}</span><small>{groupStatusLabel(role.status)}</small></label>)}</fieldset>}
          {detail && dispatchMode === 'coordinator' && <p className="asg-composer-hint">主控只能委派给群内现有角色，不会新增成员、项目或目录权限。</p>}
          {activeRun && <p className="asg-composer-hint">当前群任务为“{groupStatusLabel(activeRun.status)}”。结束或取消确认后才能提交下一条。</p>}
          <label className="aw-sr-only" htmlFor="asg-instruction">会话群任务内容</label><textarea id="asg-instruction" value={instruction} maxLength={8000} disabled={!detail || Boolean(activeRun) || busy === 'group_send'} placeholder={dispatchMode === 'coordinator' ? '描述目标，让主控在限定次数内规划、委派并汇总…' : '描述任务，并选择一个或多个角色…'} onChange={event => { setInstruction(event.target.value); submission.current = undefined }} />
          <div className="asg-composer-footer"><span>{detail && dispatchMode === 'manual' && !manualTargetsWithinLimit ? `已选 ${targetRoleIds.length} 个角色，最大调用 ${maxTurns} 次` : !sendReady && detail ? dispatchMode === 'manual' ? '请选择至少一个已就绪角色' : !coordinator ? '请选择已就绪的主控角色' : coordinatorOfflineRoles.length ? `${coordinatorOfflineRoles.length} 个参与角色未就绪：${coordinatorOfflineRoles.map(role => role.name).join('、')}` : '请选择已就绪的主控角色' : `${instruction.length}/8000 · 点击发送`}</span><button type="submit" className="primary-button" disabled={!detail || Boolean(activeRun) || Boolean(busy) || !instruction.trim() || !sendReady}>{busy === 'group_send' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{busy === 'group_send' ? '发送中' : '发送群任务'}</button></div>
        </form>
      </main>
    </div>

    <dialog className="asg-editor" ref={dialog} aria-labelledby="asg-editor-title" onCancel={event => { event.preventDefault(); closeEditor() }}>
      {editor && <form onSubmit={event => void saveEditor(event)}>
        <header><div><h2 id="asg-editor-title">{editor.groupId ? '编辑会话群' : '新建会话群'}</h2><p>只组合已有授权；保存不会自动启动智能体。</p></div><button type="button" className="aw-icon-button" aria-label="关闭会话群编辑" onClick={closeEditor}><X size={19} /></button></header>
        <div className="asg-editor-body">
          {editorError && <div className="aw-feedback error" role="alert"><CircleAlert size={16} /><span>{editorError}</span></div>}
          {candidateTruncation && <p className="asg-candidate-note" role="status">候选列表仅显示{candidateTruncation}。若找不到旧会话，请先同步本机并刷新。</p>}
          <div className="asg-editor-settings"><label>群名称<input value={editor.name} maxLength={80} autoFocus onChange={event => updateEditor({ name: event.target.value })} /></label><label>默认运行方式<select value={editor.mode} onChange={event => updateEditor({ mode: event.target.value as AgentSessionGroupMode })}><option value="manual">我来指挥</option><option value="coordinator">主控协调</option></select></label><label>最大执行次数<input type="number" min={1} max={12} value={editor.maxTurns} onChange={event => updateEditor({ maxTurns: boundedTurns(event.target.value) })} /></label>{editor.mode === 'coordinator' && <label>默认主控<select value={editor.coordinatorRoleId} onChange={event => updateEditor({ coordinatorRoleId: event.target.value })}><option value="">请选择主控角色</option>{editor.roles.filter(role => role.name.trim()).map(role => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>}</div>
          <div className="asg-editor-heading"><div><h3>角色与原生会话</h3><p>同一智能体可承担多个角色，但必须选择不同原生会话。</p></div><button type="button" className="small-button" disabled={editor.roles.length >= 6} onClick={() => updateEditor({ roles: [...editor.roles, blankRole()] })}><Plus size={14} />添加角色</button></div>
          <div className="asg-role-editors">{editor.roles.map((role, index) => {
            const agent = candidates.find(item => item.id === role.agentId)
            const project = agent?.projects.find(item => item.id === role.projectId)
            const duplicate = editor.roles.some((other, otherIndex) => otherIndex !== index && other.agentId === role.agentId && other.nativeSessionId === role.nativeSessionId && Boolean(role.nativeSessionId))
            return <fieldset className="asg-role-editor" data-duplicate={duplicate} key={role.id}><legend>角色 {index + 1}</legend><div className="asg-role-editor-title"><label>角色名称<input value={role.name} maxLength={60} onChange={event => updateRole(index, { name: event.target.value })} /></label><button type="button" className="aw-icon-button danger" aria-label={`移除角色 ${index + 1}`} disabled={editor.roles.length <= 2} onClick={() => updateEditor({ roles: editor.roles.filter((_, roleIndex) => roleIndex !== index), coordinatorRoleId: editor.coordinatorRoleId === role.id ? '' : editor.coordinatorRoleId })}><Trash2 size={15} /></button></div><label>职责<textarea value={role.responsibility} maxLength={500} onChange={event => updateRole(index, { responsibility: event.target.value })} /></label><div className="asg-role-binding"><label>智能体<select value={role.agentId} onChange={event => updateRole(index, { agentId: event.target.value, projectId: '', nativeSessionId: '' })}><option value="">选择已有智能体</option>{candidates.map(item => <option value={item.id} key={item.id}>{item.name} · {groupStatusLabel(item.status)}</option>)}</select></label><label>授权项目<select value={role.projectId} disabled={!agent} onChange={event => updateRole(index, { projectId: event.target.value, nativeSessionId: '' })}><option value="">选择项目</option>{agent?.projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>原生会话<select value={role.nativeSessionId} disabled={!project} onChange={event => updateRole(index, { nativeSessionId: event.target.value })}><option value="">选择原生会话</option>{project?.sessions.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label></div>{agent?.message && <small>{agent.message}</small>}{duplicate && <small role="alert">此智能体和原生会话已被另一个角色使用。</small>}</fieldset>
          })}</div>
        </div>
        <footer><span>{editor.roles.length}/6 个角色</span><button type="button" className="small-button" onClick={closeEditor}>取消</button><button type="submit" className="primary-button" disabled={Boolean(editorValidation) || Boolean(busy)}>{busy === 'group_create' || busy === 'group_update' ? <LoaderCircle size={15} className="spin" /> : null}{editor.groupId ? '保存设置' : '创建会话群'}</button></footer>
      </form>}
    </dialog>
  </section>
}
