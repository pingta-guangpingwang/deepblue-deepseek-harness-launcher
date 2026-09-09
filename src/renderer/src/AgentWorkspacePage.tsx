import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowLeft, Bot, CheckCircle2, CircleAlert, Folder, FolderPlus, LoaderCircle, LogIn, MessageSquare, Monitor, Pause, Play, Plus, RefreshCw, Send, Settings2, Square, Unplug } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type { AgentAdapter, AgentHostAction, AgentHostSnapshot, AgentWorkspaceRequest } from '../../shared/agent-host'
import './agent-workspace.css'
import { LocalAgentWorkspace } from './LocalAgentWorkspace'
import { AgentSessionGroups } from './AgentSessionGroups'

// Existing DeepSeek operation-table design: device → native project/session → conversation.
// The launcher is an authenticated view of website IDs, not a second conversation database.
type JsonRecord = Record<string, unknown>
export interface WorkspaceAgent { id: string; name: string; adapter: string; status: string }
export interface WorkspaceProject { id: string; name: string }
export interface WorkspaceSession { id: string; projectId: string; title: string; status: string }
export interface WorkspaceTask {
  id: string; projectId: string; sessionId: string; clientRequestId: string; status: string
  request: string; reply: string; summary: string; createdAt: string; progress?: number
}
export interface WorkspaceMessage { id: string; role: 'user' | 'assistant'; text: string; occurredAt: string }
export interface WorkspaceData {
  agent: WorkspaceAgent; projects: WorkspaceProject[]; sessions: WorkspaceSession[]; tasks: WorkspaceTask[]; canDispatch?: boolean
}
export interface WorkspaceTimelineRow { id: string; role: 'user' | 'assistant'; text: string; time: string; task?: WorkspaceTask }
const POLL_MS = 4000
const DOWNLOAD_URL = 'https://deepseek.ailishishu.com/'
const REVOKED_DEVICE_HELP = '设备已从账号移除。重新登录启动器后自动登记；原项目文件不会删除'
const ACTIVE_TASKS = new Set(['queued', 'delivered', 'running', 'awaiting_approval', 'cancel_requested'])
const object = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const rows = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(object) : []
const statusNames: Record<string, string> = {
  unbound: '未绑定', connecting: '连接中', online: '已连接', offline: '离线', revoked: '已撤销',
  stopped: '已停止', starting: '启动中', reconnecting: '正在重连', failed: '失败', working: '执行中',
  awaiting_connection: '等待连接', queued: '排队中', delivered: '等待执行', running: '执行中',
  awaiting_approval: '等待本机确认', cancel_requested: '正在取消', completed: '已完成', cancelled: '已取消',
  idle: '待命', ready: '可用', busy: '忙碌', unknown: '待检查', unavailable: '暂不支持', error: '检查未通过', needs_login: '请在本机登录'
}
export const workspaceStatusLabel = (value: string): string => statusNames[value] || value || '待检查'
export function normalizeWorkspaceAgent(value: unknown): WorkspaceAgent {
  const row = object(value)
  return { id: string(row.id), name: string(row.display_name) || string(row.displayName) || string(row.adapter_code) || '智能体', adapter: string(row.adapter_code) || string(row.adapterCode), status: string(row.status) }
}
export function normalizeWorkspaceData(value: unknown): WorkspaceData {
  const state = object(value)
  return {
    agent: normalizeWorkspaceAgent(state.agent),
    projects: rows(state.projects).filter(row => string(row.id)).map(row => ({ id: string(row.id), name: string(row.source_name) || '未命名项目' })),
    sessions: rows(state.sessions).filter(row => string(row.id)).map(row => ({ id: string(row.id), projectId: string(row.project_id), title: string(row.source_title) || '未命名会话', status: string(row.source_status) })),
    tasks: rows(state.tasks).filter(row => string(row.id)).map(row => ({ id: string(row.id), projectId: string(row.project_id), sessionId: string(row.session_id), clientRequestId: string(row.client_request_id), status: string(row.status), request: string(row.request_text), reply: string(row.final_text), summary: string(row.latest_summary), createdAt: string(row.created_at), progress: typeof row.progress_percent === 'number' ? Math.max(0, Math.min(100, row.progress_percent)) : undefined })),
    canDispatch: typeof object(state.access).canDispatchToday === 'boolean' ? object(state.access).canDispatchToday as boolean : undefined
  }
}
export function normalizeWorkspaceHistory(value: unknown): WorkspaceMessage[] {
  return rows(value).filter(row => ['user', 'assistant'].includes(string(row.message_role)) && string(row.body_text)).map(row => ({ id: string(row.external_message_id), role: row.message_role as 'user' | 'assistant', text: string(row.body_text), occurredAt: string(row.occurred_at) }))
}
export function workspaceTime(value: string): number {
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value
  return Date.parse(text) || 0
}
export function workspaceTimeline(history: WorkspaceMessage[], tasks: WorkspaceTask[]): WorkspaceTimelineRow[] {
  const timeline: WorkspaceTimelineRow[] = history.map((message, index) => ({ id: `history:${message.id || index}`, role: message.role, text: message.text, time: message.occurredAt }))
  // Match roles as well as text so an assistant echo cannot hide a user's request.
  const nativeTexts = new Set(history.map(message => `${message.role}:${message.text.trim()}`))
  for (const task of tasks) {
    const completed = task.status === 'completed'
    if (task.request && !(completed && nativeTexts.has(`user:${task.request.trim()}`))) timeline.push({ id: `${task.id}:request`, role: 'user', text: task.request, time: task.createdAt })
    if (!(completed && task.reply && nativeTexts.has(`assistant:${task.reply.trim()}`))) timeline.push({ id: `${task.id}:reply`, role: 'assistant', text: task.reply || task.summary || workspaceStatusLabel(task.status), time: task.createdAt, task })
  }
  return timeline.map((row, index) => ({ row, index })).sort((a, b) => workspaceTime(a.row.time) - workspaceTime(b.row.time) || a.index - b.index).map(item => item.row)
}
export function workspaceNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean { return scrollHeight - scrollTop - clientHeight < 64 }
export function workspaceEnterSends(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'nativeEvent'>): boolean { return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing }
export function workspaceHostManagement(host: Pick<AgentHostSnapshot, 'connection' | 'deviceId'> | undefined, manage: boolean, busy: boolean) {
  const revoked = host?.connection === 'revoked'
  return { revoked, visible: Boolean(host && (manage || !host.deviceId || revoked)), toggleDisabled: busy || revoked, unbindDisabled: busy }
}
function sameData<T>(previous: T, next: T): T { return JSON.stringify(previous) === JSON.stringify(next) ? previous : next }
function timeLabel(value?: string): string { const time = value ? workspaceTime(value) : 0; return time ? new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '尚未同步' }
function StateLabel({ value, label }: { value: string; label?: string }): React.JSX.Element {
  const tone = ['online', 'ready', 'completed', 'idle'].includes(value) ? 'good' : ['failed', 'revoked'].includes(value) ? 'bad' : ['starting', 'connecting', 'reconnecting', 'awaiting_approval'].includes(value) ? 'pending' : 'neutral'
  return <span className={`aw-status ${tone}`}><i aria-hidden="true" />{label || workspaceStatusLabel(value)}</span>
}
function Empty({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="aw-empty"><MessageSquare size={27} aria-hidden="true" /><h3>{title}</h3><p>{children}</p></div>
}

export function AgentWorkspacePage(props: { snapshot: LauncherSnapshot; onLogin(): void; initialSource?: 'local' | 'cloud'; manageRequest?: number; onManageRequestHandled?(request: number): void }): React.JSX.Element {
  const [source, setSource] = useState<'local' | 'cloud' | 'groups'>(props.initialSource || 'local')
  useEffect(() => { if (props.initialSource) setSource(props.initialSource) }, [props.initialSource])
  useEffect(() => { if (props.manageRequest) setSource('cloud') }, [props.manageRequest])
  return <div className="agent-workspace"><nav className="aw-toolbar aw-source-tabs" aria-label="工作台数据来源"><button className={source === 'local' ? 'primary-button' : 'small-button'} aria-pressed={source === 'local'} onClick={() => setSource('local')}>本机项目与对话</button><button className={source === 'cloud' ? 'primary-button' : 'small-button'} aria-pressed={source === 'cloud'} onClick={() => setSource('cloud')}>网站同步与托管</button><button className={source === 'groups' ? 'primary-button' : 'small-button'} aria-pressed={source === 'groups'} onClick={() => setSource('groups')}>会话群</button></nav><div className="aw-source-content">{source === 'local' ? <LocalAgentWorkspace {...props} /> : source === 'cloud' ? <CloudAgentWorkspace {...props} /> : <AgentSessionGroups snapshot={props.snapshot} onLogin={props.onLogin} />}</div></div>
}
export function CloudAgentWorkspace({ snapshot, onLogin, manageRequest, onManageRequestHandled }: { snapshot: LauncherSnapshot; onLogin(): void; manageRequest?: number; onManageRequestHandled?(request: number): void }): React.JSX.Element {
  const api = window.launcher
  const supported = Boolean(api?.agentHostState && api.agentHostAction && api.agentWorkspaceRequest)
  const signedIn = snapshot.account.status === 'signed_in'
  const userId = snapshot.account.user?.id || ''
  const [host, setHost] = useState<AgentHostSnapshot>()
  const [cloudAgents, setCloudAgents] = useState<WorkspaceAgent[]>([])
  const [agentId, setAgentId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [data, setData] = useState<WorkspaceData>()
  const [history, setHistory] = useState<WorkspaceMessage[]>([])
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [manage, setManage] = useState(false)
  const [deviceNameDraft, setDeviceNameDraft] = useState('')
  useEffect(() => { setDeviceNameDraft(host?.deviceName || '') }, [host?.deviceName])
  useEffect(() => {
    if (!manageRequest) return
    setManage(true)
    onManageRequestHandled?.(manageRequest)
  }, [manageRequest, onManageRequestHandled])
  const hostManagement = workspaceHostManagement(host, manage, Boolean(busy))
  const [confirmAction, setConfirmAction] = useState<AgentHostAction>()
  const [importAgentId, setImportAgentId] = useState('')
  const [mobilePane, setMobilePane] = useState<'agents' | 'sessions' | 'conversation'>('agents')
  const [newContent, setNewContent] = useState(false)
  const [acknowledgedTasks, setAcknowledgedTasks] = useState<WorkspaceTask[]>([])
  const scroll = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const forceBottom = useRef(true)
  const polling = useRef(false)
  const generation = useRef(0)
  const activatedAt = useRef<Record<string, number>>({})
  const historyRequested = useRef<Record<string, number>>({})
  const submission = useRef<{ signature: string; clientRequestId: string } | undefined>(undefined)
  const pendingNewTask = useRef('')
  const live = useRef({ userId, agentId, projectId, sessionId })
  live.current = { userId, agentId, projectId, sessionId }
  const selectedBinding = host?.agents.find(agent => agent.id === agentId)
  const selectedProject = data?.projects.find(project => project.id === projectId)
  const selectedSession = data?.sessions.find(session => session.id === sessionId)
  const agents = useMemo(() => {
    if (!signedIn) return []
    const result = cloudAgents.slice()
    for (const local of host?.agents || []) if (!result.some(agent => agent.id === local.id)) result.push({ id: local.id, name: local.name, adapter: local.adapter, status: local.status })
    return result
  }, [cloudAgents, host?.agents, signedIn])
  const sessions = useMemo(() => data?.sessions.filter(session => session.projectId === projectId) || [], [data?.sessions, projectId])
  const visibleTasks = useMemo(() => {
    const all = [...(data?.tasks || [])]
    for (const task of acknowledgedTasks) if (!all.some(item => item.id === task.id)) all.push(task)
    return all.filter(task => task.projectId === projectId && task.sessionId === sessionId)
  }, [data?.tasks, acknowledgedTasks, projectId, sessionId])
  const timeline = useMemo(() => workspaceTimeline(history, visibleTasks), [history, visibleTasks])
  const timelineKey = JSON.stringify(timeline)
  const runtimeOnline = selectedBinding ? selectedBinding.status === 'online' && ['ready', 'busy'].includes(selectedBinding.runtimeStatus) : ['online', 'working'].includes(data?.agent.status || '')
  const selectedAgentName = selectedBinding?.name || agents.find(agent => agent.id === agentId)?.name || '选择智能体'
  const activeCount = visibleTasks.filter(task => ACTIVE_TASKS.has(task.status)).length

  async function request(value: AgentWorkspaceRequest): Promise<JsonRecord> {
    if (!window.launcher?.agentWorkspaceRequest) throw new Error('当前启动器内核不支持工作台，请升级启动器。')
    const response = await window.launcher.agentWorkspaceRequest(value)
    if (response.ok === false) throw new Error(string(response.message) || '操作未完成，请稍后重试。')
    return response
  }

  useLayoutEffect(() => {
    generation.current += 1
    setHost(undefined); setCloudAgents([]); setData(undefined); setHistory([]); setAcknowledgedTasks([])
    setAgentId(''); setProjectId(''); setSessionId(''); setInstruction(''); setError(''); setSyncError(''); setNotice(''); setBusy('')
    submission.current = undefined; pendingNewTask.current = ''; activatedAt.current = {}; historyRequested.current = {}
  }, [userId, signedIn])

  useEffect(() => {
    if (!supported) { setLoading(false); return }
    const current = ++generation.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const isCurrent = (): boolean => !disposed && generation.current === current
    async function tick(): Promise<void> {
      if (!isCurrent()) return
      if (document.hidden || polling.current) { timer = setTimeout(() => void tick(), POLL_MS); return }
      polling.current = true
      try {
        const nextHost = await window.launcher!.agentHostState!()
        if (!isCurrent()) return
        setHost(previous => sameData(previous, nextHost))
        if (!signedIn) { setLoading(false); return }
        const bootstrap = await request({ scope: 'hub', method: 'GET', action: 'bootstrap' })
        if (!isCurrent()) return
        const nextAgents = rows(bootstrap.agents).map(normalizeWorkspaceAgent).filter(agent => agent.id)
        setCloudAgents(previous => sameData(previous, nextAgents))
        if (!agentId) {
          const first = nextHost.agents[0]?.id || nextAgents[0]?.id
          if (first) setAgentId(first)
          return
        }
        if (Date.now() - (activatedAt.current[agentId] || 0) > 240000) {
          await request({ scope: 'hub', method: 'POST', action: 'activate_sync', body: { agentId, reason: 'launcher_workspace' } })
          activatedAt.current[agentId] = Date.now()
          if (!isCurrent()) return
        }
        const stateResponse = await request({ scope: 'hub', method: 'GET', action: 'agent_state', params: { agentId } })
        if (!isCurrent()) return
        const nextData = normalizeWorkspaceData(stateResponse.state)
        if (nextData.agent.id !== agentId) throw new Error('返回的智能体不匹配，请重新刷新。')
        setData(previous => sameData(previous, nextData))
        setAcknowledgedTasks(previous => previous.filter(task => !nextData.tasks.some(item => item.id === task.id)))
        const createdTask = nextData.tasks.find(task => task.id === pendingNewTask.current)
        if (createdTask?.sessionId && createdTask.projectId === projectId && !sessionId) {
          pendingNewTask.current = ''; forceBottom.current = true; setSessionId(createdTask.sessionId)
          return
        }
        if (!projectId || !nextData.projects.some(project => project.id === projectId)) {
          setProjectId(nextData.projects[0]?.id || '')
          setSessionId('')
          return
        }
        if (sessionId) {
          const validSession = nextData.sessions.some(session => session.id === sessionId && session.projectId === projectId)
          if (!validSession) { setSessionId(''); setHistory([]); return }
          if (['online', 'working'].includes(nextData.agent.status) && Date.now() - (historyRequested.current[sessionId] || 0) > 60000) {
            await request({ scope: 'hub', method: 'POST', action: 'request_session_history', body: { agentId, sessionId } })
            historyRequested.current[sessionId] = Date.now()
            if (!isCurrent()) return
          }
          const result = await request({ scope: 'hub', method: 'GET', action: 'session_history', params: { agentId, sessionId } })
          if (!isCurrent()) return
          setHistory(previous => sameData(previous, normalizeWorkspaceHistory(result.messages)))
        }
        setSyncError('')
      } catch (cause) {
        if (isCurrent()) setSyncError(cause instanceof Error ? cause.message : '同步失败；保留当前内容，请检查网络后重试。')
      } finally {
        polling.current = false
        if (isCurrent()) { setLoading(false); timer = setTimeout(() => void tick(), POLL_MS) }
      }
    }
    void tick()
    return () => { disposed = true; clearTimeout(timer) }
  }, [supported, signedIn, userId, agentId, projectId, sessionId, reload])

  useLayoutEffect(() => {
    if (!scroll.current) return
    if (forceBottom.current || stickToBottom.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight
      forceBottom.current = false; stickToBottom.current = true; setNewContent(false)
    } else if (timeline.length) setNewContent(true)
  }, [timelineKey])

  function selectAgent(id: string): void {
    generation.current += 1; setAgentId(id); setProjectId(''); setSessionId(''); setData(undefined); setHistory([])
    setReload(value => value + 1)
    setInstruction(''); submission.current = undefined; pendingNewTask.current = ''; setError(''); setSyncError(''); setLoading(true); setMobilePane('sessions'); forceBottom.current = true
  }
  function selectProject(id: string): void {
    generation.current += 1; setProjectId(id); setSessionId(''); setHistory([]); setInstruction(''); submission.current = undefined; pendingNewTask.current = ''; forceBottom.current = true
    setReload(value => value + 1)
  }
  function selectSession(id: string): void {
    generation.current += 1; setSessionId(id); setHistory([]); setInstruction(''); submission.current = undefined; pendingNewTask.current = ''
    setReload(value => value + 1)
    forceBottom.current = true; setNewContent(false); setMobilePane('conversation')
  }
  async function hostAction(action: AgentHostAction): Promise<void> {
    if (busy) return
    if (!signedIn && action.action !== 'discover') { onLogin(); return }
    if (action.action === 'resume' && hostManagement.revoked) { setError(REVOKED_DEVICE_HELP); return }
    const account = live.current.userId
    setBusy(action.action); setError(''); setNotice(''); setConfirmAction(undefined)
    try {
      const next = await window.launcher!.agentHostAction!(action)
      if (live.current.userId !== account) return
      setHost(next)
      if (action.action === 'add_agent' || action.action === 'import_existing') {
        const added = next.agents.find(agent => !host?.agents.some(previous => previous.id === agent.id))
        if (added) selectAgent(added.id)
      }
      if (action.action === 'revoke_device') { setAgentId(''); setData(undefined); setProjectId(''); setSessionId('') }
      if (action.action === 'remove_agent' && action.agentId === agentId) { setAgentId(''); setData(undefined) }
      setReload(value => value + 1)
      if (action.action === 'import_existing') setImportAgentId('')
    } catch (cause) { if (live.current.userId === account) setError(cause instanceof Error ? cause.message : '操作失败，请重试。') }
    finally { if (live.current.userId === account) setBusy('') }
  }
  async function refreshNative(): Promise<void> {
    if (!agentId || busy) return
    const current = { ...live.current }
    setBusy('refresh'); setError('')
    try {
      if (selectedBinding) await window.launcher!.agentHostAction!({ action: 'refresh', agentId })
      else await request({ scope: 'hub', method: 'POST', action: 'request_sync', body: { agentId } })
      if (sessionId) await request({ scope: 'hub', method: 'POST', action: 'request_session_history', body: { agentId, sessionId } })
      if (live.current.userId === current.userId && live.current.agentId === current.agentId) { setNotice('已通知本机同步，收到新的项目和会话后自动显示。'); setReload(value => value + 1) }
    } catch (cause) { if (live.current.userId === current.userId) setError(cause instanceof Error ? cause.message : '同步请求失败。') }
    finally { if (live.current.userId === current.userId) setBusy('') }
  }
  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    if (!instruction.trim() || busy || !runtimeOnline || !projectId || data?.canDispatch === false) return
    if (!signedIn) { onLogin(); return }
    const selection = { ...live.current }
    const payload = { agentId, projectId, sessionId: sessionId || null, instruction: instruction.trim(), mode: sessionId ? 'continue_session' : 'new_task' }
    const signature = JSON.stringify(payload)
    if (submission.current?.signature !== signature) submission.current = { signature, clientRequestId: crypto.randomUUID() }
    const clientRequestId = submission.current.clientRequestId
    setBusy('send'); setError(''); setNotice('')
    try {
      const result = await request({ scope: 'hub', method: 'POST', action: 'send_task', body: { ...payload, clientRequestId } })
      if (live.current.userId !== selection.userId || live.current.agentId !== selection.agentId) return
      const taskId = string(result.taskId)
      if (!taskId) throw new Error('服务器未返回任务编号；请重试同一内容以确认，不要重复创建任务。')
      setAcknowledgedTasks(previous => [...previous.filter(task => task.id !== taskId), { id: taskId, projectId, sessionId, clientRequestId, status: string(result.status) || 'queued', request: payload.instruction, reply: '', summary: '服务器已确认，等待本机执行', createdAt: new Date().toISOString() }])
      if (!sessionId) pendingNewTask.current = taskId
      if (live.current.projectId === projectId && live.current.sessionId === sessionId) { setInstruction(''); forceBottom.current = true }
      submission.current = undefined; setNotice('任务已进入同一账号的队列，手机网页也会同步显示。'); setReload(value => value + 1)
    } catch (cause) { if (live.current.userId === selection.userId) setError(cause instanceof Error ? cause.message : '发送结果未确认；内容已保留，重试不会重复创建同一任务。') }
    finally { if (live.current.userId === selection.userId) setBusy('') }
  }
  async function cancel(taskId: string): Promise<void> {
    if (busy) return
    const account = live.current.userId
    setBusy(`cancel:${taskId}`); setError('')
    try { await request({ scope: 'hub', method: 'POST', action: 'cancel_task', body: { agentId, taskId } }); if (live.current.userId === account) setReload(value => value + 1) }
    catch (cause) { if (live.current.userId === account) setError(cause instanceof Error ? cause.message : '取消失败，请重试。') }
    finally { if (live.current.userId === account) setBusy('') }
  }
  async function checkin(): Promise<void> {
    if (busy) return
    const account = live.current.userId
    setBusy('checkin'); setError('')
    try {
      await request({ scope: 'checkin', method: 'POST', action: 'claim_checkin' })
      if (live.current.userId === account) { setNotice('签到成功，正在同步今日任务权限。'); setReload(value => value + 1) }
    } catch (cause) { if (live.current.userId === account) setError(cause instanceof Error ? cause.message : '签到失败，请重试。') }
    finally { if (live.current.userId === account) setBusy('') }
  }

  if (!supported || host?.supported === false) return <div className="aw-unavailable"><Monitor size={36} /><h2>请升级启动器</h2><p>当前内核未提供本机托管接口，不能安全启动智能体或发送任务。</p><button className="primary-button" onClick={() => void api?.openExternal(DOWNLOAD_URL)}>下载最新版启动器</button><small>下载后覆盖安装即可；原有项目与会话不会由此页面删除。</small></div>
  return <section className="agent-workspace" data-mobile-pane={mobilePane} aria-label="智能体工作台">
    <div className="aw-toolbar">
      <div className="aw-device-line"><Monitor size={17} /><strong>{host?.deviceName || '这台电脑'}</strong><StateLabel value={host?.connection || 'connecting'} label={host?.enabled === false && host.connection !== 'unbound' && !hostManagement.revoked ? '已暂停托管' : undefined} /></div>
      <div className="aw-toolbar-actions"><span>心跳 {timeLabel(host?.lastHeartbeatAt)}</span><button className="small-button" disabled={Boolean(busy)} onClick={() => setReload(value => value + 1)} aria-label="刷新工作台状态"><RefreshCw size={14} /></button><button className="small-button" aria-expanded={signedIn && hostManagement.visible} onClick={() => setManage(value => !value)}><Settings2 size={14} />{hostManagement.visible ? '返回会话' : '管理本机'}</button></div>
    </div>
    {(error || syncError) && <div className="aw-feedback error" role="alert"><CircleAlert size={16} /><span>{error || syncError}</span>{/登录|会话.*过期/.test(error || syncError) && <button onClick={onLogin}>重新登录</button>}<button onClick={() => { setError(''); setSyncError(''); setReload(value => value + 1) }}>重试同步</button></div>}
    {notice && <div className="aw-feedback" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button onClick={() => setNotice('')}>知道了</button></div>}
    {!signedIn && <div className="aw-login"><LogIn size={20} /><div><strong>登录 AI历史书，连接这台电脑</strong><p>登录后自动登记设备并保持登录。手机使用同一账号，就能找到这台电脑。</p></div><button className="primary-button" onClick={onLogin}>登录并连接</button></div>}
    {signedIn && hostManagement.visible && <div className="aw-management-view" aria-label="本机绑定管理">
    {host && <div className="aw-management">
      <div><strong>{host.deviceId ? '本机托管设置' : '允许这台电脑接收远程任务'}</strong><p>只启动你添加的智能体，只访问你选择的项目。电脑关机、睡眠或完全退出启动器后无法远程启动。</p></div>
      {host.deviceId && <form className="aw-device-name-form" onSubmit={event => { event.preventDefault(); void hostAction({ action: 'rename_device', name: deviceNameDraft }) }}><label htmlFor="aw-device-name">设备名称<input id="aw-device-name" value={deviceNameDraft} maxLength={80} onChange={event => setDeviceNameDraft(event.target.value)} /></label><button className="small-button" disabled={Boolean(busy) || !deviceNameDraft.trim() || deviceNameDraft.trim() === host.deviceName}>保存名称</button><small>设备 ID：{host.deviceId} · 改名不会更换设备或项目</small></form>}
      {hostManagement.revoked ? <p className="aw-feedback error" role="alert"><CircleAlert size={16} /><span>{REVOKED_DEVICE_HELP}</span></p> : host.message && <p role="status">{host.message}</p>}
      <div className="aw-management-actions">
        {!host.deviceId ? <button className="primary-button" disabled={Boolean(busy)} onClick={() => void hostAction({ action: 'bind_device' })}>{busy === 'bind_device' ? <LoaderCircle size={15} className="spin" /> : <Monitor size={15} />}重试连接这台电脑</button> : <><button className="small-button" disabled={hostManagement.toggleDisabled} onClick={() => void hostAction({ action: host.enabled ? 'pause' : 'resume' })}>{host.enabled ? <Pause size={14} /> : <Play size={14} />}{host.enabled ? '暂停后台托管' : '恢复后台托管'}</button><button className="small-button danger" disabled={hostManagement.unbindDisabled} onClick={() => setConfirmAction({ action: 'revoke_device' })}><Unplug size={14} />解绑本机</button></>}
        <button className="small-button" disabled={Boolean(busy)} onClick={() => void hostAction({ action: 'discover' })}><RefreshCw size={14} />检测本机智能体</button>
      </div>
      {host.discovered.length > 0 && <div className="aw-discovered">{host.discovered.map(item => <div key={item.adapter}><span><strong>{item.name}</strong><small>{item.message || (item.available ? '本机已检测到' : '未检测到可用命令')}</small></span><button className="small-button" disabled={Boolean(busy) || !item.available || !host.deviceId} onClick={() => void hostAction({ action: 'add_agent', adapter: item.adapter as AgentAdapter, name: item.name })}><Plus size={13} />添加并选择项目</button></div>)}</div>}
      {confirmAction && <div className="aw-confirm" role="alert"><p>{confirmAction.action === 'revoke_device' ? '解绑会停止本机接收任务并撤销设备凭据，不会删除你的项目文件。' : '移除此托管绑定？原生项目和会话文件不会被删除。'}</p><button className="small-button" onClick={() => setConfirmAction(undefined)}>取消</button><button className="small-button danger" onClick={() => void hostAction(confirmAction)}>确认{confirmAction.action === 'revoke_device' ? '解绑' : '移除'}</button></div>}
    </div>}
    <div className="aw-management aw-legacy-management">
      <div><strong>接入网站已有智能体</strong><p>复用原实例、项目和对话，不重复创建。先检测本机旧连接配置，再确认授权；接入后需主动点击启动。</p></div>
      <button className="small-button" disabled={Boolean(busy)} onClick={() => void hostAction({ action: 'discover_existing' })}>检测已有连接配置</button>
      <div className="aw-discovered">{agents.filter(agent => !host?.agents.some(bound => bound.id === agent.id)).map(agent => {
        const candidate = host?.legacyCandidates?.find(item => item.adapter === agent.adapter)
        return <div key={agent.id}><span><strong>{agent.name}</strong><small>{candidate?.message || '尚未检测本机配置'}</small></span><button className="small-button" disabled={Boolean(busy) || !candidate?.available} onClick={() => setImportAgentId(agent.id)}>关联到本机</button></div>
      })}</div>
      {importAgentId && <div className="aw-confirm aw-import-confirm" role="region" aria-label="确认智能体项目授权"><p>允许启动器接收此智能体的远程任务，并访问以下原授权项目？不会强制终止旧服务中的任务；关联后仍需主动启动。</p><ul>{host?.legacyCandidates?.find(item => item.adapter === agents.find(agent => agent.id === importAgentId)?.adapter)?.projectRoots.map(root => <li className="aw-local-path" key={root}>{root}</li>)}</ul><button className="small-button" disabled={Boolean(busy)} onClick={() => setImportAgentId('')}>取消</button><button className="primary-button" disabled={Boolean(busy)} onClick={() => void hostAction({ action: 'import_existing', agentId: importAgentId })}>授权并关联原实例</button></div>}
    </div></div>}
    {!(signedIn && hostManagement.visible) && <>
    <nav className="aw-mobile-nav" aria-label="工作台分栏"><button aria-current={mobilePane === 'agents' ? 'page' : undefined} onClick={() => setMobilePane('agents')}>智能体</button><button aria-current={mobilePane === 'sessions' ? 'page' : undefined} onClick={() => setMobilePane('sessions')}>项目与会话</button><button aria-current={mobilePane === 'conversation' ? 'page' : undefined} onClick={() => setMobilePane('conversation')}>对话</button></nav>
    <div className="aw-panes">
      <aside className="aw-agent-pane">
        <header className="aw-pane-heading"><h2>我的智能体</h2><button className="aw-icon-button" aria-label="添加智能体" onClick={() => { setManage(true); void hostAction({ action: 'discover' }) }}><Plus size={17} /></button></header>
        <div className="aw-agent-list">{agents.map(agent => {
          const local = host?.agents.find(item => item.id === agent.id)
          return <button className={`aw-agent-row ${agentId === agent.id ? 'selected' : ''}`} key={agent.id} aria-pressed={agentId === agent.id} onClick={() => selectAgent(agent.id)}><Bot size={19} /><span><strong>{local?.name || agent.name}</strong><small>{agent.adapter} · {local ? '本机托管' : '独立连接器'}</small><StateLabel value={local?.status || 'unbound'} label={local ? undefined : '未由本机托管'} /></span></button>
        })}{!agents.length && <div className="aw-inline-empty">{loading ? '正在读取智能体…' : '先绑定本机，再检测并添加智能体。'}</div>}</div>
        <div className="aw-local-note"><Monitor size={15} /><p>托管服务独立于页面运行。DeepSeek Harness 仍从首页启动。</p></div>
      </aside>
      <aside className="aw-session-pane">
        <header className="aw-pane-heading"><h2>项目与会话</h2>{selectedBinding && <button className="aw-icon-button" disabled={Boolean(busy)} aria-label="添加授权项目" onClick={() => void hostAction({ action: 'add_project', agentId })}><FolderPlus size={17} /></button>}</header>
        <div className="aw-project-select"><label htmlFor="aw-project">授权项目</label><select id="aw-project" value={projectId} disabled={!data?.projects.length} onChange={event => selectProject(event.target.value)}>{!data?.projects.length && <option value="">尚未同步项目</option>}{data?.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select><button className="small-button" disabled={!projectId || Boolean(busy)} onClick={() => selectSession('')}><Plus size={14} />新建会话</button></div>
        <div className="aw-session-list">{sessions.map(session => <button key={session.id} className={`aw-session-row ${sessionId === session.id ? 'selected' : ''}`} aria-pressed={sessionId === session.id} onClick={() => selectSession(session.id)}><MessageSquare size={16} /><span><strong>{session.title}</strong><small>{workspaceStatusLabel(session.status)}</small></span></button>)}{!sessions.length && <div className="aw-inline-empty">{!agentId ? '选择左侧智能体。' : !projectId ? '添加授权目录并启动后，项目会自动同步到这里。' : '这个项目还没有同步会话。可直接新建，或点击同步本机。'}</div>}</div>
        {selectedBinding && <div className="aw-agent-control"><div><span>运行环境</span><StateLabel value={selectedBinding.runtimeStatus} /></div><p>{selectedBinding.message || (selectedBinding.busy ? '正在处理任务，停止或重启会中断执行。' : '只启动已授权的本机运行环境。')}</p><div className="aw-control-buttons"><button className="primary-button" disabled={Boolean(busy) || !host?.enabled || selectedBinding.runtimeStatus === 'unavailable'} onClick={() => void hostAction({ action: ['stopped', 'failed'].includes(selectedBinding.status) ? 'start' : 'stop', agentId })}>{['stopped', 'failed'].includes(selectedBinding.status) ? <Play size={14} /> : <Square size={14} />}{['stopped', 'failed'].includes(selectedBinding.status) ? '启动' : '停止'}</button><button className="small-button" disabled={Boolean(busy) || !host?.enabled || selectedBinding.runtimeStatus === 'unavailable'} onClick={() => void hostAction({ action: 'restart', agentId })}>重启</button><button className="aw-icon-button danger" disabled={Boolean(busy)} aria-label="移除智能体托管绑定" onClick={() => { setManage(true); setConfirmAction({ action: 'remove_agent', agentId }) }}><Unplug size={14} /></button></div></div>}
      </aside>
      <main className="aw-conversation-pane">
        <header className="aw-conversation-heading"><button className="aw-back aw-icon-button" aria-label="返回项目会话" onClick={() => setMobilePane('sessions')}><ArrowLeft size={17} /></button><div><h2>{selectedSession?.title || (selectedProject ? '新建会话' : selectedAgentName)}</h2><p><Folder size={13} />{selectedProject?.name || '选择项目后开始'}<span>·</span>{activeCount ? `${activeCount} 个任务处理中` : '原生会话同步'}</p></div><button className="small-button" disabled={!agentId || !runtimeOnline || Boolean(busy)} onClick={() => void refreshNative()}><RefreshCw size={14} className={busy === 'refresh' ? 'spin' : ''} />同步本机</button></header>
        <div className="aw-messages" ref={scroll} tabIndex={0} aria-label="智能体对话内容" onScroll={() => { if (!scroll.current) return; stickToBottom.current = workspaceNearBottom(scroll.current.scrollHeight, scroll.current.scrollTop, scroll.current.clientHeight); if (stickToBottom.current) setNewContent(false) }}>
          {!timeline.length && <Empty title={loading ? '正在同步工作台' : selectedProject ? selectedSession ? '读取最近对话' : '从这个项目开始' : '先选择一个本机项目'}>{selectedProject ? '这里与手机网页使用同一份任务与会话。完整原生记录仍保存在你的电脑中。' : '左侧选择智能体，再选择已授权的项目。没有手工填密钥，也不会把任意目录交给远程执行。'}</Empty>}
          {timeline.map(row => <article className={`aw-message ${row.role}`} key={row.id}><div className="aw-message-byline"><strong>{row.role === 'user' ? '你' : selectedAgentName}</strong><time>{timeLabel(row.time)}</time></div><div className="aw-message-body">{row.text}</div>{row.task && <div className="aw-task-status"><StateLabel value={row.task.status} />{row.task.progress !== undefined && ACTIVE_TASKS.has(row.task.status) && <progress value={row.task.progress} max={100} aria-label={`任务进度 ${row.task.progress}%`} />}{row.task.status === 'awaiting_approval' && <small>请在本机智能体内确认权限</small>}{ACTIVE_TASKS.has(row.task.status) && row.task.status !== 'cancel_requested' && <button className="aw-text-button" disabled={Boolean(busy)} onClick={() => void cancel(row.task!.id)}>取消任务</button>}</div>}</article>)}
        </div>
        {newContent && <button className="aw-new-content" onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; stickToBottom.current = true; setNewContent(false) }}><ArrowDown size={14} />有新内容，回到最新</button>}
        <form className="aw-composer" onSubmit={event => void send(event)}>
          {signedIn && data?.canDispatch === false && <p className="aw-composer-hint">今天尚未签到，签到后可免费派发任务。<button type="button" className="aw-text-button" disabled={Boolean(busy)} onClick={() => void checkin()}>{busy === 'checkin' ? '签到中…' : '立即签到'}</button></p>}
          {agentId && !runtimeOnline && <p className="aw-composer-hint">{selectedBinding?.runtimeStatus === 'unavailable' ? '此智能体暂不支持远程交互，请切换其他已就绪智能体；历史记录仍可查看。' : selectedBinding ? '智能体尚未就绪，请先启动并完成本机检查；电脑离线时不能派发任务。' : '这个智能体尚未连线，请在它所在的电脑启动连接器。'}</p>}
          <label className="aw-sr-only" htmlFor="aw-instruction">发送给当前智能体的任务</label><textarea id="aw-instruction" value={instruction} maxLength={8000} disabled={!signedIn || !projectId || busy === 'send'} placeholder={sessionId ? '继续这个原生会话…' : '输入任务，在所选项目中创建会话…'} onChange={event => setInstruction(event.target.value)} onKeyDown={event => { if (workspaceEnterSends(event)) { event.preventDefault(); void send() } }} />
          <div className="aw-composer-footer"><span>Enter 发送 · Shift + Enter 换行 <span>{instruction.length}/8000</span></span><button type="submit" className="primary-button" disabled={Boolean(busy) || !signedIn || !runtimeOnline || !projectId || data?.canDispatch === false || !instruction.trim()}>{busy === 'send' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}{busy === 'send' ? '发送中' : '发送任务'}</button></div>
        </form>
      </main>
    </div></>}
  </section>
}
