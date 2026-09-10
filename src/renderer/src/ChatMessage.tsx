import { useState, type ReactNode } from 'react'
import { Bot, UserRound, ChevronDown, ChevronUp } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './conversation.css'

export function ChatMessage({ role, name, time, text, children, richBody, eventSeq, badge, className = '' }: { role: 'user' | 'assistant' | 'system'; name: string; time?: string; text: string; children?: ReactNode; richBody?: ReactNode; eventSeq?: number; badge?: string; className?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(24000)
  const long = text.length > 1200 || text.split('\n').length > 18
  return <article className={`chat-message ${role} ${className}`} data-event-seq={eventSeq} aria-label={`${name}${role === 'user' ? '提问' : '回复'}`}>
    <div className="chat-avatar" aria-hidden="true">{role === 'user' ? <UserRound size={18} /> : <Bot size={18} />}</div>
    <div className="chat-message-content"><div className="chat-message-meta"><strong>{name}</strong>{badge && <span>{badge}</span>}{time && <time>{time}</time>}</div>
      <div className={`chat-bubble ${long && !expanded ? 'is-folded' : ''}`}>{richBody || <Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span className="chat-attachment-reference">图片附件：{alt || '请点击文件卡片查看'}</span>, a: ({ href, children }) => /^https?:\/\//i.test(href || '') ? <button type="button" className="chat-text-link" onClick={() => void window.launcher?.openExternal(href!)}>{children}</button> : <span>{children}</span> }}>{text.slice(0, expanded ? visible : 6000)}</Markdown>}{children}{!richBody && expanded && text.length > visible && <button className="chat-expand" onClick={() => setVisible(value => value + 24000)}>继续显示此条消息</button>}</div>
      {long && <button type="button" className="chat-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{expanded ? '收起长消息' : '展开完整消息'}</button>}
    </div>
  </article>
}
