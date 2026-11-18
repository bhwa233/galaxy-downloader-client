import type { EmbeddedBrowser } from './browser'
import type { ListingEntry, ListingOwner } from './listings/types'
import { subscriptionPlatforms, type SubscriptionPlatform, type SubscriptionSource, type SubscriptionType } from '../../shared/subscriptions'
import { i18n } from '../../shared/i18n'

export type SourceIdentity = Pick<SubscriptionSource, 'platform' | 'accountId' | 'url' | 'name' | 'avatar'>
export type SubscriptionEntry = Pick<ListingEntry, 'id' | 'url' | 'title' | 'thumbnail' | 'duration' | 'publishedAt'> & { type: SubscriptionType }
export type SubscriptionStream = { key: string; url: string; type?: SubscriptionType }
export type SubscriptionPage = { entries: SubscriptionEntry[]; hasMore: boolean; owner?: ListingOwner }
export type ResolvedSubscription = { source: SourceIdentity; pages: Record<string, SubscriptionPage>; aliases?: string[] }
type Platform = {
  identify(url: URL): { id: string; url: string } | undefined
  streams(source: SourceIdentity, types: SubscriptionType[]): SubscriptionStream[]
  canonical(source: SourceIdentity, owner?: ListingOwner): SourceIdentity
}

// Request handling is already owned by the listing adapters. This registry supplies only account
// identity and which of their lists a subscription watches; the scheduler does not branch on sites.
const platforms: Record<SubscriptionPlatform, Platform> = {
  bilibili: {
    identify(url) {
      const id = url.hostname === 'space.bilibili.com' ? /^\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] : undefined
      return id ? { id, url: 'https://space.bilibili.com/' + id } : undefined
    },
    streams: source => [{ key: 'uploads', url: source.url }],
    canonical: (source, owner) => ({ ...source, name: owner?.name || source.name, avatar: owner?.avatar || source.avatar }),
  },
  douyin: {
    identify(url) {
      const id = ['www.douyin.com', 'douyin.com'].includes(url.hostname) ? /^\/user\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] : undefined
      return id && id !== 'self' ? { id, url: 'https://www.douyin.com/user/' + id } : undefined
    },
    streams: source => [{ key: 'uploads', url: source.url }],
    canonical: (source, owner) => ({ ...source, name: owner?.name || source.name, avatar: owner?.avatar || source.avatar }),
  },
  youtube: {
    identify(url) {
      const id = ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)
        ? /^\/(@[^/]+|channel\/[A-Za-z0-9_-]+|user\/[^/]+|c\/[^/]+)(?:\/|$)/.exec(url.pathname)?.[1] : undefined
      return id ? { id, url: 'https://www.youtube.com/' + id } : undefined
    },
    streams: (source, types) => types.map(type => ({ key: type, type, url: source.url + (type === 'shorts' ? '/shorts' : '/videos') })),
    canonical(source, owner) {
      const id = owner?.id || (source.accountId.startsWith('channel/') ? source.accountId.slice(8) : '')
      if (!/^UC[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error(i18n.t('subscriptions:errors.channelId'))
      return { ...source, accountId: id, url: 'https://www.youtube.com/channel/' + id, name: owner?.name || source.name, avatar: owner?.avatar || source.avatar }
    },
  },
}

export interface SubscriptionReader {
  identify(input: string): SourceIdentity
  resolve(input: string, signal: AbortSignal): Promise<ResolvedSubscription>
  streams(source: SourceIdentity, types: SubscriptionType[]): SubscriptionStream[]
  page(source: SourceIdentity, stream: SubscriptionStream, page: number, signal: AbortSignal): Promise<SubscriptionPage>
}

export class CreatorSubscriptionReader implements SubscriptionReader {
  constructor(private browser: EmbeddedBrowser) {}
  streams(source: SourceIdentity, types: SubscriptionType[]): SubscriptionStream[] {
    return platforms[source.platform].streams(source, types)
  }
  identify(input: string): SourceIdentity {
    let url: URL
    try { url = new URL(input.trim()) } catch { throw new Error(i18n.t('subscriptions:errors.profileUrl')) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(i18n.t('subscriptions:errors.profileUrl'))
    let source: SourceIdentity | undefined
    for (const [platform, adapter] of Object.entries(platforms)) {
      const found = adapter.identify(url)
      if (found) { source = { platform: platform as SubscriptionPlatform, accountId: found.id, url: found.url, name: found.id }; break }
    }
    if (!source) throw new Error(i18n.t('subscriptions:errors.profileUrl'))
    return source
  }
  async resolve(input: string, signal: AbortSignal): Promise<ResolvedSubscription> {
    let source = this.identify(input)
    const original = source.url
    const pages: Record<string, SubscriptionPage> = {}
    for (const stream of this.streams(source, [...subscriptionPlatforms[source.platform].types])) {
      const page = await this.page(source, stream, 1, signal)
      pages[stream.key] = page
      source = platforms[source.platform].canonical(source, page.owner)
    }
    return { source, pages, aliases: [original] }
  }
  async page(source: SourceIdentity, stream: SubscriptionStream, page: number, signal: AbortSignal): Promise<SubscriptionPage> {
    const listing = await this.browser.inspectProfile(stream.url, page, undefined, signal)
    if (!listing || listing.kind !== 'profile') throw new Error(i18n.t('subscriptions:errors.listingUnavailable'))
    const entries = listing.groups.flatMap(group => group.entries).flatMap(entry => {
      if (!entry.url.startsWith('https://')) return []
      const type = stream.type || (entry.kind === 'image' ? 'image' : 'video')
      // A missing Shorts tab can fall back to the channel's videos. Those are not Shorts.
      if (stream.type === 'shorts' && !new URL(entry.url).pathname.startsWith('/shorts/')) return []
      return [{ id: entry.id, title: entry.title, url: entry.url, thumbnail: entry.thumbnail?.startsWith('https://') ? entry.thumbnail : undefined,
        duration: entry.duration, publishedAt: entry.publishedAt, type }]
    })
    return { entries, hasMore: listing.groups.some(group => group.pagination.hasMore) && (stream.type !== 'shorts' || entries.length > 0), owner: listing.owner || (entries.length ? { id: source.accountId, name: listing.groups.flatMap(group => group.entries).find(entry => entry.author)?.author || source.name } : undefined) }
  }
}
