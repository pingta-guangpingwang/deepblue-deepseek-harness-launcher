import { useEffect, useState } from 'react'
import { ArrowLeft, Maximize2, Minus, X } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type { ConversationTarget } from '../../shared/conversation'
import { LocalRoomWorkspace } from './LocalRoomWorkspace'
import { LocalAgentWorkspace } from './LocalAgentWorkspace'
import { CloudAgentWorkspace } from './AgentWorkspacePage'
import { AgentSessionGroups } from './AgentSessionGroups'
import { useLauncherAppearance } from './launcher-appearance'

function ConversationContent({ snapshot, target }: { snapshot: LauncherSnapshot; target: ConversationTarget }): React.JSX.Element {
  useLauncherAppearance(snapshot.settings)
  const main = (): void => { void window.launcher?.focusMainWindow?.() }
  const shared = { snapshot, onLogin: main, detached: true }
  return <>
    <header className="conversation-window-title"><button className="small-button" onClick={main}><ArrowLeft size={15} />主窗口</button><strong>{target.title}</strong><button className="aw-icon-button" aria-label="最小化" onClick={() => window.launcher?.windowAction('minimize')}><Minus size={17} /></button><button className="aw-icon-button" aria-label="最大化或还原" onClick={() => window.launcher?.windowAction('maximize')}><Maximize2 size={16} /></button><button className="aw-icon-button" aria-label="关闭聊天窗口" onClick={() => window.launcher?.windowAction('close')}><X size={18} /></button></header>
    <div className="conversation-window-body">
      {target.kind === 'local-room' && <LocalRoomWorkspace {...shared} initialRoomId={target.roomId} onLegacy={main} />}
      {target.kind === 'local-session' && <LocalAgentWorkspace {...shared} initialProjectId={target.projectId} initialSessionId={target.sessionId} initialConversationId={target.conversationId} />}
      {target.kind === 'cloud-session' && <CloudAgentWorkspace {...shared} initialAgentId={target.agentId} initialProjectId={target.projectId} initialSessionId={target.sessionId} />}
      {target.kind === 'legacy-room' && <AgentSessionGroups {...shared} initialRoomId={target.roomId} />}
    </div>
  </>
}

export default function ConversationWindowPage(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot>()
  const [target, setTarget] = useState<ConversationTarget>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const api = window.launcher
    if (!api?.getConversationContext) { setError('当前内核不支持独立聊天窗口，请升级启动器。'); return }
    const unsubscribe = api.onSnapshot(value => { if (!disposed) setSnapshot(value) })
    void Promise.all([api.getSnapshot(), api.getConversationContext()]).then(([state, context]) => {
      if (disposed) return
      if (!state || !context) throw new Error('会话窗口已失效，请从主窗口重新打开。')
      setSnapshot(state); setTarget(context)
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : '无法读取会话') })
    return () => { disposed = true; unsubscribe() }
  }, [])
  return <div className="conversation-window">{error ? <div role="alert"><p>{error}</p><button className="small-button" onClick={() => window.launcher?.windowAction('close')}>关闭窗口</button></div> : snapshot && target ? <ConversationContent snapshot={snapshot} target={target} /> : <p role="status">正在打开原会话…</p>}</div>
}
