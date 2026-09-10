import { describe, expect, it } from 'vitest'
import { mergeHistoryWindow } from './history-window'
import type { LocalControlEvent } from '../../shared/local-control'
const rows = (from: number, count: number): LocalControlEvent[] => Array.from({ length: count }, (_, index) => ({ id: String(from + index), seq: from + index, roomId: 'room', kind: 'message', createdAt: '', payload: { body: 'text' } }))
describe('bounded local history viewport', () => {
  it('pages arbitrarily far backwards without accumulating rendered objects', () => {
    let current = rows(9901, 100)
    for (let from = 9851; from > 0; from -= 50) { current = mergeHistoryWindow(current, rows(from, 50), 'older'); expect(current.length).toBeLessThanOrEqual(120); expect(current[0]!.seq).toBe(from) }
  })
  it('supports forward reload of evicted rows and deduplicates overlap', () => {
    const current = mergeHistoryWindow(rows(1, 120), rows(100, 100), 'newer')
    expect(current).toHaveLength(120); expect(current[0]!.seq).toBe(80); expect(current.at(-1)!.seq).toBe(199)
  })
  it('bounds retained payload bytes as well as row count', () => {
    const input = rows(1, 100).map(row => ({ ...row, payload: { body: 'x'.repeat(100000) } }))
    expect(mergeHistoryWindow([], input, 'newer').length).toBeLessThan(12)
  })
})
