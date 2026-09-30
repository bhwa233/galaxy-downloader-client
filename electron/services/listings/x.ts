// X user timelines. The listing is the GraphQL call the profile page makes for itself, issued from
// inside that page so the cookies and the TLS handshake are the browser's.
//
// Two things a request to it needs are not knowable from out here, and both are read off the page
// rather than reproduced: the CSRF token, which X keeps in the 'ct0' cookie its own scripts read, and
// the operation id of the timeline query, which changes with every deploy and lives in the page's own
// script bundle. Reading what the page already holds is different from reproducing a signature - see
// the note on Evaluate in types.ts.
//
// Checked signed in on 2026-09-23: the signed-in site is still the responsive-web bundle (main.*.js)
// holding these query ids, and UserByScreenName / UserMedia answer the shape below to a request
// without X's own x-client-transaction-id. UserMedia is the profile's 媒体 tab: only posts carrying a
// picture or a video, where UserTweets spent most of each page on text posts this client drops (3 of
// 20 kept on the page it was measured on). Signed out, X serves a different front end (x-web) with no
// query ids at all, so this stands down and the page is swept instead. Every step still stands down
// rather than insisting: no token, no operation id, or a reply that is not this shape.
import { LoginRequired } from '../login'
import { isRecord, onePage, type Evaluate, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'

const HOST = 'https://x.com'
// The public web client's bearer. A constant of the site, the same for every visitor, and the request
// is refused without it; it is not a credential of any account.
const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const COUNT = 20
// Paths under x.com that are the site rather than somebody's timeline.
const NOT_A_PROFILE = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose', 'login', 'intent', 'hashtag', 'about', 'tos', 'privacy'])

export function handleOf(url: URL): string {
  if (!/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) return ''
  const parts = url.pathname.split('/').filter(Boolean)
  // '/<handle>' is the timeline; '/<handle>/status/<id>' is one post and belongs to the engine.
  if (parts.length !== 1 || NOT_A_PROFILE.has(parts[0].toLowerCase())) return ''
  return /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) ? parts[0] : ''
}

type Media = { type?: string; media_url_https?: string; video_info?: { duration_millis?: number; variants?: { bitrate?: number; url?: string }[] } }
type Legacy = {
  id_str?: string; full_text?: string; created_at?: string
  favorite_count?: number; reply_count?: number
  entities?: { media?: Media[] }; extended_entities?: { media?: Media[] }
}
type Tweet = { rest_id?: string; legacy?: Legacy; core?: { user_results?: { result?: { legacy?: { screen_name?: string } } } } }

// The operation ids X is using right now, found in its own script bundle. Cached for the run: they
// change with a deploy, not between two pages of one listing.
let operations: Record<string, string> | undefined

// Searched inside the page, and fetched there without credentials: abs.twimg.com answers without CORS
// headers, so the credentialed fetch every adapter request goes through is refused outright (measured
// 2026-09-23 - that refusal is what made this adapter stand down on every profile). Only the ids come
// back, not the megabytes of script they were found in.
const FIND_OPERATIONS = `(async () => {
  const names = ['UserMedia', 'UserByScreenName', 'TweetResultByRestId']
  const found = {}
  // Bounded: the bundle wanted is one of the first few (main.*.js when signed in), and reading a
  // site's whole script list looking for something is not a thing to do without an end to it.
  const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src).filter(s => /abs\\.twimg\\.com/.test(s)).slice(0, 12)
  for (const script of scripts) {
    if (names.every(name => found[name])) break
    let text = ''
    try { text = await (await fetch(script)).text() } catch { continue }
    for (const name of names) {
      const matched = new RegExp('queryId:"([\\\\w-]+)",operationName:"' + name + '"').exec(text)
        || new RegExp('operationName:"' + name + '",queryId:"([\\\\w-]+)"').exec(text)
      if (matched) found[name] = matched[1]
    }
  }
  return found
})()`

async function operationIds(evaluate: Evaluate, signal: AbortSignal): Promise<Record<string, string>> {
  if (operations) return operations
  signal.throwIfAborted()
  const found = await evaluate<Record<string, string>>(FIND_OPERATIONS).catch(() => ({} as Record<string, string>))
  if (found.UserMedia && found.UserByScreenName && found.TweetResultByRestId) operations = found
  return found
}

const count = (value: number | undefined) => typeof value === 'number' && value >= 0 ? value : undefined

// The feature flags every query here is sent with; the reduced set is accepted.
const FEATURES = { responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true }

export function entryOf(tweet: Tweet, author?: string): ListingEntry | undefined {
  const legacy = tweet.legacy
  const id = legacy?.id_str || tweet.rest_id
  if (!legacy || !id) return undefined
  const media = legacy.extended_entities?.media || legacy.entities?.media || []
  // A post with no media is text - a 长文 included - and text is not what this client downloads.
  if (!media.length) return undefined
  const video = media.find(item => item.type === 'video' || item.type === 'animated_gif')
  const posted = legacy.created_at ? Date.parse(legacy.created_at) : NaN
  return {
    id, url: `${HOST}/${author || 'i'}/status/${id}`,
    title: legacy.full_text?.replace(/https?:\/\/t\.co\/\w+/g, '').trim().split('\n')[0].slice(0, 80) || `X ${id}`,
    thumbnail: media[0]?.media_url_https,
    // A GIF on X is a silent video file, so it downloads as one.
    kind: video ? 'video' : 'image',
    duration: video?.video_info?.duration_millis ? Math.round(video.video_info.duration_millis / 1000) : undefined,
    likes: count(legacy.favorite_count), comments: count(legacy.reply_count),
    author, publishedAt: Number.isNaN(posted) ? undefined : Math.floor(posted / 1000),
  }
}

// The timeline arrives as instructions, each holding entries, each holding either a post or a cursor.
function harvest(payload: unknown, author: string | undefined, into: Map<string, ListingEntry>): string | undefined {
  let next: string | undefined
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) walk(item); return }
    const record = value as Record<string, unknown>
    const content = record.content as Record<string, unknown> | undefined
    const cursor = content?.value
    if (content?.cursorType === 'Bottom' && typeof cursor === 'string') next = cursor
    const result = (record.tweet_results as { result?: Tweet } | undefined)?.result
    if (result) {
      const entry = entryOf(result, result.core?.user_results?.result?.legacy?.screen_name || author)
      if (entry) into.set(entry.id, entry)
    }
    for (const key of Object.keys(record)) walk(record[key])
  }
  walk(payload)
  return next
}

// Where each page ended. X pages by an opaque cursor, so a step forward is one request and only a
// jump into an unread part pays for the pages it skips.
let walked: { key: string; cursors: Map<number, string> } | undefined
function resume(key: string, page: number): { from: string; at: number } {
  if (walked?.key !== key) { walked = { key, cursors: new Map() }; return { from: '', at: 1 } }
  let at = 1
  for (const reached of walked.cursors.keys()) if (reached < page && reached >= at) at = reached + 1
  return { from: at > 1 ? walked.cursors.get(at - 1) || '' : '', at: at > 1 ? at : 1 }
}

export const x: ProfileAdapter = {
  id: 'x',
  matches(url) { return Boolean(handleOf(url)) },
  entryUrl(url) { return `${HOST}/${handleOf(url)}` },
  async fetchPage({ url, page, fetch, evaluate, signal }: PageRequest): Promise<ListingPage | undefined> {
    const handle = handleOf(url)
    if (!handle) throw new Error('链接中没有用户名')
    // Without a way to read the page there is nothing to read the token or the operation ids from,
    // and neither can be invented here.
    if (!evaluate) return undefined
    // Not httpOnly, because X's own scripts read it to put it on every request they make.
    const token = await evaluate<string>(`(document.cookie.match(/(?:^|; )ct0=([^;]+)/) || [])[1] || ''`).catch(() => '')
    if (!token) throw new LoginRequired('X 没有给这个访客发出请求令牌，通常是还没有登录。请打开登录窗口完成登录后重试。')
    const ids = await operationIds(evaluate, signal)
    // The operation ids were not where this expects them. That is this adapter being out of date with
    // X's bundle rather than X refusing, so the address goes back to the ordinary route.
    if (!ids.UserMedia || !ids.UserByScreenName) return undefined
    const headers = { authorization: BEARER, 'x-csrf-token': token, 'content-type': 'application/json' }
    const referrer = `${HOST}/${handle}`
    const call = async (operation: string, variables: object, features: object) =>
      await fetch(`${HOST}/i/api/graphql/${ids[operation]}/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`, { headers, referrer, signal })

    // Everything below takes a numeric user id, which only the handle lookup can give.
    const lookup = await call('UserByScreenName', { screen_name: handle, withSafetyModeUserFields: true }, FEATURES)
    const profile = await lookup.json().catch(() => undefined) as { data?: { user?: { result?: { rest_id?: string } } } } | undefined
    if (lookup.status >= 400 || !isRecord(profile) || !isRecord(profile.data)) return undefined
    const rest = profile.data.user?.result?.rest_id
    if (!rest) throw new LoginRequired('没有读到这个账号。它可能不存在，也可能只对已登录的访客可见。请打开登录窗口完成登录后重试。')

    const { from, at } = resume(handle, page)
    let cursor = from
    const entries = new Map<string, ListingEntry>()
    let more: string | undefined
    for (let reached = at; reached <= page; reached += 1) {
      signal.throwIfAborted()
      entries.clear()
      const response = await call('UserMedia', { userId: rest, count: COUNT, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: true, withV2Timeline: true, ...(cursor ? { cursor } : {}) }, FEATURES)
      const body = await response.json().catch(() => undefined) as { data?: unknown; errors?: { message?: string }[] } | undefined
      if (response.status >= 400 || !isRecord(body)) return undefined
      if (body.errors?.length) throw new Error(`X 接口返回拒绝：${body.errors[0]?.message || '未说明原因'}`)
      if (!isRecord(body.data)) return undefined
      more = harvest(body.data, handle, entries)
      if (more) walked?.cursors.set(reached, more)
      if (reached === page || !more) break
      cursor = more
    }
    if (!entries.size && page === 1) throw new LoginRequired('这个时间线没有读到任何带媒体的帖子。可能是受保护的账号，也可能需要登录后才能看到。请打开登录窗口完成登录后重试。')
    return onePage('posts', `${handle} 的媒体`, [...entries.values()], { index: page, size: COUNT, hasMore: Boolean(more) })
  },
}

// One post: '/<handle>/status/<id>', with or without the '/photo/<n>' a picture link adds.
export function postIdOf(url: URL): string {
  if (!/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) return ''
  return /^\/\w{1,15}\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/.exec(url.pathname)?.[1] || ''
}

// The file a clip is served as: the highest-bitrate mp4 among its variants. The playlist variant has
// no bitrate and is not a file.
function clipOf(media: Media): string | undefined {
  return (media.video_info?.variants || []).filter(variant => variant.url && /\.mp4(\?|$)/.test(variant.url)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url
}

// A picture post, which the engine has no extractor for: it answers "no video" and the page sweep
// only collects pictures on articles. Read through TweetResultByRestId, the query the post page
// itself runs (captured signed in on 2026-09-23: two pictures, each at media_url_https). A post with
// no picture at all is a video post and stands down - the engine serves those, with quality choice.
export const xPost: ProfileAdapter = {
  id: 'x-post',
  post: true,
  matches(url) { return Boolean(postIdOf(url)) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, fetch, evaluate, signal }: PageRequest): Promise<ListingPage | undefined> {
    const id = postIdOf(url)
    if (!id) throw new Error('链接中没有帖子编号')
    if (!evaluate) return undefined
    const token = await evaluate<string>(`(document.cookie.match(/(?:^|; )ct0=([^;]+)/) || [])[1] || ''`).catch(() => '')
    if (!token) throw new LoginRequired('X 没有给这个访客发出请求令牌，通常是还没有登录。请打开登录窗口完成登录后重试。')
    const ids = await operationIds(evaluate, signal)
    if (!ids.TweetResultByRestId) return undefined
    const variables = { tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false }
    const response = await fetch(`${HOST}/i/api/graphql/${ids.TweetResultByRestId}/TweetResultByRestId?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`, {
      headers: { authorization: BEARER, 'x-csrf-token': token, 'content-type': 'application/json' }, referrer: url.href, signal,
    })
    const body = await response.json().catch(() => undefined) as { data?: { tweetResult?: { result?: Tweet & { tweet?: Tweet } } } } | undefined
    if (response.status >= 400 || !isRecord(body) || !isRecord(body.data)) return undefined
    // A post shown with a visibility notice comes wrapped one level down.
    const found = body.data.tweetResult?.result
    const tweet = found?.tweet || found
    const media = tweet?.legacy?.extended_entities?.media || tweet?.legacy?.entities?.media || []
    if (!media.some(item => item.type === 'photo')) return undefined
    const author = tweet?.core?.user_results?.result?.legacy?.screen_name
    const text = tweet?.legacy?.full_text?.replace(/https?:\/\/t\.co\/\w+/g, '').trim().split('\n')[0].slice(0, 80) || `X ${id}`
    const entries = media.map((item, index): ListingEntry | undefined => {
      const photo = item.type === 'photo'
      // 'name=orig' is the uploaded original rather than the display size.
      const file = photo ? (item.media_url_https ? `${item.media_url_https}?name=orig` : undefined) : clipOf(item)
      if (!file) return undefined
      return {
        id: `${id}-${index + 1}`, url: url.href, title: media.length > 1 ? `${text} · ${index + 1}` : text,
        thumbnail: item.media_url_https, kind: photo ? 'image' : 'video', media: file, author,
        duration: item.video_info?.duration_millis ? Math.round(item.video_info.duration_millis / 1000) : undefined,
      }
    }).filter((entry): entry is ListingEntry => Boolean(entry))
    return { title: text, kind: 'post', groups: [{ id: 'files', entries, pagination: { index: 1, size: entries.length, hasMore: false } }] }
  },
}
