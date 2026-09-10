import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { LocalOnlineChannel } from './online-channel'
import type { LocalControlSnapshot, LocalRuntimeDescriptor } from '../../shared/local-control'

type Reply = Record<string, any>
interface Options {
  storageDir: string; moduleDir: string; nodePath: string
  ownerId: () => string | undefined
  descriptors: () => Promise<LocalRuntimeDescriptor[]>
  onChange: () => void
}
export class LocalControlBridge {
  private child?: ChildProcess
  private loading?: Promise<void>
  private online?: LocalOnlineChannel
  private onlineConnected = false
  private owner?: string
  private ownerEpoch = 0
  private pending = new Map<string, { resolve(value: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private state: LocalControlSnapshot = { supported: true, protocol: 1, version: 0, rooms: [], catalog: [], busy: false }
  constructor(private options: Options) {}
  snapshot(): LocalControlSnapshot { return this.owner === this.options.ownerId() ? { ...this.state, onlineConnected: this.onlineConnected } : { ...this.state, rooms: [], catalog: [], lastResult: undefined, onlineConnected: false } }
  isBusy(): boolean { return this.state.busy === true }
  isActive(): boolean { return this.child?.connected === true }
  async initialize(): Promise<void> {
    if (this.loading) return this.loading
    if (this.child?.connected) return
    this.loading = (async () => {
      const directory = path.join(this.options.storageDir, 'local-control')
      const descriptors = await this.options.descriptors()
      this.owner = this.options.ownerId()
      const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SHENLAN_LOCAL_CONTROL_ROOT: directory }
      delete environment.SHENLAN_AGENT_INTERACTION_KEY
      const child = fork(path.join(this.options.moduleDir, 'connector/local-control/child.mjs'), [], { execPath: this.options.nodePath, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: environment } as ForkOptions)
      this.child = child
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('本地总控启动超时，原有智能体不受影响')), 30000)
        const fail = (): void => {
          clearTimeout(timer); if (this.child === child) this.child = undefined
          this.state = { ...this.state, busy: false, error: '本地总控进程已退出；请重新打开工作台，未确认任务不会自动重发' }
          for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本地总控连接中断')) }; this.pending.clear(); this.options.onChange(); reject(new Error('本地总控启动失败'))
        }
        child.on('error', fail); child.on('exit', fail)
        child.on('message', (message: Reply) => {
          if (message?.type === 'ready') { clearTimeout(timer); this.state = message.snapshot; this.options.onChange(); resolve() }
          if (message?.type === 'fatal') { clearTimeout(timer); this.state.error = String(message.message || '本地总控不可用'); reject(new Error(this.state.error)); this.options.onChange() }
          if (message?.type === 'changed') { this.state.version = Number(message.version) || this.state.version + 1; this.state.busy = message.busy === true; this.options.onChange() }
          if (message?.type === 'result') {
            const pending = this.pending.get(message.requestId); if (!pending) return
            clearTimeout(pending.timer); this.pending.delete(message.requestId)
            if (message.error) pending.reject(new Error(String(message.error))); else pending.resolve(message.result || {})
          }
        })
        child.send({ type: 'initialize', directory, ownerId: this.options.ownerId() || null, descriptors })
      })
    })().finally(() => { this.loading = undefined })
    return this.loading
  }
  async refreshContext(): Promise<void> {
    await this.initialize(); const descriptors = await this.options.descriptors()
    const nextOwner = this.options.ownerId()
    if (this.owner !== nextOwner) {
      this.stopOnline()
      this.ownerEpoch++
      this.state = { ...this.state, rooms: [], catalog: [], lastResult: undefined, fileProgress: undefined }
    }
    this.owner = nextOwner; this.child?.send({ type: 'context', ownerId: this.owner || null, descriptors })
  }
  async request(command: string, input: Reply = {}, requestId = randomUUID().replaceAll('-', '')): Promise<Reply> {
    await this.initialize()
    if (this.owner !== this.options.ownerId()) await this.refreshContext()
    const requestOwner = this.owner, requestEpoch = this.ownerEpoch
    if (!/^[a-f0-9]{32}$/.test(requestId) || JSON.stringify(input).length > 2 * 1024 * 1024) throw new Error('本地总控请求无效或过大')
    if (this.pending.has(requestId)) throw new Error('同一请求正在处理中，请等待结果')
    const result = await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('本地操作尚未确认，请刷新状态，不要重复发送任务')) }, command === 'attach_files' ? 10 * 60 * 1000 : 30000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.child!.send({ type: 'request', command, input, requestId }, error => { if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('本地总控连接中断')) } })
    })
    if (requestOwner !== this.options.ownerId() || requestEpoch !== this.ownerEpoch) throw new Error('账号已切换，已忽略旧账号的本地响应')
    if (command === 'snapshot') this.state = result as LocalControlSnapshot
    return result
  }
  async connectOnline(ticket: (channel: string) => Promise<Reply>, current: () => boolean): Promise<void> {
    if (!current()) return
    await this.initialize()
    if (!current()) return
    this.online ||= new LocalOnlineChannel({ ticket, current, request: (command, input, id) => this.request(command, input, id), changed: connected => { this.onlineConnected = connected; this.options.onChange() } })
    this.online.start()
  }
  stopOnline(): void { this.online?.stop(); this.online = undefined; this.onlineConnected = false }
  async close(): Promise<void> {
    const child = this.child; if (!child) return
    if (this.isBusy()) throw new Error('本地协作仍在运行，请完成或取消后再更新模块')
    this.stopOnline()
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.disconnect(); resolve() }, 5000)
      child.once('exit', () => { clearTimeout(timer); resolve() }); child.send({ type: 'shutdown' })
    })
    this.child = undefined
  }
}
