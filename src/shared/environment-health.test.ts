import { describe, expect, it } from 'vitest'
import type { EnvironmentItem } from './types'
import { coreRuntimeMissing, coreRuntimeReady, unavailableSourceCount } from './environment-health'

function environment(statuses: Partial<Record<EnvironmentItem['id'], EnvironmentItem['status']>>): EnvironmentItem[] {
  return (Object.entries(statuses) as Array<[EnvironmentItem['id'], EnvironmentItem['status']]>).map(([id, status]) => ({ id, label: id, status, detail: '' }))
}

describe('launcher environment health', () => {
  it('treats an on-demand package manager as non-blocking once Node and Harness are ready', () => {
    const items = environment({ node: 'ready', harness: 'ready', pnpm: 'warning', network: 'warning' })
    expect(coreRuntimeReady(items)).toBe(true)
    expect(coreRuntimeMissing(items)).toBe(false)
  })

  it('still requires both core runtime components', () => {
    expect(coreRuntimeReady(environment({ node: 'ready', harness: 'missing', pnpm: 'ready' }))).toBe(false)
    expect(coreRuntimeMissing(environment({ node: 'ready', harness: 'missing', pnpm: 'ready' }))).toBe(true)
    expect(coreRuntimeMissing(environment({ node: 'ready', pnpm: 'ready' }))).toBe(true)
  })

  it('accepts one healthy download route instead of failing for an unavailable mirror', () => {
    expect(unavailableSourceCount([
      { enabled: true, status: 'unavailable' },
      { enabled: true, status: 'available' }
    ])).toBe(0)
    expect(unavailableSourceCount([
      { enabled: true, status: 'unavailable' },
      { enabled: true, status: 'unavailable' }
    ])).toBe(1)
  })
})
