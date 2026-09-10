// Supplemental UI edge-state fixture. Never imported by the production entry.
import { createRoot } from 'react-dom/client'
import { LocalRoomWorkspace } from './LocalRoomWorkspace'
import { mockSnapshot } from './mock'
import type { LauncherApi } from '../../shared/types'
import type { LocalControlEvent, LocalRoomDetail, LocalControlSnapshot } from '../../shared/local-control'
import './styles.css'
import './agent-workspace.css'
const roomId = 'a'.repeat(32), memberId = 'b'.repeat(32)
const events: LocalControlEvent[] = Array.from({ length: new URLSearchParams(location.search).has('performance') ? 10000 : 140 }, (_, index) => ({ id: String(index + 1).padStart(32, '0'), roomId, seq: index + 1, createdAt: '2026-09-10T05:00:00Z', kind: 'message', payload: { body: `合成历史 ${index + 1}`, authorType: 'assistant', memberId } }))
const native: LocalControlEvent[] = [{ id: 'e'.repeat(32), roomId, seq: 141, kind: 'native', createdAt: '2026-09-10T05:01:00Z', payload: { memberId, event: { source: 'cursor', type: 'tool_call', data: { title: '合成测试：运行项目校验', status: 'completed', rawInput: { command: 'npm test' }, content: [{ type: 'text', text: '合成工具结果：全部测试通过。此内容不代表真实模型执行。' }] } } } }]
const room: LocalRoomDetail['room'] = { id: roomId, name: '边界状态合成验收', coordinatorMemberId: memberId, permissionMode: 'assist', permissionRevision: 1, cloudSync: true, syncState: 'offline', syncError: '模拟网络中断，本机继续工作', maxSteps: 16, members: [{ id: memberId, displayName: '主控', mentionHandle: '主控', agentId: 'qa', projectId: 'qa' }] }
let approvals: LocalRoomDetail['approvals'] = [{ id: 'c'.repeat(32), memberId, requestHash: 'd'.repeat(64), stage: 'awaiting_user', status: 'pending', reason: '合成测试：主控请求你确认项目测试命令', proposal: { kind: 'execute', command: 'npm test' } }]
let delay = 0, failure = false
const calls: Array<Record<string, any>> = []
const control = (): LocalControlSnapshot => ({ supported: true, protocol: 1, version: 1, busy: false, catalog: [], rooms: [{ id: roomId, name: room.name, permissionMode: room.permissionMode, permissionRevision: room.permissionRevision, cloudSync: true, syncState: room.syncState, memberCount: 1, status: 'awaiting_approval', pendingApprovals: approvals.length }] })
;(window as any).localQa = { calls, delay: (value: number) => { delay = value }, fail: () => { failure = true } }
window.launcher = {
  agentHostAction: async (request: any) => {
    calls.push(structuredClone(request)); let result: unknown
    if (request.command !== 'snapshot' && delay) await new Promise(resolve => setTimeout(resolve, delay))
    if (failure && !['snapshot', 'read_room'].includes(request.command)) { failure = false; throw new Error('合成失败：操作结果尚未确认，请重试原请求') }
    if (request.command === 'snapshot') result = control()
    else if (request.command === 'read_room') {
      const all = request.input.view === 'native' ? native : events
      const before = request.input.before, after = request.input.after
      const items = after !== undefined ? all.filter(row => row.seq > after).slice(0, 100) : all.filter(row => before === undefined || row.seq < before).slice(-(request.input.limit || 50))
      result = { room: structuredClone(room), history: { items: request.input.metadataOnly ? [] : items, latestSeq: all.at(-1)?.seq || 0, total: all.length, hasEarlier: !!items.length && items[0]!.seq > all[0]!.seq, hasLater: !!items.length && items.at(-1)!.seq < all.at(-1)!.seq }, approvals: structuredClone(approvals), runs: [{ id: 'f'.repeat(32), status: 'awaiting_approval', instruction: '合成任务：验证审批状态、可读工具记录与输入保护', stepCount: 1, maxSteps: 16 }], files: [] }
    } else if (request.command === 'set_permission') { room.permissionMode = request.input.mode; room.permissionRevision++; result = { permissionMode: room.permissionMode } }
    else if (request.command === 'decide_approval') { approvals = []; result = { approved: request.input.approved } }
    else result = { accepted: true }
    return { localControl: { ...control(), lastResult: { requestId: request.requestId, result } } }
  }
} as unknown as LauncherApi
createRoot(document.getElementById('root')!).render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 14, gap: 10 }}><header>合成状态验收 · 不访问真实账号或模型</header><LocalRoomWorkspace snapshot={mockSnapshot} onLogin={() => {}} onLegacy={() => {}} /></div>)
