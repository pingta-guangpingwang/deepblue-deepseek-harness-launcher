import type { CatalogPlugin, HarnessVersion, ModelCatalogItem } from '../shared/types'

export const bundledVersions: HarnessVersion[] = [
  {
    version: '0.1.0-rc.6',
    channel: 'stable',
    installed: true,
    active: true,
    rollbackReady: false,
    sizeMb: 75,
    publishedAt: '2026-08-05',
    notes: ['首个候选发行版', '提供 Web、Headless 与插件 Profile 工作流']
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
