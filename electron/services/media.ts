import { randomUUID } from 'node:crypto'
import type { MediaResult, MediaItem } from '../../shared/contracts'

export type RawInfo = {
  id?: string; title?: string; webpage_url?: string; original_url?: string; url?: string; ext?: string; duration?: number; thumbnail?: string;
  thumbnails?: { url?: string; width?: number }[]; _type?: string;
  extractor_key?: string; extractor?: string; vcodec?: string; entries?: RawInfo[]; playlist_index?: number;
  formats?: { format_id: string; height?: number; format_note?: string; ext?: string; vcodec?: string; acodec?: string; has_drm?: boolean }[]
}

export function normalizeUrl(input: string): string {
  const candidate = input.match(/https?:\/\/[^\s<>"「」]+/i)?.[0]?.replace(/[，。！）)]+$/, '')
  if (!candidate) throw new Error('请粘贴有效的 http 或 https 媒体链接')
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('链接格式不受支持')
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

// A YouTube channel is a playlist of tab playlists, so one level of flattening would list the tabs
// themselves as downloadable items. Recurse until the leaves, which are the actual media.
export function flattenEntries(raw: RawInfo, limit = 100): RawInfo[] {
  const flat: RawInfo[] = []
  const walk = (node: RawInfo) => {
    const children = node.entries?.filter(Boolean) || []
    if (!children.length) { flat.push(node); return }
    for (const child of children) { if (flat.length >= limit) return; walk(child) }
  }
  walk(raw)
  return flat.slice(0, limit)
}

export function mediaResult(raw: RawInfo, url: string, method: MediaResult['method']): MediaResult {
  const entries = flattenEntries(raw)
  const items: MediaItem[] = entries.map((entry, index) => ({
    id: String(index + 1), title: entry.title || raw.title || `媒体 ${index + 1}`, duration: entry.duration,
    // Channel and playlist entries carry a thumbnails list instead of a single thumbnail.
    thumbnail: entry.thumbnail || entry.thumbnails?.filter(item => item.url).sort((first, second) => (second.width || 0) - (first.width || 0))[0]?.url,
    kind: entry.vcodec === 'none' ? 'audio' : 'video',
    formats: (entry.formats || []).filter(format => !format.has_drm && format.ext !== 'mhtml' && (format.acodec !== 'none' || format.vcodec !== 'none')).map(format => ({
      id: format.format_id, label: [format.height ? `${format.height}p` : format.vcodec === 'none' ? '音频' : format.format_note, format.ext].filter(Boolean).join(' · '),
      height: format.height, extension: format.ext || '', audioOnly: format.vcodec === 'none',
    })),
  }))
  if (!items.length) throw new Error('没有找到可下载内容')
  return { id: randomUUID(), url, title: raw.title || items[0].title, platform: platformOf(url), method, items }
}

export function needsChrome(message: string): boolean {
  return /cookie|decrypt|dpapi|sign.?in|log.?in|登录|验证|captcha|403|412|bot|unsupported url|unable to extract|no video|not available|signature/i.test(message)
}
