import type { ModelDefinition } from './types'

export const DEEPSEEK_FLASH_MODEL = 'deepseek-flash'
export const DEEPSEEK_MODEL_CATALOG_DATE = '2026-10-20'

export function canonicalDeepSeekModel(id: string): string {
  return ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(id) ? DEEPSEEK_FLASH_MODEL : id
}

export const officialDeepSeekModels: ModelDefinition[] = [
  {
    id: DEEPSEEK_FLASH_MODEL,
    name: 'DeepSeek V4.1 Flash',
    description: 'DeepSeek-V4.1-Flash-1017，支持文字、图片理解与工具调用。',
    recommended: true,
    inputModalities: ['text', 'image']
  },
  {
    id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro',
    description: '复杂推理、规划与高难度代码任务；仅支持文字输入。',
    inputModalities: ['text']
  }
]

export function canonicalDeepSeekModels(models: ModelDefinition[]): ModelDefinition[] {
  const selected = new Map<string, ModelDefinition>()
  for (const model of models) {
    const id = canonicalDeepSeekModel(model.id)
    const normalized = { ...model, id }
    if (model.id !== id) {
      // Retire only the old bundled experiment's hard-coded limits; preserve
      // explicitly different user policies and unrelated custom models.
      if (normalized.imagePixelBudget === 640_000) delete normalized.imagePixelBudget
      if (normalized.imageMaxBytes === 1_048_576) delete normalized.imageMaxBytes
    }
    if (!selected.has(id) || model.id === id) selected.set(id, normalized)
  }
  return [...selected.values()]
}
