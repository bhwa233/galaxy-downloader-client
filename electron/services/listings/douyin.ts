// 抖音 signs every listing call with 'a_bogus', computed by obfuscated script. Nothing here reproduces
// it, and nothing needs to: the security SDK replaces the page's own window.fetch, so a request issued
// from inside the page is signed on its way out. Measured against the live API - a call carrying only
// the business and device parameters, with no a_bogus, no msToken and no x-secsdk-web-signature,
// answers status_code 0 with a full page of posts. This is the route the client already takes.
import { i18n } from '../../../shared/i18n'
import { LoginRequired, VerificationRequired } from '../login'
import { isRecord, onePage, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'

// What the page asks for. It is answered with a few more than it asked, so the page size is never
// assumed: every reply reports the length it actually held.
const COUNT = 18
const HOST = 'https://www.douyin.com'

// The descriptors the page sends about itself. Screen and viewport measurements are deliberately left
// out rather than invented: the reduced set is accepted, and a made-up screen size would be a claim
// this process cannot support.
const CLIENT = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
  pc_client_type: '1', update_version_code: '170400',
  version_code: '290100', version_name: '29.1.0', cookie_enabled: 'true', platform: 'PC',
} as const

// How the listing itself is asked for, as opposed to who is asking.
const LISTING = {
  locate_query: 'false', show_live_replay_strategy: '1', need_time_list: '1', time_list_query: '0',
  whale_cut_token: '', cut_version: '1', publish_video_strategy_type: '2', from_user_page: '1',
} as const

type Image = { url_list?: string[] }
type Post = {
  aweme_id?: string; desc?: string; create_time?: number; media_type?: number
  video?: { cover?: { url_list?: string[] }; duration?: number }
  images?: Image[] | null
  author?: { nickname?: string }
  mix_info?: { mix_name?: string }
  // 'play_count' is always zero on the web listing, so it is never read: a card saying 0 plays for a
  // post with four hundred thousand likes would be worse than a card saying nothing.
  statistics?: { digg_count?: number; comment_count?: number }
  // How a paid 短剧 episode says so (measured 2026-09-23 on 《嫌疑人的秘密》: episodes 12 on carry
  // paid_type 1, the free ones 0). 'series_paid_status' is read as this account having bought it.
  entertainment_video_paid_way?: { paid_type?: number }
  series_paid_info?: { series_paid_status?: number }
}
type PostsResponse = { status_code?: number; status_msg?: string; aweme_list?: Post[]; has_more?: number; max_cursor?: number }

function secUserIdOf(url: URL): string {
  return /\/user\/([^/?#]+)/.exec(url.pathname)?.[1] || ''
}

// Which of the profile's three tabs is being read. The address already says so; what it used to do was
// overwrite it with 'post', so 喜欢 and 推荐 both answered with the user's own uploads - the wrong
// listing rather than a smaller one.
export type Tab = 'post' | 'like' | 'recommend'
export function tabOf(url: URL): Tab {
  const stated = url.searchParams.get('showTab')
  return stated === 'like' || stated === 'recommend' ? stated : 'post'
}

// One endpoint per tab, each the one the profile page itself calls for that tab (captured from the
// client's own session, 2026-09-23). All three answer in the same shape. A 喜欢 or 推荐 the owner keeps
// private answers status 0 with an empty list; the page then shows "推荐内容不可见" and asks for nothing.
const ENDPOINT: Record<Tab, string> = {
  post: 'aweme/v1/web/aweme/post/',
  like: 'aweme/v1/web/aweme/favorite/',
  recommend: 'aweme/v1/web/familiar/recommend/feed/',
}

// The cursor each page ended on. Pages are reached by cursor, so without this the walk to page 5 starts
// over at the beginning every time the user turns it - four requests for one page, and the pacing that
// goes with each. Remembering where the page before ended makes the ordinary case one request.
// One profile at a time is all a listing on screen can be, so a second one simply replaces the first.
let walked: { key: string; cursors: Map<number, number> } | undefined

function resume(key: string, page: number): { from: number; at: number } {
  if (walked?.key !== key) { walked = { key, cursors: new Map() }; return { from: 0, at: 1 } }
  // The deepest page at or before this one that is already known, so a jump forward still walks but a
  // step forward does not.
  let at = 1
  for (const reached of walked.cursors.keys()) if (reached < page && reached >= at) at = reached + 1
  return { from: at > 1 ? walked.cursors.get(at - 1) || 0 : 0, at: at > 1 ? at : 1 }
}

const count = (value: number | undefined) => typeof value === 'number' && value > 0 ? value : undefined

export function entryOf(post: Post): ListingEntry | undefined {
  const id = post.aweme_id?.trim()
  if (!id) return undefined
  const images = Array.isArray(post.images) ? post.images : []
  const image = images.length > 0
  return {
    id,
    // The page links a picture post as a 笔记 and a video as a 视频; following its own form keeps the
    // address one the site will serve rather than one it has to redirect.
    url: `${HOST}/${image ? 'note' : 'video'}/${id}`,
    title: post.desc?.trim() || i18n.t('errors:douyin.post', { id }),
    thumbnail: post.video?.cover?.url_list?.[0] || images[0]?.url_list?.[0],
    kind: image ? 'image' : 'video',
    // Reported in milliseconds, and zero on a picture post that has no video behind it.
    duration: post.video?.duration ? Math.round(post.video.duration / 1000) : undefined,
    likes: count(post.statistics?.digg_count),
    comments: count(post.statistics?.comment_count),
    author: post.author?.nickname?.trim() || undefined,
    wall: post.entertainment_video_paid_way?.paid_type === 1 && !post.series_paid_info?.series_paid_status ? 'purchase' : undefined,
    publishedAt: post.create_time || undefined,
  }
}

// 'user/self' is the signed-in user's own page and carries no sec_user_id at all: the literal 'self'
// in the path is not one, and handing it to the API asks about a user that does not exist. The page
// asks 'user/profile/self/' who that is, and so does this; no answer is a sign-in problem. Page storage
// is no substitute: it also holds other users' ids (a 'LOG_TRACE' entry in the session this was
// measured on), and taking the first one found listed a stranger's posts as the user's own.
async function ownId(fetch: PageRequest['fetch'], signal: AbortSignal): Promise<string> {
  const response = await fetch(`${HOST}/aweme/v1/web/user/profile/self/?${new URLSearchParams(CLIENT)}`, { signal })
  const body = await response.json().catch(() => undefined) as { user?: { sec_uid?: string } } | undefined
  return isRecord(body) ? body.user?.sec_uid?.trim() || '' : ''
}

export const douyin: ProfileAdapter = {
  id: 'douyin',
  matches(url) {
    return /(^|\.)douyin\.com$/.test(url.hostname) && Boolean(secUserIdOf(url))
  },
  // The tab the address already names is kept; only an address that named none is sent to 作品.
  entryUrl(url) {
    const target = new URL(url.href)
    target.searchParams.set('showTab', tabOf(url))
    return target.href
  },
  async fetchPage({ url, page, fetch, signal }: PageRequest): Promise<ListingPage | undefined> {
    const tab = tabOf(url)
    let sec = secUserIdOf(url)
    if (!sec) throw new Error(i18n.t('errors:listing.noUserKey'))
    if (sec === 'self') {
      sec = await ownId(fetch, signal)
      if (!sec) throw new LoginRequired(i18n.t('errors:douyin.myProfile'))
    }
    // The cursor cache is per tab as well as per user: 作品 and 喜欢 are different listings walked with
    // different cursors, and one key for both would hand a page of one the other's place in the walk.
    const { from, at } = resume(`${sec}|${tab}`, page)
    let cursor = from
    let body: PostsResponse = {}
    // Whatever is left of the walk: one request when the page before this one is already known, and
    // only a jump into an unread part of the listing pays for the pages it skips over.
    for (let reached = at; reached <= page; reached += 1) {
      signal.throwIfAborted()
      const query = new URLSearchParams({ ...CLIENT, ...LISTING, sec_user_id: sec, count: String(COUNT), max_cursor: String(cursor) })
      const response = await fetch(`${HOST}/${ENDPOINT[tab]}?${query}`, { signal })
      body = await response.json().catch(() => { throw new VerificationRequired(i18n.t('errors:douyin.verification')) }) as PostsResponse
      // A tab whose endpoint this adapter guessed wrong answers 404 or with something that is not a
      // listing at all. That is this adapter being wrong rather than 抖音 refusing, so it stands down.
      if (tab !== 'post' && (response.status >= 400 || !isRecord(body))) return undefined
      if (body.status_code) throw new Error(body.status_msg ? i18n.t('errors:douyin.apiMessage', { code: body.status_code, message: body.status_msg }) : i18n.t('errors:douyin.api', { code: body.status_code }))
      // A reply holding nothing but its status code is how 抖音 refuses to go deeper: the response to
      // the page's own request carries 'whale-decision-custom: black_no_login', and a signed-out visitor
      // is served the first page and no more. Named as a sign-in rather than a plain failure, because
      // that is what it is and the window that fixes it is one the client can offer.
      // 喜欢 has a second reason to be empty - the user can hide it - and that is said as itself.
      // A hidden 推荐 answers aweme_list null even to a signed-in visitor, so for that tab no list on the
      // first page is privacy rather than a sign-in problem (measured 2026-09-23).
      if (reached === 1 && !body.aweme_list?.length && (tab === 'recommend' || (tab === 'like' && Array.isArray(body.aweme_list)))) {
        throw new Error(i18n.t(tab === 'like' ? 'errors:douyin.privateLikes' : 'errors:douyin.privateRecommended'))
      }
      if (!body.aweme_list) {
        if (tab === 'like' && reached === 1) throw new LoginRequired(i18n.t('errors:douyin.noLikes'))
        throw new LoginRequired(i18n.t('errors:douyin.signInForMore', { page: reached }))
      }
      // Where this page ended, so the page after it can start here instead of at the beginning.
      if (body.max_cursor) walked?.cursors.set(reached, body.max_cursor)
      if (reached === page) break
      if (!body.has_more || !body.max_cursor) break
      cursor = body.max_cursor
    }
    const entries = (body.aweme_list || []).map(entryOf).filter((entry): entry is ListingEntry => Boolean(entry))
    const author = (body.aweme_list || []).find(post => post.author?.nickname)?.author?.nickname
    // The reply holds a few more than were asked for, so the page reports what it actually carried.
    const named = ({ post: 'errors:douyin.posts', like: 'errors:douyin.likes', recommend: 'errors:douyin.recommended' } as const)[tab]
    return onePage('posts', author ? i18n.t(named, { author }) : undefined, entries, { index: page, size: entries.length, hasMore: Boolean(body.has_more && body.max_cursor) })
  },
}

// A 合集 of one creator's works. The link the site itself uses is 'douyin.com/collection/<mix_id>';
// the id also turns up on a work that belongs to one, which is what the video adapter below reads.
//
// Checked in the client on 2026-09-23: '/collection/<mix_id>' lists the 合集, and a 短剧 episode's mix
// is the whole show, walked page by page through 'cursor'. A reply that is not this shape still makes
// the adapter stand down.
function mixIdOf(url: URL): string {
  if (!/(^|\.)douyin\.com$/.test(url.hostname)) return ''
  return /^\/collection\/(\d+)/.exec(url.pathname)?.[1] || (/^\/mix\/detail\/(\d+)/.exec(url.pathname)?.[1] || '')
}

async function mixPage(fetch: PageRequest['fetch'], mix: string, page: number, signal: AbortSignal): Promise<ListingPage | undefined> {
  const { from, at } = resume(`mix|${mix}`, page)
  let cursor = from
  let body: PostsResponse = {}
  for (let reached = at; reached <= page; reached += 1) {
    signal.throwIfAborted()
    const query = new URLSearchParams({ ...CLIENT, mix_id: mix, count: String(COUNT), cursor: String(cursor) })
    const response = await fetch(`${HOST}/aweme/v1/web/mix/aweme/?${query}`, { signal })
    const reply = await response.json().catch(() => undefined) as (PostsResponse & { cursor?: number }) | undefined
    // Not a listing. That is this adapter being wrong about the endpoint, not 抖音 refusing.
    if (response.status >= 400 || !isRecord(reply)) return undefined
    body = reply
    if (body.status_code) throw new Error(body.status_msg ? i18n.t('errors:douyin.apiMessage', { code: body.status_code, message: body.status_msg }) : i18n.t('errors:douyin.api', { code: body.status_code }))
    if (!Array.isArray(body.aweme_list)) {
      if (reached === 1) throw new LoginRequired(i18n.t('errors:douyin.collectionEmpty'))
      throw new LoginRequired(i18n.t('errors:douyin.signInForMore', { page: reached }))
    }
    // The mix endpoint reports where it stopped as 'cursor'; the profile one calls it 'max_cursor'.
    const ended = reply.cursor ?? body.max_cursor
    if (ended) walked?.cursors.set(reached, ended)
    if (reached === page || !body.has_more || !ended) break
    cursor = ended
  }
  const entries = (body.aweme_list || []).map(entryOf).filter((entry): entry is ListingEntry => Boolean(entry))
  // The 合集's own name - for a 短剧 that is the show's title. One creator publishes many of them, and
  // naming each after its creator would file every show they made into the same directory.
  const named = (body.aweme_list || []).find(post => post.mix_info?.mix_name?.trim())?.mix_info?.mix_name?.trim()
  const author = (body.aweme_list || []).find(post => post.author?.nickname)?.author?.nickname
  const title = named || (author ? i18n.t('errors:douyin.authorCollection', { author }) : i18n.t('errors:douyin.collection'))
  return { title, kind: 'collection', groups: [{ id: 'collection', title, directory: title, entries, pagination: { index: page, size: entries.length, hasMore: Boolean(body.has_more) } }] }
}

export const douyinCollection: ProfileAdapter = {
  id: 'douyin-collection',
  matches(url) { return Boolean(mixIdOf(url)) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, fetch, signal }: PageRequest): Promise<ListingPage | undefined> {
    const mix = mixIdOf(url)
    if (!mix) throw new Error(i18n.t('errors:listing.noCollectionId'))
    return await mixPage(fetch, mix, page, signal)
  },
}

// A work's own page. Like the 哔哩哔哩 one beside it, this claims more than it lists: only the work can
// say whether a 合集 is behind it, so it reads the work and stands down when there is not - which is
// every ordinary 抖音 video, and is the engine's job.
function awemeIdOf(url: URL): string {
  if (!/(^|\.)douyin\.com$/.test(url.hostname)) return ''
  return /^\/(?:video|note)\/(\d+)/.exec(url.pathname)?.[1] || ''
}

export const douyinVideo: ProfileAdapter = {
  id: 'douyin-video',
  matches(url) { return Boolean(awemeIdOf(url)) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, group, fetch, signal }: PageRequest): Promise<ListingPage | undefined> {
    const aweme = awemeIdOf(url)
    if (!aweme) throw new Error(i18n.t('errors:listing.noWorkId'))
    const query = new URLSearchParams({ ...CLIENT, aweme_id: aweme })
    const response = await fetch(`${HOST}/aweme/v1/web/aweme/detail/?${query}`, { signal })
    const body = await response.json().catch(() => undefined) as { aweme_detail?: { mix_info?: { mix_id?: string } } } | undefined
    // No detail, no mix field, or no mix: one work, which the engine downloads on its own. Standing
    // down here is the common case, not the exception.
    const mix = isRecord(body) ? body.aweme_detail?.mix_info?.mix_id : undefined
    if (response.status >= 400 || !mix) return undefined
    return await mixPage(fetch, String(mix), group === 'collection' ? page : 1, signal)
  },
}

// 短剧 catalogue. 'douyin.com/series' without a modal_id is the catalogue of shows; an episode link
// is rewritten to '/video/<modal_id>' before it ever reaches here (see normalizeUrl). Captured signed
// in on 2026-09-23: the page reads 'series/card/feed' by offset, 16 shows a page, each card's
// 'series_id' being the show's 合集 id - so a show is listed as the 合集 link it is, marked whole, and
// picking one queues every episode of it (Parser.expand walks the 合集).
type Show = { series_id?: string; series_name?: string; desc?: string; cover_url?: Image; stats?: { total_episode?: number; updated_to_episode?: number; play_vv?: number }; author?: { nickname?: string } }
type Catalogue = { status_code?: number; status_msg?: string; card_list?: { series?: Show }[]; has_more?: boolean | number; offset?: number }
const SHOWS = 16

export const douyinSeries: ProfileAdapter = {
  id: 'douyin-series',
  matches(url) { return /(^|\.)douyin\.com$/.test(url.hostname) && /^\/series\/?$/.test(url.pathname) && !url.searchParams.get('modal_id') },
  entryUrl(url) { return url.href },
  async fetchPage({ page, fetch, signal }: PageRequest): Promise<ListingPage | undefined> {
    const query = new URLSearchParams({ ...CLIENT, offset: String((page - 1) * SHOWS), count: String(SHOWS) })
    const response = await fetch(`${HOST}/aweme/v1/web/series/card/feed/?${query}`, { signal })
    const body = await response.json().catch(() => undefined) as Catalogue | undefined
    if (response.status >= 400 || !isRecord(body) || !Array.isArray(body.card_list)) return undefined
    if (body.status_code) throw new Error(body.status_msg ? i18n.t('errors:douyin.apiMessage', { code: body.status_code, message: body.status_msg }) : i18n.t('errors:douyin.api', { code: body.status_code }))
    const entries = body.card_list.map(card => card.series).filter((show): show is Show => Boolean(show?.series_id)).map((show): ListingEntry => {
      const episodes = show.stats?.total_episode || show.stats?.updated_to_episode
      return {
        id: show.series_id!, url: `${HOST}/collection/${show.series_id}`, whole: true, kind: 'video',
        title: `${show.series_name?.trim() || i18n.t('errors:douyin.show', { id: show.series_id })}${episodes ? i18n.t('errors:douyin.episodes', { count: episodes }) : ''}`,
        thumbnail: show.cover_url?.url_list?.[0], views: count(show.stats?.play_vv), author: show.author?.nickname?.trim() || undefined,
      }
    })
    if (!entries.length && page === 1) throw new LoginRequired(i18n.t('errors:douyin.showsEmpty'))
    return onePage('shows', i18n.t('errors:douyin.shows'), entries, { index: page, size: SHOWS, hasMore: Boolean(body.has_more) })
  },
}
