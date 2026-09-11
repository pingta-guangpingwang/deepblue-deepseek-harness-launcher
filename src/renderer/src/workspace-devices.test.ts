import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG, localAgentStatus } from '../../shared/agent-catalog'
import { normalizeWorkspaceDevices, workspaceDevicesTree } from './workspace-devices'

describe('workspace hierarchy', () => {
  it('keeps all eight connection entries independent from native history reader coverage', () => {
    expect(AGENT_CATALOG).toHaveLength(8)
    expect(new Set(AGENT_CATALOG.map(agent => agent.id)).size).toBe(8)
    expect(AGENT_CATALOG.filter(agent => agent.nativeHistory)).toHaveLength(3)
    expect(localAgentStatus('cursor')).toBe('未关联')
    expect(localAgentStatus('trae')).toBe('暂不支持执行')
  })
  it('uses device binding ownership, isolates selected projects, and leaves legacy instances unassigned', () => {
    const agents = ['a', 'b', 'legacy'].map(id => ({ id, name: id, adapter: 'codex', status: 'online' }))
    const devices = normalizeWorkspaceDevices([{ id: 'device-a', name: '电脑 A', status: 'online', agents: [{ agentId: 'a', runtimeStatus: 'ready' }] }, { id: 'device-b', name: '电脑 B', status: 'offline', agents: [{ agentId: 'b', runtimeStatus: 'ready' }] }])
    const tree = workspaceDevicesTree(agents, devices, undefined, { agent: agents[1]!, projects: [{ id: 'p', name: 'B 的项目' }], sessions: [], tasks: [] })
    expect(tree.map(node => node.id)).toEqual(['device-a', 'device-b', 'unassigned'])
    expect(tree[0]!.agents[0]!.projects).toBeUndefined()
    expect(tree[1]!.agents[0]!.projects?.[0]?.name).toBe('B 的项目')
    expect(tree[1]!.agents[0]!.status).toBe('设备离线')
    expect(tree[2]!.agents[0]!.id).toBe('legacy')
  })
  it('does not manufacture a local device for an empty or unauthenticated response', () => {
    expect(normalizeWorkspaceDevices(null)).toEqual([])
    expect(workspaceDevicesTree([], [])).toEqual([])
  })
})
