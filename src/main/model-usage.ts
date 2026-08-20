export interface ParsedModelUsage {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function parseModelUsageLine(line: string): ParsedModelUsage | undefined {
  if (!line.includes('assistant/message') || !line.includes('usage')) return undefined
  try {
    const event = JSON.parse(line) as {
      type?: string
      data?: { usage?: Record<string, unknown>; message?: { source?: { kind?: string; provider?: string; model?: string } } }
    }
    const source = event.data?.message?.source
    const usage = event.data?.usage
    if (event.type !== 'assistant/message' || !source?.provider || !source.model || !usage) return undefined
    if (source.kind && source.kind !== 'model') return undefined
    return {
      provider: source.provider,
      model: source.model,
      inputTokens: token(usage.inputTokens),
      outputTokens: token(usage.outputTokens),
      cacheReadTokens: token(usage.cacheReadTokens),
      cacheWriteTokens: token(usage.cacheWriteTokens)
    }
  } catch {
    return undefined
  }
}
