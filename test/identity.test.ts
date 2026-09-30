import { expect, test } from 'vitest'
import { acceptLanguageFor, chromeUserAgent, clientHints, fetchMetadata, relatedTo } from '../electron/services/identity'

test('the user agent keeps nothing that names this client', () => {
  const electron = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) galaxy-downloader/0.1.0 Chrome/142.0.0.0 Electron/42.1.0 Safari/537.36'
  expect(chromeUserAgent(electron)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')
  // An agent that already reads as plain Chrome is left exactly as it is.
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  expect(chromeUserAgent(chrome)).toBe(chrome)
})

test('client hints carry the Chromium that is actually running', () => {
  const hints = clientHints('142.0.7444.60', 'win32')
  expect(hints['sec-ch-ua']).toBe('"Chromium";v="142", "Not=A?Brand";v="24", "Google Chrome";v="142"')
  expect(hints['sec-ch-ua-platform']).toBe('"Windows"')
  expect(clientHints('141.0.0.0', 'darwin')['sec-ch-ua-platform']).toBe('"macOS"')
  expect(hints['sec-ch-ua-mobile']).toBe('?0')
})

test('language follows the interface the user picked', () => {
  expect(acceptLanguageFor('zh')).toBe('zh-CN,zh;q=0.9')
  expect(acceptLanguageFor('ja')).toMatch(/^ja,/)
})

test('a request only states where it came from when it knows', () => {
  expect(fetchMetadata('https://api.bilibili.com/x/space/wbi/arc/search', 'https://space.bilibili.com/242020511/video'))
    .toEqual({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })
  expect(fetchMetadata('https://www.youtube.com/youtubei/v1/browse', 'https://www.youtube.com/@a/videos')['sec-fetch-site']).toBe('same-origin')
  expect(fetchMetadata('https://i.ytimg.com/vi/a/hq.jpg', 'https://www.youtube.com/@a/videos')['sec-fetch-site']).toBe('cross-site')
  expect(fetchMetadata('https://www.youtube.com/', undefined)).toEqual({})
})

test('cookies are collected from every host a platform keeps them on', () => {
  expect(relatedTo('https://www.youtube.com/@Fatcat996/videos')).toEqual([
    'https://www.youtube.com/', 'https://www.google.com/', 'https://accounts.google.com/',
  ])
  expect(relatedTo('https://space.bilibili.com/242020511')).toContain('https://passport.bilibili.com/')
  // The parsed origin itself is always asked about, even on a platform with no related hosts.
  expect(relatedTo('https://example.test/media')).toEqual(['https://example.test/'])
  expect(relatedTo('not a url')).toEqual([])
})
