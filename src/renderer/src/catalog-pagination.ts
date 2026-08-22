export type CatalogPageToken = number | 'start-gap' | 'end-gap'

export function catalogPageTokens(currentPage: number, pageCount: number): CatalogPageToken[] {
  if (pageCount <= 9) return Array.from({ length: pageCount }, (_, index) => index + 1)
  const pages = new Set([1, pageCount])
  for (let page = Math.max(2, currentPage - 2); page <= Math.min(pageCount - 1, currentPage + 2); page += 1) pages.add(page)
  if (currentPage <= 4) for (let page = 2; page <= 6; page += 1) pages.add(page)
  if (currentPage >= pageCount - 3) for (let page = pageCount - 5; page < pageCount; page += 1) pages.add(page)
  const ordered = [...pages].sort((left, right) => left - right)
  const tokens: CatalogPageToken[] = []
  ordered.forEach((page, index) => {
    const previous = ordered[index - 1]
    if (previous && page - previous > 1) tokens.push(previous === 1 ? 'start-gap' : 'end-gap')
    tokens.push(page)
  })
  return tokens
}

export function catalogCapacity(width: number, height: number): number {
  const columns = Math.max(1, Math.min(5, Math.floor((width + 12) / 232)))
  const rows = Math.max(1, Math.min(3, Math.floor((height + 12) / 262)))
  return columns * rows
}
