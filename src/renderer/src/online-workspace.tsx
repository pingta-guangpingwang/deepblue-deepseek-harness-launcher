import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { LocalRoomWorkspace } from './LocalRoomWorkspace'
import type { LauncherApi, LauncherSnapshot } from '../../shared/types'
import type { LocalControlSnapshot, LocalFileMetadata } from '../../shared/local-control'
import baseCss from './styles.css?inline'
import workspaceCss from './agent-workspace.css?inline'
import localCss from './local-room-workspace.css?inline'
import conversationCss from './conversation.css?inline'

type Data = Record<string, any>
const site = window as unknown as { Auth?: { user?: { id: string } }; agentWorkspaceRequest(action: string, options: Data): Promise<Data>; AgentRooms?: { setMode(mode: string): void }; showSaveFilePicker?: (input: Data) => Promise<any> }
let deviceId = '', epoch = 0, ticket: Data | undefined, connected = false
let connectionChanged = (_online: boolean): void => {}
const requests = new Set<AbortController>(), urls = new Set<string>(), files = new Map<string, LocalFileMetadata>()
let fileProgress: LocalControlSnapshot['fileProgress']
function reset(): void { epoch++; ticket = undefined; connected = false; requests.forEach(controller => controller.abort()); requests.clear(); urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); files.clear(); connectionChanged(false) }
async function access(): Promise<Data> {
  if (ticket && Date.parse(ticket.expiresAt) > Date.now() + 5000) return ticket
  const requested = epoch, selected = deviceId
  const value = await site.agentWorkspaceRequest('ticket', { localControl: true, query: { deviceId: selected } })
  const url = new URL(value.relayUrl, location.origin)
  if (epoch !== requested || deviceId !== selected) throw new Error('账号或电脑已切换')
  if (url.origin !== location.origin || !url.pathname.endsWith('/v2/local') || url.search) throw new Error('在线服务地址无效')
  ticket = value; return value
}
async function relay(path: string, init: RequestInit = {}): Promise<Response> {
  const requested = epoch, controller = new AbortController(); requests.add(controller)
  try {
    const value = await access()
    const response = await fetch(value.relayUrl + path, { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(path.startsWith('/file/') ? 600000 : 35000)]), headers: { ...init.headers, authorization: `Bearer ${value.token}` } })
    if (requested !== epoch) throw new Error('账号或电脑已切换')
    if (response.status === 401) ticket = undefined
    if (!response.ok) { const error = await response.json().catch(() => ({})); if (error.error === 'launcher_offline') { connected = false; connectionChanged(false) }; throw new Error(error.message || '在线请求未完成；不会自动重发任务') }
    if (!response.body) { requests.delete(controller); return response }
    const reader = response.body.getReader()
    return new Response(new ReadableStream({
      async pull(target) { try { const value = await reader.read(); if (value.done) { requests.delete(controller); target.close() } else target.enqueue(value.value) } catch (error) { requests.delete(controller); target.error(error) } },
      async cancel() { requests.delete(controller); controller.abort(); await reader.cancel().catch(() => {}) }
    }), { status: response.status, headers: response.headers })
  } catch (error) { requests.delete(controller); throw error }
}
async function transfer(command: string, input: Data): Promise<Data> {
  const file = (input.file?.id === input.fileId ? input.file : files.get(input.fileId)) as LocalFileMetadata | undefined; if (!file) throw new Error('请刷新文件列表后重试')
  let writer: any
  if (command === 'save_file' && site.showSaveFilePicker) {
    try { const handle = await site.showSaveFilePicker({ suggestedName: file.name }); writer = await handle.createWritable() }
    catch (error) { if ((error as Error).name === 'AbortError') return { saved: false }; throw error }
  }
  if (!writer && file.byteSize > 128 * 1024 * 1024) throw new Error('此浏览器不支持大文件流式另存，请在电脑浏览器点击“另存为”或直接到启动器查看')
  const requested = epoch; let bytes = 0
  try {
    const response = await relay(`/file/${input.roomId}/${file.id}?download=${command === 'save_file' ? 1 : 0}`)
    if (!response.body) throw new Error('文件数据流不可用')
    const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []
    try { for (;;) { const item = await reader.read(); if (requested !== epoch) throw new Error('连接已变化'); if (item.done) break; bytes += item.value.byteLength; fileProgress = { fileId: file.id, phase: 'transferring', bytes, total: file.byteSize }; if (writer) await writer.write(item.value); else chunks.push(item.value as Uint8Array<ArrayBuffer>) } }
    finally { await reader.cancel().catch(() => {}) }
    if (bytes !== file.byteSize) throw new Error('文件传输中断，未保存不完整版本')
    if (writer) { await writer.close(); return { saved: true } }
    const url = URL.createObjectURL(new Blob(chunks, { type: file.mime })); urls.add(url)
    // Only explicit preview/download creates bytes or an object URL in this browser.
    if (command === 'preview_file') return { url, file }
    if (command === 'open_file' && ['pdf','image','text'].includes(file.previewKind)) window.open(url, '_blank', 'noopener')
    else { const link = document.createElement('a'); link.href = url; link.download = file.name; link.click() }
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 60000)
    return command === 'open_file' ? { opened: true } : { saved: true }
  } catch (error) { await writer?.abort().catch(() => {}); throw error }
  finally { fileProgress = undefined }
}
window.launcher = {
  agentHostAction: async (request: Data) => {
    if (!connected) throw new Error('启动器未连接，无法读取或提交任务')
    let result: Data
    if (['preview_file','save_file','open_file'].includes(request.command)) result = await transfer(request.command, request.input)
    else {
      const response = await relay('/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: request.command, input: request.input || {}, requestId: request.requestId }) })
      const body = await response.json(); if (body.ok !== true) throw new Error(body.message || '本地请求未确认'); result = body.result
      for (const file of result.files || []) { files.set(file.id, file); if (files.size > 256) files.delete(files.keys().next().value!) }
      if (request.command === 'snapshot') { result.onlineConnected = true; result.fileProgress = fileProgress }
    }
    return { localControl: { lastResult: { requestId: request.requestId, result } } }
  },
  openExternal: async (url: string) => { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer') }
} as unknown as LauncherApi

function OnlineWorkspace(): React.JSX.Element {
  const [active, setActive] = useState(document.querySelector('#workbench')?.getAttribute('data-workspace-mode') === 'local')
  const [devices, setDevices] = useState<Data[]>([]), [selected, setSelected] = useState(''), [online, setOnline] = useState(false), [error, setError] = useState(''), [accountEpoch, setAccountEpoch] = useState(0)
  connectionChanged = setOnline
  useEffect(() => {
    const mode = (event: Event): void => { const enabled = (event as CustomEvent).detail.active === true; setActive(enabled); if (!enabled) reset() }
    const auth = (): void => { reset(); setDevices([]); setSelected(''); setAccountEpoch(value => value + 1) }
    window.addEventListener('agent-online-mode', mode); window.addEventListener('auth-change', auth)
    return () => { reset(); window.removeEventListener('agent-online-mode', mode); window.removeEventListener('auth-change', auth) }
  }, [])
  useEffect(() => {
    if (!active) return
    let alive = true
    void site.agentWorkspaceRequest('devices', { localControl: true }).then(value => { if (alive) { setDevices(value.devices || []); setSelected(previous => previous || value.devices?.[0]?.id || ''); setError('') } }).catch(error => { if (alive) setError(error.message) })
    return () => { alive = false }
  }, [active, accountEpoch])
  useEffect(() => {
    reset(); deviceId = selected
    if (!active || !selected) return
    let alive = true, pending = false
    const poll = async (): Promise<void> => {
      if (pending || document.hidden || !alive) return; pending = true
      try { const response = await relay('/presence'); const value = await response.json(); if (alive) { connected = value.online === true; setOnline(connected); setError('') } }
      catch (error) { if (alive) { connected = false; setOnline(false); setError((error as Error).message) } }
      finally { pending = false }
    }
    void poll(); const timer = setInterval(() => void poll(), 2000)
    return () => { alive = false; clearInterval(timer); reset() }
  }, [active, selected, accountEpoch])
  const snapshot = { account: { status: site.Auth?.user ? 'signed_in' : 'signed_out', user: site.Auth?.user } } as LauncherSnapshot
  return <div className="online-root"><header className="online-heading"><label>在线电脑 <select aria-label="在线电脑" value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择已绑定的电脑</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label><span role="status">{online ? '在线直读 · 服务器不保存内容' : '未连接 · 无离线副本'}</span></header>{error && <p role="alert">{error}</p>}<LocalRoomWorkspace key={accountEpoch + ':' + selected} snapshot={snapshot} connected={active && online} web onLogin={() => {}} onLegacy={() => document.querySelector<HTMLButtonElement>('#agentGroupWorkspaceTab')?.click()} /></div>
}
const target = document.getElementById('agentOnlineWorkspace')
if (target) {
  const shadow = target.attachShadow({ mode: 'open' }), style = document.createElement('style'), root = document.createElement('div')
  style.textContent = (baseCss + workspaceCss + localCss + conversationCss).replaceAll(':root', ':host') + '\n:host{font:14px "Microsoft YaHei UI",system-ui,sans-serif;color:#202124} .online-root{height:100%;display:flex;flex-direction:column;gap:10px}.online-heading{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center}.online-heading select{padding:7px;border:1px solid #e4e6ea;border-radius:7px;background:white}.online-heading span{color:#666970;font-size:12px}.local-control-workspace{flex:1;min-height:0} .online-root>div,.online-root>section{min-height:0}'; root.style.height = '100%'; shadow.append(style, root); createRoot(root).render(<OnlineWorkspace />)
}
