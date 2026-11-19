import type { MediaItem, Settings } from './contracts'

const defaults: Record<Settings['locale'], string> = {
  zh: 'zh-Hans,zh-CN,zh,en', en: 'en,zh-Hans,zh-CN,zh',
}

export const subtitleLanguagesFor = (settings: Pick<Settings, 'subtitleLanguages' | 'locale'>): string => settings.subtitleLanguages || defaults[settings.locale]

export function hasMatchingSubtitles(item: MediaItem, languages: ReadonlySet<string>, allowAutomatic: boolean): boolean {
  if (item.kind !== 'video' || !item.subtitleTracks) return false
  const matches = (track: string) => languages.has('all') || languages.has(track)
  return item.subtitleTracks.manual.some(matches) || (allowAutomatic && item.subtitleTracks.automatic.some(matches))
}
