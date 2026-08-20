import type { EnvironmentItem } from './types'

const CORE_RUNTIME_IDS = ['node', 'harness'] as const

export function coreRuntimeReady(items: EnvironmentItem[]): boolean {
  return CORE_RUNTIME_IDS.every((id) => items.some((item) => item.id === id && item.status === 'ready'))
}

export function coreRuntimeMissing(items: EnvironmentItem[]): boolean {
  return CORE_RUNTIME_IDS.some((id) => !items.some((item) => item.id === id) || items.some((item) => item.id === id && item.status === 'missing'))
}

export function unavailableSourceCount(items: Array<{ enabled: boolean; status: string }>): number {
  const enabled = items.filter((item) => item.enabled)
  if (!enabled.length) return 0
  return enabled.some((item) => item.status === 'available' || item.status === 'slow') ? 0 : 1
}
