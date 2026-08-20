import type { ModelProviderTemplate } from './types'

const UPDATED_AT = '2026-08-18'

export const modelProviderTemplates: ModelProviderTemplate[] = [
  {
    id: 'deepseek-official', name: 'DeepSeek 官方', description: '官方 V4 模型，Flash 适合日常工程，Pro 适合复杂规划与高难度代码任务。', region: 'china',
    api: 'deepseek', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/guides/reasoning_model', billingUrl: 'https://platform.deepseek.com/usage', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '速度与成本均衡，适合默认工程模型。', recommended: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: '复杂推理、规划与高难度代码任务。' }
    ]
  },
  {
    id: 'qwen', name: '通义千问 · 阿里云百炼', description: '百炼官方稳定模型目录，覆盖旗舰、均衡与高速档。', region: 'china',
    api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWEN_API_KEY',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/model-list-text-generation/', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', description: '旗舰推理与智能体任务。', recommended: true },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', description: '效果、速度与费用均衡。' },
      { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', description: '高频低延迟任务。' }
    ]
  },
  {
    id: 'volcengine', name: '豆包 · 火山方舟', description: '火山方舟官方 Doubao Seed 2.0 文本与智能体模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKeyEnv: 'VOLCENGINE_API_KEY',
    docsUrl: 'https://www.volcengine.com/docs/82379/1958524', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro', description: '复杂推理、工具调用与工程任务。', recommended: true },
      { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao Seed 2.0 Lite', description: '低延迟与高频调用。' }
    ]
  },
  {
    id: 'moonshot', name: 'Kimi · 月之暗面', description: 'Kimi 官方长程编程、知识工作和多模态模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY',
    docsUrl: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart.html', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'kimi-k3', name: 'Kimi K3', description: '旗舰长程编程与知识工作模型。', recommended: true },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', description: '代码与工具调用专用。' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', description: '文本、图片与视频理解。' }
    ]
  },
  {
    id: 'zhipu', name: '智谱 GLM', description: '智谱官方旗舰长程工程与通用智能模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'glm-5.2', name: 'GLM-5.2', description: '1M 上下文旗舰长程工程模型。', recommended: true },
      { id: 'glm-5.1', name: 'GLM-5.1', description: '复杂 Coding 与自主智能体任务。' }
    ]
  },
  {
    id: 'qianfan', name: '百度千帆', description: '百度千帆官方文心旗舰与深度思考模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://qianfan.baidubce.com/v2', apiKeyEnv: 'QIANFAN_API_KEY',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan/s/7m95lyy43', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'ernie-5.1', name: 'ERNIE 5.1', description: '最新旗舰通用与联网任务。', recommended: true },
      { id: 'ernie-5.0', name: 'ERNIE 5.0', description: '稳定全模态与长文本任务。' },
      { id: 'ernie-x1.1', name: 'ERNIE X1.1', description: '深度推理任务。' }
    ]
  },
  {
    id: 'tencent-tokenhub', name: '腾讯云 TokenHub', description: '腾讯官方统一模型网关，精选当前可用语言模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://tokenhub.tencentmaas.com/v1', apiKeyEnv: 'TENCENT_TOKENHUB_API_KEY',
    docsUrl: 'https://cloud.tencent.com/document/product/1823/130078', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'hy3', name: '腾讯混元 Hy3', description: '腾讯旗舰通用与推理模型。', recommended: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro · TokenHub', description: 'TokenHub 原厂直供模型。' },
      { id: 'glm-5.2', name: 'GLM-5.2 · TokenHub', description: '长程工程与代码任务。' }
    ]
  },
  {
    id: 'minimax', name: 'MiniMax 稀宇', description: 'MiniMax 官方 M2 系列文本、代码与智能体模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://api.minimaxi.com/v1', apiKeyEnv: 'MINIMAX_API_KEY',
    docsUrl: 'https://platform.minimaxi.com/docs/api-reference/api-overview', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', description: '复杂任务与智能体工作流。', recommended: true },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', description: '同等能力的高速档。' }
    ]
  },
  {
    id: 'stepfun', name: '阶跃星辰 StepFun', description: '阶跃官方推理、智能体与多模态模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://api.stepfun.com/v1', apiKeyEnv: 'STEPFUN_API_KEY',
    docsUrl: 'https://platform.stepfun.com/docs/zh/guides/models/overview', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'step-3.5-flash', name: 'Step 3.5 Flash', description: '旗舰推理、编码与工具调用。', recommended: true },
      { id: 'step-3', name: 'Step 3', description: '多模态推理模型。' }
    ]
  },
  {
    id: 'siliconflow', name: '硅基流动', description: '硅基流动官方目录中的主流开源模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY',
    docsUrl: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash · SiliconFlow', description: '适合日常工程与智能体。', recommended: true },
      { id: 'Pro/zai-org/GLM-5', name: 'GLM-5 Pro · SiliconFlow', description: '复杂推理与编码任务。' },
      { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen 3.5 397B · SiliconFlow', description: '千问开源旗舰模型。' }
    ]
  },
  {
    id: 'baichuan', name: '百川智能', description: '百川官方 Chat Completions 模型。', region: 'china',
    api: 'openai-completions', baseURL: 'https://api.baichuan-ai.com/v1', apiKeyEnv: 'BAICHUAN_API_KEY',
    docsUrl: 'https://platform.baichuan-ai.com/docs/api', custom: false, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'Baichuan4-Turbo', name: 'Baichuan 4 Turbo', description: '百川旗舰升级版。', recommended: true },
      { id: 'Baichuan4-Air', name: 'Baichuan 4 Air', description: '高性价比高速模型。' },
      { id: 'Baichuan2-Turbo', name: 'Baichuan 2 Turbo', description: '官方 API 文档兼容模型。' }
    ]
  },
  {
    id: 'openai', name: 'OpenAI', description: 'OpenAI 官方 GPT-5.6 模型家族。', region: 'global',
    api: 'openai-responses', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY',
    docsUrl: 'https://developers.openai.com/api/docs/models', billingUrl: 'https://platform.openai.com/usage', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: '旗舰复杂专业工作模型。', recommended: true },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: '智能、速度与成本均衡。' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: '高频、成本敏感任务。' }
    ]
  },
  {
    id: 'anthropic', name: 'Anthropic Claude', description: 'Anthropic 官方 Claude 5 与高效模型。', region: 'global',
    api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview', billingUrl: 'https://console.anthropic.com/settings/usage', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'claude-fable-5', name: 'Claude Fable 5', description: '长程智能体与最高能力任务。', recommended: true },
      { id: 'claude-opus-5', name: 'Claude Opus 5', description: '复杂编码与企业工作。' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', description: '速度与智能均衡。' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: '低延迟高频任务。' }
    ]
  },
  {
    id: 'google', name: 'Google Gemini', description: 'Google 官方稳定 Gemini 多模态模型。', region: 'global',
    api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'GEMINI_API_KEY',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models', billingUrl: 'https://aistudio.google.com/usage', custom: false, featured: true, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: [
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', description: '稳定版智能体与多模态模型。', recommended: true },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: '持续推理与编码任务。' },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', description: '高吞吐低成本任务。' }
    ]
  },
  {
    id: 'custom', name: '自定义模型服务', description: '连接自建网关或 OpenAI / Anthropic / Gemini 兼容接口。', region: 'custom',
    api: 'openai-completions', baseURL: '', apiKeyEnv: 'CUSTOM_MODEL_API_KEY', docsUrl: '', custom: true, featured: false, catalogUpdatedAt: UPDATED_AT,
    suggestedModels: []
  }
]
