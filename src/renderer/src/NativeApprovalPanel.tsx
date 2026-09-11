import { useEffect, useRef, useState } from 'react'
import { CircleAlert, RefreshCw, ShieldCheck } from 'lucide-react'
import type { NativeApproval, NativeApprovalSnapshot } from '../../shared/native-approvals'

const labels: Record<NativeApproval['state'], string> = { pending: '等待审批', submitted: '已提交 · 等待原生确认', confirmed: '原生结果已同步', resolved: '原生已处理 · 执行结果待确认', unconfirmed: '提交结果未确认', expired: '审批已过期' }
export function NativeApprovalPanel({ sessionId, enabled, load, decide }: {
  sessionId: string; enabled: boolean
  load(): Promise<NativeApprovalSnapshot>
  decide(approval: NativeApproval, approved: boolean): Promise<NativeApprovalSnapshot>
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<NativeApprovalSnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [retry, setRetry] = useState(0)
  const actions = useRef({ load, decide }); actions.current = { load, decide }
  const scope = useRef(sessionId); scope.current = sessionId
  const submitting = useRef(false)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    setSnapshot(undefined); setError(''); setBusy(''); submitting.current = false
    if (!enabled || !sessionId) return
    const poll = async (): Promise<void> => {
      try {
        if (!submitting.current) {
          const result = await actions.current.load()
          if (result.sessionId !== sessionId) throw new Error('返回的审批不属于当前对话')
          if (!stopped) { setSnapshot(result); setError('') }
        }
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : '审批状态未确认') }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 3000) }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [sessionId, enabled, retry])
  async function respond(approval: NativeApproval, approved: boolean): Promise<void> {
    if (submitting.current || !enabled || error || approval.expiresAt <= Date.now()) return
    submitting.current = true; setBusy(approval.id); setError('')
    const context = sessionId
    try {
      const result = await actions.current.decide(approval, approved)
      if (result.sessionId !== context) throw new Error('审批响应归属不匹配')
      if (scope.current === context) setSnapshot(result)
    } catch (cause) { if (scope.current === context) setError(cause instanceof Error ? cause.message : '审批回传结果未确认；不会自动重发') }
    finally { if (scope.current === context) { submitting.current = false; setBusy('') } }
  }
  if (!sessionId) return null
  if (!enabled) return <p className="aw-approval-hint">设备离线或尚未连接，远程审批不可操作。</p>
  return <section className="aw-approvals" aria-label="当前原会话审批">
    {(error || snapshot?.status !== 'ready') && <div className="aw-approval-hint" role="status"><CircleAlert size={15} /><span>{error || snapshot?.message || '正在检查原会话审批通道…'}</span><button className="aw-icon-button" aria-label="重新检查审批状态" disabled={Boolean(busy)} onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} /></button></div>}
    {snapshot?.status === 'ready' && !snapshot.requests.length && <p className="aw-approval-hint"><ShieldCheck size={14} />原会话审批已同步 · 当前没有待审批</p>}
    {snapshot?.requests.map(approval => <section className={`aw-approval${approval.state === 'pending' ? ' pending' : ''}`} key={approval.id} aria-label={approval.title}>
      <header><CircleAlert size={18} /><strong>{approval.title}</strong><span role="status">{busy === approval.id ? '正在提交决定…' : labels[approval.state]}</span></header>
      <p>{approval.reason}</p>
      {(approval.command || approval.cwd || approval.paths.length > 0 || approval.details) && <dl>
        {approval.command && <><dt>命令</dt><dd><pre>{approval.command}</pre></dd></>}
        {approval.cwd && <><dt>工作目录</dt><dd>{approval.cwd}</dd></>}
        {approval.paths.length > 0 && <><dt>涉及文件</dt><dd>{approval.paths.map((value, index) => <div key={index}>{value}</div>)}</dd></>}
        {approval.details && <><dt>请求范围</dt><dd><pre>{approval.details}</pre></dd></>}
      </dl>}
      {approval.state === 'pending' && <div className="aw-approval-actions"><button className="primary-button" disabled={!!busy || !!error || !approval.canApprove || approval.expiresAt <= Date.now()} onClick={() => void respond(approval, true)}>批准一次</button><button className="small-button" disabled={!!busy || !!error || !approval.canReject || approval.expiresAt <= Date.now()} onClick={() => void respond(approval, false)}>拒绝</button><small>只处理当前原会话的这次请求</small></div>}
      {approval.state === 'unconfirmed' && <p>先刷新核对原生状态，不会自动重复提交审批。</p>}
    </section>)}
  </section>
}
