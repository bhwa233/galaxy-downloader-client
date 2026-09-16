import { expect, test } from 'vitest'
import { flattenEntries, mediaResult } from '../electron/services/media'
import { Parser } from '../electron/services/parser'
import type { Engine } from '../electron/services/engine'
import type { ChromeConnection } from '../electron/services/chrome'

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

async function plan(raw: object) {
  const engine = { request: async () => raw } as unknown as Engine
  return new Parser(engine, {} as ChromeConnection).parse('https://example.test/media', undefined, '', new AbortController().signal)
}

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
