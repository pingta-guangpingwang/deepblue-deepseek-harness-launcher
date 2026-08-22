import type { LauncherSnapshot } from '../../shared/types'
import { modelProviderTemplates } from '../../shared/model-provider-catalog'
import petCatalog from '../../../pet-store/catalog.payload.json'

export const mockSnapshot: LauncherSnapshot = {
  launcherVersion: '0.10.13',
  platform: 'win32-x64',
  distributionMode: 'offline',
  runStatus: 'stopped',
  activeHarnessVersion: '0.1.1-rc.2',
  latestHarnessVersion: '0.1.1-rc.2',
  runtimeUpdates: {
    status: 'available',
    message: '检测到 2 个独立模块可更新',
    items: [
      { id: 'harness-core', label: 'DeepSeek Harness 核心', currentVersion: '0.1.0-rc.8', nextVersion: '0.1.1-rc.2', size: 48_600_000, required: true },
      { id: 'package-manager', label: 'pnpm 插件环境', currentVersion: '11.22.0', nextVersion: '11.23.0', size: 6_900_000, required: true }
    ]
  },
  environment: [
    { id: 'node', label: '内置 Node.js', version: '24.16.0', status: 'ready', detail: '独立运行时可用，不修改系统环境' },
    { id: 'harness', label: 'Harness 核心', version: '0.1.1-rc.2', status: 'ready', detail: '整合包内置版本' },
    { id: 'pnpm', label: '插件包管理器', version: '11.22.0', status: 'ready', detail: '用于安装和更新 Harness 插件' },
    { id: 'network', label: '更新网络', status: 'ready', detail: '至少一个在线源可用' }
  ],
  sources: [
    { id: 'github', name: 'GitHub', baseUrl: 'https://github.com/pingta-guangpingwang/deepseek-harness.git', enabled: true, kind: 'repository', status: 'available', latencyMs: 142 },
    { id: 'gitee', name: 'Gitee', baseUrl: 'https://gitee.com/wanggp123/deepseek-harness.git', enabled: true, kind: 'repository', status: 'available', latencyMs: 35 },
    { id: 'runtime-v2', name: '运行时模块目录', baseUrl: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json', enabled: true, kind: 'manifest', status: 'available', latencyMs: 28 },
    { id: 'npmmirror', name: 'npmmirror', baseUrl: 'https://registry.npmmirror.com', enabled: true, kind: 'registry', status: 'available', latencyMs: 56 }
  ],
  tasks: [
    { id: 'catalog', title: '同步模型与插件目录', detail: '使用内置目录', status: 'completed', progress: 100, createdAt: new Date().toISOString() },
    { id: 'environment', title: '验证整合包运行环境', detail: '4 项检查全部通过', status: 'completed', progress: 100, createdAt: new Date().toISOString() }
  ],
  logs: [
    { id: 1, time: '20:21:03', level: 'INFO', message: '深蓝DeepSeekHarness启动器 0.10.6 已启动' },
    { id: 2, time: '20:21:03', level: 'INFO', message: '内置 Node.js 24.16.0 可用' },
    { id: 3, time: '20:21:04', level: 'INFO', message: 'Harness 0.1.1-rc.2 完整性检查通过' },
    { id: 4, time: '20:21:05', level: 'INFO', message: '选择工作区后即可启动本地服务' }
  ],
  versions: [
    { version: '0.1.1-rc.2', channel: 'stable', installed: true, active: true, rollbackReady: false, sizeMb: 75, publishedAt: '2026-08-22', notes: ['同步 DeepSeek 官方 dsh-v0.1.1-rc.2', '支持 DeepSeek 官方视觉模型图片输入'] },
    { version: '0.1.0-rc.3', channel: 'preview', installed: true, active: false, rollbackReady: true, sizeMb: 73, publishedAt: '2026-07-28', notes: ['历史候选版本'] }
  ],
  plugins: [],
  models: [
    { id: 'deepseek-v4-flash', provider: 'DeepSeek', model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', description: '面向高频对话、工具调用与代码任务的快速模型。模型调用需要用户自己的 API Key。', context: '以官方当前配置为准', capabilities: ['对话', '工具调用', '代码'], status: 'available', configured: false, docsUrl: 'https://api-docs.deepseek.com/' },
    { id: 'deepseek-v4-pro', provider: 'DeepSeek', model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', description: '适合复杂推理、规划和需要更充分分析的任务。', context: '以官方当前配置为准', capabilities: ['推理', '规划', '代码'], status: 'available', configured: false, docsUrl: 'https://api-docs.deepseek.com/' },
    { id: 'deepseek-v4-flash-vision-exp', provider: 'DeepSeek', model: 'deepseek-v4-flash-vision-exp', displayName: 'DeepSeek V4 Flash Vision Exp', description: 'DeepSeek 官方视觉实验模型，支持图片理解与文字提取。', context: '以官方当前配置为准', capabilities: ['图片理解', 'OCR', '工具调用'], status: 'preview', configured: false, docsUrl: 'https://api-docs.deepseek.com/zh-cn/guides/vision' },
    { id: 'custom', provider: '兼容接口', model: 'custom', displayName: '自定义 OpenAI 兼容模型', description: '通过 Harness 的模型设置连接兼容服务，不由启动器保存密钥。', context: '由服务商决定', capabilities: ['可配置'], status: 'available', configured: false }
  ],
  modelHub: {
    active: { provider: 'deepseek-official', model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
    secureStorageAvailable: true,
    templates: modelProviderTemplates,
    providers: [{
      id: 'deepseek-official', name: 'DeepSeek 官方', api: 'deepseek', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
      configured: true, secureStorage: true, custom: false, updatedAt: new Date().toISOString(), docsUrl: 'https://api-docs.deepseek.com/', billingUrl: 'https://platform.deepseek.com/usage',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text'] },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] },
        { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', inputModalities: ['text', 'image'], imagePixelBudget: 640_000, imageMaxBytes: 1_048_576, imageDetail: 'auto' }
      ]
    }],
    usage: {
      'deepseek-official:deepseek-v4-flash': { inputTokens: 148240, outputTokens: 42780, cacheReadTokens: 96200, cacheWriteTokens: 8100, requests: 46, updatedAt: new Date().toISOString(), source: 'harness-session-log' }
    }
  },
  account: { status: 'signed_out', sessionRemembered: false },
  favorites: { status: 'signed_out', resourceIds: [] },
  discovery: {
    status: 'ready', updatedAt: new Date().toISOString(),
    news: [
      { id: 'news-1', title: '智能体开发进入可组合工具阶段', summary: '模型、工具、Skill 与工作流正在从单点功能走向可组合工程。', category: 'applications', publishedAt: '2026-08-18 09:12:00', sourceCount: 3, heat: 88, url: 'https://ailishishu.com/news/', sourceName: 'AI历史书公开来源' },
      { id: 'news-2', title: '主流模型平台继续补齐工具调用能力', summary: '多个平台更新了连接器、工具调用和长上下文能力。', category: 'models', publishedAt: '2026-08-18 08:30:00', sourceCount: 2, heat: 74, url: 'https://ailishishu.com/news/', sourceName: 'AI历史书公开来源' }
    ],
    hotNews: [{ id: 'news-1', title: '智能体开发进入可组合工具阶段', summary: '模型、工具、Skill 与工作流正在从单点功能走向可组合工程。', category: 'applications', publishedAt: '2026-08-18 09:12:00', sourceCount: 3, heat: 88, url: 'https://ailishishu.com/news/', sourceName: 'AI历史书公开来源' }],
    games: [
      { slug: 'yugong-yishan', title: '愚公移山', summary: '国风神话题材点击放置 H5 游戏，在100颗星球上挑战万座山岳。', coverUrl: 'https://ailishishu.com/games/assets/covers/yugong-yishan-v1.webp', category: 'simulation', tags: ['国风', '放置', '经营'], featured: true, loginRequired: true, url: 'https://ailishishu.com/games/player.html?slug=yugong-yishan', mode: 'hosted_playable' },
      { slug: 'hajimi-defense', title: '哈基米守罐大战', summary: '部署猫咪防线，守住金枪鱼罐头。', coverUrl: 'https://ailishishu.com/games/assets/global/hajimi-defense.webp', category: 'strategy', tags: ['猫咪塔防', 'AI美术'], featured: true, loginRequired: true, url: 'https://ailishishu.com/games/player.html?slug=hajimi-defense', mode: 'hosted_playable' }
    ],
    tools: [{ id: 'ai-tool-chatgpt', type: 'ai_native_tool', title: 'ChatGPT', author: 'OpenAI', summary: '通用对话、研究、写作与代码协作入口。', firstStep: '选一个真实任务验证输出。', capabilities: ['对话', '研究', '代码'], difficulty: '入门', pricingMode: 'free', canonicalUrl: 'https://ailishishu.com/tools/?resource=ai-tool-chatgpt', editorialScore: 9, popularityScore: 98, rating: 4.7, ratingCount: 128 }],
    extensions: [{ id: 'skill-code-review', type: 'skill', title: '代码审查 Skill', author: 'AI历史书编辑部', summary: '把安全、边界、测试与回滚检查组成可重复流程。', firstStep: '先在一个小改动上运行。', capabilities: ['代码审查', '安全'], difficulty: '进阶', pricingMode: 'free', canonicalUrl: 'https://ailishishu.com/tools/?resource=skill-code-review', editorialScore: 8, popularityScore: 70, rating: 4.8, ratingCount: 36, repositoryUrl: 'https://github.com/anthropics/skills' }],
    prompts: [{ id: 'prompt-project-brief', type: 'prompt', title: '项目需求澄清提示词', author: 'AI历史书编辑部', summary: '把模糊想法整理为目标、边界、验收和风险。', firstStep: '粘贴现有需求并标注不能改变的约束。', capabilities: ['需求分析', '项目规划'], difficulty: '入门', pricingMode: 'free', canonicalUrl: 'https://ailishishu.com/tools/?resource=prompt-project-brief', editorialScore: 8.8, popularityScore: 82, rating: 4.6, ratingCount: 54 }],
    skills: [{ id: 'skill-code-review', type: 'skill', title: '代码审查 Skill', author: 'AI历史书编辑部', summary: '把安全、边界、测试与回滚检查组成可重复流程。', firstStep: '先在一个小改动上运行。', capabilities: ['代码审查', '安全'], difficulty: '进阶', pricingMode: 'free', canonicalUrl: 'https://ailishishu.com/tools/?resource=skill-code-review', editorialScore: 8, popularityScore: 70, rating: 4.8, ratingCount: 36, repositoryUrl: 'https://github.com/anthropics/skills' }],
    workflows: [],
    knowledgeBases: [],
    agents: [],
    careers: [{ id: 'product-manager', industryId: 'internet', industryName: '互联网与软件', title: '产品经理', summary: '围绕真实工作任务选择 AI。', tasks: [{ id: 'product-research', title: '用户研究', summary: '从材料中找目标、痛点与证据。' }] }],
    totals: { games: 2, tools: 1, extensions: 1, prompts: 1, skills: 1, workflows: 0, knowledgeBases: 0, agents: 0, careers: 1 }
  },
  resourceLibrary: [],
  workspaces: [
    { path: 'D:\\DeepSeek\\workspace', name: 'workspace', lastOpenedAt: new Date().toISOString(), pinned: true },
    { path: 'D:\\Projects\\agent-lab', name: 'agent-lab', lastOpenedAt: new Date(Date.now() - 86400000).toISOString(), pinned: false }
  ],
  skins: {
    status: 'ready',
    source: 'remote',
    generatedAt: '2026-08-15T14:30:00.000Z',
    activeSkinId: 'deep-ocean-whale',
    downloadedSkinIds: ['deep-ocean-whale'],
    favoriteSkinIds: ['deep-ocean-whale', 'anime-star-observatory'],
    items: [
      {
        id: 'deep-ocean-whale', name: '深海鲸歌', description: '发光鲸鱼穿行于深海数据城，适合深色半透明界面。', mediaKind: 'image', styles: ['cyber', 'nature'], tags: ['深海', '鲸鱼', '蓝色', '宁静'], featured: true, contentRating: 'everyone',
        thumbnail: { url: '/skin-previews/deep-ocean-whale.webp', sha256: '0e7c4ddcd19a0a62a437c1cadacb65169e9b397c8809770638caf6d713504d3b', size: 23360, mime: 'image/webp' },
        media: { url: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/assets/deep-ocean-whale.png', sha256: 'caebe4f83861bc4ba2faf51215ab928119c6a18de28a80549ee1d4f85da1f767', size: 2219828, mime: 'image/png' },
        license: { name: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', author: 'DeepSeekHarness Skin Store contributors', sourceUrl: 'https://gitee.com/wanggp123/deepseek-harness-skins' },
        presentation: { position: '50% 50%', overlay: 'rgba(2, 9, 20, 0.34)', blurPx: 0, surfaceOpacity: 0.72 }
      },
      {
        id: 'anime-star-observatory', name: '星海观测者', description: '原创成年赛博伙伴眺望全息星海，主体位于右侧。', mediaKind: 'image', styles: ['anime', 'cyber'], tags: ['二次元', '星海', '伙伴', '蓝紫'], featured: true, contentRating: 'everyone',
        thumbnail: { url: '/skin-previews/anime-star-observatory.webp', sha256: '37300966665e0b8f694e362d148cf4406901724b8c9451706f5c4c81592d3fd5', size: 19188, mime: 'image/webp' },
        media: { url: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/assets/anime-star-observatory.png', sha256: '138f4d6b7c371e7849ac8a972be26f54488e3160606d9f136d88675e682d4ff1', size: 2168129, mime: 'image/png' },
        license: { name: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', author: 'DeepSeekHarness Skin Store contributors', sourceUrl: 'https://gitee.com/wanggp123/deepseek-harness-skins' },
        presentation: { position: '68% 50%', overlay: 'rgba(3, 7, 23, 0.28)', blurPx: 0, surfaceOpacity: 0.7 }
      },
      {
        id: 'pixel-neon-workspace', name: '像素霓虹工位', description: '雨夜巨城和小机器人陪伴的像素风工作室。', mediaKind: 'image', styles: ['pixel', 'cyber'], tags: ['像素风', '机器人', '城市', '雨夜'], featured: true, contentRating: 'everyone',
        thumbnail: { url: '/skin-previews/pixel-neon-workspace.webp', sha256: '7d86aaf33a9e2cbc5ab35d389a2f5fb87204f4a078860b2a2bc6909e51e6199d', size: 21844, mime: 'image/webp' },
        media: { url: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/assets/pixel-neon-workspace.png', sha256: '8f5260242bd868b8cc90df81fce5c48509d7a1efb0f08324ab4bdb532e8ef9ff', size: 1686631, mime: 'image/png' },
        license: { name: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', author: 'DeepSeekHarness Skin Store contributors', sourceUrl: 'https://gitee.com/wanggp123/deepseek-harness-skins' },
        presentation: { position: '50% 50%', overlay: 'rgba(1, 7, 18, 0.36)', blurPx: 0, surfaceOpacity: 0.76 }
      },
      {
        id: 'ai-studio-presenter', name: '深蓝演播伙伴', description: '原创虚构成年演播伙伴，留出大面积低干扰阅读区。', mediaKind: 'image', styles: ['realistic', 'cyber'], tags: ['真人风', '伙伴', '演播室', '留白'], featured: false, contentRating: 'everyone',
        thumbnail: { url: '/skin-previews/ai-studio-presenter.webp', sha256: 'fe24e907b0038df83a127531af32f0ea91771859cbea7062eee9f39fa01e172e', size: 8824, mime: 'image/webp' },
        media: { url: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/assets/ai-studio-presenter.png', sha256: 'f67712282160161693f6163c630d176187e273d2ce330854b2706b71b57fd796', size: 1399667, mime: 'image/png' },
        license: { name: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', author: 'DeepSeekHarness Skin Store contributors', sourceUrl: 'https://gitee.com/wanggp123/deepseek-harness-skins' },
        presentation: { position: '72% 50%', overlay: 'rgba(2, 8, 18, 0.34)', blurPx: 1, surfaceOpacity: 0.74 }
      }
    ]
  },
  pets: {
    status: 'ready',
    source: 'remote',
    generatedAt: petCatalog.generatedAt,
    activePetId: 'deepblue-whale-helper',
    downloadedPetIds: ['deepblue-whale-helper'],
    items: petCatalog.items as LauncherSnapshot['pets']['items']
  },
  settings: {
    workspace: 'D:\\DeepSeek\\workspace',
    storageRoot: 'D:\\DeepSeek\\DeepBlueHarnessData',
    storageSetupCompleted: false,
    port: 3080,
    autoOpen: true,
    theme: 'light',
    channel: 'stable',
    backupBeforeUpdate: true,
    keepBackups: 3,
    installMode: 'package',
    skinCatalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/catalog.json',
    petCatalogUrl: 'https://gitee.com/wanggp123/deepseek-harness-pets/raw/master/catalog.json',
    sources: [
      { id: 'github', name: 'GitHub', baseUrl: 'https://github.com/pingta-guangpingwang/deepseek-harness.git', enabled: true, kind: 'repository' },
      { id: 'gitee', name: 'Gitee', baseUrl: 'https://gitee.com/wanggp123/deepseek-harness.git', enabled: true, kind: 'repository' },
      { id: 'runtime-v2', name: '运行时模块目录', baseUrl: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json', enabled: true, kind: 'manifest' },
      { id: 'npmmirror', name: 'npmmirror', baseUrl: 'https://registry.npmmirror.com', enabled: true, kind: 'registry' }
    ]
  },
  installation: {
    programRoot: 'C:\\Users\\Public\\Programs\\DeepBlueDeepSeekHarness',
    storageRoot: 'D:\\DeepSeek\\DeepBlueHarnessData',
    setupRequired: true,
    desktopShortcutReady: false,
    startMenuShortcutReady: false
  }
}
