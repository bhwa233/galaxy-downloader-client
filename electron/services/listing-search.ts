import type { ListingQuery, ListingSearchState, MediaGroup } from '../../shared/contracts'
import { matchesListing, sortListing } from '../../shared/listing-query'
import type { ParsePlan } from './parser'
import { sourceOf } from './listings/bilibili-collection'

type Session = { ids: string[]; pagination?: MediaGroup['pagination']; limited: boolean; nativeOrder?: boolean; reversed?: Session }

// Reuses Parser and each adapter's paced pagination. The cache belongs to a parse plan, so another
// URL or tab cannot reuse its cursors/results; changing filters reuses the pages already read.
export class ListingSearch {
  private sessions = new WeakMap<ParsePlan, Map<string, Session>>()
  private active = new WeakMap<ParsePlan, Map<string, Session>>()
  constructor(private read: (plan: ParsePlan, page: number, groupId: string, signal: AbortSignal, order?: 'reverse') => Promise<ParsePlan>) {}

  private session(plan: ParsePlan, groupId: string, original = false): Session {
    const current = this.active.get(plan)?.get(groupId)
    if (current && !original) return current
    let groups = this.sessions.get(plan)
    if (!groups) { groups = new Map(); this.sessions.set(plan, groups) }
    let held = groups.get(groupId)
    if (!held) {
      const group = plan.result.groups?.find(found => found.id === groupId)
      if (!group) throw new Error('Listing group expired')
      held = { ids: [...new Set(group.itemIds)], pagination: group.pagination, limited: Boolean(plan.result.truncated) }
      groups.set(groupId, held)
    }
    return held
  }

  async page(plan: ParsePlan, page: number, groupId: string, signal: AbortSignal): Promise<void> {
    const held = this.session(plan, groupId)
    if (page <= (held.pagination?.index ?? 1)) return
    const next = await this.read(plan, page, groupId, signal, held.nativeOrder ? 'reverse' : undefined)
    signal.throwIfAborted()
    const group = next.result.groups?.find(found => found.id === groupId)
    if (!group) { held.limited = true; return }
    const known = new Set(held.ids)
    const signatures = new Set(held.ids.map(id => { const item = plan.catalog.get(id); return item?.url || item?.mediaId || id }))
    const fresh = [...new Set(group.itemIds)].filter(id => { const item = next.catalog.get(id); const key = item?.url || item?.mediaId || id; if (known.has(id) || signatures.has(key)) return false; signatures.add(key); return true })
    for (const [id, item] of next.catalog) plan.catalog.set(id, item)
    for (const [id, source] of next.sources) plan.sources.set(id, source)
    const items = new Map(plan.result.items.map(item => [item.id, item]))
    for (const item of next.result.items) items.set(item.id, item)
    plan.result.items = [...items.values()]
    held.ids.push(...fresh)
    held.pagination = group.pagination ? { ...group.pagination, total: group.pagination.total ?? held.pagination?.total } : undefined
    // A repeated page, missing continuation, or an explicit truncation is partial, never success.
    held.limited ||= Boolean(next.result.truncated) || Boolean(group.pagination?.hasMore && (!fresh.length || group.pagination.index < page)) || Boolean(held.pagination && !held.pagination.hasMore && held.pagination.total !== undefined && held.ids.length < held.pagination.total)
    this.present(plan, groupId)
  }

  private present(plan: ParsePlan, groupId: string, query?: ListingQuery, status?: ListingSearchState['status']): void {
    const held = this.session(plan, groupId)
    const group = plan.result.groups!.find(found => found.id === groupId)!
    const applied = query || group.search?.query
    const all = held.ids.map(id => plan.catalog.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    const matching = applied ? all.filter(item => matchesListing(item, applied)) : all
    const search = applied ? {
      query: applied, status: status || group.search?.status || 'stopped', scanned: all.length,
      matched: matching.length, missingDates: all.filter(item => item.publishedAt === undefined).length,
      total: held.pagination?.total,
      nativeOrder: held.nativeOrder,
    } : undefined
    // New objects keep React's result references useful; credentials stay in plan.sources in main.
    plan.result = { ...plan.result, groups: plan.result.groups!.map(found => found.id !== groupId ? found : {
      ...found, allItemIds: [...new Set([...(found.allItemIds || found.itemIds), ...held.ids])], itemIds: sortListing(matching, held.nativeOrder ? 'original' : applied?.sort || 'original').map(item => item.id), pagination: held.pagination, search,
    }) }
  }

  async run(plan: ParsePlan, groupId: string, query: ListingQuery, signal: AbortSignal, changed: () => void, scan = true): Promise<void> {
    const original = this.session(plan, groupId, true)
    // Bilibili season reversal is a real server order (verified against the first and last entries),
    // so the latest end can be shown after one page. Its cache is separate from the original order.
    const native = query.sort === 'reverse' && original.pagination?.hasMore && sourceOf(new URL(plan.result.url))?.type === 'season'
    const held = native ? original.reversed ||= { ids: [], pagination: { index: 0, size: original.pagination!.size, total: original.pagination?.total, hasMore: true }, limited: false, nativeOrder: true } : original
    let views = this.active.get(plan)
    if (!views) { views = new Map(); this.active.set(plan, views) }
    views.set(groupId, held)
    const filtered = Boolean(query.keyword || query.since !== undefined || query.before !== undefined || query.kind !== 'all' || query.durationMin !== undefined || query.durationMax !== undefined)
    const state = () => held.limited ? 'limited' : held.pagination?.hasMore ? 'stopped' : 'completed'
    this.present(plan, groupId, query, scan && held.pagination?.hasMore ? 'running' : !scan && held.pagination?.hasMore && !held.limited ? 'ready' : state())
    changed()
    if (!scan) return
    try {
      if (native && held.pagination?.index === 0) await this.page(plan, 1, groupId, signal)
      if (native && !filtered) { this.present(plan, groupId, query, held.limited ? 'limited' : held.pagination?.hasMore ? 'ready' : 'completed'); return }
      // Automatic lists such as YouTube Mix have no finite end. Keep their partial status explicit.
      if (/\b(?:list=RD)/.test(plan.result.url)) held.limited = true
      while (held.pagination?.hasMore && !held.limited) {
        signal.throwIfAborted()
        await this.page(plan, held.pagination.index + 1, groupId, signal)
        this.present(plan, groupId, query, 'running')
        changed()
      }
      this.present(plan, groupId, query, state())
    } catch (error) {
      this.present(plan, groupId, query, signal.aborted ? 'stopped' : 'interrupted')
      throw error
    } finally { changed() }
  }
}
