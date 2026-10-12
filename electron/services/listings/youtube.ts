import { i18n } from '../../../shared/i18n'
import { countOf, seconds } from './text'
import { onePage, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'

// One continuation of the 影片 grid. The page asks for the same number on its own scrolls.
const PAGE_SIZE = 30
// Only used when the channel page withholds its own version; the endpoint rejects a request with none.
const CLIENT_VERSION = '2.20240304.00.00'
// The listing is read in English so counts arrive as '1,234 views' rather than in a locale this
// process would have to learn: the numbers are the same either way.
const LANGUAGE = { hl: 'en', gl: 'US' }
const TABS = ['videos', 'shorts', 'streams', 'playlists', 'featured', 'community', 'about']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// A renderer writes its text either as one string or as a list of runs that have to be joined.
function textOf(value: unknown): string {
  if (!isRecord(value)) return ''
  if (typeof value.simpleText === 'string') return value.simpleText
  return Array.isArray(value.runs) ? value.runs.map(run => isRecord(run) && typeof run.text === 'string' ? run.text : '').join('') : ''
}

const at = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((node, key) => isRecord(node) ? node[key] : undefined, value)
const listAt = (value: unknown, ...keys: string[]): Record<string, unknown>[] => { const found = at(value, ...keys); return Array.isArray(found) ? found.filter(isRecord) : [] }
const stringAt = (value: unknown, ...keys: string[]): string => { const found = at(value, ...keys); return typeof found === 'string' ? found : '' }

// The widest picture on offer, whether the shape lists it as a thumbnail or as an image source.
function widest(candidates: Record<string, unknown>[]): string | undefined {
  const best = [...candidates].sort((first, second) => Number(second.width || 0) - Number(first.width || 0))[0]
  const address = typeof best?.url === 'string' ? best.url : ''
  return address ? address.replace(/^\/\//, 'https://') : undefined
}

// The current channel grid: every card is a view model rather than the renderer the older tabs and
// search results still use. Both shapes appear in the same responses, so both are read.
export function lockupEntry(lockup: Record<string, unknown>): ListingEntry | undefined {
  const type = stringAt(lockup, 'contentType')
  if (type && !/VIDEO|SHORTS/.test(type)) return undefined
  const id = stringAt(lockup, 'contentId').trim()
  if (!id) return undefined
  const metadata = at(lockup, 'metadata', 'lockupMetadataViewModel')
  // Counts and the relative publish time share one row, told apart by what they say rather than by order.
  const parts = listAt(metadata, 'metadata', 'contentMetadataViewModel', 'metadataRows')
    .flatMap(row => listAt(row, 'metadataParts')).map(part => stringAt(part, 'text', 'content'))
  const badges = listAt(lockup, 'contentImage', 'thumbnailViewModel', 'overlays')
    .flatMap(overlay => listAt(overlay, 'thumbnailBottomOverlayViewModel', 'badges')).map(badge => stringAt(badge, 'thumbnailBadgeViewModel', 'text'))
  return {
    id, url: `https://www.youtube.com/watch?v=${id}`,
    // The grid is given titles already cut to its own width, so a long one arrives ending in '...'.
    title: stringAt(metadata, 'title', 'content').trim() || i18n.t('errors:youtube.video', { id }),
    thumbnail: widest(listAt(lockup, 'contentImage', 'thumbnailViewModel', 'image', 'sources')),
    kind: 'video',
    duration: seconds(badges.find(badge => /^\d+(:\d+)+$/.test(badge))),
    views: countOf(parts.find(part => /view|watch/i.test(part))),
    // The rest of the row is a relative time ('4 days ago'), which is not a date this client can claim.
  }
}

// The 短片 tab has a view model of its own: no length, a title and a count, and a /shorts address.
export function shortsEntry(lockup: Record<string, unknown>): ListingEntry | undefined {
  const endpoint = at(lockup, 'onTap', 'innertubeCommand', 'reelWatchEndpoint')
  const id = (stringAt(endpoint, 'videoId') || stringAt(lockup, 'entityId').split('-').pop() || '').trim()
  if (!id) return undefined
  const overlay = at(lockup, 'overlayMetadata')
  return {
    id, url: `https://www.youtube.com/shorts/${id}`,
    title: stringAt(overlay, 'primaryText', 'content').trim() || i18n.t('errors:youtube.short', { id }),
    thumbnail: widest(listAt(lockup, 'thumbnailViewModel', 'image', 'sources')) || widest(listAt(endpoint, 'thumbnail', 'thumbnails')),
    kind: 'video',
    views: countOf(stringAt(overlay, 'secondaryText', 'content')),
  }
}

export function entryOf(renderer: Record<string, unknown>): ListingEntry | undefined {
  const id = typeof renderer.videoId === 'string' ? renderer.videoId.trim() : ''
  if (!id) return undefined
  return {
    id, url: `https://www.youtube.com/watch?v=${id}`,
    title: (textOf(renderer.title) || textOf(renderer.headline)).trim() || i18n.t('errors:youtube.video', { id }),
    thumbnail: widest(listAt(renderer, 'thumbnail', 'thumbnails')),
    kind: 'video',
    // A live stream has no length and reports who is watching rather than who has watched.
    duration: seconds(textOf(renderer.lengthText)),
    views: countOf(textOf(renderer.viewCountText) || textOf(renderer.shortViewCountText)),
    author: textOf(renderer.ownerText).trim() || textOf(renderer.shortBylineText).trim() || undefined,
    // 'publishedTimeText' is relative ('3 years ago'), which is not a date this client can claim.
  }
}

// Both routes read the same renderers: the ones baked into the channel page, and the ones the page
// receives later from its own continuation requests. The token is where the next page hides.
export function harvest(node: unknown, sink: Map<string, ListingEntry>): string | undefined {
  let token: string | undefined
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (!isRecord(value)) return
    const video = value.videoRenderer ?? value.gridVideoRenderer
    if (isRecord(video)) { const entry = entryOf(video); if (entry) sink.set(entry.id, entry); return }
    const lockup = value.lockupViewModel
    if (isRecord(lockup)) { const entry = lockupEntry(lockup); if (entry) sink.set(entry.id, entry); return }
    const short = value.shortsLockupViewModel
    if (isRecord(short)) { const entry = shortsEntry(short); if (entry) sink.set(entry.id, entry); return }
    const continuation = value.continuationItemRenderer
    if (isRecord(continuation)) {
      const endpoint = isRecord(continuation.continuationEndpoint) ? continuation.continuationEndpoint : undefined
      const command = endpoint && isRecord(endpoint.continuationCommand) ? endpoint.continuationCommand : undefined
      if (typeof command?.token === 'string') token = command.token
      return
    }
    for (const child of Object.values(value)) walk(child)
  }
  walk(node)
  return token
}

// The page ships its data as a JavaScript assignment, so the object is read by balancing its braces:
// a regular expression would end the object early at the first video title containing '};'.
export function embeddedJson(html: string, name: string): unknown {
  const marker = html.indexOf(`${name} =`)
  const start = marker < 0 ? -1 : html.indexOf('{', marker)
  if (start < 0) return undefined
  let depth = 0; let quoted = false; let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (char === '{') depth += 1
    else if (char === '}' && (depth -= 1) === 0) {
      try { return JSON.parse(html.slice(start, index + 1)) } catch { return undefined }
    }
  }
  return undefined
}

// A channel page carries continuation tokens for several of its shelves, and the last one found is not
// the grid's. Both routes therefore read from the grid itself: its rows on the first page, and the
// rows a continuation appends after that.
function gridOf(data: unknown): unknown {
  const tabs = listAt(data, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs')
  const selected = tabs.find(tab => at(tab, 'tabRenderer', 'selected') === true) || tabs[0]
  return at(selected, 'tabRenderer', 'content', 'richGridRenderer', 'contents') ?? data
}

function appendedOf(payload: unknown): unknown {
  const items = listAt(payload, 'onResponseReceivedActions')
    .map(action => at(action, 'appendContinuationItemsAction', 'continuationItems')).find(Array.isArray)
  return items ?? payload
}

function channelOf(data: unknown): string | undefined {
  const metadata = isRecord(data) && isRecord(data.metadata) ? data.metadata.channelMetadataRenderer : undefined
  const title = isRecord(metadata) && typeof metadata.title === 'string' ? metadata.title.trim() : ''
  return title || undefined
}

const handleOf = (url: URL) => /^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)/.exec(url.pathname)?.[1]

// What the channel page told us, kept while that listing is the one being read: the API key and client
// version it carries, its name, and the continuation token each page ended on. 'tokens.get(n)' is the
// token that fetches page n + 1. One listing at a time is all that can be on screen, so a second one
// replaces the first rather than accumulating.
let walked: { key: string; api?: string; version: string; channel?: string; tokens: Map<number, string> } | undefined

export const youtube: ProfileAdapter = {
  id: 'youtube',
  matches(url) {
    return /(^|\.)youtube\.com$/.test(url.hostname) && Boolean(handleOf(url))
  },
  // A channel opens on 首页, a trailer and a few shelves; /videos is the plain listing of its uploads.
  entryUrl(url) {
    const target = new URL(url.href)
    const handle = handleOf(target)
    const tab = target.pathname.slice((handle || '').length + 1).replace(/^\/|\/$/g, '')
    if (handle && !TABS.includes(tab)) target.pathname = `/${handle}/videos`
    return target.href
  },
  async fetchPage({ url, page, fetch, signal }: PageRequest): Promise<ListingPage> {
    const address = new URL(this.entryUrl(url))
    for (const [key, value] of Object.entries(LANGUAGE)) address.searchParams.set(key, value)
    if (walked?.key !== address.href) walked = { key: address.href, version: CLIENT_VERSION, tokens: new Map() }
    const held = walked
    const entries = new Map<string, ListingEntry>()
    const continuation = async (from: string) => {
      const response = await fetch(`https://www.youtube.com/youtubei/v1/browse${held.api ? `?key=${held.api}` : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, referrer: address.href, signal,
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: held.version, ...LANGUAGE } }, continuation: from }),
      })
      return harvest(appendedOf(await response.json()), entries)
    }
    // The token a page ended on is the whole of what the next page needs, and the channel page's key,
    // version and name do not change while the listing is being read. So a step forward is one request,
    // and only a first read or a jump into an unread part pays for the channel page and the walk.
    const resumed = page > 1 ? held.tokens.get(page - 1) : undefined
    let token: string | undefined
    if (resumed) token = await continuation(resumed)
    else {
      const html = await (await fetch(address.href, { signal })).text()
      const data = embeddedJson(html, 'ytInitialData')
      if (!data) throw new Error(i18n.t('errors:youtube.noData'))
      held.api = /"INNERTUBE_API_KEY":"([\w-]+)"/.exec(html)?.[1]
      held.version = /"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/.exec(html)?.[1] || CLIENT_VERSION
      held.channel = channelOf(data)
      token = harvest(gridOf(data), entries)
      // Every page before the requested one is paid for, then dropped: only the page asked for is shown.
      for (let reached = 1; reached < page; reached += 1) {
        if (!token) return onePage('videos', undefined, [], { index: page, size: PAGE_SIZE, hasMore: false })
        held.tokens.set(reached, token)
        entries.clear()
        token = await continuation(token)
      }
    }
    if (token) held.tokens.set(page, token)
    const channel = held.channel
    // A channel listing leaves the owner off every row, because the whole page is one owner.
    // 短片 arrive in larger batches than 影片, so the page reports what it actually held.
    return onePage('videos', channel ? i18n.t('errors:youtube.videos', { channel }) : undefined,
      [...entries.values()].map(entry => ({ ...entry, author: entry.author || channel })),
      { index: page, size: entries.size || PAGE_SIZE, hasMore: Boolean(token) })
  },
}
