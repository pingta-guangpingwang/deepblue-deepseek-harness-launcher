import { parse, parseDocument } from 'yaml'
import type { ModelProviderDraft } from '../shared/types'

const CATALOG_PROVIDERS = new Set(['openai', 'anthropic', 'google'])
const MODEL_APIS = new Set<ModelProviderDraft['api']>([
  'deepseek', 'openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'
])

export interface HarnessProviderProfile extends Omit<ModelProviderDraft, 'apiKey'> {
  apiKeyEnv: string
}

export interface HarnessModelSettingsSnapshot {
  active: { provider: string; model: string }
  providers: HarnessProviderProfile[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validProviderId(value: string): boolean {
  return /^[a-z][a-z0-9-]{1,39}$/.test(value)
}

function validModelId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)
}

function validCredentialRef(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function validBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function modelList(value: unknown, fallback: HarnessProviderProfile | undefined): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return fallback?.models.map((item) => ({ ...item })) || []
  const seen = new Set<string>()
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return []
    const id = entry.id.trim()
    if (!validModelId(id) || seen.has(id)) return []
    seen.add(id)
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 100) : id
    return [{ id, name }]
  }).slice(0, 50)
}

function profileFromSection(
  id: string,
  section: Record<string, unknown>,
  fallback: HarnessProviderProfile | undefined
): HarnessProviderProfile | undefined {
  const baseURL = typeof section.baseURL === 'string' && validBaseURL(section.baseURL.trim())
    ? section.baseURL.trim().replace(/\/$/, '')
    : fallback?.baseURL
  if (!baseURL || !validBaseURL(baseURL)) return undefined
  const api = typeof section.api === 'string' && MODEL_APIS.has(section.api as ModelProviderDraft['api'])
    ? section.api as ModelProviderDraft['api']
    : fallback?.api || 'openai-completions'
  const displayName = typeof section.displayName === 'string' && section.displayName.trim()
    ? section.displayName.trim().slice(0, 80)
    : fallback?.name || id
  const rawRef = typeof section.apiKeyEnv === 'string' ? section.apiKeyEnv.trim() : ''
  const apiKeyEnv = validCredentialRef(rawRef)
    ? rawRef
    : fallback?.apiKeyEnv || `${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`
  return {
    id,
    name: displayName,
    api,
    baseURL,
    apiKeyEnv,
    models: modelList(section.models, fallback),
    docsUrl: fallback?.docsUrl,
    billingUrl: fallback?.billingUrl,
    custom: fallback?.custom ?? true
  }
}

/** Read the model state Harness exposes through its shared settings document. */
export function parseHarnessModelSettings(
  source: string,
  fallbackProviders: HarnessProviderProfile[],
  fallbackActive: { provider: string; model: string }
): HarnessModelSettingsSnapshot {
  const root = parse(source || '{}\n') as unknown
  if (!isRecord(root)) throw new Error('Harness 模型设置必须是对象')
  const byId = new Map(fallbackProviders.map((provider) => [provider.id, provider]))
  const providers: HarnessProviderProfile[] = []
  const deepseekFallback = byId.get('deepseek-official')
  if (deepseekFallback) {
    const section = isRecord(root['llm-deepseek']) ? root['llm-deepseek'] : {}
    const deepseek = profileFromSection('deepseek-official', section, deepseekFallback)
    if (deepseek) providers.push({ ...deepseek, api: 'deepseek', custom: false })
  }
  const pi = isRecord(root['llm-pi-ai']) ? root['llm-pi-ai'] : undefined
  const rawProviders = isRecord(pi?.providers) ? pi.providers : {}
  for (const [rawId, rawProfile] of Object.entries(rawProviders)) {
    const id = rawId.trim().toLowerCase()
    if (!validProviderId(id) || id === 'deepseek-official' || !isRecord(rawProfile)) continue
    const profile = profileFromSection(id, rawProfile, byId.get(id))
    if (profile) providers.push(profile)
  }
  const rawActive = isRecord(root['agent-default-model']) ? root['agent-default-model'] : undefined
  let active = typeof rawActive?.provider === 'string' && typeof rawActive.model === 'string'
    ? { provider: rawActive.provider.trim(), model: rawActive.model.trim() }
    : { ...fallbackActive }
  if (!validProviderId(active.provider) || !validModelId(active.model)) active = { ...fallbackActive }
  let activeProvider = providers.find((provider) => provider.id === active.provider)
  if (!activeProvider) {
    active = providers[0]
      ? { provider: providers[0].id, model: providers[0].models[0]?.id || fallbackActive.model }
      : { ...fallbackActive }
    activeProvider = providers.find((provider) => provider.id === active.provider)
  }
  if (activeProvider && !activeProvider.models.some((model) => model.id === active.model)) {
    activeProvider.models.unshift({ id: active.model, name: active.model })
  }
  return { active, providers }
}

export function mergeHarnessModelSettings(
  source: string,
  active: { provider: string; model: string },
  providers: HarnessProviderProfile[],
  removedProviderId?: string
): string {
  const document = parseDocument(source || '{}\n')
  const parsed = parse(source || '{}\n') as { 'llm-pi-ai'?: { providers?: Record<string, unknown>; [key: string]: unknown } } | null
  document.setIn(['agent-default-model'], active)
  const existingPi = parsed?.['llm-pi-ai'] && typeof parsed['llm-pi-ai'] === 'object' ? parsed['llm-pi-ai'] : {}
  const piProviders: Record<string, unknown> = existingPi.providers && typeof existingPi.providers === 'object'
    ? { ...existingPi.providers }
    : {}
  if (removedProviderId) delete piProviders[removedProviderId]
  for (const provider of providers) {
    if (provider.id === 'deepseek-official') {
      // DeepSeek owns a first-class Harness adapter instead of a llm-pi-ai
      // profile.  Older launcher builds could leave the API key in this
      // endpoint field, so every model-settings write also acts as a safe,
      // idempotent migration back to the official endpoint.  Credentials
      // remain exclusively in the encrypted launcher store/environment.
      document.setIn(['llm-deepseek', 'baseURL'], provider.baseURL)
      document.setIn(['llm-deepseek', 'apiKeyEnv'], provider.apiKeyEnv)
      continue
    }
    const profile: Record<string, unknown> = {
      displayName: provider.name,
      apiKeyEnv: provider.apiKeyEnv,
      baseURL: provider.baseURL
    }
    if (!CATALOG_PROVIDERS.has(provider.id)) profile.api = provider.api
    if (!CATALOG_PROVIDERS.has(provider.id) || provider.models.length) profile.models = provider.models
    piProviders[provider.id] = profile
  }
  if (Object.keys(piProviders).length || Object.keys(existingPi).some((key) => key !== 'providers')) {
    document.setIn(['llm-pi-ai'], { ...existingPi, providers: piProviders })
  } else document.deleteIn(['llm-pi-ai'])
  return document.toString()
}
