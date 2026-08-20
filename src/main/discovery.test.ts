import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDiscovery, fetchNewsDetail, fetchResourceDetail } from './discovery'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('online Ailishishu directories', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('merges hosted games, website showcase, tools, extensions and all careers', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/news.php')) return Promise.resolve(response({ ok: true, stream: [{ id: 'n1', title: '新闻', summary: '摘要', sourceUrl: 'https://example.com', source: '公开来源' }], hot: [] }))
      if (url.includes('/games.php')) return Promise.resolve(response({ ok: true, games: [{ slug: 'hosted-one', title: '站内游戏', shortDescription: '可试玩', tags: [] }] }))
      if (url.includes('global-ai-games.json')) return Promise.resolve(response({ games: [{ slug: 'global-one', title: '全球游戏', shortDescription: '全球项目', tags: [], source: { repo: 'repo' } }] }))
      if (url.includes('global-ai-game-showcase.json')) return Promise.resolve(response({ items: [{ slug: 'showcase-one', title: '开源项目', shortDescription: '项目说明', tags: [], mode: 'source_only', source: { repo: 'repo2' } }] }))
      if (url.includes('/careers.php')) return Promise.resolve(response({ ok: true, data: Array.from({ length: 33 }, (_, index) => ({ id: `role-${index}`, title: `职业${index}`, industryName: '行业', tasks: [{ id: `task-${index}`, title: '任务', summary: '具体任务' }] })) }))
      const type = new URL(url).searchParams.get('type') || 'resource'
      return Promise.resolve(response({ ok: true, data: [{ id: `${type}-1`, type, title: type, summary: '真实目录条目', capabilities: ['能力'] }] }))
    }))

    const result = await fetchDiscovery()
    expect(result.status).toBe('ready')
    expect(result.games.map((item) => item.slug)).toEqual(['hosted-one', 'global-one', 'showcase-one'])
    expect(result.careers).toHaveLength(33)
    expect(result.tools).toHaveLength(3)
    expect(result.extensions).toHaveLength(3)
    expect(result.prompts[0]?.type).toBe('prompt')
    expect(result.skills[0]?.type).toBe('skill')
    expect(result.workflows[0]?.type).toBe('workflow')
    expect(result.knowledgeBases[0]?.type).toBe('knowledge_base')
    expect(result.agents[0]?.type).toBe('agent')
    expect(result.news[0]?.summary).toBe('摘要')
    expect(result.news[0]).not.toHaveProperty('whyImportant')
  })

  it('loads the same public article content used by the website reader', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({
      ok: true,
      item: {
        id: 'news-source-1', title: '来源一致的新闻', summary: '网站摘要', category: 'industry', publishedAt: '2026-08-19 10:00:00', sourceCount: 1,
        source: '官方来源', sourceUrl: 'https://example.com/news',
        sources: [{ name: '官方来源', title: '原始标题', url: 'https://example.com/news', publishedAt: '2026-08-19 10:00:00', previewKind: 'article_extract', contentPreview: '第一段公开正文。\n\n第二段公开正文。' }]
      }
    }))))
    const detail = await fetchNewsDetail('news-source-1')
    expect(detail.summary).toBe('网站摘要')
    expect(detail.content).toContain('第二段公开正文')
    expect(detail.contentLabel).toBe('来源公开正文线索')
    expect(detail.sources[0]?.url).toBe('https://example.com/news')
  })

  it('keeps the previous complete directory when every network request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const previous = await (async () => ({
      status: 'ready' as const,
      updatedAt: 'old',
      news: [], hotNews: [],
      games: [{ slug: 'kept', title: '保留游戏', summary: '缓存', category: 'game', tags: [], featured: false, loginRequired: false, url: 'https://ailishishu.com/games/', mode: 'source_only' as const }],
      tools: [], extensions: [], prompts: [], skills: [], workflows: [], knowledgeBases: [], agents: [], careers: [],
      totals: { games: 1, tools: 0, extensions: 0, prompts: 0, skills: 0, workflows: 0, knowledgeBases: 0, agents: 0, careers: 0 }
    }))()
    const result = await fetchDiscovery(previous)
    expect(result.games[0]?.slug).toBe('kept')
    expect(result.status).toBe('ready')
  })

  it('loads structured tool and Skill details for the native launcher sheet', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({
      ok: true,
      data: {
        id: 'skill-native-detail', type: 'skill', title: '资料整理 Skill', author: 'AI历史书编辑部',
        summary: '把资料变成可复用结构。', firstStep: '准备一份真实材料', capabilities: ['整理', '复核'],
        inputs: ['原始资料'], steps: ['识别范围', '结构化整理'], outcomes: ['可复用清单'],
        promptText: '请先标出不确定项。', skillContent: '# Skill\n逐条核对来源。', limitations: '重要结论必须人工核验。',
        rating: 4.8, ratingCount: 19, popularityScore: 91,
        publicMetrics: { repository: 'anthropics/skills', stars: 166636, forks: 19843 },
        editorialComment: '适合先在低风险任务验证。',
        source: { name: 'AI历史书', url: 'https://ailishishu.com/' }
      }
    }))))
    const item = await fetchResourceDetail('skill-native-detail')
    expect(item.type).toBe('skill')
    expect(item.steps).toEqual(['识别范围', '结构化整理'])
    expect(item.skillContent).toContain('逐条核对')
    expect(item.sourceUrl).toBe('https://ailishishu.com/')
    expect(item.repositoryUrl).toBe('https://github.com/anthropics/skills')
    expect(item.stars).toBe(166636)
    expect(item.rating).toBe(4.8)
  })

  it('loads a complete SKILL.md only from the matching trusted site path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, data: {
        id: 'public-skill-safe', type: 'skill', title: '安全 Skill', author: '编辑部', summary: '摘要',
        skillContent: null, skillContentUrl: './skill-content/public-skill-safe.md'
      } }))
      .mockResolvedValueOnce(new Response('# Safe Skill\n\n完整步骤。', { status: 200, headers: { 'content-length': '24' } }))
    vi.stubGlobal('fetch', fetchMock)
    const item = await fetchResourceDetail('public-skill-safe')
    expect(item.skillContent).toContain('完整步骤')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://ailishishu.com/tools/skill-content/public-skill-safe.md')
  })
})
