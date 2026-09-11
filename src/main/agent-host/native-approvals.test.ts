import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeApprovals } from './native-approvals'
import { DesktopApprovalIpc, TRUNCATED_NATIVE_VALUE } from './desktop-approval-ipc'
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-approval-')); roots.push(root)
  const project = path.join(root, 'project'); await mkdir(project)
  const threadId = randomUUID(), turnId = randomUUID()
  const request = { id: 12, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'item', command: 'npm test', cwd: await realpath(project), reason: '执行项目测试' } }
  const item = { id: 'item', type: 'commandExecution', status: 'inProgress', changes: [{ path: 'app.ts' }] }
  const state = { id: threadId, cwd: project, requests: [request], turns: [{ turnId, status: 'inProgress', items: [item] }] }
  const ipc = { read: vi.fn(async () => ({ owner: 'desktop-owner', state, revision: 1, updatedAt: Date.now() })), decide: vi.fn(async () => {}), close() {} }
  const context = { sessionId: 'local-session', threadId, projectPath: project }
  const manager = new NativeApprovals(path.join(root, 'receipts'), ipc as unknown as DesktopApprovalIpc)
  return { root, project, request, item, state, ipc, context, manager }
}
describe('native approval decisions', () => {
  it('shows the real operation and forwards a decision to exactly the original request once', async () => {
    const f = await fixture(), snapshot = await f.manager.read(f.context), approval = snapshot.requests[0]!
    expect(snapshot.status).toBe('ready'); expect(approval.command).toBe('npm test'); expect(approval.canApprove).toBe(true)
    const input = { id: approval.id, requestHash: approval.requestHash, approved: true }
    await Promise.all([f.manager.decide(f.context, input), f.manager.decide(f.context, input)])
    expect(f.ipc.decide).toHaveBeenCalledTimes(1)
    expect(f.ipc.decide).toHaveBeenCalledWith(f.context.threadId, 'desktop-owner', f.request.method, 12, true, undefined)
    await expect(f.manager.decide(f.context, { ...input, approved: false })).rejects.toThrow('不同决定')
  })
  it('does not treat optimistic native request removal as successful execution', async () => {
    const f = await fixture(), approval = (await f.manager.read(f.context)).requests[0]!
    f.ipc.decide.mockImplementationOnce(async () => { f.state.requests = [] })
    const submitted = await f.manager.decide(f.context, { id: approval.id, requestHash: approval.requestHash, approved: true })
    expect(submitted.requests[0]?.state).toBe('resolved')
    f.item.status = 'completed'
    expect((await f.manager.read(f.context)).requests[0]?.state).toBe('confirmed')
  })
  it('confirms decline only from the original native item terminal status', async () => {
    const f = await fixture(), approval = (await f.manager.read(f.context)).requests[0]!
    f.ipc.decide.mockImplementationOnce(async () => { f.state.requests = []; f.item.status = 'declined' })
    expect((await f.manager.decide(f.context, { id: approval.id, requestHash: approval.requestHash, approved: false })).requests[0]?.state).toBe('confirmed')
  })
  it('rejects changed, expired and cross-project decisions before forwarding', async () => {
    const f = await fixture(), approval = (await f.manager.read(f.context)).requests[0]!
    f.request.params.command = 'changed command'
    await expect(f.manager.decide(f.context, { ...approval, approved: true })).rejects.toThrow('变化或过期')
    const fresh = (await f.manager.read(f.context)).requests[0]!
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 70000)
    await expect(f.manager.decide(f.context, { ...fresh, approved: true })).rejects.toThrow('变化或过期')
    const other = path.join(f.root, 'other'); await mkdir(other)
    expect((await f.manager.read({ ...f.context, projectPath: other })).status).toBe('unavailable')
    expect(f.ipc.decide).not.toHaveBeenCalled()
  })
  it('never approves incomplete previews or session-wide file grant expansion', async () => {
    const f = await fixture()
    f.request.params.command = TRUNCATED_NATIVE_VALUE
    expect((await f.manager.read(f.context)).requests[0]?.canApprove).toBe(false)
    f.request.params.command = 'npm test'; f.request.method = 'item/fileChange/requestApproval'
    Object.assign(f.request.params, { grantRoot: 'C:\\' })
    const approval = (await f.manager.read(f.context)).requests[0]!
    expect(approval.canApprove).toBe(false); expect(approval.canReject).toBe(true)
  })
  it('records uncertain delivery and does not replay it after a restart', async () => {
    const f = await fixture(), approval = (await f.manager.read(f.context)).requests[0]!
    f.ipc.decide.mockRejectedValueOnce(new Error('disconnected'))
    await expect(f.manager.decide(f.context, { ...approval, approved: true })).rejects.toThrow('disconnected')
    const restarted = new NativeApprovals(path.join(f.root, 'receipts'), f.ipc as unknown as DesktopApprovalIpc)
    await restarted.decide(f.context, { ...approval, approved: true })
    expect(f.ipc.decide).toHaveBeenCalledTimes(1)
    expect((await restarted.read(f.context)).requests[0]?.state).toBe('unconfirmed')
  })
  it('rechecks the owner after native IO and before sending a permission decision', async () => {
    const f = await fixture(), approval = (await f.manager.read(f.context)).requests[0]!
    let calls = 0
    await expect(f.manager.decide(f.context, { ...approval, approved: true }, () => { if (++calls >= 2) throw Error('owner changed') })).rejects.toThrow('owner changed')
    expect(f.ipc.decide).not.toHaveBeenCalled(); expect(f.manager.isBusy()).toBe(false)
  })
  it('handles canonical desktop turn history as well as older turn arrays', async () => {
    const f = await fixture()
    Object.assign(f.state, { turnHistory: { history: { entitiesByKey: { active: f.state.turns[0] } } } }); f.state.turns = []
    expect((await f.manager.read(f.context)).requests[0]?.canApprove).toBe(true)
  })
})
