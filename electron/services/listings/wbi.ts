import { createHash } from 'node:crypto'

// Bilibili signs its space APIs with wbi: two rotating keys are shuffled through a fixed table into a
// salt, and every request carries a timestamp plus the md5 of its own sorted query. Signing is a pure
// function of (keys, params), so it is kept here and tested on its own.
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

export function keyOf(url: string): string {
  return url.split('/').pop()?.split('.')[0] || ''
}

export function mixinKey(imgKey: string, subKey: string): string {
  const raw = `${imgKey}${subKey}`
  return MIXIN_TABLE.map(index => raw[index] || '').join('').slice(0, 32)
}

export function signQuery(params: Record<string, string | number>, mixin: string, now = Date.now()): string {
  const signed: Record<string, string> = { ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])), wts: String(Math.floor(now / 1000)) }
  const query = Object.keys(signed).sort()
    // The characters bilibili strips from values before hashing; leaving them in makes every signature wrong.
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(signed[key].replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${query}&w_rid=${createHash('md5').update(`${query}${mixin}`).digest('hex')}`
}
