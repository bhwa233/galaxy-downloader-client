import { randomUUID } from 'node:crypto'
import type { MediaResult } from '../../shared/contracts'
import { Engine, type Cookie, type EngineProfile, type EngineRequest } from './engine'
import { ChromeConnection } from './chrome'
import { flattenEntries, mediaResult, needsChrome, normalizeUrl, platformOf, type RawInfo } from './media'

export type DownloadSource = { kind: 'engine'; request: EngineRequest } | { kind: 'http'; url: string; cookies: Cookie[]; headers: Record<string, string>; extension: string }
export type ParsePlan = { result: MediaResult; sources: Map<string, DownloadSource> }
export class ChromeRequired extends Error {}

// Creator home pages are listings of posts, so they take the Chrome listing route instead of yt-dlp.
export function isProfileUrl(url: string): boolean {
  const { hostname, pathname } = new URL(url)
  return /xiaohongshu\.com$/.test(hostname) && /\/user\/profile\//.test(pathname)
    || (hostname === 'space.bilibili.com' || /bilibili\.com$/.test(hostname) && /\/space\//.test(pathname))
    || /douyin\.com$/.test(hostname) && /\/user\//.test(pathname)
}

export class Parser {
  constructor(private engine: Engine, private chrome: ChromeConnection, private fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) {}
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
  private fromEngine(raw: RawInfo, request: EngineRequest, method: 'direct' | 'chrome'): ParsePlan {
    const result = mediaResult(raw, request.url!, method)
    const entries = flattenEntries(raw)
    const parent = raw.webpage_url || raw.original_url || request.url
    return { result, sources: new Map(result.items.map((item, index): [string, DownloadSource] => {
      const entry = entries[index]
      // Nested playlists (a YouTube channel's tabs) have no single index to pass down, so each entry is
      // downloaded from its own page. Parts that share the parent page — a Bilibili 分P — keep the index.
      // A flat playlist entry carries only 'url'; a fully extracted one carries 'webpage_url'.
      const page = entry?.webpage_url || entry?.original_url || (entry?._type === 'url' ? entry.url : undefined)
      const target = page && page !== parent ? page : undefined
      return [item.id, { kind: 'engine', request: { ...request, operation: 'download', url: target || request.url, entry: target || !raw.entries ? undefined : Number(item.id) } }]
    })) }
  }

  async parse(input: string, profile: EngineProfile | undefined, proxy: string, signal: AbortSignal, chromeOnly = false, filter: 'all' | 'video' | 'audio' | 'image' = 'all'): Promise<ParsePlan> {
    const url = normalizeUrl(input)
    if (isProfileUrl(url)) {
      const listing = await this.chrome.inspectProfile(url, signal)
      let entries = listing.entries
      if (filter !== 'all') entries = entries.filter(entry => entry.kind === filter)
      const result: MediaResult = { id: randomUUID(), url, title: listing.title, platform: platformOf(url), method: 'chrome', profile: true, items: entries.slice(0, 500).map((entry, index) => ({ id: String(index + 1), title: entry.title, thumbnail: entry.thumbnail, kind: entry.kind, formats: [] })) }
      const sources = new Map<string, DownloadSource>(entries.slice(0, 500).map((entry, index) => [String(index + 1), { kind: 'engine', request: { operation: 'download', url: entry.url, cookies: listing.cookies, headers: { Referer: url, 'User-Agent': listing.userAgent }, proxy } }]))
      if (!result.items.length) throw new ChromeRequired('主页中没有找到符合筛选条件的内容，请确认已登录并滚动加载内容。')
      return { result, sources }
    }
    if (!chromeOnly) {
      const request: EngineRequest = { operation: 'extract', url, profile, proxy }
      try { return this.fromEngine(await this.extract(request, signal), request, 'direct') }
      catch (error) {
        signal.throwIfAborted()
        if (!needsChrome(String(error))) {
          // A stable direct media URL is useful even when yt-dlp's generic extractor rejects its extension.
          const response = await this.fetcher(url, { method: 'HEAD', signal })
          const type = response.headers.get('content-type') || ''
          if (response.ok && /^(video|audio|image)\//i.test(type)) {
            const extension = type.split('/')[1]?.split(';')[0] || 'bin'
            const kind = type.startsWith('image/') ? 'image' : type.startsWith('audio/') ? 'audio' : 'video'
            const id = '1'
            return { result: { id: randomUUID(), url, title: url.split('/').pop()?.split('?')[0] || '媒体', platform: platformOf(url), method: 'direct', items: [{ id, title: url.split('/').pop()?.split('?')[0] || '媒体', kind, formats: [], }] }, sources: new Map([[id, { kind: 'http', url, cookies: [], headers: {}, extension }]]) }
          }
        }
        if (!needsChrome(String(error))) throw error
      }
    }
    let media
    try { media = await this.chrome.inspect(url, signal) }
    catch (error) { signal.throwIfAborted(); throw new ChromeRequired(error instanceof Error ? error.message : '请授权连接 Chrome') }
    signal.throwIfAborted()
    if (!media.images.length) {
      const request: EngineRequest = { operation: 'extract', url: media.url, proxy, cookies: media.cookies, headers: { Referer: media.url, 'User-Agent': media.userAgent } }
      try { return this.fromEngine(await this.extract(request, signal), request, 'chrome') }
      catch { signal.throwIfAborted() }
    }
    const assets = media.videos.length ? media.videos.map(address => ({ address, kind: 'video' as const })) : media.images.map(address => ({ address, kind: 'image' as const }))
    if (!assets.length) throw new ChromeRequired('Chrome 页面尚未提供媒体资源。请先在 Chrome 完成登录或验证、播放目标内容，再重试。')
    const sources = new Map<string, DownloadSource>()
    const result: MediaResult = {
      id: randomUUID(), url, title: media.title, platform: platformOf(url), method: 'chrome',
      items: assets.slice(0, 100).map(({ address, kind }, index) => {
        const id = String(index + 1)
        if (kind === 'video') sources.set(id, { kind: 'engine', request: { operation: 'download', url: address, cookies: media.cookies, proxy, headers: { Referer: media.url, 'User-Agent': media.userAgent } } })
        else sources.set(id, { kind: 'http', url: address, cookies: media.cookies, headers: { Referer: media.url, 'User-Agent': media.userAgent }, extension: /\.(png|webp|gif)(\?|$)/i.exec(address)?.[1] || 'jpg' })
        return { id, title: `${media.title}${assets.length > 1 ? ` · ${index + 1}` : ''}`, kind, formats: [], thumbnail: kind === 'image' ? address : media.thumbnail }
      }),
    }
    return { result, sources }
  }
}
