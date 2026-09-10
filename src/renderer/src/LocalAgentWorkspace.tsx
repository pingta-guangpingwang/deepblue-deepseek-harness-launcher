import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Folder, MessageSquare, Monitor, RefreshCw, Paperclip, Send } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type { AgentHostAction, AgentHostSnapshot } from '../../shared/agent-host'
import { ChatMessage } from './ChatMessage'
import { ConversationControls } from './ConversationControls'
const names: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', qclaw: 'OpenClaw' }
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
  const [query, setQuery] = useState('')
  const [adapter, setAdapter] = useState('all')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
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
  const running = tasks.some(item => ['running', 'delivered'].includes(item.status))
  const binding = host?.agents.find(item => item.adapter === project?.adapter && item.projectRoots.some(root => root.toLowerCase() === project?.path.toLowerCase()))
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
  function selectProject(id: string): void { setProject(id); setSession(host?.localCatalog?.sessions.find(item => item.projectId === id)?.id || ''); setConversationId(crypto.randomUUID().replaceAll('-', '')); setDraft(''); setModel(''); stick.current = true }
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
  async function sync(): Promise<void> {
    if (!project || busy) return
    if (snapshot.account.status !== 'signed_in') { onLogin(); return }
    setBusy(true); setError(''); setNotice('')
    try {
      let result = await action({ action: 'bind_local_project', projectId })
      const agent = result.agents.find(item => item.adapter === project.adapter && item.projectRoots.some(root => root.toLowerCase() === project.path.toLowerCase()))
      if (agent) result = await action({ action: 'refresh', agentId: agent.id })
      if (mounted.current) { setHost(previous => ({ ...result, localHistory: previous?.localHistory })); setNotice('本机项目和对话目录已推送网站；后续由本机托管进程持续更新。') }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '同步失败，本机记录未受影响') }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="agent-workspace" data-mobile-pane={mobilePane} aria-label="本机智能体项目">
    <nav className="aw-toolbar" aria-label="切换本机智能体">{[['all', '全部'], ...Object.entries(names)].map(([id, name]) => <button key={id} className={adapter === id ? 'primary-button' : 'small-button'} aria-pressed={adapter === id} onClick={() => { setAdapter(id!); setQuery(''); setModel(''); setFileIds([]); stick.current = true }}>{name} · {projectsForAdapter(allProjects, id!).length}</button>)}</nav>
    {adapter !== 'all' && !projects.length && <p className="aw-feedback" role="status">未发现 {names[adapter]} 的本机项目记录。切换入口仍可用；先在原生智能体创建项目，再点击刷新本机。</p>}
    {nativeOwned && <div className="aw-feedback" role="status">{host?.desktopRelay?.message || '正在检查桌面桥接'}。草稿保留，不会另开 CLI 抢占原对话。{draft && <button className="small-button" onClick={() => void navigator.clipboard.writeText(draft).then(() => setNotice('草稿已复制，可粘贴到桌面原对话。')).catch(() => setError('复制失败，请手动复制草稿'))}>复制草稿</button>}</div>}
    <div className="aw-toolbar"><div className="aw-device-line"><Monitor size={16} /><strong>本机原生记录</strong><span className="aw-status">读取于 {stamp(host?.localCatalog?.scannedAt)}</span></div><button className="small-button" disabled={scanning} onClick={() => void scan()}><RefreshCw size={14} className={scanning ? 'spin' : ''} />{scanning ? '读取中…' : '刷新本机'}</button></div>
    {error && <div className="aw-feedback error" role="alert"><span>{error}。已有内容保留，不代表操作成功。</span></div>}
    {notice && <div className="aw-feedback" role="status"><span>{notice}</span></div>}
    {tasks.filter(task => task.status === 'failed').slice(-1).map(task => <div className="aw-feedback" key={task.id}><span>任务未成功，可恢复原消息继续编辑。</span><button className="small-button" disabled={Boolean(draft)} onClick={() => setDraft(task.instruction)}>恢复到输入框</button></div>)}
    {!detached && <nav className="aw-mobile-tabs" aria-label="本机会话面板">{([['agents','项目'],['sessions','对话列表'],['conversation','聊天']] as const).map(([id,label]) => <button key={id} className="small-button" aria-pressed={mobilePane === id} onClick={() => { setMobilePane(id); if (id === 'agents') setHideProjects(false); if (id === 'sessions') setHideSessions(false) }}>{label}</button>)}</nav>}
    <div className="aw-panes" data-hide-first={hideProjects} data-hide-second={hideSessions}>
      <aside className="aw-agent-pane"><header className="aw-pane-heading"><h2>本机项目 · {projects.length}</h2></header><div className="aw-project-select"><input aria-label="搜索本机项目" placeholder="搜索名称或目录" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="aw-agent-list">{projects.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} className={`aw-agent-row ${projectId === item.id ? 'selected' : ''}`} aria-pressed={projectId === item.id} onClick={() => selectProject(item.id)}><Folder size={17} /><span><strong>{item.name}</strong><small>{names[item.adapter]}</small></span></button>)}{!projects.length && <p className="aw-inline-empty">{scanning ? '正在读取智能体保存的项目索引，不扫描整个磁盘。' : '没有找到本机记录，请先在原生智能体创建对话后刷新。'}</p>}</div><div className="aw-local-note"><p>直接读取本机，无需网站登录。不会混入云端历史。</p></div></aside>
      <aside className="aw-session-pane"><header className="aw-pane-heading"><h2>最近对话 · {sessions.length}</h2></header><div className="aw-session-list">{sessions.map(item => <button key={item.id} className={`aw-session-row ${sessionId === item.id ? 'selected' : ''}`} aria-pressed={sessionId === item.id} onClick={() => { setSession(item.id); stick.current = true }}><MessageSquare size={16} /><span><strong>{item.title}</strong><small>{stamp(item.lastActivityAt)}</small></span></button>)}</div></aside>
      <main className="aw-conversation-pane" ref={chatPane}><header className="aw-conversation-heading"><div><h2>{session?.title || (tasks.length ? '当前本机会话' : '本机新会话')}</h2><p className="aw-local-path">{project?.path || (detached ? '原项目暂不可用；不会切换到其他项目' : '最新活动的项目优先显示')}</p></div><button className="small-button" disabled={!project || busy} onClick={() => void sync()}>{binding ? '立即同步网站' : '同步此项目到网站'}</button><ConversationControls pane={chatPane} detached={detached} target={project ? { kind: 'local-session', projectId, sessionId: sessionId || undefined, conversationId: sessionId ? undefined : conversationId, title: session?.title || project.name } : undefined} lists={[{ name: '项目', collapsed: hideProjects, toggle: () => setHideProjects(value => !value) }, { name: '对话列表', collapsed: hideSessions, toggle: () => setHideSessions(value => !value) }]} /></header>
        <div className="aw-messages" ref={scroll} tabIndex={0} aria-label="本机原生对话" onScroll={() => { const node = scroll.current; if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64 }}>
          {messages.map((message, index) => <ChatMessage key={`${message.id}:${index}`} role={message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system'} name={message.role === 'user' ? '你' : names[project?.adapter || ''] || '智能体'} time={stamp(message.occurredAt)} text={message.text} />)}
          {tasks.map(task => <div key={task.id}>
            {!messages.some(message => message.role === 'user' && message.text === task.instruction) && <ChatMessage role="user" name="你" text={task.instruction} />}
            <ChatMessage role="assistant" name={names[project?.adapter || ''] || '智能体'} badge={task.status === 'running' ? '执行中' : task.status === 'delivered' ? '已送达桌面' : task.status === 'unconfirmed' ? '结果未确认' : task.status === 'completed' ? '执行结束' : task.status === 'cancelled' ? '已停止' : '失败'} text={messages.some(message => message.role === 'assistant' && message.text === task.reply) ? '回复已显示在原生记录中。' : task.reply || task.summary || ''}>{task.status === 'running' && task.backend !== 'desktop' && <button className="small-button" onClick={() => void action({ action: 'cancel_local', taskId: task.id }).catch(cause => setError(String(cause.message)))}>停止本机任务</button>}</ChatMessage>
          </div>)}
          {!messages.length && !tasks.length && <p className="aw-inline-empty">{sessionId ? '正在读取本机对话…' : '可以直接发送任务，创建原生会话。'}</p>}
        </div>
<form className="aw-composer" onSubmit={event => { event.preventDefault(); void send() }}><div className="aw-toolbar"><button type="button" className="small-button" disabled={busy || running} onClick={() => void chooseFiles()}><Paperclip size={14} />添加本机文件</button><select onFocus={() => void refreshModels()} aria-label="本机智能体模型" value={model} onChange={event => setModel(event.target.value)}><option value="">{session ? '沿用当前对话模型' : '使用智能体默认模型'}</option>{host?.localCatalog?.models?.filter(item => item.adapter === project?.adapter).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" className="small-button" onClick={() => void refreshModels()}>刷新模型</button><button type="button" className="small-button" disabled={!project || running || detached} onClick={() => { setSession(''); setConversationId(crypto.randomUUID().replaceAll('-', '')); stick.current = true }}>新建对话</button></div>{fileIds.length > 0 && <div className="aw-local-files">{host?.localFiles?.filter(file => fileIds.includes(file.id)).map(file => <button type="button" className="small-button" key={file.id} onClick={() => setFileIds(ids => ids.filter(id => id !== file.id))}>{file.name} · 移除</button>)}</div>}<textarea aria-label="本机任务内容" placeholder="直接交给本机智能体；无需网站登录或签到" value={draft} maxLength={12000} disabled={!project || busy || running} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} /><div className="aw-composer-footer"><span>音视频作为文件交付；具体解析能力取决于智能体。</span><button type="submit" className="primary-button" disabled={!project || !draft.trim() || busy || running || nativeOwned}><Send size={14} />{nativeOwned ? sessionId ? '桌面桥接未就绪' : '请更新本机托管模块' : busy ? '提交中…' : desktopSession ? '发送到桌面原对话' : '本机发送'}</button></div></form>
        <div className="aw-local-note"><p>{binding ? `托管状态：${binding.status}；最近推送：${stamp(binding.lastSyncedAt)}` : '尚未开启网站同步。修改时间不是运行状态；本机任务沿用智能体账号、权限和模型额度。'}</p></div>
      </main>
    </div>
  </section>
}
