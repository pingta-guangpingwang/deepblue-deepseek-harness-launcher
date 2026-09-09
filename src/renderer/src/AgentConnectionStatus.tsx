import { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type { LauncherSnapshot } from '../../shared/types'
import type { AgentHostSnapshot } from '../../shared/agent-host'
import './agent-connection-status.css'

export function agentSetupStage(signedIn: boolean, host?: AgentHostSnapshot): 'login' | 'device' | 'agents' | 'ready' {
  if (!signedIn) return 'login'
  if (!host?.deviceId || host.connection === 'revoked') return 'device'
  return host.agents.length ? 'ready' : 'agents'
}

export function AgentConnectionStatus({ snapshot, onLogin, onManage, blocked = false }: { snapshot: LauncherSnapshot; onLogin(): void; onManage(): void; blocked?: boolean }): React.JSX.Element {
  const [host, setHost] = useState<AgentHostSnapshot>()
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const checking = useRef(false)
  const account = snapshot.account.status === 'signed_in' ? snapshot.account.user?.id || '' : ''
  const accountRef = useRef(account)
  accountRef.current = account
  const stage = agentSetupStage(Boolean(account), host)
  const ready = host?.agents.filter(agent => agent.status === 'online' && ['ready', 'busy'].includes(agent.runtimeStatus)).length || 0
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    setHost(undefined); setError(''); setOpen(false)
    async function poll() {
      try { const result = await window.launcher?.agentHostState?.(); if (!stopped && result) setHost(result) }
      catch { if (!stopped) setError('无法读取托管状态，请检查更新') }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 5000) }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [account])
  useEffect(() => {
    if (!host || stage === 'ready' || snapshot.account.status === 'checking') return
    const key = `agent-setup-seen:${account || 'guest'}:${stage}`
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1') } catch { /* optional session preference */ }
    setOpen(true)
  }, [account, stage, Boolean(host), snapshot.account.status])
  useEffect(() => {
    if (open && !blocked && !dialog.current?.open) dialog.current?.showModal()
    if ((!open || blocked) && dialog.current?.open) dialog.current.close()
  }, [open, blocked])
  async function refresh() {
    if (checking.current) return
    checking.current = true; setError('')
    const requestedAccount = account
    try {
      if (!window.launcher?.agentHostAction) throw new Error('当前启动器缺少连接接口，请检查更新')
      const result = await window.launcher.agentHostAction({ action: 'check_connection' }); if (accountRef.current === requestedAccount) setHost(result)
    }
    catch (cause) { if (accountRef.current === requestedAccount) setError(cause instanceof Error ? cause.message : '检测失败，请重试') }
    finally { checking.current = false }
  }
  function next() { setOpen(false); if (stage === 'login') onLogin(); else onManage() }
  const accountLabel = !account ? '账号未登录' : host?.accountConnection?.status === 'connected' ? '账号已验证' : host?.accountConnection?.status === 'failed' ? '账号连接失败' : '账号检测中'
  const deviceLabel = host?.connection === 'revoked' ? '设备授权已失效' : !host?.deviceId ? '设备未授权' : !host.enabled ? '托管已暂停' : host.connection === 'online' ? '设备心跳在线' : '设备正在重连'
  return <>
    <div className="agent-connection-strip" aria-label="智能体连接状态">
      <Monitor size={15} aria-hidden="true" /><span>{accountLabel}</span><span>{deviceLabel}</span><span>{ready}/{host?.agents.length || 0} 个智能体已就绪</span>
      <button className="aw-text-button" onClick={() => setOpen(true)}>连接指引</button><button className="aw-icon-button" aria-label="重新检测账号连接" onClick={() => void refresh()}><RefreshCw size={14} /></button>
      {error && <span role="alert">{error}</span>}
    </div>
    <dialog className="agent-setup-dialog" ref={dialog} aria-labelledby="agent-setup-title" onCancel={() => setOpen(false)}>
      <header><ShieldCheck size={24} /><h2 id="agent-setup-title">{stage === 'login' ? '登录后，连接你的电脑' : stage === 'device' ? '授权这台电脑接收任务' : stage === 'agents' ? '把已有智能体接入启动器' : '智能体连接与授权'}</h2><button className="aw-icon-button" aria-label="关闭连接指引" onClick={() => setOpen(false)}><X size={20} /></button></header>
      <p>手机网页通过启动器连接本机智能体。只访问你主动授权的项目，不会自动开放整台电脑。</p>
      <ol><li>登录同一个 AI历史书账号，启动器自动登记这台电脑并保持登录。</li><li>在管理本机中修改设备名称，选择智能体和允许访问的项目。</li><li>主动启动对应智能体，确认“已就绪”后开始交互。</li></ol>
      {stage === 'agents' && <p>账号中有 {host?.cloudAgents?.length ?? '待检测'} 个智能体记录；服务器在线不代表已交给这台启动器托管。</p>}
      {host?.accountConnection?.message && <p role="status">{host.accountConnection.message}</p>}
      <p className="agent-setup-note">电脑需开机、联网且不休眠。关闭网页后保留低频心跳；任务执行中仍会继续回传结果。</p>
      <footer><button className="small-button" onClick={() => setOpen(false)}>暂时不用</button><button className="primary-button" onClick={next}>{stage === 'login' ? '前往登录' : '前往绑定与启动'}</button></footer>
    </dialog>
  </>
}
