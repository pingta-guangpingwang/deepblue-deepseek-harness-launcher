const RESOURCE_ID = /^[a-zA-Z0-9._:-]{1,191}$/

export function parseFavoriteIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const ids = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
    const row = item as Record<string, unknown>
    const value = typeof row.resource_key === 'string' ? row.resource_key : typeof row.resourceKey === 'string' ? row.resourceKey : ''
    return value.trim()
  }).filter((id) => RESOURCE_ID.test(id))
  return [...new Set(ids)].slice(0, 500)
}

export function validFavoriteId(value: string): boolean {
  return RESOURCE_ID.test(value)
}
