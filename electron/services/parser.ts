import { randomUUID } from 'node:crypto'
import type { MediaGroup, MediaItem, MediaResult } from '../../shared/contracts'
import { Engine, type Cookie, type EngineProfile, type EngineRequest } from './engine'
import type { EmbeddedBrowser } from './browser'
import { findAdapter } from './listings'
import { LoginRequired } from './login'
import { logger } from './log'
import { SHORTENERS, flattenEntries, isCookieFailure, mediaResult, needsBrowser, normalizeUrl, platformOf, type RawInfo } from './media'

const log = logger('parser')

// 'collection' is not a file: it is a whole collection picked from a catalogue, expanded into its
// items when the download is asked for (see Parser.expand). It never reaches the queue as itself.
export type DownloadSource = { kind: 'engine'; request: EngineRequest } | { kind: 'http'; url: string; cookies: Cookie[]; headers: Record<string, string>; extension: string } | { kind: 'collection'; url: string }
// 'result' holds the page on screen; 'catalog' keeps every item seen so far, so a selection made on an
// earlier page still resolves when the download is finally started.
export type ParsePlan = { result: MediaResult; sources: Map<string, DownloadSource>; catalog: Map<string, MediaItem> }
// 'page' and 'group' say which page of which tab is wanted; 'single' asks for the one piece of media
// the address names and nothing around it, which is what a queued job re-resolving itself wants: its
// URL is one post out of a listing, and expanding that listing again would download all of it.
export type ParseOptions = { browserOnly?: boolean; page?: number; group?: string; single?: boolean }
// How many items of a listing are kept. A collection of several hundred still fits; the cap is there so
// one parse cannot fill the window with more rows than anyone picks from.
const MOST = 500

// Creator home pages are listings of posts, so they take the browser listing route instead of yt-dlp.
// Only where an adapter knows the platform's listing API: that route asks the API from inside a page
// and has nothing else to offer, so a platform without one is better served by yt-dlp than by a route
// that would open a window and find nothing to call. 抖音 is the one that lands there today.
export function isProfileUrl(url: string): boolean {
  return Boolean(findAdapter(url))
}

// Listings the client will not walk. Saying so is kinder than letting the address fall through to a
// route that was never going to serve it and failing there for a reason that reads like a login problem.
const REFUSED: { host: RegExp; path: RegExp; message: string }[] = [
  { host: /(^|\.)xiaohongshu\.com$/, path: /\/user\/profile\//, message: '暂不支持小红书主页解析，请改用单篇笔记链接。' },
]

// Pages a platform sends a visitor to instead of the one they asked for, when it wants a check passed
// first. Landing on one is not the page being empty, and the two are worth telling apart.
const CHALLENGES = /wappoc_appmsgcaptcha|\/captcha|\/verify|passport\.weibo|\/challenge/i

// The long numeric id a media host files one video under. X serves one video as a master playlist,
// a playlist per quality and an init segment per track - measured on one timeline video: nine captured
// addresses, every one of them under 'amplify_video/<id>/' - and its poster as
// 'amplify_video_thumb/<id>/'. The id is what says those are one video, and which poster is its.
const mediaIdOf = (address: string) => /\/(\d{12,})\//.exec(address)?.[1]

// One entry per video rather than per captured address: of the addresses sharing an id, the playlist
// with the shortest path is the master, which the engine expands into every quality itself. Addresses
// without an id are kept as they were - nothing says they belong together.
export function collapseStreams(addresses: string[]): string[] {
  const kept: string[] = []
  const byId = new Map<string, number>()
  const manifest = (address: string) => /\.(m3u8|mpd)(\?|$)/i.test(address)
  const rank = (address: string) => (manifest(address) ? 0 : 1_000_000) + new URL(address).pathname.length
  for (const address of addresses) {
    const id = mediaIdOf(address)
    if (!id) { kept.push(address); continue }
    const at = byId.get(id)
    if (at === undefined) { byId.set(id, kept.length); kept.push(address) }
    else if (rank(address) < rank(kept[at])) kept[at] = address
  }
  return kept
}

export function refusalFor(url: string): string | undefined {
  const { hostname, pathname } = new URL(url)
  return REFUSED.find(entry => entry.host.test(hostname) && entry.path.test(pathname))?.message
}

// How long a single work's parse is worth keeping. A picture post becomes one task per picture, and
// every one of them resolves the same post when it runs: without this, nine pictures cost nine
// parses of one page. Short, because the addresses a parse hands out are signed and time-limited -
// 微信公众号's are minutes, not hours - so a stale plan is worse than a second parse.
const REUSE_PARSE_FOR = 2 * 60 * 1_000

export class Parser {
  // Set once a browser's cookie database turns out to be unreadable on this machine, so later parses
  // skip the attempt instead of paying the same seconds-long failure again.
  private cookiesUnavailable = false
  // The last few single-work parses, by address. Only ever consulted for 'single': a listing has
  // pages and a selection behind it, and serving one of those from a cache would show the user a
  // page they did not ask for.
  private recent = new Map<string, { plan: ParsePlan; at: number }>()
  constructor(private engine: Engine, private browser: EmbeddedBrowser, private fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) {}
  private async extract(request: EngineRequest, signal: AbortSignal): Promise<RawInfo> {
    const raw = await this.engine.request<RawInfo>(request, signal)
    const entries = flattenEntries(raw)
    // Bilibili 番剧 returns flat entries holding nothing but an id and a url, which would label every
    // episode with the series title. Pay for the full extraction only where the cheap listing is empty.
    if (entries.length > 1 && entries.filter(entry => entry.title).length * 2 < entries.length) {
      return this.engine.request<RawInfo>({ ...request, flat: false }, signal)
    }
    return raw
  }
  private fromEngine(raw: RawInfo, request: EngineRequest, method: 'direct' | 'browser'): ParsePlan {
    const result = mediaResult(raw, request.url!, method)
    const entries = flattenEntries(raw)
    const parent = raw.webpage_url || raw.original_url || request.url
    return { result, catalog: new Map(result.items.map(item => [item.id, item])), sources: new Map(result.items.map((item, index): [string, DownloadSource] => {
      const entry = entries[index]
      // Nested playlists (a YouTube channel's tabs) have no single index to pass down, so each entry is
      // downloaded from its own page. Parts that share the parent page — a Bilibili 分P — keep the index.
      // A flat playlist entry carries only 'url'; a fully extracted one carries 'webpage_url'.
      const page = entry?.webpage_url || entry?.original_url || (entry?._type === 'url' ? entry.url : undefined)
      const target = page && page !== parent ? page : undefined
      return [item.id, { kind: 'engine', request: { ...request, operation: 'download', url: target || request.url, entry: target || !raw.entries ? undefined : Number(item.id) } }]
    })) }
  }

  // A short link says nothing about what is behind it, and everything downstream routes on the
  // address: which adapter claims it, which platform it is filed under, whether it is a 短剧. So it is
  // followed first. Through the client's own session, like every other request, and best-effort - a
  // shortener that will not answer leaves the address as it was, which is no worse than not trying.
  private async resolve(url: string, signal: AbortSignal): Promise<string> {
    if (!SHORTENERS.test(new URL(url).hostname)) return url
    for (const method of ['HEAD', 'GET'] as const) {
      try {
        const response = await this.fetcher(url, { method, redirect: 'follow', signal })
        if (response.url && response.url !== url) return normalizeUrl(response.url)
      } catch { signal.throwIfAborted() }
    }
    return url
  }

  // Every item of a collection, every page of it, as one plan: what a whole collection picked from a
  // catalogue becomes when it is downloaded. Each item keeps its own address, so the queue treats it
  // like any listing entry - one task per item, re-resolving itself - and the collection's name is the
  // batch and the directory. Pages are walked one after another, at the listing's own pace.
  async expand(url: string, profile: EngineProfile | undefined, signal: AbortSignal): Promise<ParsePlan> {
    let plan: ParsePlan | undefined
    for (let page = 1; page <= 50; page += 1) {
      const next = await this.read(url, profile, signal, { page, group: 'collection' })
      const group = next.result.groups?.find(found => found.id === 'collection')
      if (!plan) {
        // What cannot be bought here is not queued: a paid 短剧 episode would only fail as a task.
        plan = next
        const locked = new Set(plan.result.items.filter(item => item.wall).map(item => item.id))
        plan.result.items = plan.result.items.filter(item => !locked.has(item.id))
        for (const id of locked) { plan.catalog.delete(id); plan.sources.delete(id) }
        for (const found of plan.result.groups || []) found.itemIds = found.itemIds.filter(id => !locked.has(id))
      }
      else {
        for (const item of next.result.items) {
          if (plan.catalog.has(item.id) || item.wall) continue
          plan.result.items.push(item); plan.catalog.set(item.id, item)
          const source = next.sources.get(item.id)
          if (source) plan.sources.set(item.id, source)
          plan.result.groups?.[0]?.itemIds.push(item.id)
        }
      }
      if (!group?.pagination?.hasMore || plan.result.items.length >= MOST) break
    }
    if (!plan?.result.items.length) throw new Error('这部合集里没有可下载的内容：没有读到任何一集，或者每一集都需要单独购买')
    return plan
  }

  async parse(input: string, profile: EngineProfile | undefined, signal: AbortSignal, options: ParseOptions = {}): Promise<ParsePlan> {
    const address = await this.resolve(normalizeUrl(input), signal)
    // A post an adapter reads file by file is re-resolved once per file by the tasks it splits into,
    // so it is kept like a single work: an eight-picture carousel is one read, not eight.
    if (!options.single && !findAdapter(address)?.post) return await this.read(address, profile, signal, options)
    const held = this.recent.get(address)
    if (held && Date.now() - held.at < REUSE_PARSE_FOR) return held.plan
    const plan = await this.read(address, profile, signal, options)
    // Only the last handful: this is for the tasks of one post finishing together, not a history.
    if (this.recent.size > 8) this.recent.clear()
    this.recent.set(address, { plan, at: Date.now() })
    return plan
  }

  private async read(url: string, profile: EngineProfile | undefined, signal: AbortSignal, { browserOnly = false, page = 1, group, single = false }: ParseOptions): Promise<ParsePlan> {
    const refusal = refusalFor(url)
    if (refusal) throw new Error(refusal)
    // An adapter can claim an address and then stand down once it has read it - a 哔哩哔哩 video with no
    // parts and no collection is one video - in which case this falls through to the ordinary route.
    // A job re-resolving its post skips the listing adapters - expanding a listing again would queue
    // all of it - except the ones that read a single post, which is what that job needs.
    const adapter = findAdapter(url)
    log.info(`解析 ${url}${page > 1 ? ` 第 ${page} 页` : ''}${group ? ` · ${group}` : ''}${single ? ' · 单个作品' : ''}${browserOnly ? ' · 仅浏览器' : ''}${adapter ? ` · 列表适配器 ${adapter.id}` : ''}`)
    const listing = adapter && (!single || adapter.post) ? await this.browser.inspectProfile(url, page, group, signal) : undefined
    if (listing?.kind === 'post') {
      // One work's files, each fetched as it is: the adapter already has every address, and the
      // engine is the thing that could not read this post.
      const entries = listing.groups.flatMap(found => found.entries).filter(entry => entry.media)
      const items: MediaItem[] = entries.map(({ media: _media, ...entry }) => ({ ...entry, formats: [] }))
      const sources = new Map<string, DownloadSource>(entries.map(entry => [entry.id, {
        kind: 'http', url: entry.media!, cookies: listing.cookies, headers: { Referer: url, 'User-Agent': listing.userAgent },
        extension: /\.(\w{3,4})$/.exec(new URL(entry.media!).pathname)?.[1] || (entry.kind === 'image' ? 'jpg' : 'mp4'),
      }]))
      const result: MediaResult = { id: randomUUID(), url, title: listing.title, platform: platformOf(url), method: 'browser', items }
      return { result, sources, catalog: new Map(items.map(item => [item.id, item])) }
    }
    if (listing) {
      const groups: MediaGroup[] = []
      const items: MediaItem[] = []
      const sources = new Map<string, DownloadSource>()
      for (const found of listing.groups) {
        // Entry ids are the platform's own post ids, so the same post keeps its id across pages.
        const entries = found.entries.slice(0, Math.max(0, MOST - items.length))
        groups.push({ id: found.id, title: found.title || '内容', directory: found.directory, itemIds: entries.map(entry => entry.id), pagination: found.pagination })
        for (const entry of entries) {
          // The post's own address is kept on the item: the window offers it as a link, and it is the
          // same public page the listing was read from.
          const { whole, ...shown } = entry
          items.push({ ...shown, formats: [] })
          sources.set(entry.id, whole ? { kind: 'collection', url: entry.url } : { kind: 'engine', request: { operation: 'download', url: entry.url, cookies: listing.cookies, headers: { Referer: url, 'User-Agent': listing.userAgent } } })
        }
      }
      if (!items.length) throw new LoginRequired(listing.kind === 'collection' ? '这个合集里没有读到任何内容。请打开登录窗口完成登录或验证后重试。' : '主页中没有读到任何作品。请打开登录窗口完成登录或验证后重试。')
      const result: MediaResult = { id: randomUUID(), url, title: listing.title, platform: platformOf(url), method: 'browser', listing: listing.kind, groups, items }
      return { result, sources, catalog: new Map(items.map(item => [item.id, item])) }
    }
    if (!browserOnly) {
      // The engine goes out as whoever the user is inside this client: the cookies they signed in with
      // here, under the same agent the browser session uses. Without this the first attempt is always
      // anonymous, which fails on anything gated and looks like a stranger on everything else.
      // Only for a platform this client knows: visiting the front page of some file host the user
      // pasted a direct link to would cost a page load and teach nobody anything.
      if (platformOf(url) !== new URL(url).hostname.replace(/^www\./, '')) await this.browser.warm(url, signal)
      const { cookies, userAgent } = await this.browser.identity(url)
      const request: EngineRequest = {
        operation: 'extract', url, profile: this.cookiesUnavailable ? undefined : profile,
        cookies, headers: { 'User-Agent': userAgent },
      }
      let failure: unknown
      try { return this.fromEngine(await this.extract(request, signal), request, 'direct') }
      catch (error) { signal.throwIfAborted(); failure = error; log.info('引擎直连失败', error) }
      // Public media needs no login at all, so an unreadable cookie database must not decide its fate.
      if (request.profile && isCookieFailure(String(failure))) {
        this.cookiesUnavailable = true
        const retry: EngineRequest = { ...request, profile: undefined }
        log.info('读不了浏览器 cookie，改为不带配置重试')
        try { return this.fromEngine(await this.extract(retry, signal), retry, 'direct') }
        catch (error) { signal.throwIfAborted(); failure = error; log.info('不带配置重试也失败', error) }
      }
      if (!needsBrowser(String(failure))) {
        // A stable direct media URL is useful even when yt-dlp's generic extractor rejects its extension.
        const response = await this.fetcher(url, { method: 'HEAD', signal })
        const type = response.headers.get('content-type') || ''
        if (response.ok && /^(video|audio|image)\//i.test(type)) {
          const extension = type.split('/')[1]?.split(';')[0] || 'bin'
          const kind = type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? 'audio' : 'video'
          const id = '1'
          const item: MediaItem = { id, title: url.split('/').pop()?.split('?')[0] || '媒体', kind, formats: [] }
          return { result: { id: randomUUID(), url, title: item.title, platform: platformOf(url), method: 'direct', items: [item] }, catalog: new Map([[id, item]]), sources: new Map([[id, { kind: 'http', url, cookies: [], headers: {}, extension }]]) }
        }
        throw failure
      }
    }
    log.info(`改用应用内浏览器打开页面 ${url}`)
    let media
    try { media = await this.browser.inspect(url, signal) }
    catch (error) { signal.throwIfAborted(); log.warn('应用内浏览器打开页面失败', error); throw new LoginRequired(error instanceof Error ? error.message : '请在应用内浏览器登录后重试') }
    signal.throwIfAborted()
    // An article is read off the page and nowhere else: the engine has no extractor for one, so the
    // attempt would only cost a failure. Everything else is offered to it first, because a real
    // extractor beats a DOM sweep whenever there is one.
    if (!media.images.length && !media.article) {
      const request: EngineRequest = { operation: 'extract', url: media.url, cookies: media.cookies, headers: { Referer: media.url, 'User-Agent': media.userAgent } }
      try { return this.fromEngine(await this.extract(request, signal), request, 'browser') }
      catch (error) { signal.throwIfAborted(); log.info('用浏览器身份再交给引擎也失败，改读页面', error) }
    }
    // An article holds several kinds at once - 微信公众号 puts pictures, a music card and a video in
    // one page - and every one of them is downloadable, so they are listed side by side. A player page
    // is one work: its pictures are the poster for the video, not a second thing to download.
    // What the address itself says it is. A 微信公众号 music card answers with an audio file, and
    // labelling it 视频 on the card would be describing it wrongly for no reason.
    const played = (address: string) => ({ address, kind: /\.(mp3|m4a|aac|flac|ogg|opus|wav)(\?|$)/i.test(address) ? 'audio' as const : 'video' as const })
    // Where the page ended up is not where it was asked for, and where it ended up is a verification
    // page. Measured: 微信公众号 sends a cold session to /mp/wappoc_appmsgcaptcha and the article never
    // renders, so the honest answer is "it wants you to pass its check" rather than "this page has no
    // media" - which is true of the captcha page and says nothing about the article.
    if (CHALLENGES.test(new URL(media.url).pathname)) {
      throw new LoginRequired('平台把这次访问转到了验证页面，文章本身没有打开。请打开登录窗口完成验证（必要时登录）后重试。')
    }
    const assets: { address: string; kind: MediaItem['kind'] }[] = media.article
      ? [...media.videos.map(played), ...media.images.map(address => ({ address, kind: 'image' as const }))]
      : media.videos.length ? collapseStreams(media.videos).map(played) : media.images.map(address => ({ address, kind: 'image' as const }))
    // The player each stream came from, matched by the id both are filed under, so a card shows its own
    // cover and post rather than the page's share image under the page's title.
    const posterOf = (address: string) => { const id = mediaIdOf(address); return id ? media.posters.find(found => mediaIdOf(found.poster) === id) : undefined }
    if (!assets.length) {
      // On a platform this client knows, an empty page is most often one shown to a visitor it does
      // not know, and signing in is the fix worth offering. Any other site that opened and held no
      // media simply has none - telling its user to sign in would send them after the wrong thing.
      const known = platformOf(url) !== new URL(url).hostname.replace(/^www\./, '')
      if (known) throw new LoginRequired('页面没有提供可下载的内容。如果它需要登录才能看到，请打开登录窗口完成登录或验证后重试。')
      throw new Error('这个页面没有可下载的内容。')
    }
    const sources = new Map<string, DownloadSource>()
    const result: MediaResult = {
      id: randomUUID(), url, title: media.title, platform: platformOf(url), method: 'browser',
      items: assets.slice(0, 100).map(({ address, kind }, index) => {
        const id = String(index + 1)
        // Anything with a timeline goes to the engine, which knows how to resume and remux it; a
        // picture is a single GET and needs none of that.
        if (kind !== 'image') sources.set(id, { kind: 'engine', request: { operation: 'download', url: address, cookies: media.cookies, headers: { Referer: media.url, 'User-Agent': media.userAgent } } })
        else sources.set(id, { kind: 'http', url: address, cookies: media.cookies, headers: { Referer: media.url, 'User-Agent': media.userAgent }, extension: /\.(png|webp|gif)(\?|$)/i.exec(address)?.[1] || 'jpg' })
        const player = kind === 'image' ? undefined : posterOf(address)
        return {
          id, title: player?.text || `${media.title}${assets.length > 1 ? ` · ${index + 1}` : ''}`, kind, formats: [],
          url: player?.link, thumbnail: kind === 'image' ? address : player?.poster || media.thumbnail,
        }
      }),
    }
    return { result, sources, catalog: new Map(result.items.map(item => [item.id, item])) }
  }
}
