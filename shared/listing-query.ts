import type { ListingQuery, MediaItem } from './contracts'

// One predicate/order for main-process scans and the renderer's selection order. Existing media
// adapters own pagination; this only interprets the metadata they already returned.
export function matchesListing(item: MediaItem, query: ListingQuery): boolean {
  const dated = query.since !== undefined || query.before !== undefined
  if (query.keyword && !item.title.toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase())) return false
  if (dated && (item.publishedAt === undefined || query.since !== undefined && item.publishedAt < query.since || query.before !== undefined && item.publishedAt >= query.before)) return false
  if (query.kind === 'video' && item.kind === 'image') return false
  if (query.kind === 'image' && item.kind !== 'image' && !item.thumbnail?.startsWith('http')) return false
  if ((query.durationMin !== undefined || query.durationMax !== undefined) && (item.duration === undefined || query.durationMin !== undefined && item.duration < query.durationMin || query.durationMax !== undefined && item.duration > query.durationMax)) return false
  return true
}

export function sortListing(items: MediaItem[], sort: ListingQuery['sort']): MediaItem[] {
  return sort === 'reverse' ? [...items].reverse() : items
}
