import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { defaultSession: { fetch: electron.fetch, cookies: { get: vi.fn() } } },
  shell: { openExternal: vi.fn() }
}))

import { AccountService } from './account'

function signedInService(): AccountService {
  const service = new AccountService()
  Object.assign(service, { accessToken: 'test-access-token', account: { status: 'signed_in', sessionRemembered: true, user: { id: 'user-1', name: 'Tester' } } })
  return service
}

describe('AccountService multi-agent room transport', () => {
  beforeEach(() => {
    electron.fetch.mockReset()
    electron.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
  })

  it('forwards bounded room detail cursors through authenticated GET', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: 'room-1', afterRevision: 'b'.repeat(64), afterMessageSeq: '42', beforeMessageSeq: '7' } })
    const [url, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    const query = new URL(url).searchParams
    expect(query.get('action')).toBe('room_detail')
    expect(query.get('roomId')).toBe('room-1')
    expect(query.get('afterRevision')).toBe('b'.repeat(64))
    expect(query.get('afterMessageSeq')).toBe('42')
    expect(query.get('beforeMessageSeq')).toBe('7')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-access-token')
  })

  it('keeps structured mentions as stable member IDs when sending', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'POST', action: 'room_send', body: {
      roomId: 'room-1', clientRequestId: 'request-1', expectedDefinitionRevision: 2,
      content: [{ type: 'text', text: '请 ' }, { type: 'mention', memberId: 'member-review' }, { type: 'text', text: ' 复核' }], access: 'workspace_write'
    } })
    const [, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ roomId: 'room-1', clientRequestId: 'request-1', expectedDefinitionRevision: 2, content: [{ type: 'text', text: '请 ' }, { type: 'mention', memberId: 'member-review' }, { type: 'text', text: ' 复核' }], access: 'workspace_write', action: 'room_send' })
  })

  it('approves one whole run without accepting rewritten scope', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'POST', action: 'room_approve', body: { roomId: 'room-1', runId: 'run-1', approvalId: 'approval-1' } })
    const [, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ roomId: 'room-1', runId: 'run-1', approvalId: 'approval-1', action: 'room_approve' })
  })

  it('rejects legacy group actions instead of silently falling back', async () => {
    await expect(signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'group_list' })).rejects.toThrow('只能在本机绑定流程执行')
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('rejects unknown room query keys before network access', async () => {
    await expect(signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: 'room-1', memberCount: '3' } })).rejects.toThrow('查询参数无效')
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed room revisions and message cursors before network access', async () => {
    const service = signedInService()
    await expect(service.agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: 'room-1', afterRevision: 'not-a-hash' } })).rejects.toThrow('查询参数无效')
    await expect(service.agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: 'room-1', afterMessageSeq: '-1' } })).rejects.toThrow('查询参数无效')
    expect(electron.fetch).not.toHaveBeenCalled()
  })
})
