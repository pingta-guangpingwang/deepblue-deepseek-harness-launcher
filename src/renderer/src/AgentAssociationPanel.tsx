import { useEffect, useRef, useState } from 'react'
import { Copy, Link2, RefreshCw, X } from 'lucide-react'
import type { AgentAdapter, AgentHostSnapshot } from '../../shared/agent-host'
import { AGENT_CATALOG } from '../../shared/agent-catalog'

const adapters = AGENT_CATALOG.map(agent => [agent.id, agent.name] as const)
export function AgentAssociationPanel({ request }: { request?: { adapter: AgentAdapter; sequence: number } }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [adapter, setAdapter] = useState<AgentAdapter>()
  const [host, setHost] = useState<AgentHostSnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!request) return
    setOpen(true); setAdapter(request.adapter)
    void window.launcher?.agentHostState?.().then(value => {
      if (value?.associations?.some(item => item.adapter === request.adapter)) setHost(value)
      else void begin(request.adapter)
    })
  }, [request])
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.current?.close() }
    }
    window.addEventListener('keydown', closeOnEscape, true)
    let disposed = false
    const refresh = async (): Promise<void> => {
      try { const value = await window.launcher?.agentHostState?.(); if (!disposed && value) setHost(value) }
      catch { if (!disposed) setError('暂时无法读取托管模块，请检查版本管理中的本机托管模块') }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('keydown', closeOnEscape, true) }
  }, [open])
  const association = host?.associations?.find(item => item.adapter === adapter)
  async function begin(next: AgentAdapter): Promise<void> {
    if (busy) return
    setAdapter(next); setCopied(false); setBusy(true); setError('')
    try {
      if (!window.launcher?.agentHostAction) throw new Error('请先更新本机托管模块')
      const result = await window.launcher.agentHostAction({ action: 'begin_association', adapter: next })
      if (!result.associations?.some(item => item.adapter === next)) throw new Error('当前托管模块不支持主动关联，请先更新本机托管模块')
      setHost(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法创建关联请求，请重试') }
    finally { setBusy(false) }
  }
  async function check(): Promise<void> {
    setBusy(true); setError('')
    try { const value = await window.launcher?.agentHostAction?.({ action: 'check_associations' }); if (value) setHost(value) }
    catch { setError('检查未完成，请稍后重试；正在运行的任务不会被中断') }
    finally { setBusy(false) }
  }
  return <>
    <button ref={trigger} className="small-button aw-association-entry" onClick={() => setOpen(true)}><Link2 size={14} />关联本机智能体</button>
    {open && <dialog ref={dialog} className="aw-association-dialog" aria-labelledby="association-heading" onClose={() => { setOpen(false); trigger.current?.focus() }}>
      <header><div><h2 id="association-heading">让智能体主动接入</h2><p>无需搜索整个硬盘。把接入说明交给这台电脑上的智能体，由它登记实际位置。</p></div><button className="aw-icon-button" aria-label="关闭关联说明" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
      <div className="aw-association-choices" aria-label="选择要关联的智能体">{adapters.map(([id, name]) => {
        const ready = host?.agents.some(item => item.adapter === id && item.status === 'online' && item.runtimeStatus === 'ready')
        return <button key={id} className={adapter === id ? 'primary-button' : 'small-button'} disabled={busy} aria-pressed={adapter === id} onClick={() => {
          const existing = host?.associations?.find(item => item.adapter === id)
          if (existing) { setAdapter(id); setCopied(false); setError('') } else void begin(id)
        }}>{name}{ready ? ' · 已就绪' : ' · 关联'}</button>
      })}</div>
      {error && <p role="alert" className="aw-feedback error">{error}</p>}
      {!adapter && <p className="aw-inline-empty">选择一个智能体，生成专用于本机的接入说明。</p>}
      {busy && !association && <p role="status">正在准备本机接入说明…</p>}
      {association && <section className="aw-association-detail">
        <p role="status" className={`aw-feedback${association.status === 'invalid' ? ' error' : ''}`}>{association.message}</p>
        <dl><dt>启动器程序</dt><dd>{association.launcherPath}</dd><dt>智能体填写的配置文件</dt><dd>{association.configPath}</dd></dl>
        <label htmlFor="association-prompt">复制以下说明，粘贴给原生智能体</label>
        <textarea id="association-prompt" readOnly value={association.prompt} spellCheck={false} />
        <div className="aw-management-actions"><button className="primary-button" disabled={busy || association.status === 'unsupported'} onClick={() => {
          void navigator.clipboard.writeText(association.prompt).then(() => setCopied(true)).catch(() => setError('复制未成功，请选中上方说明手动复制'))
        }}><Copy size={14} />{copied ? '已复制接入说明' : '复制接入说明'}</button><button className="small-button" disabled={busy} onClick={() => void check()}><RefreshCw size={14} />{busy ? '检查中…' : '立即检查配置'}</button><button className="small-button" disabled={busy} onClick={() => void begin(association.adapter)}>重新生成</button></div>
        <p className="aw-association-boundary">接口验证后，到“网站同步与托管 → 管理本机”连接智能体并启动。连接时一次授权，自动同步它的全部原生项目，新增项目也会自动加入。只有真实登录和连接检查通过后才显示“已就绪”，不会复制登录凭据。</p>
      </section>}
    </dialog>}
  </>
}
