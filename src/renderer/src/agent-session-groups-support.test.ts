import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION, launcherSupportsAgentSessionGroups } from './agent-session-groups-support'

describe('agent session group base launcher gate', () => {
  it('accepts the minimum stable launcher and newer versions', () => {
    expect(AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION).toBe('0.10.35')
    expect(launcherSupportsAgentSessionGroups('0.10.35')).toBe(true)
    expect(launcherSupportsAgentSessionGroups('0.10.35+local')).toBe(true)
    expect(launcherSupportsAgentSessionGroups('0.11.0')).toBe(true)
    expect(launcherSupportsAgentSessionGroups('1.0.0')).toBe(true)
  })

  it('fails closed for older, prerelease, or malformed snapshots', () => {
    expect(launcherSupportsAgentSessionGroups('0.10.34')).toBe(false)
    expect(launcherSupportsAgentSessionGroups('0.10.35-rc.1')).toBe(false)
    expect(launcherSupportsAgentSessionGroups('0.9.99')).toBe(false)
    expect(launcherSupportsAgentSessionGroups('')).toBe(false)
    expect(launcherSupportsAgentSessionGroups('latest')).toBe(false)
  })
})
