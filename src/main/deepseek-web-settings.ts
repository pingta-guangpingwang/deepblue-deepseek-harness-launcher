import { isMap, isSeq, parseDocument } from 'yaml'

export interface DeepSeekWebSearchState {
  supported: boolean
  enabled: boolean
  selection: 'deepseek-api' | 'default' | 'custom'
}

// Keep the runtime allowlist exact; newer unknown protocols are not assumed safe.
export const supportsDeepSeekWebApi = (version: string): boolean => version === '0.2.1-rc.2'

function profileDocument(source: string) {
  const document = parseDocument(source || '[]\n', { prettyErrors: false })
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Harness profile patch 必须是 YAML 数组')
  return document
}

function lastEntry(document: ReturnType<typeof profileDocument>, id: string): number {
  if (!isSeq(document.contents)) return -1
  return document.contents.items.findLastIndex(row => isMap(row) && String(row.get('id')) === id)
}

export function readDeepSeekWebSearch(source: string, version: string): DeepSeekWebSearchState {
  const document = profileDocument(source)
  const index = lastEntry(document, 'web')
  const search = index >= 0 ? document.getIn([index, 'config', 'searchProvider']) : undefined
  const fetch = index >= 0 ? document.getIn([index, 'config', 'fetchProvider']) : undefined
  const enabled = search === 'deepseek-search-api' && fetch === 'deepseek-fetch-api'
  const defaultSelection = (search === undefined || search === 'deepseek-official') && (fetch === undefined || fetch === 'http')
  return { supported: supportsDeepSeekWebApi(version), enabled, selection: enabled ? 'deepseek-api' : defaultSelection ? 'default' : 'custom' }
}

export function mergeDeepSeekWebSearch(source: string, enabled: boolean, credentialRef = 'DEEPSEEK_API_KEY'): string {
  if (typeof enabled !== 'boolean') throw new Error('搜索开关值必须是布尔值')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)) throw new Error('DeepSeek 凭据引用无效')
  const document = profileDocument(source)
  const set = (id: string, values: Record<string, unknown>) => {
    let index = lastEntry(document, id)
    if (index < 0) {
      if (!isSeq(document.contents)) throw new Error('Harness profile patch 必须是 YAML 数组')
      document.add(document.createNode({ id, config: values }))
      return
    }
    const config = document.getIn([index, 'config'], true)
    if (config !== undefined && !isMap(config)) throw new Error('搜索配置包含动态表达式，请在 DSH 原生设置中修改')
    for (const [key, value] of Object.entries(values)) document.setIn([index, 'config', key], value)
  }
  set('web', {
    searchProvider: enabled ? 'deepseek-search-api' : 'deepseek-official',
    fetchProvider: enabled ? 'deepseek-fetch-api' : 'http'
  })
  if (enabled) {
    const apiIndex = lastEntry(document, 'web-deepseek-api')
    const existingBase = apiIndex >= 0 ? document.getIn([apiIndex, 'config', 'baseURL']) : undefined
    const existingRef = apiIndex >= 0 ? document.getIn([apiIndex, 'config', 'apiKeyEnv']) : undefined
    set('web-deepseek-api', {
      // Do not redirect an already-configured gateway credential to a new host.
      apiKeyEnv: typeof existingRef === 'string' && existingRef.trim() ? existingRef : credentialRef,
      baseURL: typeof existingBase === 'string' && existingBase.trim() ? existingBase : 'https://api.deepseek.com/v1/tools'
    })
  }
  return document.toString()
}

/** Enable the requested new backend only when the user has no explicit choice. */
export function initializeDeepSeekWebSearch(source: string, version: string, credentialRef = 'DEEPSEEK_API_KEY'): string {
  if (!supportsDeepSeekWebApi(version)) return source
  const document = profileDocument(source)
  const index = lastEntry(document, 'web')
  if (index >= 0 && document.hasIn([index, 'config']) && !isMap(document.getIn([index, 'config'], true))) return source
  if (index >= 0 && (document.hasIn([index, 'config', 'searchProvider']) || document.hasIn([index, 'config', 'fetchProvider']))) return source
  if (lastEntry(document, 'web-deepseek-api') >= 0) return source
  return mergeDeepSeekWebSearch(source, true, credentialRef)
}
