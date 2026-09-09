import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { defaultSession: { fetch: electron.fetch, cookies: { get: vi.fn() } } },
  shell: { openExternal: vi.fn() }
}))

import { AccountService } from './account'

const ROOM_ID = '1'.repeat(32)
const MEMBER_ID = '2'.repeat(32)
const RUN_ID = '3'.repeat(32)
const APPROVAL_ID = '4'.repeat(32)

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

  it('forwards one bounded newer-message cursor through authenticated GET', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: ROOM_ID, afterRevision: 'b'.repeat(64), afterMessageSeq: '42' } })
    const [url, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    const query = new URL(url).searchParams
    expect(query.get('action')).toBe('room_detail')
    expect(query.get('roomId')).toBe(ROOM_ID)
    expect(query.get('afterRevision')).toBe('b'.repeat(64))
    expect(query.get('afterMessageSeq')).toBe('42')
    expect(query.has('beforeMessageSeq')).toBe(false)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-access-token')
  })

  it('forwards an earlier-message cursor without a competing after cursor', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: ROOM_ID, beforeMessageSeq: '7' } })
    const [url] = electron.fetch.mock.calls[0] as [string, RequestInit]
    const query = new URL(url).searchParams
    expect(query.get('beforeMessageSeq')).toBe('7')
    expect(query.has('afterMessageSeq')).toBe(false)
  })

  it('keeps structured mentions as stable member IDs when sending', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'POST', action: 'room_send', body: {
      roomId: ROOM_ID, clientRequestId: 'request-1', expectedDefinitionRevision: 2,
      content: [{ type: 'text', text: '请 ' }, { type: 'mention', memberId: MEMBER_ID }, { type: 'text', text: ' 复核' }], access: 'workspace_write'
    } })
    const [, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ roomId: ROOM_ID, clientRequestId: 'request-1', expectedDefinitionRevision: 2, content: [{ type: 'text', text: '请 ' }, { type: 'mention', memberId: MEMBER_ID }, { type: 'text', text: ' 复核' }], access: 'workspace_write', action: 'room_send' })
  })

  it('approves one whole run without accepting rewritten scope', async () => {
    await signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'POST', action: 'room_approve', body: { roomId: ROOM_ID, runId: RUN_ID, approvalId: APPROVAL_ID } })
    const [, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ roomId: ROOM_ID, runId: RUN_ID, approvalId: APPROVAL_ID, action: 'room_approve' })
  })

  it('rejects legacy group actions instead of silently falling back', async () => {
    await expect(signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'group_list' })).rejects.toThrow('只能在本机绑定流程执行')
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('rejects unknown room query keys before network access', async () => {
    await expect(signedInService().agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: ROOM_ID, memberCount: '3' } })).rejects.toThrow('查询参数无效')
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed room revisions and message cursors before network access', async () => {
    const service = signedInService()
    await expect(service.agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: ROOM_ID, afterRevision: 'not-a-hash' } })).rejects.toThrow('查询参数无效')
    await expect(service.agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: ROOM_ID, afterMessageSeq: '-1' } })).rejects.toThrow('查询参数无效')
    await expect(service.agentWorkspaceRequest({ scope: 'hub', method: 'GET', action: 'room_detail', params: { roomId: ROOM_ID, afterMessageSeq: '4', beforeMessageSeq: '3' } })).rejects.toThrow('查询参数无效')
    expect(electron.fetch).not.toHaveBeenCalled()
  })
})
