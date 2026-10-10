import { expect, it } from 'vitest'
import { harnessUsesProfileModelSettings, mergeHarnessProfileModelSettings, parseHarnessModelSettings, profileModelSettingsSource } from './model-settings'
it('writes the 0.2 profile format and preserves unrelated comments and expressions', () => {
  const source = "# Custom deployment\n- id: connection\n  config:\n    trustedHosts: !!js ctx.webStartup.trustedHosts\n"
  const provider = { id: 'synthetic', name: 'Synthetic', api: 'openai-completions' as const, baseURL: 'http://127.0.0.1:4321/v1', apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: 'test-model', name: 'Test', inputModalities: ['text', 'image'] as Array<'text' | 'image'> }] }
  const active = { provider: 'synthetic', model: 'test-model' }
  const patch = mergeHarnessProfileModelSettings(source, active, [provider])
  expect(patch).toContain('# Custom deployment')
  expect(patch).toContain('!!js ctx.webStartup.trustedHosts')
  expect(patch).toContain('input:')
  expect(parseHarnessModelSettings(profileModelSettingsSource(patch), [provider], active).active).toEqual(active)
  const removed = mergeHarnessProfileModelSettings(patch, active, [], 'synthetic')
  expect(removed).not.toContain('SYNTHETIC_KEY')
  expect(harnessUsesProfileModelSettings('0.2.1-alpha.2')).toBe(true)
  expect(harnessUsesProfileModelSettings('0.1.1-rc.2')).toBe(false)
})

it('projects official DeepSeek settings to the new Messages endpoint without removed imageDetail', () => {
  const provider = { id: 'deepseek-official', name: 'DeepSeek', api: 'deepseek' as const, baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] as Array<'text' | 'image'>, imagePixelBudget: 640000, imageDetail: 'auto' as const }] }
  const active = { provider: provider.id, model: 'vision' }
  const patch = mergeHarnessProfileModelSettings('[]\n', active, [provider])
  expect(patch).toContain('https://api.deepseek.com/anthropic')
  expect(patch).not.toContain('imageDetail')
  expect(patch).toContain('imagePixelBudget: 640000')
  expect(parseHarnessModelSettings(profileModelSettingsSource(patch), [provider], active).providers[0]?.baseURL).toBe('https://api.deepseek.com')
})
