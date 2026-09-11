import { describe, expect, it } from 'vitest'
import { DesktopFrameReader, applyDesktopPatches, TRUNCATED_NATIVE_VALUE } from './desktop-approval-ipc'
function framed(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]) }
describe('bounded desktop approval framing', () => {
  it('reads split UTF-8 frames without retaining embedded history and preserves actual approval fields', () => {
    const output: any[] = [], reader = new DesktopFrameReader(value => output.push(value))
    const frame = framed({ method: 'snapshot', params: { text: 'large历史'.repeat(10000), requests: [{ id: 12, params: { command: 'npm test "中文"', reason: '确认运行', cwd: 'E:\\project' } }] } })
    for (let at = 0; at < frame.length; at += 31) reader.feed(frame.subarray(at, at + 31))
    expect(output).toHaveLength(1)
    expect(output[0].params.text).toBe(TRUNCATED_NATIVE_VALUE)
    expect(output[0].params.requests[0].params.command).toBe('npm test "中文"')
    expect(output[0].params.requests[0].params.reason).toBe('确认运行')
  })
  it('handles adjacent frames and marks oversized command values rather than approving truncated previews', () => {
    const output: any[] = [], reader = new DesktopFrameReader(value => output.push(value))
    reader.feed(Buffer.concat([framed({ params: { command: 'x'.repeat(20000) } }), framed({ method: 'next' })]))
    expect(output[0].params.command).toBe(TRUNCATED_NATIVE_VALUE)
    expect(output[1].method).toBe('next')
  })
  it('rejects invalid escapes even in omitted history and blocks malformed frame lengths', () => {
    const body = Buffer.from('{"text":"bad\\z"}'), header = Buffer.alloc(4); header.writeUInt32LE(body.length)
    expect(() => new DesktopFrameReader(() => {}).feed(Buffer.concat([header, body]))).toThrow('转义')
    const huge = Buffer.alloc(4); huge.writeUInt32LE(0xffffffff)
    expect(() => new DesktopFrameReader(() => {}).feed(huge)).toThrow('状态帧')
  })
  it('applies only bounded structural patches and rejects prototype or invalid-index writes', () => {
    const state = { requests: [{ id: 'old' }] }
    applyDesktopPatches(state, [{ op: 'replace', path: ['requests', 0, 'id'], value: 'new' }])
    expect(state.requests[0]?.id).toBe('new')
    expect(() => applyDesktopPatches(state, [{ op: 'add', path: ['__proto__', 'bad'], value: 1 }])).toThrow()
    expect(() => applyDesktopPatches(state, [{ op: 'replace', path: ['requests', 9], value: 1 }])).toThrow()
    expect(({} as any).bad).toBeUndefined()
  })
  it('drains frames above the view budget into a bounded attribution marker and keeps following frames readable', () => {
    const output: any[] = [], reader = new DesktopFrameReader(value => output.push(value))
    const big = framed({ method: 'snapshot', pad: 'x'.repeat(8 * 1024 * 1024 + 512) })
    reader.feed(big)
    expect(output).toHaveLength(1)
    expect(output[0].__shenlanOversizedFrame).toBe(true)
    expect(output[0].size).toBe(big.length - 4)
    expect(output[0].head).toContain('"method":"snapshot"')
    expect(output[0].head.length).toBeLessThanOrEqual(64 * 1024)
    reader.feed(framed({ method: 'next', value: 1 }))
    expect(output[1]).toEqual({ method: 'next', value: 1 })
  })
  it('parses frames exactly at the view budget boundary', () => {
    const output: any[] = [], reader = new DesktopFrameReader(value => output.push(value))
    reader.feed(framed({ method: 'snapshot', pad: 'x'.repeat(8 * 1024 * 1024 - 40) }))
    expect(output[0]?.method).toBe('snapshot')
  })
})
