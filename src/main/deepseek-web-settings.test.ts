import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { initializeDeepSeekWebSearch, mergeDeepSeekWebSearch, readDeepSeekWebSearch, supportsDeepSeekWebApi } from './deepseek-web-settings'
import { canonicalDeepSeekModel, canonicalDeepSeekModels } from '../shared/deepseek-models'

describe('DeepSeek native Search / Fetch settings', () => {
  it('enables both dedicated endpoints without copying credentials into a profile', () => {
    const original = '# Keep user settings\n- id: connection\n  config:\n    trustedHosts: !!js ctx.webStartup.trustedHosts\n'
    const updated = initializeDeepSeekWebSearch(original, '0.2.1-rc.2', 'MY_DEEPSEEK_KEY')
    expect(readDeepSeekWebSearch(updated, '0.2.1-rc.2')).toEqual({ supported: true, enabled: true, selection: 'deepseek-api' })
    expect(updated).toContain('# Keep user settings')
    expect(updated).toContain('!!js ctx.webStartup.trustedHosts')
    expect(updated).toContain('https://api.deepseek.com/v1/tools')
    expect(updated).toContain('apiKeyEnv: MY_DEEPSEEK_KEY')
    expect(updated).not.toMatch(/\bapiKey:/)
    expect(initializeDeepSeekWebSearch(updated, '0.2.1-rc.2')).toBe(updated)
  })

  it('keeps a user-selected backend and an explicit disable across restarts', () => {
    const custom = '- id: web\n  config:\n    searchProvider: exa\n    fetchProvider: http\n'
    expect(initializeDeepSeekWebSearch(custom, '0.2.1-rc.2')).toBe(custom)
    expect(readDeepSeekWebSearch(custom, '0.2.1-rc.2').selection).toBe('custom')
    const enabled = mergeDeepSeekWebSearch(custom, true)
    const disabled = mergeDeepSeekWebSearch(enabled, false)
    expect(readDeepSeekWebSearch(disabled, '0.2.1-rc.2')).toMatchObject({ enabled: false, selection: 'default' })
    expect(initializeDeepSeekWebSearch(disabled, '0.2.1-rc.2')).toBe(disabled)
  })

  it('changes the effective final patch and preserves other namespace settings', () => {
    const original = '- id: web\n  config: { searchProvider: old }\n- id: web\n  config: { searchProvider: custom, fetchProvider: http, customFlag: 42 }\n- id: web-deepseek-api\n  config: { count: 7 }\n'
    const updated = mergeDeepSeekWebSearch(original, true)
    const rows = parse(updated)
    expect(rows[0].config.searchProvider).toBe('old')
    expect(rows[1].config).toMatchObject({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api', customFlag: 42 })
    expect(rows[2].config.count).toBe(7)
  })

  it('rejects malformed profiles and unknown runtime versions', () => {
    expect(() => mergeDeepSeekWebSearch('{}', true)).toThrow('YAML 数组')
    expect(() => mergeDeepSeekWebSearch('[]', 'yes' as unknown as boolean)).toThrow('布尔值')
    expect(() => mergeDeepSeekWebSearch('[]', true, 'key\napiKey: injected')).toThrow('凭据引用')
    for (const version of ['0.2.1-alpha.2', '0.2.1-rc.1', '0.2.2', '99.0.0']) {
      expect(supportsDeepSeekWebApi(version)).toBe(false)
      expect(initializeDeepSeekWebSearch('[]\n', version)).toBe('[]\n')
    }
  })

  it('preserves a custom API endpoint and its credential reference on explicit enable', () => {
    const source = '- id: web-deepseek-api\n  config:\n    baseURL: https://gateway.example/search/v1/tools\n    apiKeyEnv: GATEWAY_SEARCH_KEY\n'
    expect(initializeDeepSeekWebSearch(source, '0.2.1-rc.2')).toBe(source)
    const updated = mergeDeepSeekWebSearch(source, true)
    expect(updated).toContain('https://gateway.example/search/v1/tools')
    expect(updated).toContain('GATEWAY_SEARCH_KEY')
    expect(readDeepSeekWebSearch(updated, '0.2.1-rc.2').enabled).toBe(true)
  })

  it('collapses retired Flash aliases while keeping unrelated custom model IDs', () => {
    expect(canonicalDeepSeekModel('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash')
    const models = canonicalDeepSeekModels([
      { id: 'deepseek-v4-flash', name: 'old' }, { id: 'deepseek-v4-flash-vision-exp', name: 'old vision' },
      { id: 'deepseek-flash', name: 'current' }, { id: 'custom-model', name: 'custom' }
    ])
    expect(models).toEqual([{ id: 'deepseek-flash', name: 'current' }, { id: 'custom-model', name: 'custom' }])
  })
})
