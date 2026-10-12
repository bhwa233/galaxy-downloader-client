export { cn } from "cn"
import { i18n } from '../../shared/i18n'

// The BCP 47 tag the built-in Intl formatters take for the language the window is in.
const intlLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN'
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = (total % 60).toString().padStart(2, '0')
  return hours ? `${hours}:${minutes.toString().padStart(2, '0')}:${remaining}` : `${minutes}:${remaining}`
}
// Play counts run to seven digits, which no card has room for. Intl's compact notation cuts them the
// way each language does: at 万 and 亿 in Chinese, at K and M in English.
export function formatCount(value: number): string {
  return new Intl.NumberFormat(intlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, Math.floor(value)))
}
// Near times said the way a person would - 3 分钟前, 3 minutes ago - and older ones as a date.
export function formatRelative(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000
  const relative = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' })
  if (seconds < 60) return relative.format(0, 'second')
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), 'hour')
  if (seconds < 172_800) return relative.format(-1, 'day')
  const date = new Date(iso)
  return `${date.getMonth() + 1}-${date.getDate()}`
}
// A platform as the main process names it - its own name, an English one or a host - in the window's
// language: 'Bilibili' is 哔哩哔哩 in Chinese, 抖音 is Douyin in English. A host is shown as it is.
export function platformLabel(platform: string): string {
  const key = `platforms.${platform}`
  return i18n.exists(key) ? i18n.t(key as never) : platform
}
// A publish date is read against today, so the year is noise until the post comes from another one.
export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  const day = `${date.getMonth() + 1}-${date.getDate()}`
  return date.getFullYear() === new Date().getFullYear() ? day : `${date.getFullYear()}-${day}`
}
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`
}
