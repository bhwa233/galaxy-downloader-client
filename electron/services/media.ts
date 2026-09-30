import { randomUUID } from 'node:crypto'
import type { MediaResult, MediaItem } from '../../shared/contracts'

export type RawInfo = {
  id?: string; title?: string; webpage_url?: string; original_url?: string; url?: string; ext?: string; duration?: number; thumbnail?: string;
  thumbnails?: { url?: string; width?: number }[]; _type?: string;
  view_count?: number; comment_count?: number; uploader?: string; channel?: string; timestamp?: number; upload_date?: string;
  extractor_key?: string; extractor?: string; vcodec?: string; entries?: RawInfo[]; playlist_index?: number; playlist_count?: number;
  formats?: RawFormat[]
}
type RawFormat = { format_id: string; height?: number; fps?: number; format_note?: string; ext?: string; vcodec?: string; acodec?: string; has_drm?: boolean; filesize?: number; filesize_approx?: number; tbr?: number }

// A stream's size as the platform states it - exact where it knows, approximate where it gives one -
// and otherwise its bitrate over the whole duration.
function streamSize(format: RawFormat | undefined, duration: number | undefined): number | undefined {
  if (!format) return undefined
  if (format.filesize) return format.filesize
  if (format.filesize_approx) return format.filesize_approx
  return format.tbr && duration ? Math.round(format.tbr * 1000 / 8 * duration) : undefined
}

// What each platform calls a quality tier. 哔哩哔哩's extractor leaves format_note empty, so its own
// names are put back by height and frame rate; YouTube's format_note already is its name ('720p60').
function tierName(format: RawFormat, platform: string): string {
  const height = format.height || 0
  const smooth = (format.fps || 0) >= 50
  if (platform === 'Bilibili') {
    if (height >= 4000) return '8K 超高清'
    if (height >= 2000) return '4K 超清'
    if (height >= 1000) return smooth ? '1080P60 高帧率' : '1080P 高清'
    if (height >= 700) return smooth ? '720P60 高帧率' : '720P 高清'
    if (height >= 460) return '480P 清晰'
    return '360P 流畅'
  }
  if (format.format_note && /^\d{3,4}p/.test(format.format_note)) return format.format_note
  return `${height}p${smooth ? Math.round(format.fps!) : ''}`
}

// One entry per tier, as the platform shows it. A tier comes in several codecs with the same name -
// 哔哩哔哩 lists AVC, HEVC and AV1 of every height - and three identical names are no choice at all.
// AVC is the one kept: every player takes it, and its format id is the one that recurs from video to
// video (30064 is 720P on every 哔哩哔哩 video, 137 is 1080p on every YouTube one), which is what lets
// a tier picked on a listing's first video apply to the rest. Audio-only formats are left to 仅音频.
function tiersOf(formats: RawFormat[], platform: string, duration?: number): MediaItem['formats'] {
  // The audio a video-only tier is merged with: the best audio stream, as the download picks it.
  const audio = formats.filter(format => format.vcodec === 'none' && format.acodec && format.acodec !== 'none')
    .sort((first, second) => (second.tbr || 0) - (first.tbr || 0))[0]
  const byName = new Map<string, RawFormat>()
  // The last format of each tier in yt-dlp's order: the one it prefers, and so the one a default
  // download ('bv*+ba') takes at that height (measured: HEVC 30066 / 30077 on 哔哩哔哩, 616 on YouTube).
  const preferred = new Map<string, RawFormat>()
  for (const format of formats) {
    if (format.has_drm || format.ext === 'mhtml' || !format.vcodec || format.vcodec === 'none' || !format.height) continue
    const name = tierName(format, platform)
    const held = byName.get(name)
    // AVC first, and a video-only stream over one with its audio already muxed in. The muxed ones are
    // YouTube's legacy formats (18 is 360p), which the download session is not always offered: picking
    // 360p then fell through to the best and fetched 1080p (measured 2026-09-24). A video-only stream
    // is merged with the best audio, which is what every other tier does anyway.
    const rank = (candidate?: RawFormat) => (/^avc/.test(candidate?.vcodec || '') ? 2 : 0) + (candidate?.acodec === 'none' ? 1 : 0)
    // yt-dlp lists formats worst first, so a later one of the same rank is the better one.
    if (!held || rank(format) >= rank(held)) byName.set(name, format)
    preferred.set(name, format)
  }
  // The whole download for one video format: the stream plus the audio it is merged with, if it has none.
  const measure = (format: RawFormat) => {
    const merged = format.acodec === 'none' ? audio : undefined
    const video = streamSize(format, duration)
    const size = video === undefined ? undefined : video + (streamSize(merged, duration) || 0)
    const bitrate = format.tbr ? format.tbr + (merged?.tbr || 0) : size && duration ? size * 8 / 1000 / duration : undefined
    return { size, bitrate }
  }
  return [...byName.entries()].sort(([, first], [, second]) => (second.height || 0) - (first.height || 0) || (second.fps || 0) - (first.fps || 0))
    .map(([name, format]) => {
      const own = measure(format)
      const taken = measure(preferred.get(name) || format)
      return { id: format.format_id, label: name, height: format.height, extension: format.ext || '', audioOnly: false, ...own, preferredSize: taken.size, preferredBitrate: taken.bitrate }
    })
}

// Hosts that hand out a short link instead of the page. The address the user pasted says nothing
// about what is behind it, so it has to be followed before anything can route on it.
export const SHORTENERS = /^(v\.douyin\.com|b23\.tv|xhslink\.(com|cn))$/i

// Tracking parameters platforms staple onto a shared link. They identify the share, not the work, so
// they are dropped: two shares of one post are one post, and the queue tells duplicates apart by
// address. Named rather than matched by shape - a single-letter parameter is a real one on plenty of
// sites - so 's' and 't' are only dropped where X is the site that added them.
const SHARED = ['stkn', 'igsh', 'share_token', 'share_source', 'from_tab_name', 'spm_id_from', 'vd_source']
const SHARED_BY_X = ['s', 't']

export function normalizeUrl(input: string): string {
  const candidate = input.match(/https?:\/\/[^\s<>"「」]+/i)?.[0]?.replace(/[，。！）)]+$/, '')
  if (!candidate) throw new Error('请粘贴有效的 http 或 https 媒体链接')
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('链接格式不受支持')
  // 抖音 短剧 are the one platform that puts the work's id in the query rather than in the path: a
  // shared episode lands on '/series?modal_id=<id>', where '/series' is the 短剧 index and nothing
  // downstream would recognise it as one work. The id is an aweme id like any other, so the address
  // is written the way the rest of 抖音 is written. Inferred from the shape, not measured against the
  // API: if it is wrong the parse fails as it already did, so there is nothing to lose by it.
  if (/(^|\.)douyin\.com$/.test(url.hostname) && /^\/series\/?$/.test(url.pathname)) {
    const episode = url.searchParams.get('modal_id')
    if (episode) return `https://www.douyin.com/video/${episode}`
  }
  for (const name of [...url.searchParams.keys()]) if (name.startsWith('utm_')) url.searchParams.delete(name)
  for (const name of SHARED) url.searchParams.delete(name)
  if (/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)) for (const name of SHARED_BY_X) url.searchParams.delete(name)
  return url.href
}

export function platformOf(url: string): string {
  const host = new URL(url).hostname
  const platforms: [RegExp, string][] = [
    [/(^|\.)(bilibili\.com|b23\.tv)$/, 'Bilibili'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
    [/(^|\.)(douyin\.com|iesdouyin\.com)$/, '抖音'], [/(^|\.)(xiaohongshu\.com|xhslink\.(com|cn))$/, '小红书'],
    [/(^|\.)(weibo\.com|weibo\.cn)$/, '微博'], [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
    [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)mp\.weixin\.qq\.com$/, '微信公众号'],
  ]
  return platforms.find(([pattern]) => pattern.test(host))?.[1] ?? host.replace(/^www\./, '')
}

// The most entries a playlist is read for. It matches the engine's own 'playlistend', so a list longer
// than this arrives already cut short and neither side can see past it.
export const ENTRY_LIMIT = 100

// A YouTube channel is a playlist of tab playlists, so one level of flattening would list the tabs
// themselves as downloadable items. Recurse until the leaves, which are the actual media.
export function flattenEntries(raw: RawInfo, limit = ENTRY_LIMIT): RawInfo[] {
  const flat: RawInfo[] = []
  const walk = (node: RawInfo) => {
    const children = node.entries?.filter(Boolean) || []
    if (!children.length) { flat.push(node); return }
    for (const child of children) { if (flat.length >= limit) return; walk(child) }
  }
  walk(raw)
  return flat.slice(0, limit)
}

// yt-dlp reports the publish time as an epoch on a full extraction and as a plain 'YYYYMMDD' on a flat one.
function publishedAt(entry: RawInfo): number | undefined {
  if (entry.timestamp) return entry.timestamp
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(entry.upload_date || '')
  return date ? Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) / 1000 : undefined
}

export function mediaResult(raw: RawInfo, url: string, method: MediaResult['method']): MediaResult {
  const entries = flattenEntries(raw)
  const items: MediaItem[] = entries.map((entry, index) => ({
    id: String(index + 1), title: entry.title || raw.title || `媒体 ${index + 1}`, duration: entry.duration,
    views: entry.view_count, comments: entry.comment_count,
    author: entry.uploader || entry.channel || raw.uploader || raw.channel, publishedAt: publishedAt(entry) ?? publishedAt(raw),
    // Channel and playlist entries carry a thumbnails list instead of a single thumbnail.
    thumbnail: entry.thumbnail || entry.thumbnails?.filter(item => item.url).sort((first, second) => (second.width || 0) - (first.width || 0))[0]?.url,
    kind: entry.vcodec === 'none' ? 'audio' : 'video',
    formats: tiersOf(entry.formats || [], platformOf(url), entry.duration),
  }))
  if (!items.length) throw new Error('没有找到可下载内容')
  // A list that filled the limit exactly is one the engine stopped at rather than reached the end of:
  // 'playlistend' cuts it off there, and a YouTube Mix has no end to reach at all. Saying so is the
  // difference between a listing that is short and one the user is being shown only the front of.
  // The full length is reported where the platform gave one, and left off where it did not.
  const truncated = raw.entries && items.length >= ENTRY_LIMIT ? { shown: items.length, total: raw.playlist_count } : undefined
  return { id: randomUUID(), url, title: raw.title || items[0].title, platform: platformOf(url), method, items, truncated }
}

// Reading another browser's cookie database fails for reasons that say nothing about the media:
// Chrome 127+ seals its cookies with App-Bound Encryption, and a running browser holds a lock on the
// database. Neither means the page needs a real browser, so these are retried without the cookies.
export function isCookieFailure(message: string): boolean {
  return /decrypt|dpapi|keyring|kwallet|could not copy|cookie database|cookies from browser/i.test(message)
}

export function needsBrowser(message: string): boolean {
  return /cookie|sign.?in|log.?in|登录|验证|captcha|403|412|bot|unsupported url|unable to extract|no video|not available|signature/i.test(message)
}
