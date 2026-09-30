// 微博 user pages. The listing is the endpoint the profile's own grid calls, asked for from inside a
// page of the site, which is the one route this client has - see listings/types.ts.
//
// NOT VERIFIED AGAINST THE LIVE SITE. Unlike the three adapters beside it, the shape below was not
// read off a captured response: 微博 profiles were never probed in the client. So it is written to
// stand down rather than to insist - a reply that is not the shape this expects means the adapter
// hands the address back and the ordinary engine route runs, which is exactly what happens today. It
// can be wrong; it cannot make things worse than not having it. Once someone runs a real profile
// through it, this paragraph should be replaced by what the response actually looked like.
import { LoginRequired } from '../login'
import { isRecord, onePage, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'

// What the profile grid asks for per page.
const PAGE_SIZE = 20

type Picture = { large?: { url?: string }; original?: { url?: string }; url?: string }
type Status = {
  id?: number | string; mblogid?: string; text_raw?: string; created_at?: string
  user?: { id?: number | string; screen_name?: string }
  pic_ids?: string[]; pic_infos?: Record<string, Picture>
  page_info?: { type?: string; object_type?: string; page_pic?: string; media_info?: { duration?: number } }
  comments_count?: number; attitudes_count?: number
}
type Feed = { ok?: number; msg?: string; data?: { list?: Status[]; total_number?: number } }

// 'weibo.com/u/<uid>' and 'weibo.com/<uid>' are the profile; 'weibo.com/<uid>/<mblogid>' is one post
// and belongs to the engine, which has an extractor for it.
export function uidOf(url: URL): string {
  if (!/(^|\.)weibo\.(com|cn)$/.test(url.hostname)) return ''
  return /^\/u\/(\d+)\/?$/.exec(url.pathname)?.[1] || /^\/(\d+)\/?$/.exec(url.pathname)?.[1] || ''
}

const count = (value: number | undefined) => typeof value === 'number' && value >= 0 ? value : undefined
const https = (address: string) => address.replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://')

// 微博 writes its timestamps the way C does: 'Mon Sep 22 10:00:00 +0800 2026'.
function postedAt(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000)
}

export function entryOf(status: Status): ListingEntry | undefined {
  const id = status.mblogid?.trim()
  const uid = status.user?.id
  if (!id || !uid) return undefined
  const pictures = (status.pic_ids || []).map(pid => status.pic_infos?.[pid]).filter(Boolean) as Picture[]
  const video = status.page_info?.type === 'video' || status.page_info?.object_type === 'video'
  // A post with neither a video nor a picture is text, and text is not something this client downloads.
  if (!video && !pictures.length) return undefined
  const cover = status.page_info?.page_pic || pictures[0]?.large?.url || pictures[0]?.original?.url || pictures[0]?.url || ''
  return {
    id, url: `https://weibo.com/${uid}/${id}`,
    // A 微博 has no title, only its text. Cut to something that reads as a row rather than a paragraph.
    title: status.text_raw?.trim().split('\n')[0].slice(0, 80) || `微博 ${id}`,
    thumbnail: https(cover) || undefined,
    kind: video ? 'video' : 'image',
    duration: count(status.page_info?.media_info?.duration),
    likes: count(status.attitudes_count), comments: count(status.comments_count),
    author: status.user?.screen_name?.trim() || undefined, publishedAt: postedAt(status.created_at),
  }
}

export const weibo: ProfileAdapter = {
  id: 'weibo',
  matches(url) { return Boolean(uidOf(url)) },
  // The profile page is its own entry point, and it is the page that issues the listing request.
  entryUrl(url) { return `https://weibo.com/u/${uidOf(url)}` },
  async fetchPage({ url, page, fetch, evaluate, signal }: PageRequest): Promise<ListingPage | undefined> {
    const uid = uidOf(url)
    if (!uid) throw new Error('链接中没有用户 ID')
    // The two headers the profile page's own request carries (captured 2026-09-23). Without them the
    // endpoint answers '403 Forbidden' as HTML rather than a feed. The token is the readable
    // 'XSRF-TOKEN' cookie, which is where the page's own scripts take it from.
    const token = await evaluate?.<string>(`(document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]+)/) || [])[1] || ''`).catch(() => '') || ''
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest', ...(token ? { 'X-XSRF-TOKEN': token } : {}) }
    const response = await fetch(`https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`, { headers, referrer: `https://weibo.com/u/${uid}`, signal })
    const body = await response.json().catch(() => undefined) as (Feed & { message?: string }) | undefined
    // Signed out, the page's own request is answered {"ok":0,"message":"前方有点拥堵，请登录后使用"}.
    // Standing down there is the better answer than a sign-in error: the engine lists a profile
    // anonymously (100 posts, measured), so the user still gets a listing.
    if (isRecord(body) && body.ok === 0) return undefined
    // Not JSON, or not a shape with a feed in it. That is this adapter being wrong about the endpoint
    // rather than 微博 refusing, so it stands down and the address goes the ordinary way.
    if (!isRecord(body) || !isRecord(body.data)) return undefined
    const list = body.data.list
    // A feed key that is present but not a list is again a shape this does not understand.
    if (!Array.isArray(list)) return undefined
    // An empty first page from a profile that exists is 微博 answering a visitor it does not know.
    if (!list.length && page === 1) throw new LoginRequired('微博没有返回任何微博。请打开登录窗口完成登录后重试。')
    const entries = list.map(entryOf).filter((entry): entry is ListingEntry => Boolean(entry))
    const author = list.find(status => status.user?.screen_name)?.user?.screen_name
    const total = count(body.data.total_number)
    return onePage('posts', author ? `${author}的微博` : undefined, entries, {
      index: page, size: PAGE_SIZE, total,
      // Counted against what the feed held, not against what survived the filter: a page of text-only
      // posts is a page with nothing to download, not the end of the profile.
      hasMore: total === undefined ? list.length >= PAGE_SIZE : page * PAGE_SIZE < total,
    })
  },
}
