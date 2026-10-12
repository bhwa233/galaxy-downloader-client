import { expect, test } from 'vitest'
import { flattenEntries, mediaResult, normalizeUrl } from '../electron/services/media'
import { Parser } from '../electron/services/parser'
import type { Engine } from '../electron/services/engine'
import type { EmbeddedBrowser } from '../electron/services/browser'

const video = (id: string, extra: object = {}) => ({ id, title: `视频 ${id}`, webpage_url: `https://www.youtube.com/watch?v=${id}`, ...extra })
// A channel arrives as a playlist of tab playlists.
const channel = { title: '频道', webpage_url: 'https://www.youtube.com/@channel', entries: [
  { title: '频道 - Videos', webpage_url: 'https://www.youtube.com/@channel/videos', entries: [video('a'), video('b')] },
  { title: '频道 - Shorts', webpage_url: 'https://www.youtube.com/@channel/shorts', entries: [video('c', { thumbnails: [{ url: 'https://i.ytimg.com/small.jpg', width: 120 }, { url: 'https://i.ytimg.com/large.jpg', width: 1280 }] })] },
] }

test('a channel lists its videos, not its tabs, and falls back to the widest thumbnail', () => {
  expect(flattenEntries(channel).map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  const result = mediaResult(channel, channel.webpage_url, 'direct')
  expect(result.items.map(item => [item.id, item.title])).toEqual([['1', '视频 a'], ['2', '视频 b'], ['3', '视频 c']])
  expect(result.items[2].thumbnail).toBe('https://i.ytimg.com/large.jpg')
})

const signedIn = {
  warm: async () => {},
  identity: async () => ({ cookies: [{ name: 'SESSDATA', value: 'x', domain: '.example.test', path: '/', secure: true, expires: -1 }], userAgent: 'Mozilla/5.0 Chrome/142.0.0.0' }),
} as unknown as EmbeddedBrowser

async function plan(raw: object, browser: EmbeddedBrowser = signedIn) {
  const engine = { request: async () => raw } as unknown as Engine
  return new Parser(engine, browser).parse('https://example.test/media', undefined, new AbortController().signal)
}

test('the direct route goes out as the visitor the client is signed in as', async () => {
  const { sources } = await plan({ title: '视频', webpage_url: 'https://example.test/media' })
  const source = [...sources.values()][0]
  // The download inherits the request the extraction was made with, so both carry the same identity.
  expect(source.kind === 'engine' && source.request.cookies?.[0].name).toBe('SESSDATA')
  expect(source.kind === 'engine' && source.request.headers?.['User-Agent']).toBe('Mozilla/5.0 Chrome/142.0.0.0')
})

test('flat playlist entries download from the url the listing gave them', async () => {
  // extract_flat returns stubs: no webpage_url, no formats, thumbnails instead of thumbnail.
  const flat = { title: '频道', webpage_url: 'https://www.youtube.com/@channel', entries: [
    { _type: 'url', id: 'a', title: '视频 a', url: 'https://www.youtube.com/watch?v=a', duration: 1206, thumbnails: [{ url: 'https://i.ytimg.com/a.jpg', width: 640 }] },
  ] }
  const { result, sources } = await plan(flat)
  expect(result.items[0]).toMatchObject({ id: '1', title: '视频 a', duration: 1206, thumbnail: 'https://i.ytimg.com/a.jpg', kind: 'video' })
  expect([...sources.values()].map(source => source.kind === 'engine' && [source.request.url, source.request.entry]))
    .toEqual([['https://www.youtube.com/watch?v=a', undefined]])
})

test('entries with their own page download from it; parts sharing the parent page keep the playlist index', async () => {
  const nested = await plan(channel)
  expect([...nested.sources.values()].map(source => source.kind === 'engine' && [source.request.url, source.request.entry]))
    .toEqual([['https://www.youtube.com/watch?v=a', undefined], ['https://www.youtube.com/watch?v=b', undefined], ['https://www.youtube.com/watch?v=c', undefined]])
  // Bilibili 分P entries all report the parent page, so only the index distinguishes them.
  const parts = { title: '合集', webpage_url: 'https://example.test/media', entries: [{ title: 'P1', webpage_url: 'https://example.test/media' }, { title: 'P2', webpage_url: 'https://example.test/media' }] }
  const multipart = await plan(parts)
  expect([...multipart.sources.values()].map(source => source.kind === 'engine' && [source.request.url, source.request.entry]))
    .toEqual([['https://example.test/media', 1], ['https://example.test/media', 2]])
})

test('a shared link is reduced to the work it points at', () => {
  // 抖音 短剧 are the one platform that puts the id in the query: '/series' is the index page, and the
  // episode is 'modal_id'. Left as pasted, nothing downstream sees one work here.
  expect(normalizeUrl('https://www.douyin.com/series?modal_id=7676329918745054500'))
    .toBe('https://www.douyin.com/video/7676329918745054500')
  // Without one it is the 短剧 index and stays that way.
  expect(normalizeUrl('https://www.douyin.com/series')).toBe('https://www.douyin.com/series')
  // Share tracking identifies the share, not the post.
  expect(normalizeUrl('https://www.instagram.com/p/DdUG_iuEf3E/?utm_source=ig_web_copy_link&stkn=abc'))
    .toBe('https://www.instagram.com/p/DdUG_iuEf3E/')
  expect(normalizeUrl('https://x.com/FinanceYF5/status/2101585391140905034?s=20'))
    .toBe('https://x.com/FinanceYF5/status/2101585391140905034')
  // 's' is a real parameter on plenty of sites, so it only goes where X is the site that added it.
  expect(normalizeUrl('https://example.test/search?s=keyword')).toBe('https://example.test/search?s=keyword')
  // Everything that identifies the work itself survives.
  expect(normalizeUrl('https://www.youtube.com/watch?v=oBeBVjOBZPs&list=PLZOc7e59B5BY'))
    .toBe('https://www.youtube.com/watch?v=oBeBVjOBZPs&list=PLZOc7e59B5BY')
})

// Splitting a post into one task per media file means every one of those tasks resolves the same post
// when it runs. Without this each picture of a nine-picture post would cost its own parse of the page.
test('a single work is parsed once for all the tasks it produced', async () => {
  let parses = 0
  const engine = { request: async () => { parses += 1; return { title: '图文', webpage_url: 'https://example.test/media' } } } as unknown as Engine
  const parser = new Parser(engine, signedIn)
  const signal = new AbortController().signal
  const first = await parser.parse('https://example.test/media', undefined, signal, { single: true })
  const second = await parser.parse('https://example.test/media', undefined, signal, { single: true })
  expect(parses).toBe(1)
  // The same plan, so the addresses the first task resolved are the ones the second downloads from.
  expect(second).toBe(first)
  // A listing is never served from it: it has pages and a selection behind it, and answering with a
  // page the user did not ask for would be worse than parsing again.
  await parser.parse('https://example.test/media', undefined, signal)
  expect(parses).toBe(2)
})
