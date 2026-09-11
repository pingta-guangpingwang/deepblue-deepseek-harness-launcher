import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageSquare, Monitor, RefreshCw, Paperclip, Send } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type { AgentAdapter, AgentHostAction, AgentHostSnapshot } from '../../shared/agent-host'
import { AGENT_CATALOG, agentName, localAgentStatus } from '../../shared/agent-catalog'
import { WorkspaceTree } from './WorkspaceTree'
import { AgentAssociationPanel } from './AgentAssociationPanel'
import { NativeApprovalPanel } from './NativeApprovalPanel'
import { ChatMessage } from './ChatMessage'
import { ConversationControls } from './ConversationControls'
const names: Record<string, string> = Object.fromEntries(AGENT_CATALOG.map(agent => [agent.id, agent.name]))
const stamp = (date?: string): string => date ? new Date(date).toLocaleString('zh-CN') : '尚未确认'
export const projectsForAdapter = <T extends { adapter: string }>(projects: T[], adapter: string): T[] => adapter === 'all' ? projects : projects.filter(item => item.adapter === adapter)

export function LocalAgentWorkspace({ snapshot, onLogin, initialProjectId, initialSessionId, initialConversationId, detached = false }: { snapshot: LauncherSnapshot; onLogin(): void; initialProjectId?: string; initialSessionId?: string; initialConversationId?: string; detached?: boolean }): React.JSX.Element {
  const [host, setHost] = useState<AgentHostSnapshot>()
  const [projectId, setProject] = useState(initialProjectId || '')
  const [sessionId, setSession] = useState(initialSessionId || '')
  const [conversationId, setConversationId] = useState(() => initialConversationId || crypto.randomUUID().replaceAll('-', ''))
  const [hideProjects, setHideProjects] = useState(detached)
  const [hideSessions, setHideSessions] = useState(detached)
  const [mobilePane, setMobilePane] = useState('conversation')
  const chatPane = useRef<HTMLElement>(null)
  const [adapter, setAdapter] = useState<AgentAdapter>('codex')
  const [associationRequest, setAssociationRequest] = useState<{ adapter: AgentAdapter; sequence: number }>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmSyncAdapter, setConfirmSyncAdapter] = useState('')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const drafts = useRef(new Map<string, string>())
  const draftContext = useRef('')
  const currentDraft = useRef('')
  currentDraft.current = draft
  const [model, setModel] = useState('')
  const [fileIds, setFileIds] = useState<string[]>([])
  const scroll = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const mounted = useRef(true)
  const reading = useRef(false)
  const requestId = useRef<{ signature: string; id: string } | undefined>(undefined)
  const allProjects = host?.localCatalog?.projects || []
  const projects = projectsForAdapter(allProjects, adapter)
  const project = projects.find(item => item.id === projectId)
  const sessions = host?.localCatalog?.sessions.filter(item => item.projectId === projectId) || []
  const session = sessions.find(item => item.id === sessionId)
  const desktopSession = project?.adapter === 'codex' && !!session
  const nativeOwned = desktopSession && !host?.desktopRelay?.ready || !sessionId && host?.localConversationContinuity !== true
  const messages = host?.localHistory?.sessionId === sessionId ? host.localHistory.messages : []
  const tasks = host?.localTasks?.filter(item => item.projectId === projectId && (item.sessionId || '') === sessionId && (sessionId || item.conversationId === conversationId)) || []
  const running = tasks.some(item => ['running', 'awaiting_approval', 'delivered'].includes(item.status))
  const binding = host?.agents.find(item => item.adapter === project?.adapter)
  useEffect(() => {
    const key = `${projectId}:${sessionId || 'new'}`
    if (draftContext.current) drafts.current.set(draftContext.current, currentDraft.current)
    draftContext.current = key; setDraft(drafts.current.get(key) || '')
  }, [projectId, sessionId])
  useEffect(() => { if (detached && initialProjectId) { const item = allProjects.find(item => item.id === initialProjectId); if (item) setAdapter(item.adapter) } }, [host?.localCatalog, detached, initialProjectId])
  async function action(input: AgentHostAction): Promise<AgentHostSnapshot> {
    if (!window.launcher?.agentHostAction) throw new Error('请先更新启动器的本机托管模块')
    return window.launcher.agentHostAction(input)
  }
  async function scan(): Promise<void> {
    if (reading.current) return
    reading.current = true; setScanning(true)
    try { const result = await action({ action: 'scan_local' }); if (mounted.current) { setHost(previous => ({ ...result, localHistory: previous?.localHistory })) } }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '本机读取失败，请重试') }
    finally { reading.current = false; if (mounted.current) setScanning(false) }
  }
  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => { if (stopped) return; if (!document.hidden) await scan(); if (!stopped) timer = setTimeout(() => void poll(), 15000) }
    void poll()
    return () => { stopped = true; mounted.current = false; clearTimeout(timer) }
  }, [])
  useEffect(() => {
    let disposed = false
    const timer = setInterval(() => { void window.launcher?.agentHostState?.().then(result => { if (!disposed) setHost(previous => previous ? { ...previous, localCatalog: result.localCatalog || previous.localCatalog, localTasks: result.localTasks, agents: result.agents, desktopRelay: result.desktopRelay } : result) }).catch(() => {}) }, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [])
  useEffect(() => { if (!detached && !projects.some(item => item.id === projectId)) { setProject(projects[0]?.id || ''); setSession(host?.localCatalog?.sessions.find(item => item.projectId === projects[0]?.id)?.id || '') } }, [host?.localCatalog, adapter, detached])
  useEffect(() => {
    if (!sessionId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { const result = await action({ action: 'read_local_history', sessionId }); if (!stopped) setHost(previous => previous ? { ...previous, localHistory: result.localHistory } : result) }
      catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : '本机对话读取失败') }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 5000) }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [sessionId])
  useLayoutEffect(() => { if (scroll.current && stick.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [JSON.stringify(messages), JSON.stringify(tasks)])
  function selectProject(id: string): void { setProject(id); setSession(host?.localCatalog?.sessions.find(item => item.projectId === id)?.id || ''); setConversationId(crypto.randomUUID().replaceAll('-', '')); setModel(''); setFileIds([]); setMobilePane('sessions'); stick.current = true }
  async function chooseFiles(): Promise<void> {
    try { const result = await action({ action: 'choose_local_files' }); setHost(previous => ({ ...result, localHistory: previous?.localHistory })); setFileIds(result.localFiles?.map(file => file.id) || []) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '选择文件失败') }
  }
  async function refreshModels(): Promise<void> {
    try { const result = await action({ action: 'refresh_local_models' }); if (mounted.current) setHost(previous => previous ? { ...previous, localCatalog: result.localCatalog } : result) }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '模型刷新失败') }
  }
  async function send(): Promise<void> {
    if (!project || !draft.trim() || busy || running || nativeOwned) return
    const signature = JSON.stringify({ projectId, sessionId, conversationId, draft, model, fileIds })
    if (requestId.current?.signature !== signature) requestId.current = { signature, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      const result = await action({ action: 'send_local', projectId, sessionId: sessionId || undefined, conversationId: sessionId ? undefined : conversationId, instruction: draft.trim(), model: model || undefined, fileIds, requestId: requestId.current.id })
      if (mounted.current) { setHost(previous => ({ ...result, localHistory: previous?.localHistory })); setDraft(''); setFileIds([]); requestId.current = undefined; stick.current = true }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '本机发送失败，草稿已保留') }
    finally { if (mounted.current) setBusy(false) }
  }
  async function sync(confirmed = false): Promise<void> {
    if (!project || busy) return
    if (snapshot.account.status !== 'signed_in') { onLogin(); return }
    if (binding?.projectScope !== 'all_native' && (!confirmed || confirmSyncAdapter !== project.adapter)) { setConfirmSyncAdapter(project.adapter); return }
    setConfirmSyncAdapter('')
    setBusy(true); setError(''); setNotice('')
    try {
      let result = await action({ action: 'bind_local_project', projectId })
      const agent = result.agents.find(item => item.adapter === project.adapter)
      if (agent) result = await action({ action: 'refresh', agentId: agent.id })
      if (mounted.current) { setHost(previous => ({ ...result, localHistory: previous?.localHistory })); setNotice('这个智能体的原生项目和对话目录已推送网站；新增项目将持续自动同步。') }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '同步失败，本机记录未受影响') }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="agent-workspace" data-mobile-pane={mobilePane} aria-label="本机智能体项目">
    {confirmSyncAdapter && <div className="aw-confirm" role="region" aria-label="连接智能体授权"><p>连接 {names[confirmSyncAdapter] || confirmSyncAdapter} 后，自动同步它的全部原生项目和对话目录，并允许在这些项目内接收远程任务。之后新增项目也会自动加入，只需授权这一次。</p><button className="small-button" onClick={() => setConfirmSyncAdapter('')}>取消</button><button className="primary-button" disabled={busy || project?.adapter !== confirmSyncAdapter} onClick={() => void sync(true)}>授权并连接智能体</button></div>}


    {nativeOwned && <div className="aw-feedback" role="status">{host?.desktopRelay?.message || '正在检查桌面桥接'}。草稿保留，不会另开 CLI 抢占原对话。{draft && <button className="small-button" onClick={() => void navigator.clipboard.writeText(draft).then(() => setNotice('草稿已复制，可粘贴到桌面原对话。')).catch(() => setError('复制失败，请手动复制草稿'))}>复制草稿</button>}</div>}
    <div className="aw-toolbar"><div className="aw-device-line"><Monitor size={16} /><strong>本机工作台</strong><span className="aw-status">读取于 {stamp(host?.localCatalog?.scannedAt)}</span></div><div className="aw-local-toolbar-actions"><button className="small-button" disabled={scanning} onClick={() => void scan()}><RefreshCw size={14} className={scanning ? 'spin' : ''} />{scanning ? '读取中…' : '刷新本机'}</button><AgentAssociationPanel request={associationRequest} /></div></div>
    {error && <div className="aw-feedback error" role="alert"><span>{error}。已有内容保留，不代表操作成功。</span></div>}
    {notice && <div className="aw-feedback" role="status"><span>{notice}</span></div>}
    {tasks.filter(task => task.status === 'failed').slice(-1).map(task => <div className="aw-feedback" key={task.id}><span>任务未成功，可恢复原消息继续编辑。</span><button className="small-button" disabled={Boolean(draft)} onClick={() => setDraft(task.instruction)}>恢复到输入框</button></div>)}
    {!detached && <nav className="aw-mobile-tabs" aria-label="本机会话面板">{([['agents','设备与项目'],['sessions','对话列表'],['conversation','聊天']] as const).map(([id,label]) => <button key={id} className="small-button" aria-pressed={mobilePane === id} onClick={() => { setMobilePane(id); if (id === 'agents') setHideProjects(false); if (id === 'sessions') setHideSessions(false) }}>{label}</button>)}</nav>}
    <div className="aw-panes aw-hierarchy-panes" data-hide-first={hideProjects} data-hide-second={hideSessions}>
      <aside className="aw-agent-pane"><header className="aw-pane-heading"><h2>设备与智能体</h2><span className="aw-status">{AGENT_CATALOG.length} 种</span></header><WorkspaceTree
        devices={[{ id: 'local', name: host?.deviceName || '这台电脑', status: '本机 · 无需网站登录', agents: AGENT_CATALOG.map(item => ({
          id: item.id, adapter: item.id, name: item.name, status: localAgentStatus(item.id, host), canAssociate: true,
          projects: allProjects.filter(project => project.adapter === item.id),
          projectMessage: !item.execution ? '暂不支持远程执行，可查看关联说明。' : !item.nativeHistory ? '原生项目读取暂未接入；可以关联接口，已有启动器项目仍显示。' : scanning ? '正在读取原生项目索引…' : '尚未发现原生项目，可先关联智能体后刷新。'
        })) }]}
        selectedAgentId={adapter} selectedProjectId={projectId} loading={scanning}
        onSelectAgent={(_device, id) => { setAdapter(id as AgentAdapter); setProject(''); setSession(''); setModel(''); setFileIds([]); }}
        onSelectProject={(_device, id, project) => { setAdapter(id as AgentAdapter); selectProject(project) }}
        onAssociate={adapter => setAssociationRequest({ adapter, sequence: Date.now() })}
      /><div className="aw-local-note"><p>连接能力与项目读取能力分别显示；没有读取能力不代表没有项目。</p></div></aside>
      <aside className="aw-session-pane"><header className="aw-pane-heading"><h2>最近对话 · {sessions.length}</h2></header><div className="aw-session-list">{sessions.map(item => <button key={item.id} className={`aw-session-row ${sessionId === item.id ? 'selected' : ''}`} aria-pressed={sessionId === item.id} onClick={() => { setSession(item.id); stick.current = true }}><MessageSquare size={16} /><span><strong>{item.title}</strong><small>{stamp(item.lastActivityAt)}</small></span></button>)}</div></aside>
      <main className="aw-conversation-pane" ref={chatPane}><header className="aw-conversation-heading"><div><h2>{session?.title || (tasks.length ? '当前本机会话' : '本机新会话')}</h2><p className="aw-breadcrumb" aria-label="当前对话位置"><span>{host?.deviceName || '这台电脑'}</span><span aria-hidden="true">/</span><span>{agentName(adapter)}</span><span aria-hidden="true">/</span><span title={project?.path}>{project?.name || '选择项目'}</span></p></div><button className="small-button" disabled={!project || busy} onClick={() => void sync()}>{binding ? '立即同步网站' : '连接智能体并自动同步'}</button><ConversationControls pane={chatPane} detached={detached} target={project ? { kind: 'local-session', projectId, sessionId: sessionId || undefined, conversationId: sessionId ? undefined : conversationId, title: session?.title || project.name } : undefined} lists={[{ name: '导航', collapsed: hideProjects, toggle: () => setHideProjects(value => !value) }, { name: '对话列表', collapsed: hideSessions, toggle: () => setHideSessions(value => !value) }]} /></header>
        <div className="aw-messages" ref={scroll} tabIndex={0} aria-label="本机原生对话" onScroll={() => { const node = scroll.current; if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64 }}>
          {messages.map((message, index) => <ChatMessage key={`${message.id}:${index}`} role={message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system'} name={message.role === 'user' ? '你' : names[project?.adapter || ''] || '智能体'} time={stamp(message.occurredAt)} text={message.text} />)}
          {tasks.map(task => <div key={task.id}>
            {!messages.some(message => message.role === 'user' && message.text === task.instruction) && <ChatMessage role="user" name="你" text={task.instruction} />}
            <ChatMessage role="assistant" name={names[project?.adapter || ''] || '智能体'} badge={task.status === 'awaiting_approval' ? '等待审批' : task.status === 'running' ? '执行中' : task.status === 'delivered' ? '已送达桌面' : task.status === 'unconfirmed' ? '结果未确认' : task.status === 'completed' ? '执行结束' : task.status === 'cancelled' ? '已停止' : '失败'} text={messages.some(message => message.role === 'assistant' && message.text === task.reply) ? '回复已显示在原生记录中。' : task.reply || task.summary || ''}>{task.status === 'running' && task.backend !== 'desktop' && <button className="small-button" onClick={() => void action({ action: 'cancel_local', taskId: task.id }).catch(cause => setError(String(cause.message)))}>停止本机任务</button>}</ChatMessage>
          </div>)}
          {!messages.length && !tasks.length && <p className="aw-inline-empty">{sessionId ? '正在读取本机对话…' : project ? '可以直接发送任务，创建原生会话。' : '在左侧选择智能体和项目后开始。'}</p>}
          {desktopSession && <NativeApprovalPanel key={sessionId} sessionId={sessionId} enabled={true}
            load={async () => { const result = await action({ action: 'read_native_approvals', sessionId }); if (!result.nativeApprovals) throw new Error('当前模块尚未提供原会话审批，请更新本机托管模块'); return result.nativeApprovals }}
            decide={async (approval, approved) => { const result = await action({ action: 'decide_native_approval', sessionId, id: approval.id, requestHash: approval.requestHash, approved }); if (!result.nativeApprovals) throw new Error('审批回传未确认'); return result.nativeApprovals }}
          />}
        </div>
<form className="aw-composer" onSubmit={event => { event.preventDefault(); void send() }}><div className="aw-toolbar"><button type="button" className="small-button" disabled={busy || running} onClick={() => void chooseFiles()}><Paperclip size={14} />添加本机文件</button><select onFocus={() => void refreshModels()} aria-label="本机智能体模型" value={model} onChange={event => setModel(event.target.value)}><option value="">{session ? '沿用当前对话模型' : '使用智能体默认模型'}</option>{host?.localCatalog?.models?.filter(item => item.adapter === project?.adapter).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" className="small-button" onClick={() => void refreshModels()}>刷新模型</button><button type="button" className="small-button" disabled={!project || running || detached} onClick={() => { setSession(''); setConversationId(crypto.randomUUID().replaceAll('-', '')); stick.current = true }}>新建对话</button></div>{fileIds.length > 0 && <div className="aw-local-files">{host?.localFiles?.filter(file => fileIds.includes(file.id)).map(file => <button type="button" className="small-button" key={file.id} onClick={() => setFileIds(ids => ids.filter(id => id !== file.id))}>{file.name} · 移除</button>)}</div>}<textarea aria-label="本机任务内容" placeholder="直接交给本机智能体；无需网站登录或签到" value={draft} maxLength={12000} disabled={!project || busy || running} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="aw-composer-footer"><span>音视频作为文件交付；具体解析能力取决于智能体。</span><button type="submit" className="primary-button" disabled={!project || !draft.trim() || busy || running || nativeOwned}><Send size={14} />{nativeOwned ? sessionId ? '桌面桥接未就绪' : '请更新本机托管模块' : busy ? '提交中…' : desktopSession ? '发送到桌面原对话' : '本机发送'}</button></div></form>
        <div className="aw-local-note"><p>{binding ? `托管状态：${binding.status}；最近推送：${stamp(binding.lastSyncedAt)}` : '尚未开启网站同步。修改时间不是运行状态；本机任务沿用智能体账号、权限和模型额度。'}</p></div>
      </main>
    </div>
  </section>
}
