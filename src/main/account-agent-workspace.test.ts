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
  Object.assign(service, {
    accessToken: 'test-access-token',
    account: { status: 'signed_in', sessionRemembered: true, user: { id: 'user-1', name: 'Tester' } }
  })
  return service
}

describe('AccountService agent workspace group transport', () => {
  beforeEach(() => {
    electron.fetch.mockReset()
    electron.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
  })

  it('allows authenticated group detail reads and forwards groupId', async () => {
    await signedInService().agentWorkspaceRequest({
      scope: 'hub', method: 'GET', action: 'group_detail', params: { groupId: 'group-1', afterRevision: 'a'.repeat(64) }
    })

    expect(electron.fetch).toHaveBeenCalledOnce()
    const [url, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(new URL(url).searchParams.get('action')).toBe('group_detail')
    expect(new URL(url).searchParams.get('groupId')).toBe('group-1')
    expect(new URL(url).searchParams.get('afterRevision')).toBe('a'.repeat(64))
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-access-token')
  })

  it('allows group runs through the same bounded JSON transport', async () => {
    await signedInService().agentWorkspaceRequest({
      scope: 'hub', method: 'POST', action: 'group_send', body: {
        groupId: 'group-1', instruction: 'Review the implementation', targetRoleIds: ['role-1']
      }
    })

    const [, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      groupId: 'group-1', instruction: 'Review the implementation', targetRoleIds: ['role-1'], action: 'group_send'
    })
  })

  it('allows an explicit user approval for one coordinator delegate', async () => {
    await signedInService().agentWorkspaceRequest({
      scope: 'hub', method: 'POST', action: 'group_approve', body: {
        groupId: 'group-1', runId: 'run-1', actionId: 'action-1'
      }
    })

    const [, init] = electron.fetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      groupId: 'group-1', runId: 'run-1', actionId: 'action-1', action: 'group_approve'
    })
  })
})
