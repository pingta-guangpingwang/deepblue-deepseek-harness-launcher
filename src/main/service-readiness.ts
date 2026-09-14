export const HARNESS_READY_STABILITY_MS = 2_500
export const HARNESS_READY_MIN_SUCCESSES = 3

export interface HarnessReadinessWindow { firstSuccessAt?: number; consecutiveSuccesses: number }

export function advanceHarnessReadiness(window: HarnessReadinessWindow, successful: boolean, now: number): HarnessReadinessWindow & { ready: boolean } {
  if (!successful) return { consecutiveSuccesses: 0, ready: false }
  const firstSuccessAt = window.firstSuccessAt ?? now
  const consecutiveSuccesses = window.consecutiveSuccesses + 1
  return {
    firstSuccessAt,
    consecutiveSuccesses,
    ready: consecutiveSuccesses >= HARNESS_READY_MIN_SUCCESSES && now - firstSuccessAt >= HARNESS_READY_STABILITY_MS
  }
}
