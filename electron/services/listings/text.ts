// Listings report numbers as the strings a reader sees: '01:15' for a length, '1.2万' or '1,234 views'
// for a count. Every adapter reads them here, so a card is given plain numbers whatever the platform.

// 'MM:SS' or 'HH:MM:SS'.
export function seconds(length: string | undefined): number | undefined {
  const parts = (length || '').trim().split(':').map(Number)
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0) || undefined
}

const units: Record<string, number> = { 万: 1e4, 亿: 1e8, w: 1e4, k: 1e3, m: 1e6, b: 1e9 }

// A count already given as a number is taken as it is; a display string keeps only its leading number
// and whatever unit follows it, so '1,234 views' and '1.2万' both arrive as counts.
export function countOf(value: string | number | undefined | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  const match = /(\d[\d,.]*)\s*(万|亿|w|k|m|b)?/i.exec((value || '').replace(/\s/g, ''))
  if (!match) return undefined
  // A thousands separator is noise; a decimal point only carries meaning in front of a unit.
  const digits = Number(match[2] ? match[1].replace(/,/g, '') : match[1].replace(/[,.]/g, ''))
  if (!Number.isFinite(digits)) return undefined
  return Math.round(digits * (match[2] ? units[match[2].toLowerCase()] : 1))
}
