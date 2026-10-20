import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mergeSignedModelTemplates, modelProviderTemplates, normalizeModelProviderDraft } from './model-store'

describe('model provider templates', () => {
  it('ships a broad domestic API directory without duplicating identities or secrets', () => {
    const expectedDomestic = [
      'deepseek-official', 'qwen', 'volcengine', 'moonshot', 'zhipu', 'qianfan',
      'tencent-tokenhub', 'minimax', 'stepfun', 'siliconflow', 'baichuan'
    ]
    const domestic = modelProviderTemplates.filter((template) => template.region === 'china')

    expect(domestic.map((template) => template.id)).toEqual(expectedDomestic)
    expect(new Set(modelProviderTemplates.map((template) => template.id)).size).toBe(modelProviderTemplates.length)
    expect(new Set(modelProviderTemplates.map((template) => template.apiKeyEnv)).size).toBe(modelProviderTemplates.length)
    expect(domestic.find((template) => template.id === 'volcengine')?.name).toContain('豆包')
    expect(domestic.find((template) => template.id === 'qwen')?.name).toContain('千问')
    expect(domestic.find((template) => template.id === 'moonshot')?.name).toContain('Kimi')
  })

  it('uses verified HTTPS defaults while keeping custom gateways user-defined', () => {
    for (const template of modelProviderTemplates) {
      if (template.docsUrl) expect(new URL(template.docsUrl).protocol).toBe('https:')
      if (template.custom) {
        expect(template.baseURL).toBe('')
        expect(template.region).toBe('custom')
      } else {
        expect(new URL(template.baseURL).protocol).toBe('https:')
      }
    }
  })

  it('ships a dated selectable model catalog for every known provider', () => {
    for (const template of modelProviderTemplates) {
      expect(template.catalogUpdatedAt).toBe(template.id === 'deepseek-official' ? '2026-10-20' : '2026-08-22')
      if (template.custom) continue
      expect(template.suggestedModels.length).toBeGreaterThan(0)
      expect(template.suggestedModels.some((model) => model.recommended)).toBe(true)
      expect(new Set(template.suggestedModels.map((model) => model.id)).size).toBe(template.suggestedModels.length)
    }
  })

  it('uses the canonical multimodal Flash model without the retired experiment limits', () => {
    const deepseek = modelProviderTemplates.find((template) => template.id === 'deepseek-official')
    const flash = deepseek?.suggestedModels.find((model) => model.id === 'deepseek-flash')
    expect(flash?.inputModalities).toEqual(['text', 'image'])
    expect(flash?.imageMaxBytes).toBeUndefined()
    expect(flash?.imagePixelBudget).toBeUndefined()
    expect(deepseek?.suggestedModels.some(model => model.id === 'deepseek-v4-flash-vision-exp')).toBe(false)
  })

  it('locks known providers to official connection and model values', () => {
    const normalized = normalizeModelProviderDraft({
      id: 'openai', name: '伪造名称', api: 'openai-completions', baseURL: 'https://attacker.example/v1', apiKey: 'secret', custom: true,
      models: [{ id: 'gpt-5.6-terra', name: '伪造显示名' }, { id: 'not-an-official-model', name: '旁路模型' }]
    })
    expect(normalized).toMatchObject({
      id: 'openai', name: 'OpenAI', api: 'openai-responses', baseURL: 'https://api.openai.com/v1', custom: false,
      models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' }]
    })
  })

  it('can apply a trusted signed template without changing the launcher shell', () => {
    const liveTemplates = modelProviderTemplates.map((template) => template.id === 'deepseek-official' ? {
      ...template,
      catalogUpdatedAt: '2026-08-20',
      suggestedModels: [...template.suggestedModels, { id: 'deepseek-v4-mini', name: 'DeepSeek V4 Mini' }]
    } : template)
    const normalized = normalizeModelProviderDraft({
      id: 'deepseek-official', name: 'ignored', api: 'openai-completions', baseURL: 'https://ignored.example',
      models: [{ id: 'deepseek-v4-mini', name: 'ignored' }]
    }, liveTemplates)
    expect(normalized.models).toEqual([{ id: 'deepseek-v4-mini', name: 'DeepSeek V4 Mini' }])
  })

  it('does not let an older signed directory hide newer bundled model capabilities', () => {
    const staleDeepSeek = {
      ...modelProviderTemplates.find((template) => template.id === 'deepseek-official')!,
      catalogUpdatedAt: '2026-08-18',
      suggestedModels: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
      ]
    }
    const merged = mergeSignedModelTemplates([staleDeepSeek])
    const deepseek = merged.find((template) => template.id === 'deepseek-official')
    expect(deepseek?.catalogUpdatedAt).toBe('2026-10-20')
    expect(deepseek?.suggestedModels.find((model) => model.id === 'deepseek-flash')?.inputModalities).toEqual(['text', 'image'])
    expect(deepseek?.suggestedModels.some(model => model.id === 'deepseek-v4-flash')).toBe(false)
  })

  it('opens resource cards on one click and keeps manual model entry custom-only', () => {
    const app = readFileSync(path.resolve('src/renderer/src/App.tsx'), 'utf8')
    expect(app).toMatch(/resource-market-card[\s\S]{0,180}onClick=\{\(\) => openResource\(item\)\}/)
    expect(app).not.toMatch(/resource-market-card[^\n]+onDoubleClick/)
    expect(app).toContain("draft.custom ? <label className=\"wide\"><span>模型列表")
    expect(app).toContain('选择官方模型')
  })
})
