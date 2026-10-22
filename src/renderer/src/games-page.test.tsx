import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GamesPage } from './App'
import { mockSnapshot } from './mock'

describe('games page', () => {
  it('shows a fixed Shenlan learning link and labels hosted trials as in-launcher play', () => {
    const snapshot = structuredClone(mockSnapshot)
    snapshot.launcherVersion = '0.10.40'
    snapshot.discovery.games = [{
      slug: 'fixture-game', title: '深蓝试玩', summary: '测试游戏', category: 'arcade', tags: [], featured: false,
      loginRequired: false, url: 'https://shenlanai.com/ai-games/player.html?slug=fixture-game', mode: 'hosted_playable', sourceName: '深蓝AI游戏工坊'
    }]
    const html = renderToStaticMarkup(createElement(GamesPage, { snapshot, busy: '', onRefresh: () => {}, onPlay: () => {} }))
    expect(html).toContain('href="https://shenlanai.com/ai-games/"')
    expect(html).toContain('去深蓝试玩学习')
    expect(html).toContain('启动器内试玩')
    expect(html).not.toContain('登录并试玩')
  })

  it('keeps the learning link available and blocks native play on an older kernel', () => {
    const snapshot = structuredClone(mockSnapshot)
    snapshot.launcherVersion = '0.10.39'
    snapshot.discovery.games = [{
      slug: 'fixture-game', title: '深蓝试玩', summary: '测试游戏', category: 'arcade', tags: [], featured: false,
      loginRequired: false, url: 'https://shenlanai.com/ai-games/player.html?slug=fixture-game', mode: 'hosted_playable', sourceName: '深蓝AI游戏工坊'
    }, {
      slug: 'official-game', title: '官网体验', summary: '外部官网游戏', category: 'story', tags: [], featured: false,
      loginRequired: false, url: 'https://example.com/game', mode: 'external_playable', sourceName: '精选官网'
    }]
    const html = renderToStaticMarkup(createElement(GamesPage, { snapshot, busy: '', onRefresh: () => {}, onPlay: () => { throw new Error('older kernel must not invoke native play') } }))
    expect(html).toContain('href="https://shenlanai.com/ai-games/"')
    expect(html).toContain('更新启动器到 0.10.40 后')
    expect(html).toContain('更新启动器后试玩')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('启动器内试玩')
    expect(html).toContain('前往官网试玩')
  })
})
