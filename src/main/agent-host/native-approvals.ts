import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DesktopApprovalIpc, TRUNCATED_NATIVE_VALUE } from './desktop-approval-ipc'
import { sameLocalPath } from './local-models'
import type { NativeApproval, NativeApprovalSnapshot } from '../../shared/native-approvals'

type Json = Record<string, any>
export interface ApprovalContext { sessionId: string; threadId: string; projectPath: string }
interface Receipt { id: string; threadId: string; turnId: string; itemId: string; baseHash: string; approved: boolean; state: NativeApproval['state']; at: number }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const canonical = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const display = (value: unknown, maximum = 12000): string => String(value || '').replace(/(?:agh_live_|adh_live_|sk-)[A-Za-z0-9_-]+|Bearer\s+\S+/gi, '[凭据已隐藏]').slice(0, maximum)
const methods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])
export const nativeApprovalTurns = (state: Json): Json[] => [...(Array.isArray(state.turns) ? state.turns : []), ...Object.values(state.turnHistory?.history?.entitiesByKey || {})].filter((turn): turn is Json => !!turn && typeof turn === 'object' && Array.isArray((turn as Json).items))

export class NativeApprovals {
  private receipts = new Map<string, Receipt>()
  private challenges = new Map<string, { baseHash: string; requestHash: string; expiresAt: number }>()
  private initialized?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private activeDecisions = 0
  isBusy(): boolean { return this.activeDecisions > 0 }
  constructor(private directory: string, private ipc = new DesktopApprovalIpc()) {}
  private async initialize(): Promise<void> {
    this.initialized ||= (async () => {
      const value = await readFile(path.join(this.directory, 'decisions.json'), 'utf8').catch(() => '')
      if (!value) return
      if (value.length > 512 * 1024) throw new Error('审批回执文件异常，已停止提交')
      const rows = JSON.parse(value)
      if (!Array.isArray(rows)) throw new Error('审批回执格式异常，已停止提交')
      for (const row of rows) if (/^[a-f0-9]{64}$/.test(row.id) && Number(row.at) > Date.now() - 86400000) this.receipts.set(row.id, row)
    })()
    return this.initialized
  }
  private async persist(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, 'decisions.json')
    await writeFile(file + '.next', JSON.stringify([...this.receipts.values()].slice(-400)), { mode: 0o600 }); await rename(file + '.next', file)
  }
  private async native(context: ApprovalContext, force = false): Promise<{ state: Json; owner: string }> {
    const value = await this.ipc.read(context.threadId, force)
    const state = value.state!
    if (state.id !== context.threadId || typeof state.cwd !== 'string' || !sameLocalPath(await realpath(state.cwd), await realpath(context.projectPath))) throw new Error('原生审批不属于当前项目与会话')
    if (!Array.isArray(state.requests)) throw new Error('当前 Codex 版本未提供可核实的审批列表')
    return { state, owner: value.owner }
  }
  private proposal(context: ApprovalContext, request: Json, owner: string, state: Json): { public: NativeApproval; raw: Json; baseHash: string } | undefined {
    const params = request.params || {}, turnId = params.turnId, itemId = params.itemId
    if (!request || !['string', 'number'].includes(typeof request.id) || params.threadId !== context.threadId) return
    const validTurn = typeof turnId === 'string' && turnId.length > 0 && turnId.length < 160
    const validItem = typeof itemId === 'string' && itemId.length > 0 && itemId.length < 160
    const serialized = canonical(request)
    const complete = !serialized.includes(TRUNCATED_NATIVE_VALUE) && !serialized.includes('\\u0000shenlan-native-value-too-large') && serialized.length <= 60000
    const id = hash(canonical([owner, context.threadId, turnId, request.id]))
    const baseHash = hash(canonical([owner, context.threadId, request]))
    let challenge = this.challenges.get(id)
    if (!challenge || challenge.baseHash !== baseHash || challenge.expiresAt <= Date.now()) {
      const expiresAt = Date.now() + 60000
      challenge = { baseHash, expiresAt, requestHash: hash(baseHash + ':' + expiresAt) }; this.challenges.set(id, challenge)
    }
    const turn = nativeApprovalTurns(state).find(turn => turn.turnId === turnId || turn.id === turnId)
    const item = turn?.items?.find((item: Json) => item.id === itemId)
    const isFile = request.method === 'item/fileChange/requestApproval', isPermissions = request.method === 'item/permissions/requestApproval', network = params.networkApprovalContext
    const supported = methods.has(request.method) && validTurn && validItem && complete && !!turn && !['completed', 'interrupted', 'failed'].includes(turn.status)
    const receipt = this.receipts.get(id)
    const pending = !receipt
    const rawPaths: string[] = Array.isArray(item?.changes) ? item.changes.map((change: Json) => change.path).filter((value: unknown) => typeof value === 'string') : []
    const paths = rawPaths.slice(0, 64).map(value => display(value, 2000))
    const fullyVisible = rawPaths.length <= 64 && rawPaths.every(value => display(value, 2000) === value) && (!params.command || display(params.command) === params.command) && (!params.cwd || display(params.cwd, 2000) === params.cwd) && (!isPermissions || JSON.stringify(params.permissions || {}, null, 2).length <= 16000) && (!network || JSON.stringify(network, null, 2).length <= 4000)
    return { raw: request, baseHash, public: {
      id, requestHash: challenge.requestHash, turnId: validTurn ? turnId : '', itemId: validItem ? itemId : '',
      kind: !supported ? 'unsupported' : isFile ? 'file' : isPermissions ? 'permissions' : network ? 'network' : 'command',
      title: !supported ? '原生请求暂不支持远程处理' : isFile ? '修改文件需要审批' : isPermissions ? '本轮额外权限需要审批' : network ? '网络访问需要审批' : '执行命令需要审批',
      reason: !complete || !fullyVisible ? '原生请求信息不完整、过长或包含敏感信息，未开放批准操作' : display(params.reason || (params.grantRoot ? '此请求扩大目录授权范围，当前不支持远程批准，可拒绝。' : '请核对具体操作后决定')),
      command: typeof params.command === 'string' ? display(params.command) : undefined,
      cwd: typeof params.cwd === 'string' ? display(params.cwd, 2000) : context.projectPath,
      paths, details: isPermissions ? display(JSON.stringify(params.permissions || {}, null, 2), 16000) : network ? display(JSON.stringify(network, null, 2), 4000) : undefined,
      state: receipt?.state || 'pending', approved: receipt?.approved, expiresAt: challenge.expiresAt,
      canApprove: pending && supported && fullyVisible && (!isFile || paths.length > 0) && !params.grantRoot && (!params.availableDecisions || params.availableDecisions.includes('accept')),
      canReject: pending && supported && (!params.availableDecisions || params.availableDecisions.includes('decline'))
    } }
  }
  async read(context: ApprovalContext, force = false): Promise<NativeApprovalSnapshot> {
    try {
      await this.initialize()
      const { state, owner } = await this.native(context, force)
      const proposals = state.requests.map((request: Json) => this.proposal(context, request, owner, state)).filter(Boolean) as Array<ReturnType<NativeApprovals['proposal']> & {}>
      const requests = proposals.map(proposal => proposal.public)
      for (const receipt of this.receipts.values()) {
        if (receipt.threadId !== context.threadId || requests.some(request => request.id === receipt.id)) continue
        const turn = nativeApprovalTurns(state).find(turn => turn.turnId === receipt.turnId || turn.id === receipt.turnId)
        const item = turn?.items?.find((item: Json) => item.id === receipt.itemId)
        // A desktop acknowledgment/removal is optimistic. Only native item
        // terminal state is confirmation; never infer success from no request.
        const status = String(item?.status || '')
        const confirmed = receipt.approved ? ['completed', 'failed'].includes(status) : ['declined', 'cancelled', 'canceled'].includes(status)
        if (confirmed) receipt.state = 'confirmed'
        else if (receipt.state !== 'unconfirmed' && receipt.state !== 'confirmed') receipt.state = 'resolved'
        requests.push({ id: receipt.id, requestHash: '', turnId: receipt.turnId, itemId: receipt.itemId, kind: 'command', title: confirmed ? '原生操作结果已同步' : '审批请求已由原生界面处理', reason: confirmed ? '原生操作已经结束。' : '请求已从原生待办中移除；不能据此确认执行成功。', paths: [], state: receipt.state, approved: receipt.approved, canApprove: false, canReject: false, expiresAt: 0 })
      }
      return { sessionId: context.sessionId, status: 'ready', message: requests.some(request => request.state === 'pending') ? '等待审批，请在此决定' : '已连接原会话审批通道', readAt: new Date().toISOString(), requests: requests.slice(0, 100) }
    } catch (error) {
      return { sessionId: context.sessionId, status: 'unavailable', message: error instanceof Error ? display(error.message, 240) : '原生审批通道未就绪', readAt: new Date().toISOString(), requests: [] }
    }
  }
  async decide(context: ApprovalContext, input: { id: string; requestHash: string; approved: boolean }, authorize: () => void = () => {}): Promise<NativeApprovalSnapshot> {
    this.activeDecisions++
    const run = this.queue.catch(() => {}).then(async () => {
      await this.initialize()
      authorize()
      const { state, owner } = await this.native(context, true)
      authorize()
      const proposal = state.requests.map((request: Json) => this.proposal(context, request, owner, state)).find((proposal: ReturnType<NativeApprovals['proposal']>) => proposal?.public.id === input.id)
      const existing = this.receipts.get(input.id)
      if (existing) { if (existing.threadId !== context.threadId || existing.approved !== input.approved) throw new Error('这个审批已经提交过不同决定'); return }
      if (!proposal || proposal.public.requestHash !== input.requestHash || proposal.public.expiresAt <= Date.now()) throw new Error('审批已变化或过期，请刷新后重新核对')
      if (input.approved ? !proposal.public.canApprove : !proposal.public.canReject) throw new Error('当前原生请求不支持此审批操作')
      const receipt: Receipt = { id: input.id, threadId: context.threadId, turnId: proposal.public.turnId, itemId: proposal.public.itemId, baseHash: proposal.baseHash, approved: input.approved, state: 'submitted', at: Date.now() }
      this.receipts.set(receipt.id, receipt); await this.persist()
      try { authorize(); await this.ipc.decide(context.threadId, owner, proposal.raw.method, proposal.raw.id, input.approved, proposal.raw.params.permissions) }
      catch (error) { receipt.state = 'unconfirmed'; await this.persist(); throw error }
      await this.persist()
    })
    this.queue = run.then(() => {}, () => {})
    try { await run; return await this.read(context, true) }
    finally { this.activeDecisions-- }
  }
  close(): void { this.ipc.close(); this.challenges.clear() }
}
