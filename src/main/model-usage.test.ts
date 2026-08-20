import { describe, expect, it } from 'vitest'
import { parseModelUsageLine } from './model-usage'

describe('Harness model usage parser', () => {
  it('reads real assistant/message usage even when source.kind is absent', () => {
    const line = JSON.stringify({
      type: 'assistant/message',
      data: {
        message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
        usage: { inputTokens: 120, outputTokens: 34, cacheReadTokens: 50, cacheWriteTokens: 8 }
      }
    })
    expect(parseModelUsageLine(line)).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
      inputTokens: 120, outputTokens: 34, cacheReadTokens: 50, cacheWriteTokens: 8
    })
  })

  it('ignores malformed, unrelated, and non-model events', () => {
    expect(parseModelUsageLine('{')).toBeUndefined()
    expect(parseModelUsageLine(JSON.stringify({ type: 'user/message', data: { usage: {} } }))).toBeUndefined()
    expect(parseModelUsageLine(JSON.stringify({ type: 'assistant/message', data: { message: { source: { kind: 'tool', provider: 'x', model: 'y' } }, usage: { inputTokens: 1 } } }))).toBeUndefined()
  })
})
