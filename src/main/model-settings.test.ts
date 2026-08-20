import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mergeHarnessModelSettings, parseHarnessModelSettings } from './model-settings'

describe('Harness model settings merge', () => {
  it('preserves unrelated settings and manually-managed providers', () => {
    const result = parse(mergeHarnessModelSettings(`theme: dark
llm-pi-ai:
  timeout: 30
  providers:
    manual-gateway:
      baseURL: https://manual.example/v1
`, { provider: 'openai', model: 'gpt-example' }, [{
      id: 'openai', name: 'OpenAI', api: 'openai-responses', baseURL: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-example', name: 'GPT Example' }], custom: false
    }])) as Record<string, any>
    expect(result.theme).toBe('dark')
    expect(result['agent-default-model']).toEqual({ provider: 'openai', model: 'gpt-example' })
    expect(result['llm-pi-ai'].timeout).toBe(30)
    expect(result['llm-pi-ai'].providers['manual-gateway'].baseURL).toBe('https://manual.example/v1')
    expect(result['llm-pi-ai'].providers.openai.apiKeyEnv).toBe('OPENAI_API_KEY')
  })

  it('removes only the requested launcher provider', () => {
    const result = parse(mergeHarnessModelSettings(`llm-pi-ai:
  providers:
    remove-me: { baseURL: https://old.example/v1 }
    keep-me: { baseURL: https://keep.example/v1 }
`, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, [], 'remove-me')) as Record<string, any>
    expect(result['llm-pi-ai'].providers['remove-me']).toBeUndefined()
    expect(result['llm-pi-ai'].providers['keep-me'].baseURL).toBe('https://keep.example/v1')
  })

  it('repairs a legacy DeepSeek key mistakenly stored as the endpoint', () => {
    const leakedLegacyValue = 'sk-legacy-value-that-must-not-survive'
    const output = mergeHarnessModelSettings(`llm-deepseek:\n  baseURL: ${leakedLegacyValue}\n`, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash'
    }, [{
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      api: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      custom: false
    }])
    const result = parse(output) as Record<string, any>

    expect(output).not.toContain(leakedLegacyValue)
    expect(result['llm-deepseek']).toEqual({
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY'
    })
  })

  it('imports providers and the active model changed from Harness web', () => {
    const fallback = [{
      id: 'deepseek-official', name: 'DeepSeek 官方', api: 'deepseek' as const,
      baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }], custom: false
    }, {
      id: 'obsolete', name: 'Obsolete', api: 'openai-completions' as const,
      baseURL: 'https://old.example/v1', apiKeyEnv: 'OBSOLETE_API_KEY',
      models: [{ id: 'old', name: 'Old' }], custom: true
    }]
    const state = parseHarnessModelSettings(`agent-default-model:
  provider: qwen-team
  model: qwen3-coder-plus
llm-deepseek:
  baseURL: https://api.deepseek.com
  apiKeyEnv: DEEPSEEK_API_KEY
  models:
    - id: deepseek-v4-pro
      name: DeepSeek V4 Pro
llm-pi-ai:
  providers:
    qwen-team:
      displayName: 千问团队网关
      api: openai-completions
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      apiKeyEnv: TEAM_QWEN_KEY
      models:
        - id: qwen3-coder-plus
          name: Qwen3 Coder Plus
`, fallback, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    expect(state.active).toEqual({ provider: 'qwen-team', model: 'qwen3-coder-plus' })
    expect(state.providers.map((provider) => provider.id)).toEqual(['deepseek-official', 'qwen-team'])
    expect(state.providers.find((provider) => provider.id === 'deepseek-official')?.models)
      .toEqual([{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }])
    expect(state.providers.find((provider) => provider.id === 'qwen-team')).toMatchObject({
      name: '千问团队网关', apiKeyEnv: 'TEAM_QWEN_KEY', custom: true
    })
  })
})
