import { describe, expect, it } from 'vitest'
import { advanceHarnessReadiness, HARNESS_READY_STABILITY_MS } from './service-readiness'

describe('Harness readiness stability window', () => {
  it('does not report ready for a port that appears briefly before process failure', () => {
    let state = advanceHarnessReadiness({ consecutiveSuccesses: 0 }, true, 1_000)
    state = advanceHarnessReadiness(state, true, 1_500)
    state = advanceHarnessReadiness(state, false, 1_900)
    expect(state.ready).toBe(false)
    expect(state.consecutiveSuccesses).toBe(0)
  })

  it('requires consecutive success across the full stability window', () => {
    let state = advanceHarnessReadiness({ consecutiveSuccesses: 0 }, true, 1_000)
    for (const now of [1_500, 2_000, 2_500, 3_000]) state = advanceHarnessReadiness(state, true, now)
    expect(state.ready).toBe(false)
    state = advanceHarnessReadiness(state, true, 1_000 + HARNESS_READY_STABILITY_MS)
    expect(state.ready).toBe(true)
  })
})
