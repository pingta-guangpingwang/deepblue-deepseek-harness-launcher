import { describe, expect, it } from 'vitest'
import { projectsForAdapter } from './LocalAgentWorkspace'
describe('local agent switcher', () => {
  const projects = [{ adapter: 'codex', id: 'c' }, { adapter: 'claude-code', id: 'a' }]
  it('separates agents and retains the all view', () => {
    expect(projectsForAdapter(projects, 'all')).toEqual(projects)
    expect(projectsForAdapter(projects, 'codex').map(p => p.id)).toEqual(['c'])
    expect(projectsForAdapter(projects, 'claude-code').map(p => p.id)).toEqual(['a'])
  })
  it('does not fall back to Codex when another agent has no local projects', () => {
    expect(projectsForAdapter(projects, 'qclaw')).toEqual([])
  })
})
