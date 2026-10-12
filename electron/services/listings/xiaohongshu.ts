// Switched off: this adapter is not registered in './index', and parser.ts refuses 小红书 profiles
// outright. The listing has no route that can be walked politely - every API call is signed by
// obfuscated script that only runs in the page, which leaves scraping the grid as the only way in, and
// that is what its risk control is watching for. Kept here, whole, for the day that changes.
import { i18n } from '../../../shared/i18n'
import { countOf } from './text'
import type { ListingEntry, ProfileAdapter } from './types'

type Note = {
  note_id?: string; display_title?: string; type?: string; xsec_token?: string
  cover?: { url_default?: string; url_pre?: string; info_list?: { url?: string }[] }
  interact_info?: { liked_count?: string | number }
  user?: { nick_name?: string; nickname?: string }
}
type PostedResponse = { data?: { notes?: Note[]; has_more?: boolean } }

// Covers are served over plain HTTP; the renderer and the file loader both prefer TLS.
const secure = (address: string | undefined) => address?.replace(/^http:\/\//, 'https://')

export function entryOf(note: Note): ListingEntry | undefined {
  const id = note.note_id?.trim()
  if (!id) return undefined
  const token = note.xsec_token?.trim() || ''
  const cover = note.cover
  return {
    id,
    // The note page answers with an error unless it is given the access token the listing issued
    // alongside the id, so the token travels with the entry all the way to the download.
    url: `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user` : ''}`,
    title: note.display_title?.trim() || i18n.t('errors:xiaohongshu.note', { id }),
    thumbnail: secure(cover?.url_default || cover?.url_pre || cover?.info_list?.find(item => item.url)?.url),
    kind: note.type === 'video' ? 'video' : 'image',
    // A note publishes its likes and nothing else: no play count, and no publish time in the listing.
    likes: countOf(note.interact_info?.liked_count),
    author: (note.user?.nick_name || note.user?.nickname)?.trim() || undefined,
  }
}

// What the 笔记 listing answers with, kept whole so that a future 'x-s' implementation has only to
// call the endpoint and hand the payload here.
export function notesOf(payload: unknown): ListingEntry[] {
  const entries: ListingEntry[] = []
  for (const note of (payload as PostedResponse).data?.notes || []) {
    const entry = entryOf(note)
    if (entry && !entries.some(seen => seen.id === entry.id)) entries.push(entry)
  }
  return entries
}

export const xiaohongshu: ProfileAdapter = {
  id: 'xiaohongshu',
  matches(url) {
    return /(^|\.)xiaohongshu\.com$/.test(url.hostname) && /\/user\/profile\/[0-9a-z]+/i.test(url.pathname)
  },
  // A profile opens on its 笔记 grid already, and the search parameters carry the access token that
  // the visit needs, so the address is taken as the user gave it.
  entryUrl(url) { return url.href },
  // No fetchPage: every 小红书 API call is signed with 'x-s' by obfuscated script, and calling the
  // endpoint from inside the page does not help, because their interceptor signs their own client
  // rather than the native fetch. Reproducing the signature is the only route, and it is not written.
}
