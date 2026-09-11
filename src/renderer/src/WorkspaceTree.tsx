import { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Folder, Link2, Monitor, Search } from 'lucide-react'
import type { AgentAdapter } from '../../shared/agent-host'

export interface TreeAgent {
  id: string; adapter: string; name: string; status: string
  projects?: Array<{ id: string; name: string; path?: string }>
  projectMessage?: string
  canAssociate?: boolean
}
export interface TreeDevice { id: string; name: string; status: string; agents: TreeAgent[] }
export function WorkspaceTree({ devices, selectedAgentId, selectedProjectId, onSelectAgent, onSelectProject, onAssociate, loading = false }: {
  devices: TreeDevice[]; selectedAgentId: string; selectedProjectId: string
  onSelectAgent(deviceId: string, agentId: string): void
  onSelectProject(deviceId: string, agentId: string, projectId: string): void
  onAssociate?(adapter: AgentAdapter): void
  loading?: boolean
}): React.JSX.Element {
  const [closedDevices, setClosedDevices] = useState<string[]>([])
  const [closedAgents, setClosedAgents] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const toggle = (values: string[], id: string): string[] => values.includes(id) ? values.filter(value => value !== id) : [...values, id]
  return <>
    <div className="aw-tree-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索设备、智能体或项目" placeholder="搜索设备、智能体或项目" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <nav className="aw-tree" aria-label="设备、智能体与项目导航">
      <ul>{devices.map(device => {
        const agents = device.agents.filter(agent => !query || `${device.name} ${agent.name} ${agent.adapter}`.toLowerCase().includes(query.toLowerCase()) || agent.projects?.some(project => `${project.name} ${project.path || ''}`.toLowerCase().includes(query.toLowerCase())))
        if (query && !agents.length) return null
        const deviceOpen = !!query || !closedDevices.includes(device.id)
        return <li key={device.id} className="aw-tree-device">
          <button className="aw-tree-device-row" aria-expanded={deviceOpen} onClick={() => setClosedDevices(values => toggle(values, device.id))}>{deviceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Monitor size={17} /><span><strong>{device.name}</strong><small>{device.status}</small></span></button>
          {deviceOpen && <ul>{agents.map(agent => {
            const selected = agent.id === selectedAgentId
            const expanded = !!query || selected && !closedAgents.includes(agent.id)
            const projects = agent.projects?.filter(project => !query || `${project.name} ${project.path || ''} ${agent.name} ${device.name}`.toLowerCase().includes(query.toLowerCase()))
            return <li key={agent.id} className="aw-tree-agent">
              <div className={`aw-tree-agent-row${selected ? ' selected' : ''}`}>
                <button className="aw-tree-disclosure" aria-label={`${expanded ? '收起' : '展开'} ${agent.name} 的项目`} aria-expanded={expanded} onClick={() => {
                  if (!selected) { setClosedAgents(values => values.filter(id => id !== agent.id)); onSelectAgent(device.id, agent.id) }
                  else setClosedAgents(values => toggle(values, agent.id))
                }}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                <button className="aw-tree-agent-select" aria-pressed={selected} onClick={() => { setClosedAgents(values => values.filter(id => id !== agent.id)); onSelectAgent(device.id, agent.id) }}><Bot size={16} aria-hidden="true" /><span><strong>{agent.name}</strong><small>{agent.status}</small></span></button>
                {agent.canAssociate && onAssociate && <button className="aw-tree-connect" aria-label={`关联 ${agent.name}`} title={`关联 ${agent.name}`} onClick={() => onAssociate(agent.adapter as AgentAdapter)}><Link2 size={15} /></button>}
              </div>
              {expanded && <ul className="aw-tree-projects">{projects?.map(project => <li key={project.id}><button className={`aw-tree-project${selectedProjectId === project.id && selected ? ' selected' : ''}`} aria-current={selectedProjectId === project.id && selected ? 'page' : undefined} title={project.path || project.name} onClick={() => onSelectProject(device.id, agent.id, project.id)}><Folder size={15} aria-hidden="true" /><span>{project.name}</span></button></li>)}{!projects?.length && <li className="aw-tree-empty">{query ? '没有匹配的项目' : agent.projectMessage || (loading ? '正在读取项目…' : '尚未发现项目')}</li>}</ul>}
            </li>
          })}{!agents.length && <li className="aw-tree-empty">此设备尚未连接智能体</li>}</ul>}
        </li>
      })}</ul>
      {!devices.length && <p className="aw-tree-empty">{loading ? '正在读取设备…' : '登录后显示账号下的设备'}</p>}
      {query && devices.length > 0 && !devices.some(device => device.agents.some(agent => `${device.name} ${agent.name} ${agent.adapter}`.toLowerCase().includes(query.toLowerCase()) || agent.projects?.some(project => `${project.name} ${project.path || ''}`.toLowerCase().includes(query.toLowerCase())))) && <p className="aw-tree-empty">没有匹配结果，请修改搜索内容。</p>}
    </nav>
  </>
}
