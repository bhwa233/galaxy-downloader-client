import { i18n } from '../../../shared/i18n'
import type { ParseSession } from '../../../shared/contracts'
import { LoginRequired, VerificationRequired } from '../login'
import type { RawInfo } from '../media'
import { pause } from './pace'
import { countOf } from './text'
import { isRecord, onePage, type ListingEntry, type ProfileAdapter } from './types'

type Note = {
  note_id?: string; display_title?: string; type?: string; xsec_token?: string
  cover?: { url_default?: string; url_pre?: string; info_list?: { url?: string }[] }
  interact_info?: { liked_count?: string | number }
  user?: { nick_name?: string; nickname?: string }
}
const host = /(^|\.)xiaohongshu\.com$/i
const profilePath = /^\/user\/profile\/([\da-f]+)\/?$/i
const pageSize = 20
const maxVideos = 500

export function xiaohongshuPageSession(): ParseSession {
  if (!/(^|\.)xiaohongshu\.com$/i.test(location.hostname)) return 'unknown'
  const root = document.getElementById('app') as (HTMLElement & {
    __vue_app__?: { config?: { globalProperties?: { $pinia?: { state?: { value?: { user?: { loggedIn?: unknown } } } } } } }
  }) | null
  const initial = window as unknown as { __INITIAL_STATE__?: { user?: { loggedIn?: unknown } } }
  const marker = root?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value?.user?.loggedIn ?? initial.__INITIAL_STATE__?.user?.loggedIn
  return marker === true ? 'signedIn' : marker === false ? 'guest' : 'unknown'
}

export function xiaohongshuNoteId(url: URL): string | undefined {
  return host.test(url.hostname) ? /^\/(?:explore\/|discovery\/item\/|user\/profile\/[\da-f]+\/)([\da-f]+)\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() : undefined
}

export function checkXiaohongshuPage(landed: URL): void {
  if (!host.test(landed.hostname)) throw new Error(i18n.t('errors:xiaohongshu.unavailable'))
  if (/^\/(?:verify|challenge|captcha)(?:\/|$)/i.test(landed.pathname)) throw new VerificationRequired(i18n.t('errors:parse.challenge'))
  if (/^\/(?:login|signin)(?:\/|$)/i.test(landed.pathname)) throw new LoginRequired(i18n.t('errors:parse.signIn'))
  if (/^\/404(?:\/|$)/.test(landed.pathname)) throw new Error(i18n.t('errors:xiaohongshu.unavailable'))
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const cdn = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !/(^|\.)xhscdn\.com$/i.test(url.hostname)) return undefined
    url.protocol = 'https:'
    return url.href
  } catch { return undefined }
}

export function xiaohongshuVideo(note: unknown, url: string, id: string, title: string): RawInfo | undefined {
  if (!isRecord(note)) return undefined
  if (note.type === 'normal' || note.type === 'image') throw new Error(i18n.t('errors:xiaohongshu.videoOnly'))
  const video = isRecord(note.video) ? note.video : undefined
  const media = isRecord(video?.media) ? video.media : undefined
  const stream = isRecord(media?.stream) ? media.stream : undefined
  const formats: NonNullable<RawInfo['formats']> = []
  const seen = new Set<string>()
  let duration: number | undefined
  for (const [codec, variants] of Object.entries(stream || {})) {
    for (const [index, variant] of list(variants).entries()) {
      if (!isRecord(variant)) continue
      const address = cdn(variant.masterUrl) || list(variant.backupUrls).map(cdn).find(Boolean)
      if (!address || seen.has(address)) continue
      seen.add(address)
      const milliseconds = number(variant.duration)
      if (milliseconds && !duration) duration = milliseconds / 1000
      formats.push({ url: address, format_id: `${codec}-${index + 1}`, ext: 'mp4', width: number(variant.width), height: number(variant.height), fps: number(variant.fps),
        vcodec: text(variant.videoCodec), acodec: text(variant.audioCodec), filesize: number(variant.size) })
    }
  }
  if (!formats.length) return undefined
  const cover = list(note.imageList)[0]
  const user = isRecord(note.user) ? note.user : undefined
  return { id, title: text(note.title) || title, webpage_url: url, extractor: 'xiaohongshu', extractor_key: 'XiaoHongShu', duration,
    thumbnail: isRecord(cover) ? cdn(cover.urlDefault) || cdn(cover.url) : undefined, uploader: text(user?.nickname), uploader_id: text(user?.userId), formats }
}

export function entryOf(note: Note): ListingEntry | undefined {
  const id = text(note.note_id)
  if (!id || !/^[\da-z]+$/i.test(id)) return undefined
  const token = text(note.xsec_token)
  const cover = isRecord(note.cover) ? note.cover : undefined
  const likes = note.interact_info?.liked_count
  return {
    id,
    // The note page answers with an error unless it is given the access token the listing issued
    // alongside the id, so the token travels with the entry all the way to the download.
    url: `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user` : ''}`,
    title: text(note.display_title) || i18n.t('errors:xiaohongshu.note', { id }),
    thumbnail: cdn(cover?.url_default) || cdn(cover?.url_pre) || list(cover?.info_list).map(item => isRecord(item) ? cdn(item.url) : undefined).find(Boolean),
    kind: note.type === 'video' ? 'video' : 'image',
    // A note publishes its likes and nothing else: no play count, and no publish time in the listing.
    likes: typeof likes === 'string' || typeof likes === 'number' ? countOf(likes) : undefined,
    author: text(note.user?.nick_name) || text(note.user?.nickname),
  }
}

export function notesOf(payload: unknown): ListingEntry[] {
  const entries = new Map<string, ListingEntry>()
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined
  for (const note of list(data?.notes)) {
    if (!isRecord(note)) continue
    const entry = entryOf(note)
    if (entry && !entries.has(entry.id)) entries.set(entry.id, entry)
  }
  return [...entries.values()]
}

type ProfileSnapshot = { address: string; title: string; notes: Note[] }

function profileSnapshot(scroll: boolean): ProfileSnapshot {
  const state = (window as unknown as { __INITIAL_STATE__?: { user?: { notes?: unknown; userPageData?: { basicInfo?: { nickname?: string } } } } }).__INITIAL_STATE__
  const notes: Note[] = []
  const values = Array.isArray(state?.user?.notes) ? state.user.notes.flat(1) : []
  for (const value of values) {
    const card = value?.noteCard || value
    if (card?.type !== 'video') continue
    notes.push({ note_id: card.noteId || card.note_id || value.id, type: 'video', display_title: card.displayTitle || card.display_title,
      xsec_token: value.xsecToken || value.xsec_token || card.xsecToken || card.xsec_token, cover: { url_default: card.cover?.urlDefault || card.cover?.url_default || card.cover?.url } })
  }
  const grid = document.querySelector('#userPostedFeeds') || document.querySelector('.feeds-container')
  for (const card of grid?.querySelectorAll('.note-item') || []) {
    if (!card.querySelector('.play-icon, video, [data-type="video"]')) continue
    const anchors = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
    const link = anchors.find(anchor => anchor.search.includes('xsec_token=') && /\/(?:explore\/|discovery\/item\/|user\/profile\/[\da-f]+\/)[\da-f]+\/?$/i.test(anchor.pathname))
    if (!link || !/(^|\.)xiaohongshu\.com$/i.test(link.hostname)) continue
    const image = card.querySelector('img')
    notes.push({ note_id: link.pathname.split('/').filter(Boolean).at(-1), type: 'video', display_title: card.querySelector('.title')?.textContent || image?.alt,
      xsec_token: new URL(link.href).searchParams.get('xsec_token') || undefined, cover: { url_default: image?.currentSrc || image?.src } })
  }
  if (scroll) {
    if (grid) grid.lastElementChild?.scrollIntoView({ block: 'end' })
    window.scrollTo(0, document.documentElement.scrollHeight)
  }
  return { address: location.href, title: state?.user?.userPageData?.basicInfo?.nickname || document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title, notes }
}

export const xiaohongshu: ProfileAdapter = {
  id: 'xiaohongshu',
  matches: url => host.test(url.hostname) && profilePath.test(url.pathname),
  entryUrl(url) { return url.href },
  observeResponse(response, profile) {
    const owner = response.searchParams.get('target_user_id') || response.searchParams.get('user_id')
    return host.test(response.hostname) && response.pathname === '/api/sns/web/v1/user_posted' && (!owner || owner === profilePath.exec(profile.pathname)?.[1])
  },
  async fetchPage({ url, page, evaluate, responses = [], signal }) {
    if (!evaluate) return undefined
    const owner = profilePath.exec(url.pathname)?.[1]
    const start = (page - 1) * pageSize
    const end = Math.min(start + pageSize, maxVideos)
    const entries = new Map<string, ListingEntry>()
    let cursor = 0
    let complete = false
    let capped = false
    let issue: Error | undefined
    let title: string | undefined
    const collect = (entry: ListingEntry | undefined) => {
      if (!entry || entry.kind !== 'video' || !/^[\da-f]+$/i.test(entry.id)) return
      const held = entries.get(entry.id)
      if (!held && entries.size >= maxVideos) { capped = true; return }
      if (!held || !held.thumbnail && entry.thumbnail || !held.url.includes('xsec_token=') && entry.url.includes('xsec_token=')) entries.set(entry.id, entry)
    }
    for (let round = 0; round <= 6; round += 1) {
      signal.throwIfAborted()
      try {
        const snapshot = await evaluate<ProfileSnapshot>(`(${profileSnapshot})(${round > 0})`)
        const landed = new URL(snapshot.address)
        checkXiaohongshuPage(landed)
        if (profilePath.exec(landed.pathname)?.[1] !== owner) throw new Error(i18n.t('errors:xiaohongshu.unavailable'))
        title = text(snapshot.title)
        if (round > 0) await pause(signal, [1_350, 1_350])
        for (; cursor < responses.length; cursor += 1) {
          const response = responses[cursor]
          const payload = isRecord(response.payload) ? response.payload : undefined
          const data = isRecord(payload?.data) ? payload.data : undefined
          if (response.status === 461 || response.status === 471) throw new VerificationRequired(i18n.t('errors:parse.challenge'))
          if (response.status === 401) throw new LoginRequired(i18n.t('errors:parse.signIn'))
          if (response.status >= 400 || payload?.success === false) throw new Error(i18n.t('errors:xiaohongshu.profileIncomplete'))
          for (const entry of notesOf(payload)) collect(entry)
          if (typeof data?.has_more === 'boolean') complete = !data.has_more
        }
        for (const note of snapshot.notes) collect(entryOf(note))
        if (complete || entries.size >= end) break
      } catch (error) {
        signal.throwIfAborted()
        issue = error instanceof Error ? error : new Error(String(error))
        break
      }
    }
    const shown = [...entries.values()].slice(start, end)
    if (!shown.length && (!complete || page === 1)) throw issue || new Error(i18n.t(complete ? 'errors:xiaohongshu.noVideos' : 'errors:xiaohongshu.profileIncomplete'))
    const hasMore = end < maxVideos && (entries.size > end || !complete && !issue && shown.length === pageSize)
    const result = onePage('posts', title, shown, { index: page, size: pageSize, total: complete && !capped ? entries.size : undefined, hasMore })
    if (!hasMore && (!complete || capped)) result.truncated = { shown: entries.size }
    return result
  },
}
