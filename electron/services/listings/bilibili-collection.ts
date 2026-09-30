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

type Archive = { bvid?: string; title?: string; pic?: string; duration?: number; pubdate?: number; stat?: { view?: number } }
type ArchivesResponse = {
  code?: number; message?: string
  data?: {
    archives?: Archive[]
    meta?: { name?: string; total?: number }
    // seasons_archives_list reports 'page_num'/'total'; series/archives reports 'num'/'total'.
    page?: { total?: number }
  }
}
type ViewResponse = {
  code?: number; message?: string
  data?: {
    bvid?: string; title?: string; pic?: string; owner?: { name?: string }
    pages?: { page?: number; part?: string; duration?: number }[]
    // The episodes ride along in this reply too, but they are read from the collection endpoint
    // instead: that one is the same call every later page makes, so there is one shape to maintain.
    ugc_season?: { id?: number; title?: string; mid?: number }
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
  }
}

type Source = { mid: string; sid: string; type: 'season' | 'series' }

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

async function read<T>(fetch: PageRequest['fetch'], address: string, referrer: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(address, { referrer, signal })
  // Risk control answers with an HTML challenge page rather than JSON; that is a closed route, not a reply.
  const body = await response.json().catch(() => { throw new VerificationRequired(i18n.t('errors:bilibili.verification')) }) as T & { code?: number; message?: string }
  if (body.code) throw new Error(body.message ? i18n.t('errors:bilibili.apiMessage', { code: body.code, message: body.message }) : i18n.t('errors:bilibili.api', { code: body.code }))
  return body
}

// One page of a 合集 or a 系列, as the group it becomes. Shared by the collection adapter and by a video
// page that turns out to belong to one.
export async function collectionGroup(request: Pick<PageRequest, 'fetch' | 'signal'>, source: Source, page: number, referrer: string, named?: string): Promise<ListingGroup> {
  const { fetch, signal } = request
  const query = source.type === 'season'
    ? `x/polymer/web-space/seasons_archives_list?mid=${source.mid}&season_id=${source.sid}&sort_reverse=false&page_num=${page}&page_size=${PAGE_SIZE}`
    : `x/series/archives?mid=${source.mid}&series_id=${source.sid}&only_normal=true&sort=desc&pn=${page}&ps=${PAGE_SIZE}`
  const body = await read<ArchivesResponse>(fetch, `${API}/${query}`, referrer, signal)
  const entries = (body.data?.archives || []).map(archiveOf).filter((entry): entry is ListingEntry => Boolean(entry))
  // 系列 replies carry no name of their own, so a caller that already knows it says so; otherwise the
  // group is labelled for what it is rather than given a title invented here.
  const title = named || body.data?.meta?.name?.trim() || i18n.t(source.type === 'series' ? 'errors:bilibili.series' : 'errors:bilibili.collection')
  const total = body.data?.page?.total ?? body.data?.meta?.total
  return {
    id: 'collection', title, directory: title, entries,
    pagination: { index: page, size: PAGE_SIZE, total, hasMore: total === undefined ? entries.length === PAGE_SIZE : page * PAGE_SIZE < total },
  }
}

export const bilibiliCollection: ProfileAdapter = {
  id: 'bilibili-collection',
  matches(url) { return Boolean(sourceOf(url)) },
  // The collection page is its own entry point; nothing has to be rewritten to reach the grid.
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, fetch, signal }: PageRequest): Promise<ListingPage> {
    const source = sourceOf(url)
    if (!source) throw new Error(i18n.t('errors:listing.noCollectionId'))
    const group = await collectionGroup({ fetch, signal }, source, page, url.href)
    return { title: group.title, kind: 'collection', groups: [group] }
  },
}

// A video page with a 'p' already picked is that one part, not the list it came from: the user named it.
function bvidOf(url: URL): string {
  if (!/(^|\.)bilibili\.com$/.test(url.hostname) || url.searchParams.get('p')) return ''
  return /^\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname)?.[1] || ''
}

// A video link is one of three things and the address does not say which, so this reads the video once
// and then decides: a multi-part video lists its parts, a video inside a 合集 lists the collection, one
// that is both lists both, and an ordinary single video is handed back to the engine untouched.
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
    const parts = data.pages || []
    const season = data.ugc_season
    const groups: ListingGroup[] = []
    if (parts.length > 1) {
      const title = data.title?.trim() || i18n.t('errors:bilibili.video', { id: bvid })
      groups.push({
        id: 'parts', title: i18n.t('errors:bilibili.parts'), directory: title,
        // The part's own id has to differ from a 合集 entry's, because a 合集 contains the video being
        // looked at: both would otherwise be keyed by this same bvid and share one selection.
        entries: parts.map((part, index) => ({
          id: `${bvid}-p${part.page || index + 1}`,
          url: `https://www.bilibili.com/video/${bvid}?p=${part.page || index + 1}`,
          // The part's own name, as the site shows it, with no index added in front of it.
          title: part.part?.trim() || `${title} P${part.page || index + 1}`,
          thumbnail: cover, kind: 'video' as const, duration: count(part.duration), author,
        })),
        // Every part arrives in the one reply, so there is never a second page of them.
        pagination: { index: 1, size: parts.length, total: parts.length, hasMore: false },
      })
    }
    if (season?.id && season.mid) {
      const source: Source = { mid: String(season.mid), sid: String(season.id), type: 'season' }
      // Only the tab being turned moves; the other keeps the page it was already showing.
      const wanted = group === 'collection' || !groups.length ? page : 1
      groups.push(await collectionGroup({ fetch, signal }, source, wanted, url.href, season.title?.trim()))
    }
    // Neither a part list nor a collection: one video, which the engine already handles on its own.
    if (!groups.length) return undefined
    return { title: data.title?.trim() || groups[0].title, kind: 'collection', groups }
  },
}
