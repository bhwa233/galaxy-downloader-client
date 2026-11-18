// 哔哩哔哩 合集、系列 and 分P. Three endpoints carry all of it, and every one of them answers an
// anonymous request that carries no cookies and no wbi signature - only a Referer naming a page of the
// site. They are still called from inside a page, like every other listing, so the headers and the TLS
// handshake are the browser's rather than this process's assertions about itself.
//
//   x/web-interface/wbi/view                 one video: its 分P list and, if it has one, its 合集
//   x/polymer/web-space/seasons_archives_list one page of a 合集
//   x/series/archives                         one page of a 系列
import { i18n } from '../../../shared/i18n'
import type { ListingEntry, ListingGroup, ListingPage, PageRequest, ProfileAdapter } from './types'
import { VerificationRequired } from '../login'

const API = 'https://api.bilibili.com'
// What the site's own collection grid asks for.
const PAGE_SIZE = 30

type Archive = { bvid?: string; title?: string; pic?: string; duration?: number; pubdate?: number; stat?: { view?: number }; author?: { name?: string; mid?: number }; owner?: { name?: string; mid?: number } }
type ArchivesResponse = {
  code?: number; message?: string
  data?: {
    archives?: Archive[]
    meta?: { name?: string; total?: number }
    // seasons_archives_list reports 'page_num'/'total'; series/archives reports 'num'/'total'.
    page?: { total?: number }
  }
}
// One episode of a 合集, as the video page's own reply carries it. 'arc' is the same archive the paged
// collection endpoint answers with, so the two routes build their entries from one shape.
type Episode = { bvid?: string; title?: string; arc?: Archive & { author?: { name?: string } } }
type Season = {
  id?: number; title?: string; mid?: number
  sections?: { id?: number; title?: string; episodes?: Episode[] }[]
}
export type ViewResponse = {
  code?: number; message?: string
  data?: {
    bvid?: string; cid?: number; title?: string; pic?: string; owner?: { name?: string; mid?: number }
    rights?: { is_stein_gate?: number }; is_upower_exclusive?: boolean; redirect_url?: string
    duration?: number; pubdate?: number; stat?: { view?: number }
    pages?: { cid?: number; page?: number; part?: string; duration?: number }[]
    // The whole 合集 rides along in this reply - every section, every episode of it - so the collection
    // tab of a video page costs no second request.
    ugc_season?: Season
  }
}

const count = (value: number | undefined) => typeof value === 'number' && value >= 0 ? value : undefined
const https = (cover: string) => cover.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://')

// A 合集 entry is another BV, so it is downloaded from its own page exactly as a 投稿 would be.
function archiveOf(archive: Archive): ListingEntry | undefined {
  if (!archive.bvid) return undefined
  return {
    id: archive.bvid, url: `https://www.bilibili.com/video/${archive.bvid}`,
    title: archive.title?.trim() || i18n.t('errors:bilibili.video', { id: archive.bvid }),
    thumbnail: https(archive.pic || '') || undefined, kind: 'video',
    duration: count(archive.duration), views: count(archive.stat?.view), publishedAt: archive.pubdate || undefined,
    author: archive.owner?.name || archive.author?.name,
    authorId: archive.owner?.mid || archive.author?.mid ? String(archive.owner?.mid || archive.author?.mid) : undefined,
  }
}

// One episode of a 合集, from the video page's own reply. An 'arc' the reply did not carry costs the card
// its cover and counts, not its place in the list: the episode's own name and address still stand.
function episodeOf(episode: Episode, own: string): ListingEntry | undefined {
  const bvid = episode.bvid?.trim()
  if (!bvid) return undefined
  const arc: Archive & { author?: { name?: string } } = episode.arc || {}
  return {
    id: bvid, url: `https://www.bilibili.com/video/${bvid}`,
    title: episode.title?.trim() || arc.title?.trim() || i18n.t('errors:bilibili.video', { id: bvid }),
    thumbnail: https(arc.pic || '') || undefined, kind: 'video',
    duration: count(arc.duration), views: count(arc.stat?.view), publishedAt: arc.pubdate || undefined,
    author: arc.author?.name?.trim() || undefined,
    authorId: arc.author?.mid || arc.owner?.mid ? String(arc.author?.mid || arc.owner?.mid) : undefined,
    // Which of these is the one that was pasted: a list of sixty titles otherwise has to be read to find
    // out, and the whole point of this route is to land on the video rather than on the 合集.
    mark: bvid === own ? i18n.t('errors:bilibili.original') : undefined,
  }
}

// The whole 合集, as the tab it becomes. Every episode rides along in the video's own reply, so the tab
// is complete without a second request - and so is where the video being parsed sits in it.
function seasonOf(season: Season, own: string): ListingGroup | undefined {
  const sections = season.sections || []
  const entries = sections.flatMap(section => section.episodes || []).map(episode => episodeOf(episode, own)).filter((entry): entry is ListingEntry => Boolean(entry))
  // A reply that names a 合集 but carries no episodes of it teaches nothing about the list; the caller
  // then asks the paged endpoint instead of drawing an empty tab.
  if (!entries.length) return undefined
  const title = season.title?.trim() || i18n.t('errors:bilibili.collection')
  const index = entries.findIndex(entry => entry.id === own)
  return {
    id: 'collection', kind: 'collection', title, directory: title, entries,
    // Every episode arrived with the video, so there is never a second page of them.
    pagination: { index: 1, size: entries.length, total: entries.length, hasMore: false },
    // Where the pasted video is in the 合集: the tab then says 59/72 instead of just 72.
    position: index < 0 ? undefined : { index: index + 1, total: entries.length },
  }
}

type Source = { mid: string; sid: string; type: 'season' | 'series' }

function bangumiOf(url: URL): string | undefined {
  if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return undefined
  return /^\/bangumi\/play\/ss(\d+)/.exec(url.pathname)?.[1]
}

// A 合集 lives under its author's space, in one of three shapes the site has used. '/lists/<sid>' is
// today's; the two '/channel/...detail' forms are still handed out by older pages and shared links.
export function sourceOf(url: URL): Source | undefined {
  if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return undefined
  const mid = /^\/(\d+)\//.exec(url.pathname)?.[1] || url.searchParams.get('mid') || ''
  if (!mid) return undefined
  const listed = /^\/\d+\/lists\/(\d+)/.exec(url.pathname)?.[1]
  // The site names the kind in the query; a link without one is a 合集, which is what '/lists/' defaults to.
  if (listed) return { mid, sid: listed, type: url.searchParams.get('type') === 'series' ? 'series' : 'season' }
  const sid = url.searchParams.get('sid') || ''
  if (!sid) return undefined
  if (/^\/\d+\/channel\/collectiondetail/.test(url.pathname)) return { mid, sid, type: 'season' }
  if (/^\/\d+\/channel\/seriesdetail/.test(url.pathname)) return { mid, sid, type: 'series' }
  return undefined
}

export async function read<T>(fetch: PageRequest['fetch'], address: string, referrer: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(address, { referrer, signal })
  // Risk control answers with an HTML challenge page rather than JSON; that is a closed route, not a reply.
  const body = await response.json().catch(() => { throw new VerificationRequired(i18n.t('errors:bilibili.verification')) }) as T & { code?: number; message?: string }
  if (body.code) throw new Error(body.message ? i18n.t('errors:bilibili.apiMessage', { code: body.code, message: body.message }) : i18n.t('errors:bilibili.api', { code: body.code }))
  return body
}

// One page of a 合集 or a 系列, as the group it becomes. Shared by the collection adapter and by a video
// page that turns out to belong to one.
export async function collectionGroup(request: Pick<PageRequest, 'fetch' | 'signal' | 'order'>, source: Source, page: number, referrer: string, named?: string): Promise<ListingGroup> {
  const { fetch, signal } = request
  const query = source.type === 'season'
    ? `x/polymer/web-space/seasons_archives_list?mid=${source.mid}&season_id=${source.sid}&sort_reverse=${request.order === 'reverse'}&page_num=${page}&page_size=${PAGE_SIZE}`
    : `x/series/archives?mid=${source.mid}&series_id=${source.sid}&only_normal=true&sort=desc&pn=${page}&ps=${PAGE_SIZE}`
  const body = await read<ArchivesResponse>(fetch, `${API}/${query}`, referrer, signal)
  const entries = (body.data?.archives || []).map(archiveOf).filter((entry): entry is ListingEntry => Boolean(entry))
  // 系列 replies carry no name of their own, so a caller that already knows it says so; otherwise the
  // group is labelled for what it is rather than given a title invented here.
  const title = named || body.data?.meta?.name?.trim() || i18n.t(source.type === 'series' ? 'errors:bilibili.series' : 'errors:bilibili.collection')
  const total = body.data?.page?.total ?? body.data?.meta?.total
  return {
    id: 'collection', kind: 'collection', title, directory: title, entries,
    pagination: { index: page, size: PAGE_SIZE, total, hasMore: total === undefined ? entries.length === PAGE_SIZE : page * PAGE_SIZE < total },
  }
}

export const bilibiliCollection: ProfileAdapter = {
  id: 'bilibili-collection',
  matches(url) { return Boolean(sourceOf(url)) },
  // The collection page is its own entry point; nothing has to be rewritten to reach the grid.
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, fetch, signal, order }: PageRequest): Promise<ListingPage> {
    const source = sourceOf(url)
    if (!source) throw new Error(i18n.t('errors:listing.noCollectionId'))
    const group = await collectionGroup({ fetch, signal, order }, source, page, url.href)
    return { title: group.title, kind: 'collection', groups: [group] }
  },
}

type BangumiEpisode = { id?: number; aid?: number; cid?: number; title?: string; long_title?: string; cover?: string; duration?: number; pub_time?: number }
type BangumiResponse = { code?: number; message?: string; result?: { title?: string; cover?: string; total?: number; episodes?: BangumiEpisode[] } }

export const bilibiliBangumi: ProfileAdapter = {
  id: 'bilibili-bangumi',
  matches(url) { return Boolean(bangumiOf(url)) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, fetch, signal }: PageRequest): Promise<ListingPage> {
    const season = bangumiOf(url)
    if (!season) throw new Error(i18n.t('errors:listing.noCollectionId'))
    const address = `${API}/pgc/view/web/season?season_id=${season}`
    const body = await read<BangumiResponse>(fetch, address, url.href, signal)
    const result = body.result
    const PAGE = 100
    const episodes = result?.episodes || []
    const slice = episodes.slice((page - 1) * PAGE, page * PAGE)
    const entries = slice.map((episode, index): ListingEntry | undefined => {
      const id = episode.id || episode.aid
      if (!id) return undefined
      const cover = https(episode.cover || result?.cover || '')
      // PGC episodes report milliseconds; ListingEntry uses seconds, like UGC and part listings.
      const milliseconds = count(episode.duration)
      return { id: String(id), url: `https://www.bilibili.com/bangumi/play/ep${id}`, title: episode.long_title?.trim() || episode.title?.trim() || `第 ${(page - 1) * PAGE + index + 1} 集`, thumbnail: cover || undefined, kind: 'video', duration: milliseconds === undefined ? undefined : milliseconds / 1000, publishedAt: count(episode.pub_time) }
    }).filter((entry): entry is ListingEntry => Boolean(entry))
    const total = count(result?.total) ?? episodes.length
    return { title: result?.title?.trim() || i18n.t('errors:bilibili.collection'), kind: 'collection', groups: [{ id: 'collection', kind: 'collection', title: result?.title?.trim() || i18n.t('errors:bilibili.collection'), directory: result?.title?.trim(), entries, pagination: { index: page, size: PAGE, total, hasMore: page * PAGE < total } }] }
  },
}

// Bilibili adds p=1 to mobile share links even for videos with only one part.
// Check those videos for a collection; higher part numbers still name one explicit part.
function bvidOf(url: URL): string {
  const part = url.searchParams.get('p')
  if (!/(^|\.)bilibili\.com$/.test(url.hostname) || (part && part !== '1')) return ''
  return /^\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname)?.[1] || ''
}

// A video link is one of four things and the address does not say which, so this reads the video once
// and then decides: a multi-part video lists its parts, a video inside a 合集 lists the video itself and
// the 合集 beside it, one that is both lists both (parts first), and an ordinary single video is handed
// back to the engine untouched. Where the video has a tab of its own it leads, so a pasted link is
// ticked and ready to download instead of being buried in the 合集 it is one episode of.
export const bilibiliVideo: ProfileAdapter = {
  id: 'bilibili-video',
  matches(url) { return Boolean(bvidOf(url)) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, group, fetch, signal }: PageRequest): Promise<ListingPage | undefined> {
    const bvid = bvidOf(url)
    if (!bvid) throw new Error(i18n.t('errors:listing.noVideoId'))
    const view = await read<ViewResponse>(fetch, `${API}/x/web-interface/wbi/view?bvid=${bvid}`, url.href, signal)
    const data = view.data
    if (!data) return undefined
    const author = data.owner?.name?.trim() || undefined
    const cover = https(data.pic || '') || undefined
    const title = data.title?.trim() || i18n.t('errors:bilibili.video', { id: bvid })
    const parts = data.pages || []
    // A real multi-part video with p=1 explicitly names its first part, so keep single-part extraction.
    if (url.searchParams.get('p') && parts.length > 1) return undefined
    const season = data.ugc_season
    // The 合集 arrives with the video, so its tab is complete before anything else is asked for. Only a
    // reply that did not carry the episodes falls back to the paged endpoint.
    const collected = season?.id && season.mid ? seasonOf(season, bvid) : undefined
    const groups: ListingGroup[] = []
    if (parts.length > 1) {
      groups.push({
        // The tab says 多P by its kind; the hover hint carries the video's own title.
        id: 'parts', kind: 'parts', title, directory: title,
        // The part's own id has to differ from a 合集 entry's, because a 合集 contains the video being
        // looked at: both would otherwise be keyed by this same bvid and share one selection.
        entries: parts.map((part, index) => ({
          id: `${bvid}-p${part.page || index + 1}`,
          url: `https://www.bilibili.com/video/${bvid}?p=${part.page || index + 1}`,
          // The part's own name, as the site shows it, with no index added in front of it.
          title: part.part?.trim() || `${title} P${part.page || index + 1}`,
          thumbnail: cover, kind: 'video' as const, duration: count(part.duration), author, authorId: data.owner?.mid ? String(data.owner.mid) : undefined,
        })),
        // Every part arrives in the one reply, so there is never a second page of them.
        pagination: { index: 1, size: parts.length, total: parts.length, hasMore: false },
      })
    }
    if (collected) groups.push(collected)
    else if (season?.id && season.mid) {
      const source: Source = { mid: String(season.mid), sid: String(season.id), type: 'season' }
      // Only the tab being turned moves; the other keeps the page it was already showing.
      const wanted = group === 'collection' || !groups.length ? page : 1
      groups.push(await collectionGroup({ fetch, signal }, source, wanted, url.href, season.title?.trim()))
    }
    // Neither a part list nor a collection: one video, which the engine already handles on its own.
    if (!groups.length) return undefined
    // A single-part video leads with itself: its own card first and already ticked, the 合集 it belongs
    // to being the tab beside it, where 59/72 says where in that 合集 this video is. A multi-part video
    // already leads with its parts, which are it.
    if (parts.length <= 1) groups.unshift({
      // Labelled 单视频 by its kind; the video's own title is the hover hint, so the card below does not
      // merely repeat the tab.
      id: 'work', kind: 'work', title,
      entries: [{
        id: `${bvid}-p1`, url: `https://www.bilibili.com/video/${bvid}`, title, thumbnail: cover, kind: 'video',
        duration: count(data.duration) ?? count(parts[0]?.duration), views: count(data.stat?.view), author, authorId: data.owner?.mid ? String(data.owner.mid) : undefined, publishedAt: data.pubdate || undefined,
      }],
      // One entry, and nothing behind it: a tab that cannot grow has no page to turn.
      pagination: { index: 1, size: 1, hasMore: false },
    })
    return { title, kind: 'collection', groups }
  },
}
