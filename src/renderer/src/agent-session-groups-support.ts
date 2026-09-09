export const AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION = '0.10.35'

interface ParsedVersion { major: number; minor: number; patch: number; prerelease: boolean }

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return
  const values = match.slice(1, 4).map(Number)
  if (values.some(number => !Number.isSafeInteger(number) || number < 0)) return
  return { major: values[0]!, minor: values[1]!, patch: values[2]!, prerelease: Boolean(match[4]) }
}

export function launcherSupportsAgentSessionGroups(version: string, minimum = AGENT_SESSION_GROUPS_MIN_LAUNCHER_VERSION): boolean {
  const current = parseVersion(version)
  const required = parseVersion(minimum)
  if (!current || !required || required.prerelease) return false
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (current[key] > required[key]) return true
    if (current[key] < required[key]) return false
  }
  return !current.prerelease
}
