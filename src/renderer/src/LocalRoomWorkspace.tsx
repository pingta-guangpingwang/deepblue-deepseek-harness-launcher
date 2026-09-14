import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, Bot, Cloud, Download, ExternalLink, FileText, FolderPlus, LoaderCircle, Monitor, Paperclip, Plus, RefreshCw, Send, Settings2, ShieldCheck, Square, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { LocalControlCommand, LocalControlEvent, LocalControlSnapshot, LocalFileMetadata, LocalPermissionMode, LocalRoomDetail, LocalRoomMember, LocalRuntimeDescriptor } from '../../shared/local-control'
import type { LauncherSnapshot } from '../../shared/types'
import { AgentSessionGroups } from './AgentSessionGroups'
import { LocalPdfPreview } from './LocalPdfPreview'
import { mergeHistoryWindow } from './history-window'
import { LocalDeferredRecord } from './LocalDeferredRecord'
import { ChatMessage } from './ChatMessage'
import { ConversationControls } from './ConversationControls'
import { RoomSettingsOverview } from './RoomSettingsOverview'
import './local-room-workspace.css'

const modeNames: Record<LocalPermissionMode, string> = { ask: '请求批准', assist: '帮我批准', full: '完全批准' }
const stateNames: Record<string, string> = { idle: '待命', queued: '排队中', running: '执行中', awaiting_approval: '待批准', unknown: '待核对', completed: '执行结束', failed: '未完成', cancel_requested: '正在取消', cancelled: '已取消' }
const syncNames: Record<string, string> = { local_only: '仅在本机', pending: '等待网页确认', synced: '网页副本已确认', offline: '同步中断，本机可用', disabling: '等待清理云副本', removed: '云副本已清理' }
const operationNames: Record<string, string> = { choose_files: '正在选择并固定文件版本', preview_file: '正在读取本地预览', save_file: '正在另存文件', open_file: '正在打开本地应用', decide_approval: '正在提交审批决定', set_permission: '正在更新审批规则', send_room: '正在保存本地任务', set_cloud_sync: '正在更新网页同步设置', refresh_catalog: '正在读取本机目录', authorize_project: '正在选择授权项目', cancel_run: '正在取消本轮任务', reconcile_run: '正在核对原生状态' }
const requestId = (): string => crypto.randomUUID().replaceAll('-', '')
const sizeText = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
async function call<T>(command: LocalControlCommand, input: Record<string, unknown> = {}, id = requestId()): Promise<T> {
  const state = await window.launcher!.agentHostAction!({ action: 'local_control', command, input, requestId: id })
  const response = state.localControl?.lastResult as { requestId?: string; result?: T } | undefined
  if (!response || response.requestId !== id) throw new Error('本地响应编号不匹配，请刷新状态；不会重复提交任务')
  return response.result as T
}
export function LocalGroupsSwitch(props: { snapshot: LauncherSnapshot; onLogin(): void }): React.JSX.Element {
  const [supported, setSupported] = useState<boolean>(), [legacy, setLegacy] = useState(false)
  const [loadError, setLoadError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true, attempts = 0, timer: ReturnType<typeof setTimeout>
    const read = async (): Promise<void> => {
      try {
        if (!window.launcher?.agentHostState) { if (active) setSupported(false); return }
        const state = await window.launcher.agentHostState(); if (!active) return
        if (state.supported) { setLoadError(''); setSupported(state.localControl?.protocol === 1); return }
        setLoadError(state.message || '托管模块仍在加载，尚不能判断本地协作能力')
      } catch (cause) { if (active) setLoadError(cause instanceof Error ? cause.message : '本地模块暂不可用') }
      if (active && ++attempts < 20) timer = setTimeout(() => void read(), 1000)
    }
    void read(); return () => { active = false; clearTimeout(timer) }
  }, [retry])
  if (supported === undefined) return <div className="lcr-empty"><LoaderCircle className="spin" />正在读取本地总控模块{loadError && <><p role="status">{loadError}</p><button className="small-button" onClick={() => setRetry(value => value + 1)}>重新读取模块</button></>}</div>
  if (!supported || legacy) return <div className="lcr-legacy">{supported && <button className="small-button" onClick={() => setLegacy(false)}>返回本地协作</button>}<AgentSessionGroups {...props} /></div>
  return <LocalRoomWorkspace {...props} onLegacy={() => setLegacy(true)} />
}
export function LocalRoomWorkspace({ snapshot, onLogin, onLegacy, connected = true, web = false, initialRoomId = '', detached = false }: { snapshot: LauncherSnapshot; onLogin(): void; onLegacy(): void; connected?: boolean; web?: boolean; initialRoomId?: string; detached?: boolean }): React.JSX.Element {
  const [control, setControl] = useState<LocalControlSnapshot>(), [roomId, setRoomId] = useState(initialRoomId), [detail, setDetail] = useState<LocalRoomDetail>()
  const [hideRooms, setHideRooms] = useState(detached), [hideTasks, setHideTasks] = useState(detached)
  const chatPane = useRef<HTMLElement>(null)
  const [view, setView] = useState<'messages' | 'native' | 'files'>('messages'), [mobile, setMobile] = useState('chat')
  const [taskView, setTaskView] = useState<'tasks' | 'rules'>('tasks')
  const [draft, setDraft] = useState(''), [targets, setTargets] = useState<string[]>([]), [attached, setAttached] = useState<LocalFileMetadata[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [creating, setCreating] = useState(false), [preview, setPreview] = useState<{ file: LocalFileMetadata; url: string }>()
  const [newMessages, setNewMessages] = useState(false), [projectAdapter, setProjectAdapter] = useState('codex')
  const pendingEmptyProject = useRef<{ adapter: string; id: string } | undefined>(undefined)
  const [feedback, setFeedback] = useState(''), [loadingOlder, setLoadingOlder] = useState(false)
  const operation = useRef(false), paging = useRef(false)
  const generation = useRef(0), history = useRef<LocalControlEvent[]>([]), scroll = useRef<HTMLDivElement>(null), atBottom = useRef(true), sending = useRef(false)
  const pendingSend = useRef<{ key: string; id: string } | undefined>(undefined)
  const cursor = useRef({ hasEarlier: false, hasLater: false })
  const anchor = useRef<{ seq: string; top: number } | undefined>(undefined)
  const captureAnchor = (): void => {
    const box = scroll.current; if (!box) return
    const row = [...box.querySelectorAll<HTMLElement>('[data-event-seq]')].find(item => item.getBoundingClientRect().bottom > box.getBoundingClientRect().top + 8)
    if (row) anchor.current = { seq: row.dataset.eventSeq!, top: row.getBoundingClientRect().top }
  }
  const current = useRef({ roomId, view }); current.current = { roomId, view }
  useEffect(() => { setError(''); setFeedback('') }, [connected])
  useEffect(() => () => { if (preview?.url.startsWith('blob:')) URL.revokeObjectURL(preview.url) }, [preview?.url])
  const refreshControl = async (): Promise<void> => { const value = await call<LocalControlSnapshot>('snapshot'); setControl(value); setRoomId(old => detached && initialRoomId ? initialRoomId : value.rooms.some(room => room.id === old) ? old : value.rooms[0]?.id || '') }
  useEffect(() => {
    if (!connected) return
    let active = true, pending = false
    const refresh = async (): Promise<void> => { if (!active || pending || document.hidden) return; pending = true; try { const value = await call<LocalControlSnapshot>('snapshot'); if (active) { setControl(value); setRoomId(old => detached && initialRoomId ? initialRoomId : value.rooms.some(room => room.id === old) ? old : value.rooms[0]?.id || '') } } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '本地总控读取失败') } finally { pending = false } }
    void refresh(); const timer = setInterval(() => void refresh(), 1000); return () => { active = false; clearInterval(timer) }
  }, [snapshot.account.user?.id, connected])
  useEffect(() => {
    setAttached([]); setTargets([]); setDraft(''); setPreview(undefined); pendingSend.current = undefined
  }, [roomId, snapshot.account.user?.id])
  useEffect(() => {
    const epoch = ++generation.current; history.current = []; cursor.current = { hasEarlier: false, hasLater: false }; anchor.current = undefined; setDetail(undefined); atBottom.current = true
    if (!roomId || !connected) return
    let pending = false, active = true
    const refresh = async (): Promise<void> => {
      if (!active || pending || document.hidden) return; pending = true
      try {
        const browsingOld = history.current.length > 0 && (!atBottom.current || cursor.current.hasLater)
        const after = browsingOld ? undefined : history.current.at(-1)?.seq
        const value = await call<LocalRoomDetail>('read_room', { roomId, view: view === 'native' ? 'native' : 'messages', after, limit: 100, metadataOnly: browsingOld })
        if (!active || epoch !== generation.current) return
        if (browsingOld) {
          cursor.current.hasLater = (value.history.latestSeq || 0) > (history.current.at(-1)?.seq || 0)
          const referenced = new Set(history.current.flatMap(event => event.payload.fileIds || []))
          setDetail(previous => ({ ...value, files: [...new Map([...(previous?.files || []).filter(file => referenced.has(file.id)), ...value.files].map(file => [file.id, file])).values()], history: { ...value.history, ...cursor.current, items: history.current } })); return
        }
        const first = history.current[0]?.seq
        history.current = mergeHistoryWindow(history.current, value.history.items, 'newer')
        cursor.current = { hasEarlier: cursor.current.hasEarlier || value.history.hasEarlier || (!!first && history.current[0]!.seq > first), hasLater: value.history.hasLater }
        setDetail({ ...value, history: { ...value.history, ...cursor.current, items: history.current } })
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '本地历史读取失败，已有内容已保留') } finally { pending = false }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 1000); return () => { active = false; clearInterval(timer) }
  }, [roomId, view, snapshot.account.user?.id, connected])
  useLayoutEffect(() => {
    if (!scroll.current) return
    if (anchor.current) { const row = scroll.current.querySelector<HTMLElement>(`[data-event-seq="${anchor.current.seq}"]`); if (row) scroll.current.scrollTop += row.getBoundingClientRect().top - anchor.current.top; anchor.current = undefined }
    else if (atBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight
    setNewMessages(cursor.current.hasLater)
  }, [detail?.history.items])
  async function action(command: LocalControlCommand, input: Record<string, unknown> = {}, id = requestId()): Promise<Record<string, any> | undefined> {
    if (operation.current || sending.current) return
    operation.current = true; const epoch = generation.current
    setBusy(command); setError(''); setFeedback('')
    try {
      const result = await call<Record<string, any>>(command, { roomId, ...input }, id); if (epoch !== generation.current) return
      await refreshControl()
      if (epoch !== generation.current) return
      setFeedback(result.cancelled || result.saved === false ? '已取消，原文件未改动' : command === 'save_file' ? '文件已另存' : command === 'open_file' ? '已交给本地应用打开' : command === 'decide_approval' ? '审批决定已提交' : '')
      return result
    } catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : '操作未完成') }
    finally { operation.current = false; setBusy('') }
  }
  async function older(): Promise<void> {
    if (!detail || !history.current.length || paging.current) return; const epoch = generation.current
    paging.current = true; setLoadingOlder(true)
    try {
    const value = await call<LocalRoomDetail>('read_room', { roomId, view: view === 'native' ? 'native' : 'messages', before: history.current[0]!.seq, limit: 50 })
    if (epoch !== generation.current) return
    captureAnchor(); const last = history.current.at(-1)?.seq
    history.current = mergeHistoryWindow(history.current, value.history.items, 'older')
    cursor.current = { hasEarlier: value.history.hasEarlier, hasLater: cursor.current.hasLater || (!!last && history.current.at(-1)!.seq < last) }
    setDetail({ ...value, history: { ...value.history, ...cursor.current, items: history.current } }); atBottom.current = false
    } finally { paging.current = false; setLoadingOlder(false) }
  }
  async function newer(latest = false): Promise<void> {
    if (!roomId || paging.current) return
    paging.current = true; const epoch = generation.current
    try {
      const value = await call<LocalRoomDetail>('read_room', { roomId, view: view === 'native' ? 'native' : 'messages', after: latest ? undefined : history.current.at(-1)?.seq, limit: 50 })
      if (epoch !== generation.current) return
      if (!latest) captureAnchor()
      history.current = latest ? value.history.items : mergeHistoryWindow(history.current, value.history.items, 'newer')
      cursor.current = { hasEarlier: value.history.hasEarlier, hasLater: value.history.hasLater }
      atBottom.current = latest
      setDetail({ ...value, history: { ...value.history, ...cursor.current, items: history.current } })
    } catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : '较新记录读取失败') }
    finally { paging.current = false }
  }
  async function send(event: FormEvent): Promise<void> {
    event.preventDefault(); if (!draft.trim() || !roomId || sending.current || operation.current) return
    sending.current = true; setBusy('send_room'); setError(''); setFeedback('')
    const body = draft, selected = [...targets], fileIds = attached.map(file => file.id), epoch = generation.current
    const input = { roomId, body, targetMemberIds: selected, fileIds }, key = JSON.stringify(input)
    if (pendingSend.current?.key !== key) pendingSend.current = { key, id: requestId() }
    try {
      await call('send_room', input, pendingSend.current.id)
      if (epoch !== generation.current) return
      pendingSend.current = undefined
      setDraft(value => value === body ? '' : value)
      setTargets(value => JSON.stringify(value) === JSON.stringify(selected) ? [] : value)
      setAttached(value => value.filter(file => !fileIds.includes(file.id))); atBottom.current = true
      await refreshControl()
    } catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : '发送尚未确认，请保留原稿重试') }
    finally { sending.current = false; setBusy('') }
  }
  async function changeMode(mode: LocalPermissionMode): Promise<void> {
    const confirmFull = mode === 'full' && window.confirm('完全批准会让所有成员在本房间已选项目内免逐项审核执行。不会改变系统全局权限。确认启用？')
    if (mode === 'full' && !confirmFull) return
    const epoch = generation.current
    const result = await action('set_permission', { mode, confirmFull }); if (!result || epoch !== generation.current) return
    setDetail(old => old ? { ...old, room: { ...old.room, permissionMode: mode } } : old)
  }
  async function fileAction(file: LocalFileMetadata, command: 'preview_file' | 'open_file' | 'save_file'): Promise<void> {
    const result = await action(command, { fileId: file.id, file }); if (command === 'preview_file' && result?.url) setPreview({ file, url: result.url })
  }
  const memberName = (id?: string): string => detail?.room.members.find(member => member.id === id)?.displayName || '本地总控'
  const files = detail?.files || []
  const roomRules = detail ? [
    { label: '审批级别', value: modeNames[detail.room.permissionMode], detail: detail.room.permissionMode === 'ask' ? '需要确认时回到对应原生智能体处理' : detail.room.permissionMode === 'assist' ? '主控只代审项目范围内可验证操作' : '仅限已选项目范围，仍不覆盖系统权限' },
    { label: '项目隔离', value: detail.room.workspaceMode === 'worktree' ? '独立 Git 工作树' : '共享原目录', detail: detail.room.workspaceMode === 'worktree' ? '同房间成员共享工作树，不自动合并' : '重叠目录跨房间串行排队' },
    { label: '单轮上限', value: `${detail.room.maxSteps} 次原生调用`, detail: '达到上限后停止，不自动扩容或重放' },
    { label: '消息路由', value: '结构化 @ 指定成员', detail: '未指定成员时交给房间主控继续分派' },
    { label: '记录位置', value: detail.room.cloudSync ? (syncNames[detail.room.syncState || 'pending'] || '同步状态待确认') : '仅在本机', detail: '成员各自保留独立原生会话与工作记忆' },
  ] : []
  const roomMembers = detail?.room.members.map(member => {
    const descriptor = control?.catalog.find(item => item.id === member.agentId)
    const capability = descriptor ? [descriptor.capabilities.localExecution ? '本机执行' : '不可执行', descriptor.capabilities.approvalControl ? '统一代审' : '仅请求批准', descriptor.capabilities.richEvents ? '原生事件' : '基础回执'].join(' · ') : undefined
    return { id: member.id, name: member.displayName, handle: member.mentionHandle, role: member.id === detail.room.coordinatorMemberId ? '主控' : '成员', adapter: descriptor ? `${descriptor.name} · ${descriptor.adapter}` : member.adapter || '智能体', project: member.projectPath || descriptor?.projects.find(project => project.id === member.projectId)?.name || '项目不可用', session: member.sessionLabel || (member.runtimeSessionId ? '独立会话已建立' : '首次参与时创建'), responsibility: member.responsibility || '', status: member.sessionState === 'ready' || member.runtimeSessionId ? '会话已就绪' : '等待首次参与', capability }
  }) || []
  if (!connected) return <section className="lcr-empty" role="status"><Monitor size={30} /><h2>启动器未连接</h2><p>请保持电脑开机并在启动器连接此账号。</p><span>连接恢复后从本机重新读取。服务器没有聊天或文件副本，也不会排队重发任务。</span></section>
  return <section className="local-control-workspace" aria-label="本地总控协作">
    <div className="lcr-toolbar"><span><Monitor size={16} />本地协调与完整记录</span><div><button className="small-button" onClick={() => void action(web ? 'snapshot' : 'refresh_catalog')}><RefreshCw size={14} />{web ? '刷新状态' : '刷新本机'}</button><button className="small-button" onClick={onLegacy}>旧云端房间</button></div></div>
    {error && <div className="aw-feedback error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {(busy || feedback) && <div className="lcr-operation" role="status">{busy && <LoaderCircle size={14} className="spin" />}{busy ? (operationNames[busy] || '正在处理本地操作') + '…' : feedback}{['choose_files', 'preview_file', 'save_file', 'open_file'].includes(busy) && control?.fileProgress?.total ? ` ${sizeText(control.fileProgress.bytes)} / ${sizeText(control.fileProgress.total)}` : ''}</div>}
    <nav className="lcr-mobile-tabs" aria-label="本地协作面板">{[['rooms', '房间'], ['tasks', '任务与审批'], ['chat', '对话']].map(([key, label]) => <button key={key} aria-pressed={mobile === key} onClick={() => { setMobile(key!); if (key === 'rooms') setHideRooms(false); if (key === 'tasks') setHideTasks(false) }}>{label}</button>)}</nav>
    <div className="lcr-layout" data-mobile={mobile} data-hide-first={hideRooms} data-hide-second={hideTasks}>
      <aside className="lcr-rooms"><header><h2>本地房间</h2><button className="aw-icon-button" aria-label="新建本地房间" onClick={() => setCreating(true)}><Plus size={18} /></button></header>
        <div className="lcr-room-list">{control?.rooms.map(room => <button key={room.id} aria-pressed={room.id === roomId} className={room.id === roomId ? 'selected' : ''} onClick={() => { setRoomId(room.id); setMobile('chat') }}><strong>{room.name}</strong><span>{stateNames[room.status] || room.status} · {modeNames[room.permissionMode]}</span><small>本机完整记录</small></button>)}{control && !control.rooms.length && <p className="lcr-help">创建一个本地房间。没有网站连接也可以开始工作。</p>}</div>
        {!web && <div className="lcr-add-project"><label>添加本机项目<select aria-label="本机项目智能体" value={projectAdapter} onChange={event => setProjectAdapter(event.target.value)}><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="deepseek-harness">DSH</option><option value="claude-code">Claude Code</option></select></label><button className="small-button" disabled={Boolean(busy)} onClick={() => void action('authorize_project', { adapter: projectAdapter })}><FolderPlus size={14} />选择项目目录</button>{control?.emptyProjectCreation && <><button className="small-button" disabled={Boolean(busy)} onClick={() => { if (pendingEmptyProject.current?.adapter !== projectAdapter) pendingEmptyProject.current = { adapter: projectAdapter, id: requestId() }; void action('authorize_project', { adapter: projectAdapter, createEmpty: true }, pendingEmptyProject.current.id).then(result => { if (result) { pendingEmptyProject.current = undefined; setFeedback('空白项目已创建，可在新建房间中选择。不会读取其他项目。') } }) }}><Plus size={14} />新建空白项目</button><p className="lcr-help">空白项目建在本机运行资源目录，仅用于所选智能体，不含已有资料。</p></>}</div>}
      </aside>
      <aside className="lcr-tasks"><header><h2>{taskView === 'rules' ? '设置与规则' : '任务与审批'}</h2><button className="aw-icon-button" aria-label={taskView === 'rules' ? '返回任务与审批' : '查看房间设置与规则'} disabled={!detail} onClick={() => setTaskView(value => value === 'tasks' ? 'rules' : 'tasks')}>{taskView === 'rules' ? <ShieldCheck size={17} /> : <Settings2 size={17} />}</button></header><div className="lcr-task-scroll">
        {taskView === 'rules' && detail ? <RoomSettingsOverview rules={roomRules} members={roomMembers} boundary="公共规则对所有成员统一生效；任何成员都不能访问未授权项目、凭据目录或绕过原生权限，结果不确定时不会自动重放。" /> : <>
          {detail?.approvals.map(approval => <section className="lcr-approval" key={approval.id}><strong>{memberName(approval.memberId)} 请求 {approval.proposal.kind}</strong><p>{approval.reason || '主控正在独立审核这项操作'}</p><pre>{approval.proposal.command || approval.proposal.paths?.join('\n') || approval.proposal.reason}</pre>{approval.stage === 'reviewing' ? <span><LoaderCircle className="spin" size={14} />主控审核中</span> : <div><button className="primary-button" onClick={() => void action('decide_approval', { approvalId: approval.id, approved: true, expectedHash: approval.requestHash })}>批准一次</button><button className="small-button" onClick={() => void action('decide_approval', { approvalId: approval.id, approved: false, expectedHash: approval.requestHash })}>拒绝</button></div>}</section>)}
          {detail?.runs.map(run => <article className="lcr-run" key={run.id}><strong>{run.phase === 'waiting_project' ? '等待项目写入锁' : run.validationStatus === 'accepted_by_user' ? '用户已验收' : run.status === 'completed' ? '执行结束 · 待验收' : stateNames[run.status] || run.status}</strong><p className="task-preview">{run.instruction}</p><details><summary>任务详情</summary><p>{run.instruction}</p></details>{run.summary && <small>{run.summary}</small>}{['queued', 'running', 'awaiting_approval'].includes(run.status) && <button className="small-button" onClick={() => void action('cancel_run', { runId: run.id })}><Square size={13} />取消本轮</button>}{run.status === 'unknown' && <button className="small-button" onClick={() => void action('reconcile_run', { runId: run.id })}>只读核对原生状态</button>}{(control?.collaborationSafety || 0) >= 1 && run.status === 'completed' && run.validationStatus !== 'accepted_by_user' && <button className="small-button" disabled={Boolean(busy)} onClick={() => { if (window.confirm('确认你已检查本轮产物并验收？这只记录你的验收结论，不会合并工作树或代替测试。')) void action('accept_run', { runId: run.id, confirmed: true }) }}>确认验收</button>}</article>)}
          {detail?.room.workspaceMode === 'worktree' && <div className="lcr-worktree-info"><strong>房间独立工作树</strong><p>同房间成员共享工作树；不同房间隔离文件。端口、环境变量和外部数据库仍需分别配置。</p>{detail.room.workspaces?.map(workspace => <details key={workspace.id}><summary>{workspace.branch}</summary><p>{workspace.path}</p>{workspace.preflight && <p>{workspace.preflight.message}</p>}{workspace.preflight?.conflictPaths?.map(file => <code key={file}>{file}</code>)}</details>)}<button className="small-button" disabled={Boolean(busy)} onClick={() => void action('preflight_merge')}>检查合并冲突（不合并）</button></div>}
          {!detail?.runs.length && <p className="lcr-help">发送目标后，这里记录派发、主控审核和完成状态。</p>}
        </>}
      </div></aside>
      <main className="lcr-chat" ref={chatPane}><header><div><h2>{detail?.room.name || '选择或创建本地房间'}</h2><p>执行和完整记录保留在这台电脑</p></div>{detail && <label className="lcr-permission"><ShieldCheck size={15} /><select aria-label="主控审批级别" value={detail.room.permissionMode} onChange={event => void changeMode(event.target.value as LocalPermissionMode)}>{Object.entries(modeNames).map(([mode, label]) => <option value={mode} key={mode}>{label}</option>)}</select></label>}</header>
        <ConversationControls pane={chatPane} detached={detached} target={detail ? { kind: 'local-room', roomId, title: detail.room.name } : undefined} lists={[{ name: '房间列表', collapsed: hideRooms, toggle: () => setHideRooms(value => !value) }, { name: '任务面板', collapsed: hideTasks, toggle: () => setHideTasks(value => !value) }]} />
        {detail && <div className="lcr-view-tabs"><div role="tablist" aria-label="本地房间内容">{[['messages', '对话'], ['native', '原生执行记录'], ['files', '文件']].map(([key, label]) => <button role="tab" aria-selected={view === key} key={key} onClick={() => setView(key as typeof view)}>{label}</button>)}</div><span className="lcr-help">文字按需读取 · 文件点击后传输</span></div>}
        <div className="lcr-history" ref={scroll} onScroll={() => {
          if (!scroll.current) return
          const box = scroll.current; atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 70
          if (view === 'files') return
          if (box.scrollTop < 100 && cursor.current.hasEarlier) void older().catch(cause => setError(cause.message))
          else if (atBottom.current && cursor.current.hasLater) void newer()
        }}>
          {view !== 'files' && detail?.history.hasEarlier && <button className="lcr-older" disabled={loadingOlder} onClick={() => void older().catch(cause => setError(cause.message))}>{loadingOlder ? '正在加载更早记录…' : '加载更早的本地记录'}</button>}
          {view === 'files' ? <div className="lcr-file-list">{files.map(file => <LocalFileCard key={file.id} file={file} onAction={fileAction} />)}{detail && !files.length && <p className="lcr-help">附加文件或等待智能体交付。这里只读取本地版本，不会自动上传。</p>}</div> : detail?.history.items.map(event => event.payload.deferred ? <LocalDeferredRecord key={event.id} event={event} read={offset => call('read_event', { roomId, eventId: event.id, offset })} render={loaded => <LocalNativeEvent event={loaded} name={memberName(loaded.payload.memberId)} />} /> : view === 'native' ? <LocalNativeEvent key={event.id} event={event} name={memberName(event.payload.memberId)} /> : <ChatMessage key={event.id} className="lcr-message" eventSeq={event.seq} role={event.kind === 'delegation' ? 'system' : event.payload.authorType === 'user' ? 'user' : 'assistant'} name={event.kind === 'delegation' ? `${memberName(event.payload.fromMemberId)} → ${memberName(event.payload.toMemberId)}` : event.payload.authorType === 'user' ? '你' : memberName(event.payload.memberId)} time={new Date(event.createdAt).toLocaleTimeString()} text={String(event.payload.body || event.payload.instruction || '')}>
            {(event.payload.fileIds || []).map((id: string) => { const file = files.find(item => item.id === id); return file ? <LocalFileCard key={id} file={file} onAction={fileAction} /> : null })}
          </ChatMessage>)}
          {!detail && (!control || roomId ? <div className="lcr-empty" role="status"><LoaderCircle className="spin" /><p>正在读取本地房间记录</p><span>若读取失败，上方会保留错误原因；不会重新派发任务。</span></div> : <div className="lcr-empty"><Bot size={30} /><p>由主控协调本机智能体</p><span>默认帮你审核，工作不依赖网页保持打开。</span><button className="primary-button" onClick={() => setCreating(true)}>创建本地房间</button></div>)}
        </div>
        {newMessages && <button className="lcr-new-messages" onClick={() => void newer(true)}><ArrowDown size={14} />回到最新记录</button>}
        {detail && <form className="lcr-composer" onSubmit={event => void send(event)}><div className="lcr-routing"><span>{targets.length ? '直接交给' : '交给主控规划'}</span>{detail.room.members.map(member => <button type="button" key={member.id} aria-pressed={targets.includes(member.id)} onClick={() => setTargets(old => old.includes(member.id) ? old.filter(id => id !== member.id) : [...old, member.id])}>@{member.mentionHandle}</button>)}</div>
          {attached.length > 0 && <div className="lcr-attached">{attached.map(file => <span key={file.id}>{file.name}<button type="button" aria-label={'移除草稿附件 ' + file.name} onClick={() => setAttached(old => old.filter(row => row.id !== file.id))}><X size={12} /></button></span>)}</div>}
          <textarea aria-label="本地协作任务" placeholder="描述目标；主控会在已选项目内协调成员…" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(event as unknown as FormEvent) } }} />
          <footer><button type="button" className="small-button" disabled={web} title={web ? '请在启动器添加本地附件' : undefined} onClick={() => void action('choose_files').then(result => { if (result?.files) setAttached(old => [...old, ...result.files]) })}><Paperclip size={15} />附加本地文件</button><span>{modeNames[detail.room.permissionMode]} · Enter 发送</span><button type="submit" className="primary-button" disabled={!draft.trim() || busy === 'send_room'}><Send size={15} />发送</button></footer>
        </form>}
      </main>
    </div>
    {creating && <LocalRoomEditor catalog={control?.catalog || []} supportsIsolation={(control?.collaborationSafety || 0) >= 1} onClose={() => setCreating(false)} onCreate={async (input, id) => { const result = await call<{ roomId: string }>('create_room', input, id); setCreating(false); setRoomId(result.roomId); setView('messages'); await refreshControl() }} />}
    {preview && <LocalFilePreview preview={preview} web={web} onClose={() => setPreview(undefined)} onAction={fileAction} />}
  </section>
}

function LocalFilePreview({ preview, onClose, onAction, web }: { preview: { file: LocalFileMetadata; url: string }; web?: boolean; onClose(): void; onAction(file: LocalFileMetadata, command: 'preview_file' | 'open_file' | 'save_file'): Promise<void> }): React.JSX.Element {
  const dialog = useRef<HTMLElement>(null)
  const [imageError, setImageError] = useState(false)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const scope = dialog.current?.getRootNode() as Document | ShadowRoot
    const previous = scope?.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const guard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close.current() }
      if (event.key === 'Tab' && !dialog.current?.contains(scope?.activeElement)) { event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }
    }
    document.addEventListener('keydown', guard)
    return () => { document.removeEventListener('keydown', guard); previous?.focus() }
  }, [])
  return <div className="lcr-modal-backdrop"><section ref={dialog} className="lcr-preview" role="dialog" aria-modal="true" aria-label={'预览 ' + preview.file.name} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    if (event.key !== 'Tab') return
    const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (event.shiftKey && (dialog.current?.getRootNode() as Document | ShadowRoot)?.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
    else if (!event.shiftKey && (dialog.current?.getRootNode() as Document | ShadowRoot)?.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
  }}><header><h2>{preview.file.name}</h2><button className="aw-icon-button" aria-label="关闭文件预览" onClick={onClose}><X /></button></header>
    {preview.file.previewKind === 'pdf' ? <LocalPdfPreview url={preview.url} /> : preview.file.previewKind === 'image' ? imageError ? <p role="alert" className="lcr-help">图片无法显示，请另存后检查文件，或关闭预览后重试。</p> : <img src={preview.url} alt={preview.file.name} onError={() => setImageError(true)} /> : preview.file.previewKind === 'download' ? <p className="lcr-help">此文件类型不在内嵌预览范围，请另存后使用合适的本地应用检查。</p> : <iframe title={preview.file.name} src={preview.url} sandbox="" />}
    <footer><span>{sizeText(preview.file.byteSize)} · 本地固定版本</span><button className="small-button" onClick={() => void onAction(preview.file, 'save_file')}><Download size={14} />另存为</button><button className="small-button" onClick={() => void onAction(preview.file, 'open_file')}><ExternalLink size={14} />{web ? '在浏览器打开' : '本地应用查看'}</button></footer>
  </section></div>
}

function LocalMessageText({ text }: { text: string }): React.JSX.Element {
  const [visible, setVisible] = useState(24000)
  return <div className="lcr-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span className="lcr-help">图片引用：{alt || '请在文件面板查看'}</span>, a: ({ href, children }) => /^https?:\/\//i.test(href || '') ? <button className="lcr-link" onClick={() => void window.launcher?.openExternal(href!)}>{children}</button> : <span>{children}</span> }}>{text.slice(0, visible)}</Markdown>{text.length > visible && <button className="small-button" onClick={() => setVisible(value => value + 24000)}>继续显示这条长消息（已显示 {visible.toLocaleString()} 字）</button>}</div>
}
function LocalNativeEvent({ event, name }: { event: LocalControlEvent; name: string }): React.JSX.Element {
  const [raw, setRaw] = useState(false)
  const native = event.payload.event || {}, data = native.data || {}, item = data.item || {}, content = data.content
  const type = native.type || event.kind
  const labels: Record<string, string> = { agent_message_chunk: '智能体回复', user_message_chunk: '用户输入', tool_call: '工具调用', tool_call_update: '工具结果', 'tool/call': '工具调用', 'tool/result': '工具结果', 'action.started': '开始执行', 'action.completed': '执行完成', 'action.failed': '执行未确认', 'approval.requested': '审批请求', 'approval.decided': '审批决定', 'approval.awaiting_user': '等待用户决定', progress: '执行进度' }
  const textContent = typeof content?.text === 'string' ? content.text : Array.isArray(content) ? content.filter(row => row.type === 'text' || row.type === 'diff').map(row => row.text || row.newText || row.path || '').join('\n') : ''
  const body = textContent || item.text || data.text || data.delta || data.output || event.payload.body || event.payload.summary || event.payload.reason || event.payload.error || event.payload.finalReply || ''
  const command = data.rawInput?.command || data.rawInput?.commandLine || item.command || ''
  const title = data.title || item.type || data.name || labels[type] || type
  const status = data.status || item.status || event.payload.status
  return <article className="lcr-native-event" data-event-seq={event.seq}><div className="lcr-byline"><strong>{name} · {labels[type] || type}</strong><time>{new Date(event.createdAt).toLocaleTimeString()}</time></div><p className="lcr-native-title">{title}{status ? ` · ${stateNames[status] || status}` : ''}</p>{command && <pre>{String(command)}</pre>}{typeof body === 'string' && body && <LocalMessageText text={body} />}<details onToggle={event => setRaw(event.currentTarget.open)}><summary>查看完整原生数据</summary>{raw && <pre>{JSON.stringify(native.type ? native : event.payload, null, 2)}</pre>}</details></article>
}
function LocalFileCard({ file, onAction }: { file: LocalFileMetadata; onAction(file: LocalFileMetadata, command: 'preview_file' | 'open_file' | 'save_file'): Promise<void> }): React.JSX.Element {
  return <div className="lcr-file"><FileText size={21} /><div><strong>{file.name}</strong><small>{sizeText(file.byteSize)} · 本地固定版本 · {file.sha256.slice(0, 8)}</small></div><button className="small-button" onClick={() => void onAction(file, 'preview_file')}>预览</button><button className="aw-icon-button" aria-label={'另存 ' + file.name} onClick={() => void onAction(file, 'save_file')}><Download size={16} /></button></div>
}

function LocalRoomEditor({ catalog, supportsIsolation, onClose, onCreate }: { catalog: LocalRuntimeDescriptor[]; supportsIsolation: boolean; onClose(): void; onCreate(input: Record<string, unknown>, id: string): Promise<void> }): React.JSX.Element {
  const available = catalog.filter(item => item.projects.length)
  const makeMember = (index: number): LocalRoomMember => {
    const agent = available[index % Math.max(available.length, 1)]
    return { id: requestId(), displayName: index === 0 ? '主控' : `成员${index + 1}`, mentionHandle: index === 0 ? '主控' : `成员${index + 1}`, agentId: agent?.id || '', projectId: agent?.projects.length === 1 ? agent.projects[0]!.id : '', responsibility: index === 0 ? '拆解目标、审核成员操作并核对最终结果' : '完成主控分派的项目任务并返回实际结果', sessionLabel: index === 0 ? '主控独立会话' : `成员${index + 1}独立会话` }
  }
  const [members, setMembers] = useState<LocalRoomMember[]>(() => [makeMember(0), makeMember(1)])
  const [coordinator, setCoordinator] = useState(members[0]!.id), [name, setName] = useState(''), [mode, setMode] = useState<LocalPermissionMode>('ask'), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const [workspaceMode, setWorkspaceMode] = useState<'shared' | 'worktree'>('shared')
  const createRequest = useRef<{ signature: string; id: string } | undefined>(undefined)
  const patch = (id: string, values: Partial<LocalRoomMember>): void => setMembers(old => old.map(member => member.id === id ? { ...member, ...values } : member))
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setError('')
    if (!name.trim() || members.some(member => !member.agentId || !member.projectId || !member.displayName.trim() || !member.mentionHandle.trim())) { setError('请填写房间名称，并为每位成员选择项目和名称'); return }
    if (mode !== 'ask' && members.some(member => available.find(agent => agent.id === member.agentId)?.capabilities.approvalControl === false)) { setError('房间包含没有统一代审接口的智能体，请使用“请求批准”模式'); return }
    const confirmFull = mode === 'full' && window.confirm('本房间将使用完全批准：在已选项目范围内免逐项审核。确认启用？')
    if (mode === 'full' && !confirmFull) return
    setSaving(true)
    try { const input = { name, members, coordinatorMemberId: coordinator, permissionMode: mode, confirmFull, workspaceMode }; const signature = JSON.stringify(input); if (createRequest.current?.signature !== signature) createRequest.current = { signature, id: requestId() }; await onCreate(input, createRequest.current.id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '房间未创建，草稿已保留') }
    finally { setSaving(false) }
  }
  return <div className="lcr-modal-backdrop"><form className="lcr-editor" ref={form} role="dialog" aria-modal="true" aria-label="新建本地协作房间" onSubmit={event => void submit(event)} onKeyDown={event => {
    if (event.key === 'Escape' && !saving) onClose()
    if (event.key !== 'Tab') return
    const nodes = [...form.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]
    if (event.shiftKey && (form.current?.getRootNode() as Document | ShadowRoot)?.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() } else if (!event.shiftKey && (form.current?.getRootNode() as Document | ShadowRoot)?.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
  }}><header><h2>新建本地协作房间</h2><button type="button" className="aw-icon-button" aria-label="关闭新建房间" onClick={onClose}><X /></button></header>
    <div className="lcr-editor-body"><label>房间名称<input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：产品开发协作" maxLength={100} /></label><label>主控审批级别<select value={mode} onChange={event => setMode(event.target.value as LocalPermissionMode)}>{Object.entries(modeNames).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label><p className="lcr-help">所有成员使用同一主控权限规则。每位成员在所选项目中新建独立会话，不导入已有私聊；新房间默认仅在本机保存。</p>
      {supportsIsolation && <label>项目隔离<select value={workspaceMode} onChange={event => setWorkspaceMode(event.target.value as 'shared' | 'worktree')}><option value="shared">共享原目录（跨房间写入排队）</option><option value="worktree">每个房间独立 Git 工作树</option></select><small>Git 模式需要干净的仓库根目录。同房间成员共享代码，原分支不会自动提交或合并；非 Git 项目使用共享模式。</small></label>}
      {members.map((member, index) => { const agent = available.find(row => row.id === member.agentId); return <fieldset key={member.id}><legend>成员 {index + 1}</legend><div className="lcr-member-fields"><label>成员名称<input value={member.displayName} onChange={event => patch(member.id, { displayName: event.target.value })} /></label><label>@称呼<input value={member.mentionHandle} onChange={event => patch(member.id, { mentionHandle: event.target.value })} /></label><label>本机智能体<select value={member.agentId} onChange={event => { const next = available.find(row => row.id === event.target.value); patch(member.id, { agentId: event.target.value, projectId: next?.projects.length === 1 ? next.projects[0]!.id : '' }) }}><option value="">请选择</option>{available.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label><label>授权项目<select value={member.projectId} onChange={event => patch(member.id, { projectId: event.target.value })}><option value="">请选择项目</option>{agent?.projects.map(project => <option key={project.id} value={project.id}>{project.name} — {project.path}</option>)}</select></label></div><label>职责<textarea value={member.responsibility} onChange={event => patch(member.id, { responsibility: event.target.value })} /></label><div className="lcr-member-footer"><label><input type="radio" name="local-coordinator" checked={coordinator === member.id} onChange={() => setCoordinator(member.id)} />设为主控</label><button type="button" className="small-button" disabled={members.length < 2} onClick={() => { const next = members.filter(row => row.id !== member.id); setMembers(next); if (coordinator === member.id) setCoordinator(next[0]!.id) }}>移除此成员</button></div></fieldset> })}
      <button type="button" className="small-button" disabled={members.length >= 8 || !available.length} onClick={() => setMembers(old => [...old, makeMember(old.length)])}><Plus size={14} />添加成员</button>
      {catalog.some(row => !row.capabilities.approvalControl) && <p className="lcr-help">尚未提供统一代审接口的适配器可在“请求批准”模式加入；需要确认时必须回到对应原生智能体处理，不能切换为帮我批准或完全批准。</p>}
      {!available.length && <p role="status">没有可用项目。请关闭此窗口，先添加本机项目或刷新目录。</p>}
      {error && <p className="lcr-error" role="alert">{error}</p>}
    </div><footer><button type="button" className="small-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !available.length}>{saving ? '正在创建…' : '创建本地房间'}</button></footer>
  </form></div>
}
