import type {
  ModelProviderConnection,
  MultimodalTestRequest,
  MultimodalTestResult,
  MultimodalTestUsage
} from '../shared/types'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 45_000
const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/

interface NormalizedImage {
  mimeType: MultimodalTestRequest['image']['mimeType']
  base64: string
  dataUrl: string
}

interface ApiCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function joinEndpoint(baseURL: string, suffix: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

function versionedEndpoint(baseURL: string, version: string, resource: string): string {
  const normalized = baseURL.replace(/\/+$/, '')
  return normalized.endsWith(`/${version}`)
    ? `${normalized}/${resource}`
    : `${normalized}/${version}/${resource}`
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value.flatMap((entry) => {
    const item = asRecord(entry)
    const text = item?.text
    return typeof text === 'string' ? [text.trim()] : []
  }).filter(Boolean).join('\n\n')
}

export function normalizeMultimodalImage(image: MultimodalTestRequest['image']): NormalizedImage {
  if (!image.name.trim() || image.name.trim().length > 200) throw new Error('图片名称无效')
  const match = IMAGE_DATA_URL.exec(image.dataUrl)
  if (!match || match[1] !== image.mimeType) throw new Error('仅支持 JPG、PNG、WebP 或 GIF 图片')
  const bytes = Buffer.from(match[2]!, 'base64')
  if (!bytes.length) throw new Error('图片内容为空')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 10 MB')
  const base64 = bytes.toString('base64')
  return { mimeType: image.mimeType, base64, dataUrl: `data:${image.mimeType};base64,${base64}` }
}

export function buildMultimodalApiCall(
  provider: Pick<ModelProviderConnection, 'api' | 'baseURL'> & Partial<Pick<ModelProviderConnection, 'id'>>,
  model: string,
  prompt: string,
  image: NormalizedImage,
  apiKey: string
): ApiCall {
  const commonHeaders = { 'content-type': 'application/json' }
  if (provider.api === 'openai-responses') {
    return {
      url: joinEndpoint(provider.baseURL, 'responses'),
      headers: { ...commonHeaders, authorization: `Bearer ${apiKey}` },
      body: {
        model,
        max_output_tokens: 600,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: image.dataUrl, detail: 'auto' }
          ]
        }]
      }
    }
  }
  if (provider.api === 'anthropic-messages') {
    return {
      url: versionedEndpoint(provider.baseURL, 'v1', 'messages'),
      headers: { ...commonHeaders, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model,
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      }
    }
  }
  if (provider.api === 'google-generative-ai') {
    return {
      url: versionedEndpoint(provider.baseURL, 'v1beta', `models/${encodeURIComponent(model)}:generateContent`),
      headers: { ...commonHeaders, 'x-goog-api-key': apiKey },
      body: {
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: image.mimeType, data: image.base64 } },
            { text: prompt }
          ]
        }],
        generationConfig: { maxOutputTokens: 600 }
      }
    }
  }
  return {
    url: joinEndpoint(provider.baseURL, 'chat/completions'),
    headers: { ...commonHeaders, authorization: `Bearer ${apiKey}` },
    body: {
      model,
      max_tokens: 600,
      ...(provider.api === 'deepseek' || provider.id === 'deepseek-official' ? { thinking: { type: 'disabled' } } : {}),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } }
        ]
      }]
    }
  }
}

export function parseMultimodalApiResponse(api: ModelProviderConnection['api'], payload: unknown): { text: string; usage: MultimodalTestUsage } {
  const root = asRecord(payload) || {}
  let text = ''
  let usage: MultimodalTestUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  if (api === 'openai-responses') {
    text = typeof root.output_text === 'string' ? root.output_text.trim() : ''
    if (!text && Array.isArray(root.output)) {
      text = root.output.flatMap((entry) => {
        const item = asRecord(entry)
        return item ? [textFromContent(item.content)] : []
      }).filter(Boolean).join('\n\n')
    }
    const raw = asRecord(root.usage) || {}
    const details = asRecord(raw.input_tokens_details) || {}
    usage = { inputTokens: token(raw.input_tokens), outputTokens: token(raw.output_tokens), cacheReadTokens: token(details.cached_tokens), cacheWriteTokens: 0 }
  } else if (api === 'anthropic-messages') {
    text = textFromContent(root.content)
    const raw = asRecord(root.usage) || {}
    usage = {
      inputTokens: token(raw.input_tokens), outputTokens: token(raw.output_tokens),
      cacheReadTokens: token(raw.cache_read_input_tokens), cacheWriteTokens: token(raw.cache_creation_input_tokens)
    }
  } else if (api === 'google-generative-ai') {
    const candidate = Array.isArray(root.candidates) ? asRecord(root.candidates[0]) : undefined
    text = textFromContent(asRecord(candidate?.content)?.parts)
    const raw = asRecord(root.usageMetadata) || {}
    usage = {
      inputTokens: token(raw.promptTokenCount), outputTokens: token(raw.candidatesTokenCount),
      cacheReadTokens: token(raw.cachedContentTokenCount), cacheWriteTokens: 0
    }
  } else {
    const choice = Array.isArray(root.choices) ? asRecord(root.choices[0]) : undefined
    text = textFromContent(asRecord(choice?.message)?.content)
    const raw = asRecord(root.usage) || {}
    const details = asRecord(raw.prompt_tokens_details) || {}
    usage = { inputTokens: token(raw.prompt_tokens), outputTokens: token(raw.completion_tokens), cacheReadTokens: token(details.cached_tokens), cacheWriteTokens: 0 }
  }
  return { text: text.trim(), usage }
}

function apiError(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const nested = asRecord(root?.error)
  const message = nested?.message ?? root?.message ?? root?.error
  const safe = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
  return safe || `服务商返回 HTTP ${status}`
}

function looksUnsupported(message: string): boolean {
  return /(?:image|vision|multimodal|图片|视觉).{0,40}(?:not support|unsupported|不支持|不可用)|(?:not support|unsupported|不支持).{0,40}(?:image|vision|multimodal|图片|视觉)/i.test(message)
}

export async function runMultimodalApi(
  provider: Pick<ModelProviderConnection, 'id' | 'api' | 'baseURL'>,
  request: MultimodalTestRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<MultimodalTestResult> {
  const started = Date.now()
  const image = normalizeMultimodalImage(request.image)
  const prompt = request.prompt.trim()
  if (!prompt || prompt.length > 4_000) throw new Error('问题不能为空且不能超过 4000 字符')
  const call = buildMultimodalApiCall(provider, request.model, prompt, image, apiKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(call.url, {
      method: 'POST', headers: call.headers, body: JSON.stringify(call.body), signal: controller.signal, redirect: 'error'
    })
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('服务商响应过大，已停止读取')
    const raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('服务商响应过大，已停止读取')
    let payload: unknown = {}
    try { payload = raw ? JSON.parse(raw) : {} } catch { throw new Error(`服务商返回了无法解析的响应（HTTP ${response.status}）`) }
    if (!response.ok) {
      const error = apiError(payload, response.status)
      return {
        status: looksUnsupported(error) ? 'unsupported' : 'error', provider: request.provider, model: request.model,
        error, latencyMs: Date.now() - started, completedAt: new Date().toISOString()
      }
    }
    const parsed = parseMultimodalApiResponse(provider.api, payload)
    if (!parsed.text) throw new Error('接口调用成功，但没有返回可显示的文字结果')
    return {
      status: 'success', provider: request.provider, model: request.model, text: parsed.text,
      usage: parsed.usage, latencyMs: Date.now() - started, completedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '请求超过 45 秒，已停止等待；请检查网络或改用更快的模型'
      : error instanceof Error ? error.message : '多模态测试失败'
    return {
      status: looksUnsupported(message) ? 'unsupported' : 'error', provider: request.provider, model: request.model,
      error: message.slice(0, 500), latencyMs: Date.now() - started, completedAt: new Date().toISOString()
    }
  } finally {
    clearTimeout(timer)
  }
}
