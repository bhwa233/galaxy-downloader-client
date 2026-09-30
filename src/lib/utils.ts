export { cn } from "cn"
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = (total % 60).toString().padStart(2, '0')
  return hours ? `${hours}:${minutes.toString().padStart(2, '0')}:${remaining}` : `${minutes}:${remaining}`
}
// Play counts run to seven digits, which no card has room for; Chinese platforms cut them at 万 and 亿.
export function formatCount(value: number): string {
  if (value < 10000) return String(Math.max(0, Math.floor(value)))
  const [scale, unit] = value < 100_000_000 ? [10_000, '万'] : [100_000_000, '亿']
  const scaled = value / scale
  return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.floor(scaled)}${unit}`
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
