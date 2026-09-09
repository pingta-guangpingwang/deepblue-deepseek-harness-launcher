import { describe, expect, it } from 'vitest'
import { agentSetupStage } from './AgentConnectionStatus'
import type { AgentHostSnapshot } from '../../shared/agent-host'
const host: AgentHostSnapshot = { supported: true, enabled: true, deviceId: 'device', deviceName: 'PC', connection: 'online', agents: [], discovered: [] }
describe('connection onboarding', () => {
  it('requires login before device authorization', () => expect(agentSetupStage(false, host)).toBe('login'))
  it('requires explicit authorization for unbound or revoked devices', () => {
    expect(agentSetupStage(true)).toBe('device')
    expect(agentSetupStage(true, { ...host, connection: 'revoked' })).toBe('device')
  })
  it('does not mistake server online records for local bindings', () => {
    expect(agentSetupStage(true, { ...host, cloudAgents: [{ id: 'remote', name: 'Codex', adapter: 'codex', reportedStatus: 'online' }] })).toBe('agents')
  })
  it('completes guidance when at least one local binding exists, without claiming runtime readiness', () => {
    expect(agentSetupStage(true, { ...host, agents: [{ id: 'local', name: 'Codex', adapter: 'codex', projectRoots: [], autoStart: false, status: 'stopped', runtimeStatus: 'unknown', busy: false }] })).toBe('ready')
  })
})
