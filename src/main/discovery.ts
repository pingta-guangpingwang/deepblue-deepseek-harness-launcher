import type {
  DiscoveryHubState,
  LauncherCareerItem,
  LauncherGameItem,
  LauncherNewsDetail,
  LauncherNewsItem,
  LauncherResourceItem
} from '../shared/types'

const SITE = 'https://ailishishu.com'
const NEWS_URL = `${SITE}/ailishishu-stats/api/news.php?limit=30&compact=1`
const LIVE_GAMES_URL = `${SITE}/ailishishu-stats/api/games.php?action=list&limit=100`
const GLOBAL_GAMES_URL = `${SITE}/games/data/global-ai-games.json`
const SHOWCASE_URL = `${SITE}/games/data/global-ai-game-showcase.json`
const CAREERS_URL = `${SITE}/ailishishu-stats/api/v1/careers.php?limit=80`
const RESOURCE_URL = `${SITE}/ailishishu-stats/api/v1/resources.php?sort=heat&limit=100&type=`
const TOOL_TYPES = ['ai_native_tool', 'software_tool', 'workflow_platform'] as const
const RESOURCE_TYPES = ['prompt', 'skill', 'workflow', 'knowledge_base', 'agent'] as const

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringList(value: unknown, limit = 8): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean).slice(0, limit) : []
}

function safeHttps(value: unknown, fallback = ''): string {
  const candidate = text(value, fallback)
  if (!candidate) return ''
  try {
    const url = new URL(candidate, SITE)
    return url.protocol === 'https:' ? url.toString() : fallback
  } catch {
    return fallback
  }
}

function repositoryUrl(value: unknown): string | undefined {
  const repo = text(value)
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) return undefined
  return `https://github.com/${repo}`
}

function newsItem(value: unknown): LauncherNewsItem | undefined {
  const row = record(value)
  const id = text(row.id)
  const title = text(row.title)
  if (!id || !title) return undefined
  const source = record(row.source)
  return {
    id,
    title,
    summary: text(row.summary, '打开原始报道查看完整内容。'),
    category: text(row.category, 'industry'),
    publishedAt: text(row.publishedAt),
    sourceCount: number(row.sourceCount),
    heat: number(row.heat),
    url: safeHttps(row.sourceUrl, safeHttps(source.url, `${SITE}/news/`)),
    sourceName: text(row.source, text(source.name, text(row.sourceName, '公开来源'))),
    trustStatus: text(row.trustStatus) || undefined
  }
}

function liveGame(value: unknown): LauncherGameItem | undefined {
  const row = record(value)
  const slug = text(row.slug)
  const title = text(row.title)
  if (!slug || !title || !/^[a-z0-9-]{2,80}$/.test(slug)) return undefined
  const creator = record(row.creator)
  return {
    slug,
    title,
    summary: text(row.shortDescription, text(row.longDescription, '登录后开始试玩。')),
    coverUrl: safeHttps(row.coverUrl) || undefined,
    category: text(row.category, 'creative'),
    tags: stringList(row.tags, 5),
    featured: Boolean(row.editorReview) || slug === 'yugong-yishan',
    loginRequired: true,
    url: `${SITE}/games/player.html?slug=${encodeURIComponent(slug)}`,
    mode: 'hosted_playable',
    sourceName: text(creator.name, 'AI历史书游戏创作者')
  }
}

function globalGame(value: unknown): LauncherGameItem | undefined {
  const row = record(value)
  const source = record(row.source)
  const review = record(row.review)
  const slug = text(row.slug)
  const title = text(row.title)
  if (!slug || !title || !/^[a-z0-9-]{2,80}$/.test(slug)) return undefined
  return {
    slug,
    title,
    summary: text(row.shortDescription, text(row.longDescription, 'AI 游戏项目。')),
    coverUrl: `${SITE}/games/assets/global/${encodeURIComponent(slug)}.webp`,
    category: text(row.category, 'creative'),
    tags: stringList(row.tags, 5),
    featured: Boolean(review.score) || Boolean(row.editorialException),
    loginRequired: true,
    url: `${SITE}/games/player.html?slug=${encodeURIComponent(slug)}`,
    mode: 'hosted_playable',
    sourceName: text(source.repo, '全球 AI 游戏策展组'),
    stars: number(source.stars),
    sourceUrl: safeHttps(source.url) || repositoryUrl(source.repo)
  }
}

function showcaseGame(value: unknown): LauncherGameItem | undefined {
  const row = record(value)
  const source = record(row.source)
  const official = record(row.official)
  const review = record(row.review)
  const slug = text(row.slug)
  const title = text(row.title)
  const rawMode = text(row.mode)
  if (!slug || !title || !/^[a-z0-9-]{2,80}$/.test(slug)) return undefined
  const mode: LauncherGameItem['mode'] = rawMode === 'external_playable' || rawMode === 'official_landmark' ? rawMode : 'source_only'
  const destination = mode === 'external_playable'
    ? safeHttps(row.playUrl, `${SITE}/games/?project=${encodeURIComponent(slug)}#projectDetail`)
    : `${SITE}/games/?project=${encodeURIComponent(slug)}#projectDetail`
  return {
    slug,
    title,
    summary: text(row.shortDescription, text(row.longDescription, '打开项目说明查看玩法与来源。')),
    coverUrl: safeHttps(row.coverUrl) || undefined,
    category: text(row.category, 'creative'),
    tags: stringList(row.tags, 5),
    featured: number(review.score) >= 8,
    loginRequired: false,
    url: destination,
    mode,
    sourceName: text(source.repo, text(official.provider, '公开项目')),
    stars: number(source.stars),
    sourceUrl: safeHttps(source.url) || repositoryUrl(source.repo) || safeHttps(official.url)
  }
}

function resourceItem(value: unknown): LauncherResourceItem | undefined {
  const row = record(value)
  const id = text(row.id)
  const title = text(row.title)
  if (!id || !title) return undefined
  const capabilities = stringList(row.capabilities, 5)
  const useCases = stringList(row.useCases, 3)
  const source = record(row.source)
  const links = record(row.links)
  const metrics = record(row.publicMetrics)
  const metricsRepository = text(metrics.repository)
  const repository = safeHttps(links.repository) || repositoryUrl(metricsRepository) || (metricsRepository.startsWith('https://') ? safeHttps(metricsRepository) : '') || safeHttps(source.url)
  return {
    id,
    type: text(row.type, 'ai_native_tool'),
    title,
    author: text(row.author, 'AI历史书编辑部'),
    summary: text(row.summary, useCases[0] || '打开条目查看用途与来源。'),
    firstStep: text(row.firstStep, useCases[0] || '先用一个真实任务验证。'),
    capabilities,
    difficulty: text(row.difficulty, '入门'),
    pricingMode: text(row.pricingMode, 'unknown'),
    url: safeHttps(row.url) || undefined,
    canonicalUrl: `${SITE}/tools/?resource=${encodeURIComponent(id)}`,
    editorialScore: number(row.editorialScore),
    popularityScore: number(row.popularityScore),
    rating: number(row.rating),
    ratingCount: number(row.ratingCount),
    stars: number(metrics.stars) || undefined,
    forks: number(metrics.forks) || undefined,
    openIssues: number(metrics.openIssues) || undefined,
    repositoryUrl: repository || undefined,
    editorialComment: text(row.editorialComment) || undefined,
    installPaths: stringList(row.installPaths, 12),
    longDescription: text(row.longDescription) || undefined,
    executionMode: text(row.executionMode) || undefined,
    modelRequirement: text(row.modelRequirement) || undefined,
    tokenEstimate: text(row.tokenEstimate) || undefined,
    inputs: stringList(row.inputs, 20),
    steps: stringList(row.steps, 30),
    outcomes: stringList(row.outcomes, 20),
    limitations: text(row.limitations) || undefined,
    promptText: text(row.promptText) || undefined,
    skillContent: text(row.skillContent) || undefined,
    workflowBlueprint: row.workflowBlueprint ?? undefined,
    verifiedAt: text(row.verifiedAt) || undefined,
    sourceName: text(source.name) || undefined,
    sourceUrl: safeHttps(source.url) || undefined
  }
}

function careerItem(value: unknown): LauncherCareerItem | undefined {
  const row = record(value)
  const id = text(row.id)
  const title = text(row.title)
  if (!id || !title) return undefined
  const tasks = Array.isArray(row.tasks) ? row.tasks.map((task) => {
    const item = record(task)
    return { id: text(item.id), title: text(item.title), summary: text(item.summary) }
  }).filter((task) => task.id && task.title).slice(0, 8) : []
  return {
    id,
    industryId: text(row.industryId),
    industryName: text(row.industryName, '其他职业'),
    title,
    summary: text(row.summary),
    tasks
  }
}

async function json(url: string, signal: AbortSignal, requireOk = true): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json', 'User-Agent': 'DeepBlue-DeepSeekHarness-Launcher/0.9' }
  })
  if (!response.ok) throw new Error(`${new URL(url).pathname} 返回 HTTP ${response.status}`)
  const body = await response.json() as unknown
  if (!body || typeof body !== 'object' || (requireOk && (body as { ok?: unknown }).ok !== true)) throw new Error('目录响应无效')
  return body as Record<string, unknown>
}

async function resourceDirectory(type: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const items: unknown[] = []
  let cursor = ''
  for (let page = 0; page < 5; page += 1) {
    const payload = await json(`${RESOURCE_URL}${encodeURIComponent(type)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal)
    if (Array.isArray(payload.data)) items.push(...payload.data)
    const pagination = record(payload.pagination)
    const nextCursor = text(pagination.nextCursor)
    if (pagination.hasMore !== true || !nextCursor || nextCursor === cursor) break
    cursor = nextCursor
  }
  return { ok: true, data: items }
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => { const value = key(item); if (!value || seen.has(value)) return false; seen.add(value); return true })
}

function previousOrEmpty(previous?: DiscoveryHubState): DiscoveryHubState {
  return previous || { status: 'loading', updatedAt: '', news: [], hotNews: [], games: [], tools: [], extensions: [], prompts: [], skills: [], workflows: [], knowledgeBases: [], agents: [], careers: [], totals: { games: 0, tools: 0, extensions: 0, prompts: 0, skills: 0, workflows: 0, knowledgeBases: 0, agents: 0, careers: 0 } }
}

export async function fetchDiscovery(previous?: DiscoveryHubState): Promise<DiscoveryHubState> {
  const old = previousOrEmpty(previous)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 18_000)
  const errors: string[] = []
  try {
    const requests = await Promise.allSettled([
      json(NEWS_URL, controller.signal),
      json(LIVE_GAMES_URL, controller.signal),
      json(GLOBAL_GAMES_URL, controller.signal, false),
      json(SHOWCASE_URL, controller.signal, false),
      json(CAREERS_URL, controller.signal),
      ...TOOL_TYPES.map((type) => resourceDirectory(type, controller.signal)),
      ...RESOURCE_TYPES.map((type) => resourceDirectory(type, controller.signal))
    ])
    const value = (index: number): Record<string, unknown> | undefined => {
      const result = requests[index]
      if (!result) { errors.push('目录结果缺失'); return undefined }
      if (result.status === 'fulfilled') return result.value
      errors.push(result.reason instanceof Error ? result.reason.message : '读取失败')
      return undefined
    }
    const news = value(0)
    const live = value(1)
    const global = value(2)
    const showcase = value(3)
    const careersPayload = value(4)
    const toolPayloads = TOOL_TYPES.map((_type, index) => value(5 + index)).filter(Boolean) as Record<string, unknown>[]
    const resourcePayloads = RESOURCE_TYPES.map((type, index) => ({ type, payload: value(5 + TOOL_TYPES.length + index) })).filter((entry) => Boolean(entry.payload)) as Array<{ type: typeof RESOURCE_TYPES[number]; payload: Record<string, unknown> }>

    const stream = news && Array.isArray(news.stream) ? news.stream.map(newsItem).filter((item): item is LauncherNewsItem => Boolean(item)).slice(0, 30) : old.news
    const hot = news && Array.isArray(news.hot) ? news.hot.map(newsItem).filter((item): item is LauncherNewsItem => Boolean(item)).slice(0, 10) : old.hotNews
    const games = unique([
      ...(live && Array.isArray(live.games) ? live.games.map(liveGame).filter((item): item is LauncherGameItem => Boolean(item)) : []),
      ...(global && Array.isArray(global.games) ? global.games.map(globalGame).filter((item): item is LauncherGameItem => Boolean(item)) : []),
      ...(showcase && Array.isArray(showcase.items) ? showcase.items.map(showcaseGame).filter((item): item is LauncherGameItem => Boolean(item)) : [])
    ], (item) => item.slug)
    const tools = unique(toolPayloads.flatMap((payload) => Array.isArray(payload.data) ? payload.data.map(resourceItem).filter((item): item is LauncherResourceItem => Boolean(item)) : []), (item) => item.id)
    const resourcesByType = new Map(resourcePayloads.map(({ type, payload }) => [type, unique(Array.isArray(payload.data) ? payload.data.map(resourceItem).filter((item): item is LauncherResourceItem => Boolean(item)) : [], (item) => item.id)]))
    const prompts = resourcesByType.get('prompt') || old.prompts
    const skills = resourcesByType.get('skill') || old.skills
    const workflows = resourcesByType.get('workflow') || old.workflows
    const knowledgeBases = resourcesByType.get('knowledge_base') || old.knowledgeBases
    const agents = resourcesByType.get('agent') || old.agents
    const extensions = unique([...skills, ...workflows, ...agents], (item) => item.id)
    const careers = careersPayload && Array.isArray(careersPayload.data) ? careersPayload.data.map(careerItem).filter((item): item is LauncherCareerItem => Boolean(item)) : old.careers
    const finalGames = games.length ? games : old.games
    const finalTools = tools.length ? tools : old.tools
    const finalExtensions = extensions.length ? extensions : old.extensions
    const finalCareers = careers.length ? careers : old.careers
    const hasContent = stream.length || finalGames.length || finalTools.length || finalExtensions.length || finalCareers.length
    return {
      status: hasContent ? 'ready' : 'offline',
      updatedAt: news ? text(news.updatedAt, new Date().toISOString()) : new Date().toISOString(),
      news: stream,
      hotNews: hot.length ? hot : [...stream].sort((a, b) => b.heat - a.heat).slice(0, 8),
      games: finalGames,
      tools: finalTools,
      extensions: finalExtensions,
      prompts,
      skills,
      workflows,
      knowledgeBases,
      agents,
      careers: finalCareers,
      totals: { games: finalGames.length, tools: finalTools.length, extensions: finalExtensions.length, prompts: prompts.length, skills: skills.length, workflows: workflows.length, knowledgeBases: knowledgeBases.length, agents: agents.length, careers: finalCareers.length },
      message: errors.length ? `部分在线目录暂未更新，已保留可用内容（${errors.length} 项读取失败）。` : undefined
    }
  } catch (error) {
    return {
      ...old,
      status: old.news.length || old.games.length || old.tools.length || old.careers.length ? 'ready' : 'offline',
      updatedAt: new Date().toISOString(),
      message: error instanceof Error && error.name === 'AbortError' ? '目录连接超时，已保留上次内容。' : '目录暂时不可用，已保留上次内容。'
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchNewsDetail(id: string): Promise<LauncherNewsDetail> {
  if (!/^[a-z0-9][a-z0-9._:-]{1,119}$/i.test(id)) throw new Error('新闻编号无效')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const payload = await json(`${SITE}/ailishishu-stats/api/news.php?story=${encodeURIComponent(id)}`, controller.signal)
    const row = record(payload.item)
    const item = newsItem(row)
    if (!item) throw new Error('新闻详情暂不可用')
    const sources = Array.isArray(row.sources) ? row.sources.map((entry) => record(entry)).map((source) => ({
      name: text(source.name, item.sourceName || '公开来源'),
      title: text(source.title, item.title),
      url: safeHttps(source.url, item.url),
      publishedAt: text(source.publishedAt, item.publishedAt),
      content: text(source.contentPreview, text(source.excerpt)),
      previewKind: text(source.previewKind)
    })).filter((source) => source.url).slice(0, 12) : []
    const primary = sources[0]
    const label = primary?.previewKind === 'article_extract'
      ? '来源公开正文线索'
      : primary?.previewKind === 'public_abstract'
        ? '来源公开摘要'
        : '新闻摘要'
    return {
      ...item,
      content: primary?.content || item.summary,
      contentLabel: label,
      sources: sources.map(({ name, title, url, publishedAt }) => ({ name, title, url, publishedAt }))
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('新闻详情读取超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchResourceDetail(id: string): Promise<LauncherResourceItem> {
  if (!/^[a-z0-9][a-z0-9._:-]{1,119}$/i.test(id)) throw new Error('资源编号无效')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const payload = await json(`${SITE}/ailishishu-stats/api/v1/resources.php?id=${encodeURIComponent(id)}&detail=1`, controller.signal)
    const row = record(payload.data)
    const item = resourceItem(row)
    if (!item) throw new Error('资源详情暂不可用')
    const skillContentPath = text(row.skillContentUrl)
    if (item.type === 'skill' && !item.skillContent && skillContentPath === `./skill-content/${id}.md`) {
      try {
        const response = await fetch(`${SITE}/tools/skill-content/${encodeURIComponent(id)}.md`, {
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
          headers: { Accept: 'text/markdown,text/plain;q=0.9', 'User-Agent': 'DeepBlue-DeepSeekHarness-Launcher/0.9' }
        })
        const length = Number(response.headers.get('content-length') || 0)
        if (response.ok && length <= 200_000) {
          const content = await response.text()
          if (content.length <= 200_000) item.skillContent = content
        }
      } catch {
        // The structured detail remains useful when the optional source file is unavailable.
      }
    }
    return item
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('资源详情读取超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function loadingDiscovery(previous?: DiscoveryHubState): DiscoveryHubState {
  const old = previousOrEmpty(previous)
  return { ...old, status: 'loading', message: undefined }
}
