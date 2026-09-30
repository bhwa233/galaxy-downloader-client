// Instagram user pages and their Reels tab, read through the endpoints the site's own pages call,
// from inside a page of the site.
//
// Captured signed in on 2026-09-23. The v1 endpoints this used to call are gone for the web client:
// 'web_profile_info' and 'clips/user' answer 429, 'feed/user' answers the app shell. The profile page
// itself reads its grid through GraphQL - 'PolarisProfilePostsQuery' for posts and
// 'PolarisProfileReelsTabContentQuery' for Reels - posted to /graphql/query by doc_id. A request with
// only doc_id and variables, plus the csrf token and the app id, is answered in full; the nodes are the
// v1 media shape entryOf below reads. The doc ids change with a deploy and are read off the page's own
// scripts, the way the X adapter reads its query ids. Anything else stands down.
import { i18n } from '../../../shared/i18n'
import { LoginRequired } from '../login'
import { isRecord, onePage, type Evaluate, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'

const HOST = 'https://www.instagram.com'
// The web app identifies itself with this on every internal call. A constant of the site rather than
// of this client, and the request is refused without it.
const APP_ID = '936619743392459'
// What the profile grid asks for in one scroll.
const COUNT = 12

type Node = {
  id?: string; shortcode?: string; code?: string; pk?: string
  is_video?: boolean; media_type?: number; video_duration?: number
  display_url?: string; thumbnail_src?: string
  image_versions2?: { candidates?: { url?: string }[] }; video_versions?: { url?: string }[]
  edge_media_to_caption?: { edges?: { node?: { text?: string } }[] }
  caption?: { text?: string } | null
  taken_at_timestamp?: number; taken_at?: number
  edge_liked_by?: { count?: number }; like_count?: number
  edge_media_to_comment?: { count?: number }; comment_count?: number
  owner?: { username?: string }; user?: { username?: string }
}

// 'instagram.com/<username>' is the profile. '/p/<code>', '/reel/<code>' and '/tv/<code>' are single
// posts and belong to the engine, which has an extractor for them; so do the site's own pages.
const NOT_A_PROFILE = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'direct', 'accounts', 'about', 'legal', 'developer'])

export function handleOf(url: URL): { user: string; reels: boolean } | undefined {
  if (!/(^|\.)instagram\.com$/.test(url.hostname)) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (!parts.length || NOT_A_PROFILE.has(parts[0].toLowerCase())) return undefined
  if (parts.length > 2) return undefined
  // 'instagram.com/<user>/reels' is the same profile read through its Reels tab.
  if (parts.length === 2 && parts[1] !== 'reels') return undefined
  return { user: parts[0], reels: parts.length === 2 }
}

const count = (value: number | undefined) => typeof value === 'number' && value >= 0 ? value : undefined

export function entryOf(node: Node, fallbackAuthor?: string): ListingEntry | undefined {
  const code = node.shortcode || node.code
  if (!code) return undefined
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || ''
  // media_type 2 is video, 8 is a carousel; the GraphQL shape says so with a boolean instead.
  const video = node.is_video === true || node.media_type === 2
  return {
    id: code,
    // A Reel keeps its own path: the site serves '/p/<code>' for one too, but the address a user
    // recognises is the one they were shown.
    url: `${HOST}/${video && node.media_type === 2 ? 'reel' : 'p'}/${code}/`,
    title: caption.trim().split('\n')[0].slice(0, 80) || `Instagram ${code}`,
    thumbnail: node.display_url || node.thumbnail_src || node.image_versions2?.candidates?.[0]?.url,
    kind: video ? 'video' : 'image',
    duration: node.video_duration ? Math.round(node.video_duration) : undefined,
    likes: count(node.edge_liked_by?.count ?? node.like_count),
    comments: count(node.edge_media_to_comment?.count ?? node.comment_count),
    author: node.owner?.username || node.user?.username || fallbackAuthor,
    publishedAt: node.taken_at_timestamp || node.taken_at || undefined,
  }
}

// The two queries the profile page runs, by the names their doc ids are exported under.
const POSTS = 'PolarisProfilePostsQuery'
const REELS = 'PolarisProfileReelsTabContentQuery'
// Flags the page sends along with each query. Not part of what is asked for, but the query was
// captured with them, and a variable the server expects and does not get is a failure to avoid.
const RELAY = {
  __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
}

// What the page knows that a request needs: the doc ids, found in the scripts it has already loaded
// (fetched there without credentials - the static host sends no CORS headers for a credentialed
// read), the csrf token from its readable cookie, and the profile's numeric id, which the page writes
// into its own markup as "profile_id". Only these come back, not the scripts they were found in.
const READ_PAGE = `(async () => {
  const docs = {}
  const scripts = performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /static\\.cdninstagram\\.com.*\\.js/.test(name))
  for (const script of scripts) {
    if (docs.${POSTS} && docs.${REELS}) break
    let text = ''
    try { text = await (await fetch(script)).text() } catch { continue }
    for (const name of ['${POSTS}', '${REELS}']) {
      const found = new RegExp(name + '_instagramRelayOperation",\\\\[\\\\],\\\\(function\\\\([^)]*\\\\)\\\\{\\\\w+\\\\.exports="(\\\\d+)"').exec(text)
      if (found && !docs[name]) docs[name] = found[1]
    }
  }
  const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || ''
  const profile = (/"profile_id":"(\\d+)"/.exec(document.documentElement.innerHTML) || [])[1] || ''
  return { docs, csrf, profile }
})()`

type PageFacts = { docs: Record<string, string>; csrf: string; profile: string }
type Connection = { edges?: { node?: Node & { media?: Node } }[]; page_info?: { end_cursor?: string | null; has_next_page?: boolean } }
type Reply = { data?: { xdt_api__v1__feed__user_timeline_graphql_connection?: Connection; fetch__XDTUserDict?: { clips_connection?: Connection } }; errors?: { message?: string }[]; require_login?: boolean }

// Where each page ended. Instagram pages by an opaque cursor, so reaching page 5 without this means
// walking from the top every time the user turns it. One profile at a time is all a listing can be.
let walked: { key: string; cursors: Map<number, string> } | undefined

function resume(key: string, page: number): { from: string; at: number } {
  if (walked?.key !== key) { walked = { key, cursors: new Map() }; return { from: '', at: 1 } }
  let at = 1
  for (const reached of walked.cursors.keys()) if (reached < page && reached >= at) at = reached + 1
  return { from: at > 1 ? walked.cursors.get(at - 1) || '' : '', at: at > 1 ? at : 1 }
}

export const instagram: ProfileAdapter = {
  id: 'instagram',
  matches(url) { return Boolean(handleOf(url)) },
  entryUrl(url) {
    const found = handleOf(url)!
    return `${HOST}/${found.user}/${found.reels ? 'reels/' : ''}`
  },
  async fetchPage({ url, page, fetch, evaluate, signal }: PageRequest): Promise<ListingPage | undefined> {
    const found = handleOf(url)
    if (!found) throw new Error(i18n.t('errors:listing.noUsername'))
    // Without a way to read the page there is nothing to take the doc ids from.
    if (!evaluate) return undefined
    const facts = await (evaluate as Evaluate)<PageFacts>(READ_PAGE).catch(() => undefined)
    const doc = facts?.docs[found.reels ? REELS : POSTS]
    // The query is not where this expects it: the adapter is out of date with the site's scripts.
    if (!facts || !doc) return undefined
    if (found.reels && !facts.profile) return undefined
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': facts.csrf, 'x-ig-app-id': APP_ID }
    const referrer = `${HOST}/${found.user}/`
    const { from, at } = resume(`${found.user}|${found.reels}`, page)
    let cursor = from
    let connection: Connection | undefined
    for (let reached = at; reached <= page; reached += 1) {
      signal.throwIfAborted()
      // Posts page by 'after' + 'first'; Reels by 'after' alone (both measured on page 2).
      const variables = found.reels
        ? { data: { include_feed_video: true, page_size: COUNT, target_user_id: facts.profile }, user_id: facts.profile, ...RELAY, ...(cursor ? { after: cursor } : {}) }
        : { data: { count: COUNT, include_reel_media_seen_timestamp: true, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true }, username: found.user, ...RELAY, ...(cursor ? { after: cursor, before: null, first: COUNT, last: null } : {}) }
      const response = await fetch(`${HOST}/graphql/query`, { method: 'POST', headers, referrer, signal, body: new URLSearchParams({ doc_id: doc, variables: JSON.stringify(variables) }).toString() })
      const body = await response.json().catch(() => undefined) as Reply | undefined
      if (isRecord(body) && body.require_login) throw new LoginRequired(i18n.t('errors:instagram.profileSignIn'))
      if (response.status >= 400 || !isRecord(body) || !isRecord(body.data)) return undefined
      connection = found.reels ? body.data.fetch__XDTUserDict?.clips_connection : body.data.xdt_api__v1__feed__user_timeline_graphql_connection
      // The query ran but answered in a shape this does not read.
      if (!connection || !Array.isArray(connection.edges)) return undefined
      const next = connection.page_info?.end_cursor || ''
      if (next) walked?.cursors.set(reached, next)
      if (reached === page || !connection.page_info?.has_next_page || !next) break
      cursor = next
    }
    // A Reels edge wraps its media one level down; a posts edge is the media.
    const nodes = (connection?.edges || []).map(edge => edge.node?.media || edge.node).filter(Boolean) as Node[]
    const entries = nodes.map(node => entryOf(node, found.user)).filter((entry): entry is ListingEntry => Boolean(entry))
    if (!entries.length && page === 1) throw new LoginRequired(i18n.t('errors:instagram.profileEmpty'))
    return onePage('posts', i18n.t(found.reels ? 'errors:instagram.reels' : 'errors:instagram.posts', { user: found.user }), entries, {
      index: page, size: COUNT, hasMore: Boolean(connection?.page_info?.has_next_page && connection.page_info.end_cursor),
    })
  },
}

// One post: '/p/<code>/', also written '/<user>/p/<code>/'. A Reel is '/reel/<code>/' and is a video,
// which the engine serves.
export function postCodeOf(url: URL): string {
  if (!/(^|\.)instagram\.com$/.test(url.hostname)) return ''
  return /^\/(?:[\w.]+\/)?p\/([\w-]+)\/?$/.exec(url.pathname)?.[1] || ''
}

// A post's shortcode is its numeric id written in base64url, so the id the media endpoint takes can
// be worked out rather than looked up.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function mediaIdOf(code: string): string {
  let id = 0n
  for (const char of code) id = id * 64n + BigInt(ALPHABET.indexOf(char))
  return String(id)
}

type Info = { items?: (Node & { carousel_media?: Node[] })[]; require_login?: boolean }

// A picture post or a carousel, which the engine has no extractor for. Read through
// 'api/v1/media/<id>/info/', which the post page itself calls (captured signed in on 2026-09-23: a
// carousel of seven pictures and a clip, every file at its own address). A post with no picture is a
// video and stands down to the engine.
export const instagramPost: ProfileAdapter = {
  id: 'instagram-post',
  post: true,
  matches(url) { return Boolean(postCodeOf(url)) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, fetch, evaluate, signal }: PageRequest): Promise<ListingPage | undefined> {
    const code = postCodeOf(url)
    if (!code) throw new Error(i18n.t('errors:listing.noPostId'))
    const csrf = await evaluate?.<string>(`(document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || ''`).catch(() => '') || ''
    const response = await fetch(`${HOST}/api/v1/media/${mediaIdOf(code)}/info/`, { headers: { 'x-ig-app-id': APP_ID, ...(csrf ? { 'x-csrftoken': csrf } : {}) }, referrer: url.href, signal })
    const body = await response.json().catch(() => undefined) as Info | undefined
    if (isRecord(body) && body.require_login) throw new LoginRequired(i18n.t('errors:instagram.postSignIn'))
    const post = isRecord(body) && Array.isArray(body.items) ? body.items[0] : undefined
    if (response.status >= 400 || !post) return undefined
    const files = post.carousel_media?.length ? post.carousel_media : [post]
    // media_type 1 is a picture, 2 a clip.
    if (!files.some(file => file.media_type === 1)) return undefined
    const author = post.user?.username
    const text = post.caption?.text?.trim().split('\n')[0].slice(0, 80) || `Instagram ${code}`
    const entries = files.map((file, index): ListingEntry | undefined => {
      const picture = file.image_versions2?.candidates?.[0]?.url
      const clip = file.video_versions?.[0]?.url
      const media = file.media_type === 2 ? clip : picture
      if (!media) return undefined
      return {
        id: `${code}-${index + 1}`, url: url.href, title: files.length > 1 ? `${text} · ${index + 1}` : text,
        thumbnail: picture, kind: file.media_type === 2 ? 'video' : 'image', media, author,
        duration: file.video_duration ? Math.round(file.video_duration) : undefined,
      }
    }).filter((entry): entry is ListingEntry => Boolean(entry))
    return { title: text, kind: 'post', groups: [{ id: 'files', entries, pagination: { index: 1, size: entries.length, hasMore: false } }] }
  },
}
