import type { CatalogPlugin, HarnessVersion, ModelCatalogItem } from '../shared/types'

export const bundledVersions: HarnessVersion[] = [
  {
    version: '0.1.1-rc.2',
    channel: 'stable',
    installed: true,
    active: true,
    rollbackReady: false,
    sizeMb: 75,
    publishedAt: '2026-08-22',
    notes: ['同步 DeepSeek 官方 dsh-v0.1.1-rc.2', '新增 DeepSeek V4 Flash Vision Exp 图片输入与 Files API 管线']
  },
  {
    version: '0.1.0-rc.3',
    channel: 'preview',
    installed: false,
    active: false,
    rollbackReady: false,
    sizeMb: 73,
    publishedAt: '2026-07-28',
    notes: ['历史候选版本']
  }
]

// The public catalog stays empty until a package with a verified dsh.bundle
// declaration is available. Users can still install a trusted package spec.
export const bundledPlugins: CatalogPlugin[] = []

export const bundledModels: ModelCatalogItem[] = [
  {
    id: 'deepseek-v4-flash',
    provider: 'DeepSeek',
    model: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    description: '面向高频对话、工具调用与代码任务的快速模型。模型调用需要用户自己的 API Key。',
    context: '以官方当前配置为准',
    capabilities: ['对话', '工具调用', '代码'],
    status: 'available',
    configured: false,
    docsUrl: 'https://api-docs.deepseek.com/'
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'DeepSeek',
    model: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    description: '适合复杂推理、规划和需要更充分分析的任务。',
    context: '以官方当前配置为准',
    capabilities: ['推理', '规划', '代码'],
    status: 'available',
    configured: false,
    docsUrl: 'https://api-docs.deepseek.com/'
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    provider: 'DeepSeek',
    model: 'deepseek-v4-flash-vision-exp',
    displayName: 'DeepSeek V4 Flash Vision Exp',
    description: 'DeepSeek 官方视觉实验模型，支持图片理解、文字提取、界面检查与图表分析。',
    context: '以官方当前配置为准',
    capabilities: ['对话', '图片理解', 'OCR', '工具调用'],
    status: 'preview',
    configured: false,
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/guides/vision'
  },
  {
    id: 'custom-openai-compatible',
    provider: '兼容接口',
    model: 'custom',
    displayName: '自定义 OpenAI 兼容模型',
    description: '通过 Harness 的模型设置连接兼容服务，不由启动器保存密钥。',
    context: '由服务商决定',
    capabilities: ['可配置'],
    status: 'available',
    configured: false
  }
]
