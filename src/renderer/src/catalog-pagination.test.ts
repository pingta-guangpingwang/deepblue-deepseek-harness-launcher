import { describe, expect, it } from 'vitest'
import { catalogCapacity, catalogPageTokens } from './catalog-pagination'

describe('catalog pagination', () => {
  it('shows every page for short catalogs', () => {
    expect(catalogPageTokens(3, 6)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('keeps the first, nearby and last pages visible in a long catalog', () => {
    expect(catalogPageTokens(44, 88)).toEqual([1, 'start-gap', 42, 43, 44, 45, 46, 'end-gap', 88])
    expect(catalogPageTokens(1, 88)).toEqual([1, 2, 3, 4, 5, 6, 'end-gap', 88])
  })

  it('derives page capacity from both viewport width and height', () => {
    expect(catalogCapacity(1200, 550)).toBe(10)
    expect(catalogCapacity(740, 300)).toBe(3)
    expect(catalogCapacity(360, 520)).toBe(2)
  })
})
