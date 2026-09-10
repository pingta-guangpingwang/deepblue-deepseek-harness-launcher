import { useEffect, useState, type RefObject } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ExternalLink, Maximize, Minimize } from 'lucide-react'
import type { ConversationTarget } from '../../shared/conversation'
import './conversation.css'

export function ConversationControls({ pane, target, detached = false, lists }: { pane: RefObject<HTMLElement | null>; target?: ConversationTarget; detached?: boolean; lists?: Array<{ name: string; collapsed: boolean; toggle(): void }> }): React.JSX.Element {
  const [full, setFull] = useState(false), [error, setError] = useState('')
  useEffect(() => { const listener = (): void => setFull(Boolean(pane.current?.matches(':fullscreen'))); document.addEventListener('fullscreenchange', listener); return () => document.removeEventListener('fullscreenchange', listener) }, [pane])
  async function toggleFull(): Promise<void> {
    try { setError(''); if (full) await document.exitFullscreen(); else await pane.current?.requestFullscreen() } catch { setError('无法进入全屏；独立窗口也可使用 F11') }
  }
  return <div className="conversation-controls" aria-label="对话显示方式">
    {!detached && !full && lists?.map((list, index) => { const Icon = index === 0 ? list.collapsed ? PanelLeftOpen : PanelLeftClose : list.collapsed ? PanelRightOpen : PanelRightClose; return <button type="button" className="small-button" key={list.name} aria-expanded={!list.collapsed} onClick={list.toggle}><Icon size={15} />{list.collapsed ? '展开' : '收起'}{list.name}</button> })}
    {!detached && <button type="button" className="small-button" disabled={!target || !window.launcher?.openConversation} title={!window.launcher?.openConversation ? '独立窗口需要新版启动器内核' : '打开同一会话，不会重复启动任务'} onClick={() => { if (target) void window.launcher?.openConversation?.(target).catch(cause => setError(cause.message)) }}><ExternalLink size={15} />独立窗口</button>}
    <button type="button" className="small-button" aria-pressed={full} onClick={() => void toggleFull()}>{full ? <Minimize size={15} /> : <Maximize size={15} />}{full ? '退出全屏' : '对话全屏'}</button>
    {error && <span role="alert" className="conversation-control-error">{error}</span>}
  </div>
}
