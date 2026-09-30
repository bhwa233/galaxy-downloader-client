import type { Settings } from '../../../shared/contracts'
import { seconds } from './text'
import { onePage, type Fetcher, type Fingerprint, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'
import { keyOf, mixinKey, signQuery } from './wbi'
import { VerificationRequired } from '../login'

// What the 投稿 grid asks for in one request, so a page here is the same page the site would serve.
const PAGE_SIZE = 40
// The spm the 投稿 tab reports itself as. It is signed along with everything else, so it cannot be
// left off, and it has to be the tab's own: the value belonging to another page is a mismatch.
const LOCATION = '333.1387'
type Keys = { mixin: string; at: number }
let cached: Keys | undefined

// The script each locale is written in, as 哔哩哔哩 names them. This has to agree with the session's
// Accept-Language: a request that asks for Japanese in one field and Chinese in another is a client
// contradicting itself.
const SCRIPTS: Record<Settings['locale'], { language: string; script: string }> = {
  zh: { language: 'zh', script: 'Hans' }, 'zh-tw': { language: 'zh', script: 'Hant' },
  en: { language: 'en', script: 'Latn' }, ja: { language: 'ja', script: 'Jpan' },
}

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '')

// 风控 wants the client to describe its graphics stack. An anonymous request that is correctly signed
// and carries the site's own visitor cookies is still refused when any of these is missing, so the
// listing API cannot be called without a page having run somewhere. Measured against the live API:
// presence is what is checked, not the values - a renderer string belonging to another card is
// accepted, and so is an empty one, which is all a machine without WebGL has to report. They are
// still read off this machine rather than hardcoded, because one constant shared by every install is
// itself the thing that makes a population of clients recognisable.
function device(print: Fingerprint): Record<string, string> {
  return {
    dm_img_list: '[]',
    dm_img_str: base64(print.glVersion),
    // The page truncates this one, so the same is done here rather than sending a longer string than
    // any browser would.
    dm_cover_img_str: base64(`${print.glRenderer}${print.glVendor}`).slice(0, 130),
    // Shape taken from the page's own request; its numbers are an obfuscation of viewport and scroll
    // geometry whose mapping is not known. Dropping the parameter is refused, so this window's real
    // size travels in the same three slots.
    dm_img_inter: JSON.stringify({ ds: [], wh: [print.width, print.height, 0], of: [0, 0, 0] }),
  }
}

function midOf(url: URL): string {
  return /^\/(\d+)/.exec(url.pathname)?.[1] || /\/space\/(\d+)/.exec(url.pathname)?.[1] || ''
}

// 哔哩哔哩 keeps the day's keys in its own localStorage, under both a joined and a separate form. A page
// that has been loaded has already paid for them, so the nav call below is only for a walk that never
// opened one - a warm-up is skipped when the host's cookies are still good.
function storedKeys(storage: Record<string, string> | undefined): { image: string; sub: string } | undefined {
  if (!storage) return undefined
  // The joined form is '<img>-<sub>'; the separate keys need no splitting, so they are read first.
  const joined = /^(\S+?)-(https?:\/\/\S+)$/.exec(storage.wbi_img_urls || '')
  const image = keyOf(storage.wbi_img_url || joined?.[1] || '')
  const sub = keyOf(storage.wbi_sub_url || joined?.[2] || '')
  return image && sub ? { image, sub } : undefined
}

async function mixin(fetch: Fetcher, storage: Record<string, string> | undefined, signal: AbortSignal): Promise<string> {
  // The keys rotate daily; half an hour keeps a long session from re-fetching them on every page.
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.mixin
  let keys = storedKeys(storage)
  if (!keys) {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { referrer: 'https://www.bilibili.com/', signal })
    const body = await response.json() as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
    keys = { image: keyOf(body.data?.wbi_img?.img_url || ''), sub: keyOf(body.data?.wbi_img?.sub_url || '') }
  }
  if (!keys.image || !keys.sub) throw new Error('未能取得 wbi 签名密钥')
  cached = { mixin: mixinKey(keys.image, keys.sub), at: Date.now() }
  return cached.mixin
}

// 'video_review' is the danmaku count despite the name; 'comment' is the ordinary reply count.
type Video = { bvid?: string; title?: string; pic?: string; author?: string; play?: number; video_review?: number; comment?: number; length?: string; created?: number }
type SearchResponse = {
  code?: number; message?: string
  data?: { list?: { vlist?: Video[] }; page?: { count?: number; pn?: number; ps?: number } }
}

function count(value: number | undefined): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined
}

function entryOf(video: Video): ListingEntry | undefined {
  if (!video.bvid) return undefined
  const cover = (video.pic || '').replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://')
  return {
    id: video.bvid, url: `https://www.bilibili.com/video/${video.bvid}`, title: video.title?.trim() || `哔哩哔哩视频 ${video.bvid}`,
    thumbnail: cover || undefined, kind: 'video', duration: seconds(video.length),
    views: count(video.play), danmaku: count(video.video_review), comments: count(video.comment),
    author: video.author?.trim() || undefined, publishedAt: video.created || undefined,
  }
}

// Pages that live under a space but are not the 投稿 grid. A space URL is 'space.bilibili.com/<mid>'
// plus whatever tab, so the mid alone cannot tell them apart, and answering a collection link with the
// author's entire output is the wrong listing rather than a smaller one. 合集 and 系列 are served by
// their own adapter; 收藏夹 is out of scope, so it falls through to the engine.
const NOT_UPLOADS = /^\/\d+\/(lists|channel\/(collectiondetail|seriesdetail)|favlist)\b/

export const bilibili: ProfileAdapter = {
  id: 'bilibili',
  matches(url) {
    if (NOT_UPLOADS.test(url.pathname)) return false
    return url.hostname === 'space.bilibili.com' && Boolean(midOf(url))
      || /(^|\.)bilibili\.com$/.test(url.hostname) && /\/space\/\d+/.test(url.pathname)
  },
  // A space lands on 主页, whose feed renders too late and too partially to read; 投稿 holds the same
  // posts in a plain grid and issues the listing request the fallback route listens for. The site
  // redirects a bare /video to /upload/video, so the tab is named the way the page itself ends up.
  entryUrl(url) {
    const target = new URL(url.href)
    if (target.hostname === 'space.bilibili.com') target.pathname = target.pathname.replace(/^\/(\d+)\/?$/, '/$1/upload/video')
    return target.href
  },
  async fetchPage({ url, page, fetch, locale, fingerprint, storage, signal }: PageRequest): Promise<ListingPage> {
    const mid = midOf(url)
    if (!mid) throw new Error('链接中没有 UID')
    // Nothing to tell 风控 about the graphics stack, so this route is closed before it is tried and the
    // walk belongs in a window, where the values exist.
    if (!fingerprint) throw new Error('未能取得浏览器指纹')
    const query = signQuery({
      mid, pn: page, ps: PAGE_SIZE, tid: 0, special_type: '', order: 'pubdate', index: 0, keyword: '',
      order_avoided: 'true', platform: 'web', web_location: LOCATION,
      'x-bili-locale-json': JSON.stringify({ c_locale: SCRIPTS[locale] || SCRIPTS.zh, always_translate: false }),
      'x-bili-device-req-json': JSON.stringify({ platform: 'web', device: 'pc', spmid: LOCATION, mobi_app: 'web_cn' }),
      ...device(fingerprint),
    }, await mixin(fetch, storage, signal))
    const response = await fetch(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, {
      // The space page must be named as the referrer or the API answers -352, and it has to travel as
      // fetch's own 'referrer' option: a Referer header set by hand is rejected before it leaves.
      referrer: `https://space.bilibili.com/${mid}/upload/video`, signal,
    })
    // Risk control answers with an HTML challenge page rather than JSON; that is a closed route, not a reply.
    const body = await response.json().catch(() => { throw new VerificationRequired('哔哩哔哩返回了验证页面而不是列表数据。请打开验证页面完成验证后重试。') }) as SearchResponse
    // -352 and -799 are the risk-control rejections; both mean this route is closed for now.
    if (body.code) throw new Error(`哔哩哔哩接口返回 ${body.code}${body.message ? `：${body.message}` : ''}`)
    const videos = body.data?.list?.vlist || []
    const entries = videos.map(entryOf).filter((entry): entry is ListingEntry => Boolean(entry))
    const total = body.data?.page?.count
    const author = videos.find(video => video.author)?.author
    return onePage('uploads', author ? `${author}的投稿` : undefined, entries, { index: page, size: PAGE_SIZE, total, hasMore: total === undefined ? entries.length === PAGE_SIZE : page * PAGE_SIZE < total })
  },
}
