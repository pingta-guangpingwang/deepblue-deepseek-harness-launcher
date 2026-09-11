import type { AgentHostSnapshot } from '../../shared/agent-host'
import type { WorkspaceAgent, WorkspaceData } from './AgentWorkspacePage'
import type { TreeDevice } from './WorkspaceTree'

export interface WorkspaceDevice {
  id: string; name: string; status: string
  agents: Array<{ id: string; name: string; status: string; runtimeStatus: string }>
}
export function normalizeWorkspaceDevices(value: unknown): WorkspaceDevice[] {
  if (!Array.isArray(value)) return []
  return value.filter(row => row && typeof row.id === 'string').map(row => ({
    id: row.id, name: typeof row.name === 'string' ? row.name : '未命名设备', status: typeof row.status === 'string' ? row.status : 'unknown',
    agents: (Array.isArray(row.agents) ? row.agents : []).filter((agent: Record<string, unknown>) => typeof agent.agentId === 'string').map((agent: Record<string, unknown>) => ({
      id: String(agent.agentId), name: typeof agent.name === 'string' ? agent.name : '智能体', status: typeof agent.status === 'string' ? agent.status : 'unknown', runtimeStatus: typeof agent.runtimeStatus === 'string' ? agent.runtimeStatus : 'unknown'
    }))
  }))
}
export function workspaceDevicesTree(agents: WorkspaceAgent[], devices: WorkspaceDevice[], host?: AgentHostSnapshot, data?: WorkspaceData): TreeDevice[] {
  const named = new Map(agents.map(agent => [agent.id, agent]))
  const bound = new Set<string>()
  const local = host?.agents || []
  const nodes = devices.map(device => ({
    id: device.id, name: device.name + (device.id === host?.deviceId ? '（本机）' : ''),
    status: device.status === 'online' ? '在线' : device.status === 'offline' ? '离线' : '状态未确认',
    agents: device.agents.filter(agent => { if (bound.has(agent.id)) return false; bound.add(agent.id); return true }).map(agent => {
      const info = named.get(agent.id), current = device.id === host?.deviceId ? local.find(item => item.id === agent.id) : undefined
      return { id: agent.id, adapter: info?.adapter || current?.adapter || '', name: info?.name || agent.name,
        status: device.status !== 'online' ? '设备离线' : current?.busy || agent.runtimeStatus === 'busy' ? '执行中' : (current?.runtimeStatus || agent.runtimeStatus) === 'ready' ? '执行就绪' : '未就绪',
        projects: data?.agent.id === agent.id ? data.projects : undefined,
        projectMessage: data?.agent.id === agent.id ? '尚未同步项目' : '选择智能体后读取项目'
      }
    })
  }))
  // Only locally persisted ownership may fill a not-yet-refreshed device row.
  if (host?.deviceId && !nodes.some(device => device.id === host.deviceId)) {
    nodes.unshift({ id: host.deviceId, name: host.deviceName + '（本机）', status: host.connection === 'online' ? '在线' : '状态未确认', agents: local.map(agent => {
      bound.add(agent.id)
      return { id: agent.id, adapter: agent.adapter, name: agent.name, status: agent.runtimeStatus === 'ready' ? '执行就绪' : '未就绪', projects: data?.agent.id === agent.id ? data.projects : undefined, projectMessage: '选择智能体后读取项目' }
    }) })
  }
  const unassigned = agents.filter(agent => !bound.has(agent.id)).map(agent => ({ id: agent.id, adapter: agent.adapter, name: agent.name,
    status: '独立连接器 · 设备未归属', projects: data?.agent.id === agent.id ? data.projects : undefined, projectMessage: '选择智能体后读取项目' }))
  if (unassigned.length) nodes.push({ id: 'unassigned', name: '未归属设备的旧连接', status: '不会自动归到本机', agents: unassigned })
  return nodes
}
