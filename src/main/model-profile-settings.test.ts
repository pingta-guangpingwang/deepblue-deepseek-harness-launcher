import { expect, it } from 'vitest'
import { harnessUsesProfileModelSettings, mergeHarnessProfileModelSettings, parseHarnessModelSettings, profileModelSettingsSource } from './model-settings'
it('writes the 0.2 profile format and preserves unrelated comments and expressions', () => {
  const source = "# Custom deployment\n- id: connection\n  config:\n    trustedHosts: !!js ctx.webStartup.trustedHosts\n"
  const provider = { id: 'synthetic', name: 'Synthetic', api: 'openai-completions' as const, baseURL: 'http://127.0.0.1:4321/v1', apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: 'test-model', name: 'Test' }] }
  const active = { provider: 'synthetic', model: 'test-model' }
  const patch = mergeHarnessProfileModelSettings(source, active, [provider])
  expect(patch).toContain('# Custom deployment')
  expect(patch).toContain('!!js ctx.webStartup.trustedHosts')
  expect(parseHarnessModelSettings(profileModelSettingsSource(patch), [provider], active).active).toEqual(active)
  const removed = mergeHarnessProfileModelSettings(patch, active, [], 'synthetic')
  expect(removed).not.toContain('SYNTHETIC_KEY')
  expect(harnessUsesProfileModelSettings('0.2.1-alpha.2')).toBe(true)
  expect(harnessUsesProfileModelSettings('0.1.1-rc.2')).toBe(false)
})
