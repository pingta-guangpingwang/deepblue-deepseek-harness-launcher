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

// These packages are documented by their upstream repositories and are always
// installed through Harness' own web-profile plugin command. Nothing executes
// until the user explicitly presses Install.
export const bundledPlugins: CatalogPlugin[] = [
  {
    id: 'dsh-task-board', name: '任务看板', packageSpec: '@linxin666/dsh-client-ui-task-board@latest',
    description: '把任务按状态组织，并可交给真实 DSH 会话执行。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: true,
    tags: ['任务', '看板', '定时'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'standard'
  },
  {
    id: 'dsh-chat-recovery', name: '会话恢复', packageSpec: '@linxin666/dsh-chat-recovery@latest',
    description: '失败轮次重试与历史消息分叉编辑，不破坏原会话。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: true,
    tags: ['会话', '恢复', '重试'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'standard'
  },
  {
    id: 'dsh-skill-explorer', name: 'Skill 管理器', packageSpec: '@linxin666/dsh-client-ui-skill-explorer@latest',
    description: '在 DSH 内浏览、启停、创建和删除当前 profile 的 Skill。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: true,
    tags: ['Skill', '管理', 'Profile'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'standard'
  },
  {
    id: 'dsh-git-graph', name: 'Git 提交图谱', packageSpec: '@linxin666/dsh-client-ui-git-graph@latest',
    description: '在会话界面切换分支并查看提交历史图谱。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: false,
    tags: ['Git', '分支', '提交'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'standard'
  },
  {
    id: 'dsh-better-sidebar', name: '开发右侧面板', packageSpec: 'dsh-better-sidebar@latest',
    description: '把资源管理器、编辑器、终端、Git 与浏览器收进可扩展右侧面板。', author: 'DSH community', version: 'latest', installed: false, updateAvailable: false, featured: true,
    tags: ['文件', '编辑器', '终端'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'system'
  },
  {
    id: 'dsh-describe-image', name: '会话图像理解', packageSpec: '@linxin666/dsh-tool-describe-image@latest',
    description: '为 DSH 会话增加图片选择与 OpenAI 兼容视觉端点工具。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: true,
    tags: ['视觉', 'OCR', '图片'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'network'
  },
  {
    id: 'dsh-remote-web', name: '手机 / PC 远程配对', packageSpec: '@linxin666/dsh-remote-web-ui@latest',
    description: '用一次性配对令牌远程查看会话、发消息和切换模型；需要自行管理网络暴露。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: false,
    tags: ['远程', '配对', 'SSE'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'network'
  },
  {
    id: 'dsh-ssh', name: 'SSH 运维面板', packageSpec: '@linxin666/dsh-ssh@latest',
    description: '终端、SFTP、端口转发与集群执行；仅建议理解远程权限的用户安装。', author: 'dsh-web-ui contributors', version: 'latest', installed: false, updateAvailable: false, featured: false,
    tags: ['SSH', 'SFTP', '高权限'], repositoryUrl: 'https://github.com/zhu1090093659/dsh-web-ui', permissionLevel: 'system'
  }
]

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
