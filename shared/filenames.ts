import type { MediaStats, Settings } from './contracts'

// Reuses the queue's filename policy in the settings preview as well as on disk. Native Unicode
// iteration and TextEncoder suffice here; installed UI/formatting libraries have no filesystem policy.
export function filenameSegment(value: string, maxBytes = 150): string {
  let name = ''
  const encoder = new TextEncoder()
  // eslint-disable-next-line no-control-regex -- Windows forbids control characters in filenames.
  for (const char of value.replace(/[<>:"/\\|?*\x00-\x1f%]/g, '_').trim()) {
    if (encoder.encode(name + char).length > maxBytes) break
    name += char
  }
  name = name.replace(/[. ]+$/, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  return name || 'media'
}

export function publicationDate(timestamp?: number): string {
  if (timestamp === undefined) return ''
  const date = new Date(timestamp * 1000)
  if (!Number.isFinite(date.getTime())) return ''
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

export function mediaFilename(settings: Pick<Settings, 'filenameTemplate' | 'customFilenameTemplate'>, item: MediaStats & { title: string; id?: string }): string {
  const author = item.authorId || item.author || item.channel || ''
  const date = publicationDate(item.publishedAt)
  if (settings.filenameTemplate === 'custom') {
    const fields: Record<string, string> = { title: item.title, id: item.id || '', authorId: author, author: item.author || '', channel: item.channel || item.author || '', artist: item.artist || item.author || '', date }
    return filenameSegment(settings.customFilenameTemplate.replace(/\{(title|id|authorId|author|channel|artist|date)\}/g, (_, key: string) => fields[key]))
  }
  if (settings.filenameTemplate === 'title') return filenameSegment(item.title)
  if (settings.filenameTemplate === 'title-author' || settings.filenameTemplate === 'title-author-date') {
    // Reserve suffix space so a long title cannot consume the author name or publication date.
    const name = (item.author || item.channel || '').trim()
    const suffix = [name ? filenameSegment(name, 60) : '', ...(settings.filenameTemplate === 'title-author-date' ? [date] : [])].filter(Boolean).join('_')
    const title = filenameSegment(item.title, 150 - (suffix ? new TextEncoder().encode(suffix).length + 1 : 0))
    return filenameSegment([title, suffix].filter(Boolean).join('_'))
  }
  // Saved jobs keep the earlier account-first presets when resumed or retried.
  return filenameSegment([author, ...(settings.filenameTemplate === 'author-date-title' ? [date] : []), item.title].filter(Boolean).join('_'))
}
