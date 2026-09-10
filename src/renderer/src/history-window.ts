import type { LocalControlEvent } from '../../shared/local-control'
export const HISTORY_WINDOW_ROWS = 120
export function mergeHistoryWindow(current: LocalControlEvent[], incoming: LocalControlEvent[], direction: 'older' | 'newer'): LocalControlEvent[] {
  const rows = [...new Map([...current, ...incoming].map(row => [row.id, row])).values()].sort((a, b) => a.seq - b.seq)
  const selected = direction === 'older' ? rows.slice(0, HISTORY_WINDOW_ROWS) : rows.slice(-HISTORY_WINDOW_ROWS)
  // Bound retained payloads too, rather than retaining invisible enormous JSON.
  let bytes = 0; const result: LocalControlEvent[] = []
  for (const row of direction === 'older' ? selected : [...selected].reverse()) {
    const size = JSON.stringify(row).length * 2
    if (result.length && bytes + size > 2 * 1024 * 1024) break
    result.push(row); bytes += size
  }
  return direction === 'older' ? result : result.reverse()
}
