import { describe, expect, it, vi } from 'vitest'
import { buildMultimodalApiCall, normalizeMultimodalImage, parseMultimodalApiResponse, runMultimodalApi } from './multimodal'
import type { ModelProviderConnection, MultimodalTestRequest } from '../shared/types'

const imageRequest: MultimodalTestRequest['image'] = {
  name: 'tiny.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo='
}
const image = normalizeMultimodalImage(imageRequest)

describe('multimodal protocol adapters', () => {
  it('builds provider-specific image requests without putting keys in the body', () => {
    const responses = buildMultimodalApiCall({ api: 'openai-responses', baseURL: 'https://api.openai.com/v1' }, 'gpt-test', '读图', image, 'secret')
    expect(responses.url).toBe('https://api.openai.com/v1/responses')
    expect(responses.headers.authorization).toBe('Bearer secret')
    expect(JSON.stringify(responses.body)).not.toContain('secret')
    expect(JSON.stringify(responses.body)).toContain('input_image')

    const anthropic = buildMultimodalApiCall({ api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' }, 'claude-test', '读图', image, 'secret')
    expect(anthropic.url).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropic.headers['x-api-key']).toBe('secret')
    expect(JSON.stringify(anthropic.body)).toContain('base64')

    const gemini = buildMultimodalApiCall({ api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com' }, 'gemini-test', '读图', image, 'secret')
    expect(gemini.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent')
    expect(gemini.headers['x-goog-api-key']).toBe('secret')
    expect(JSON.stringify(gemini.body)).toContain('inline_data')

    const compatible = buildMultimodalApiCall({ api: 'openai-completions', baseURL: 'https://example.com/v1/' }, 'vision-test', '读图', image, 'secret')
    expect(compatible.url).toBe('https://example.com/v1/chat/completions')
    expect(JSON.stringify(compatible.body)).toContain('image_url')
  })

  it('parses text and real token fields from supported response shapes', () => {
    expect(parseMultimodalApiResponse('openai-responses', {
      output: [{ content: [{ type: 'output_text', text: '界面清晰' }] }],
      usage: { input_tokens: 120, output_tokens: 20, input_tokens_details: { cached_tokens: 10 } }
    })).toEqual({ text: '界面清晰', usage: { inputTokens: 120, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 } })

    expect(parseMultimodalApiResponse('anthropic-messages', {
      content: [{ type: 'text', text: '图中有一只猫' }],
      usage: { input_tokens: 80, output_tokens: 16, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }
    }).text).toBe('图中有一只猫')

    expect(parseMultimodalApiResponse('google-generative-ai', {
      candidates: [{ content: { parts: [{ text: '检测通过' }] } }],
      usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 11 }
    }).text).toBe('检测通过')
  })

  it('returns an inspectable unsupported result and never retries', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'This model does not support image input' } }), {
      status: 400, headers: { 'content-type': 'application/json' }
    }))
    const provider: Pick<ModelProviderConnection, 'id' | 'api' | 'baseURL'> = { id: 'custom', api: 'openai-completions', baseURL: 'https://example.com/v1' }
    const result = await runMultimodalApi(provider, {
      provider: 'custom', model: 'text-only', prompt: '描述图片', image: imageRequest
    }, 'secret', fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('unsupported')
    expect(result.error).toContain('does not support image')
  })

  it('rejects oversized and mismatched image payloads before network access', () => {
    expect(() => normalizeMultimodalImage({ ...imageRequest, mimeType: 'image/jpeg' })).toThrow('仅支持')
    expect(() => normalizeMultimodalImage({ ...imageRequest, dataUrl: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}` })).toThrow('10 MB')
  })
})
