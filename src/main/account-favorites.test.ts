import { describe, expect, it } from 'vitest'
import { parseFavoriteIds, validFavoriteId } from './account-favorites'

describe('AI历史书 account favorites', () => {
  it('accepts the website collection envelope and removes invalid or duplicate ids', () => {
    expect(parseFavoriteIds({ items: [
      { resource_key: 'ai-tool-chatgpt' },
      { resourceKey: 'skill.code-review:v2' },
      { resource_key: 'ai-tool-chatgpt' },
      { resource_key: '../unsafe' },
      null
    ] })).toEqual(['ai-tool-chatgpt', 'skill.code-review:v2'])
  })

  it('uses the same bounded identifier contract for mutations', () => {
    expect(validFavoriteId('workflow:research.v1')).toBe(true)
    expect(validFavoriteId('')).toBe(false)
    expect(validFavoriteId('bad/id')).toBe(false)
  })
})
