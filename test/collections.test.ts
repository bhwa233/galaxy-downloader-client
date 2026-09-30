import { expect, test } from 'vitest'
import path from 'node:path'
import { bilibili } from '../electron/services/listings/bilibili'
import { bilibiliCollection, bilibiliVideo } from '../electron/services/listings/bilibili-collection'
import { findAdapter } from '../electron/services/listings'
import { weibo } from '../electron/services/listings/weibo'
import { LoginRequired } from '../electron/services/login'
import { directoryFor } from '../electron/services/queue'
import { settingsSchema, type MediaItem, type Settings } from '../shared/contracts'
import type { ListingEntry } from '../electron/services/listings/types'
import type { ParsePlan } from '../electron/services/parser'

const reply = (body: unknown) => Promise.resolve({ json: async () => body } as Response)

// Shapes taken from the three endpoints named in docs/collections-and-pages.md.
const archives = (total: number, from: number) => ({
  code: 0,
  data: {
    archives: Array.from({ length: Math.min(30, total - from) }, (_, index) => ({
      bvid: `BV${from + index}`, title: ` 第 ${from + index + 1} 集 `, pic: 'http://i0.hdslb.com/cover.jpg',
      duration: 85, pubdate: 1_757_740_000, stat: { view: 1234 },
    })),
    meta: { name: '喵喵网络狠人2.0', total },
    page: { total },
  },
})
const view = (over: Record<string, unknown>) => ({ code: 0, data: { bvid: 'BV1Ps421u7ju', title: '少女乐队 第一话', pic: '//i0.hdslb.com/parent.jpg', owner: { name: '某位作者' }, ...over } })
const ask = (page: number, address: string, fetch: unknown, group?: string) => ({
  url: new URL(address), page, group, fetch: fetch as never,
  userAgent: 'UA', locale: 'zh' as const, signal: AbortSignal.timeout(5_000),
})

test('a bilibili collection link is claimed by the collection adapter, not by the 投稿 one', () => {
  const season = 'https://space.bilibili.com/3494376638516086/lists/8566628?type=season'
  // The 投稿 adapter used to swallow this and answer with the author's entire output instead.
  expect(bilibili.matches(new URL(season))).toBe(false)
  expect(findAdapter(season)?.id).toBe('bilibili-collection')
  expect(findAdapter('https://space.bilibili.com/242020511/channel/collectiondetail?sid=8566628')?.id).toBe('bilibili-collection')
  expect(findAdapter('https://space.bilibili.com/242020511/channel/seriesdetail?sid=4940048')?.id).toBe('bilibili-collection')
  // 收藏夹 is out of scope, so no adapter takes it and it falls through to the engine.
  expect(findAdapter('https://space.bilibili.com/242020511/favlist?fid=123')).toBeUndefined()
  // The 投稿 grid itself is untouched.
  expect(findAdapter('https://space.bilibili.com/242020511/upload/video')?.id).toBe('bilibili')
})

test('a collection is listed a page at a time, and a series asks the endpoint of its own', async () => {
  const called: string[] = []
  const fetch = (url: string) => { called.push(url); return reply(archives(48, 30)) }
  const listing = (await bilibiliCollection.fetchPage!(ask(2, 'https://space.bilibili.com/3494376638516086/lists/8566628?type=season', fetch)))!
  expect(new URL(called[0]).pathname).toBe('/x/polymer/web-space/seasons_archives_list')
  const query = new URL(called[0]).searchParams
  expect([query.get('mid'), query.get('season_id'), query.get('page_num'), query.get('page_size')]).toEqual(['3494376638516086', '8566628', '2', '30'])
  expect(listing.kind).toBe('collection')
  expect(listing.groups).toHaveLength(1)
  // The collection's own name is what its downloads are filed under.
  expect(listing.groups[0].directory).toBe('喵喵网络狠人2.0')
  expect(listing.groups[0].entries[0]).toEqual<ListingEntry>({
    id: 'BV30', url: 'https://www.bilibili.com/video/BV30', title: '第 31 集',
    thumbnail: 'https://i0.hdslb.com/cover.jpg', kind: 'video', duration: 85, views: 1234, publishedAt: 1_757_740_000,
  })
  expect(listing.groups[0].pagination).toEqual({ index: 2, size: 30, total: 48, hasMore: false })
  called.length = 0
  await bilibiliCollection.fetchPage!(ask(1, 'https://space.bilibili.com/242020511/channel/seriesdetail?sid=4940048', fetch))
  expect(new URL(called[0]).pathname).toBe('/x/series/archives')
  expect(new URL(called[0]).searchParams.get('series_id')).toBe('4940048')
})

test('a video page lists its parts, its collection, or neither - and says so by standing down', async () => {
  const pages = [{ page: 1, part: ' 开场 ', duration: 61 }, { page: 2, part: '正片', duration: 4000 }]
  const season = { id: 4940048, title: '少女乐队', mid: 339087866 }
  const answer = (body: unknown) => (url: string) => reply(url.includes('/x/web-interface/wbi/view') ? body : archives(3, 0))
  const both = (await bilibiliVideo.fetchPage!(ask(1, 'https://www.bilibili.com/video/BV1Ps421u7ju', answer(view({ pages, ugc_season: season })))))!
  expect(both.groups.map(group => group.id)).toEqual(['parts', 'collection'])
  // 分P arrive whole, so they never have a second page; the collection does.
  expect(both.groups[0].pagination).toEqual({ index: 1, size: 2, total: 2, hasMore: false })
  expect(both.groups[0].entries).toEqual<ListingEntry[]>([
    // The part's own name, no index bolted in front of it, and the parent's cover for want of its own.
    { id: 'BV1Ps421u7ju-p1', url: 'https://www.bilibili.com/video/BV1Ps421u7ju?p=1', title: '开场', thumbnail: 'https://i0.hdslb.com/parent.jpg', kind: 'video', duration: 61, author: '某位作者' },
    { id: 'BV1Ps421u7ju-p2', url: 'https://www.bilibili.com/video/BV1Ps421u7ju?p=2', title: '正片', thumbnail: 'https://i0.hdslb.com/parent.jpg', kind: 'video', duration: 4000, author: '某位作者' },
  ])
  // The collection contains the video being looked at, so the two tabs would share an id if the parts
  // were keyed by the bare bvid - and the selection and the catalog are both keyed by it.
  expect(both.groups[1].entries.map(entry => entry.id)).toContain('BV0')
  expect(new Set([...both.groups[0].entries, ...both.groups[1].entries].map(entry => entry.id)).size).toBe(5)
  // Parts are filed under the video's own title, the collection under its name.
  expect([both.groups[0].directory, both.groups[1].directory]).toEqual(['少女乐队 第一话', '少女乐队'])
  // One part and no collection is one video, which the engine already handles: the adapter stands down.
  expect(await bilibiliVideo.fetchPage!(ask(1, 'https://www.bilibili.com/video/BV1xx411c7mD', answer(view({ pages: [pages[0]] }))))).toBeUndefined()
  // A collection with no parts is a single tab, and it is the one the page number belongs to.
  const alone = (await bilibiliVideo.fetchPage!(ask(2, 'https://www.bilibili.com/video/BV1Ps421u7ju', answer(view({ pages: [pages[0]], ugc_season: season })))))!
  expect(alone.groups.map(group => group.id)).toEqual(['collection'])
  expect(alone.groups[0].pagination.index).toBe(2)
})

test('turning one tab leaves the other where it was', async () => {
  const asked: string[] = []
  const fetch = (url: string) => { asked.push(url); return reply(url.includes('/x/web-interface/wbi/view') ? view({ pages: [{ page: 1, part: 'A' }, { page: 2, part: 'B' }], ugc_season: { id: 1, title: '合集', mid: 2 } }) : archives(90, 30)) }
  const turned = (await bilibiliVideo.fetchPage!(ask(2, 'https://www.bilibili.com/video/BV1Ps421u7ju', fetch, 'collection')))!
  expect(new URL(asked[1]).searchParams.get('page_num')).toBe('2')
  expect(turned.groups[0].pagination.index).toBe(1)
  // Turning the parts tab, which has no pages of its own, must not drag the collection along with it.
  asked.length = 0
  await bilibiliVideo.fetchPage!(ask(3, 'https://www.bilibili.com/video/BV1Ps421u7ju', fetch, 'parts'))
  expect(new URL(asked[1]).searchParams.get('page_num')).toBe('1')
})

test('a video link that already names a part, and a 番剧, are left to the engine', () => {
  expect(findAdapter('https://www.bilibili.com/video/BV1bK411W797')?.id).toBe('bilibili-video')
  expect(findAdapter('https://www.bilibili.com/video/BV1bK411W797?p=3')).toBeUndefined()
  // 番剧 is a separate route that has not been built yet; claiming it here would break it silently.
  expect(findAdapter('https://www.bilibili.com/bangumi/play/ss113506')).toBeUndefined()
})

// Where the files land, which is the only thing the collection's name is used for once it is downloaded.
const settings = (over: Partial<Settings>): Settings => ({ ...settingsSchema.parse({}), downloadDirectory: path.join('/downloads'), ...over })
const item = (id: string): MediaItem => ({ id, title: `第 ${id} 集`, kind: 'video', formats: [] })
const plan = (groups: { id: string; title: string; directory?: string; itemIds: string[] }[]): ParsePlan => ({
  result: { id: 'fixture', url: 'https://www.bilibili.com/video/BV1Ps421u7ju', title: '少女乐队', platform: 'Bilibili', method: 'browser', listing: 'collection', groups, items: groups.flatMap(group => group.itemIds.map(item)) },
  sources: new Map(), catalog: new Map(),
})

test('a collection is filed under its own name, stacked below the platform directory', () => {
  const both = plan([
    { id: 'parts', title: '分P', directory: '少女乐队 第一话', itemIds: ['a'] },
    { id: 'collection', title: '少女乐队', directory: '少女/乐队', itemIds: ['b'] },
  ])
  expect(directoryFor(settings({}), both, item('a'))).toBe(path.join('/downloads', '少女乐队 第一话'))
  // The directory name is cleaned the same way a filename is: a slash would otherwise make a directory.
  expect(directoryFor(settings({ organizeByPlatform: true }), both, item('b'))).toBe(path.join('/downloads', 'Bilibili', '少女_乐队'))
  // Turned off, everything lands where it did before.
  expect(directoryFor(settings({ organizeByCollection: false }), both, item('a'))).toBe(path.join('/downloads'))
  // A profile listing names no directory, so its posts are not filed under anything either.
  const home = plan([{ id: 'posts', title: '投稿', itemIds: ['a'] }])
  expect(directoryFor(settings({}), home, item('a'))).toBe(path.join('/downloads'))
})

// 微博. The shape below is what the adapter expects, not a captured response - see the note at the top
// of listings/weibo.ts. These tests pin the mapping and, more importantly, pin the standing down:
// an adapter that is wrong about the endpoint must hand the address back, not fail on it.
const status = (id: string, over: Record<string, unknown> = {}) => ({
  id: 5_100_000_000 + Number(id.length), mblogid: id, text_raw: ` 今天的第 ${id} 条
第二行 `,
  created_at: 'Mon Sep 22 10:00:00 +0800 2026', user: { id: 1234567890, screen_name: '示例用户' },
  comments_count: 12, attitudes_count: 340, ...over,
})
const feed = (list: unknown[], total?: number) => ({ ok: 1, data: { list, total_number: total } })
// 微博 writes its timestamps the way C does, so the epoch is whatever the runtime reads that as.
const posted = Math.floor(Date.parse('Mon Sep 22 10:00:00 +0800 2026') / 1000)
const weiboAsk = (page: number, fetch: unknown) => ({
  url: new URL('https://weibo.com/u/1234567890'), page, fetch: fetch as never,
  userAgent: 'UA', locale: 'zh' as const, signal: AbortSignal.timeout(5_000),
})

test('a weibo profile is recognised, but a single post is left to the engine', () => {
  expect(findAdapter('https://weibo.com/u/1234567890')?.id).toBe('weibo')
  expect(findAdapter('https://weibo.com/1234567890')?.id).toBe('weibo')
  // A permalink is one post and yt-dlp has an extractor for it.
  expect(findAdapter('https://weibo.com/1234567890/Qa1Bc2De3')).toBeUndefined()
  expect(weibo.entryUrl(new URL('https://weibo.com/1234567890'))).toBe('https://weibo.com/u/1234567890')
})

test('a weibo page maps videos and pictures and drops posts that are only text', async () => {
  const called: string[] = []
  const video = status('Qa1Bc2De3', { page_info: { type: 'video', page_pic: 'http://wx1.sinaimg.cn/cover.jpg', media_info: { duration: 93 } } })
  const pictures = status('RixTsFiDJ', { pic_ids: ['p1'], pic_infos: { p1: { large: { url: 'https://wx2.sinaimg.cn/large/p1.jpg' } } } })
  const fetch = (url: string) => { called.push(url); return reply(feed([video, pictures, status('RtextOnly')], 96)) }
  const listing = (await weibo.fetchPage!(weiboAsk(2, fetch)))!
  expect(new URL(called[0]).searchParams.get('uid')).toBe('1234567890')
  expect(new URL(called[0]).searchParams.get('page')).toBe('2')
  expect(listing.groups[0].entries).toEqual<ListingEntry[]>([
    { id: 'Qa1Bc2De3', url: 'https://weibo.com/1234567890/Qa1Bc2De3', title: '今天的第 Qa1Bc2De3 条', thumbnail: 'https://wx1.sinaimg.cn/cover.jpg', kind: 'video', duration: 93, likes: 340, comments: 12, author: '示例用户', publishedAt: posted },
    { id: 'RixTsFiDJ', url: 'https://weibo.com/1234567890/RixTsFiDJ', title: '今天的第 RixTsFiDJ 条', thumbnail: 'https://wx2.sinaimg.cn/large/p1.jpg', kind: 'image', duration: undefined, likes: 340, comments: 12, author: '示例用户', publishedAt: posted },
  ])
  // A text-only post is not a download, but it still counted towards the page: dropping it from the
  // page size would read as the profile having ended.
  expect(listing.groups[0].pagination).toEqual({ index: 2, size: 20, total: 96, hasMore: true })
})

test('a weibo reply this adapter does not understand is handed back rather than failed on', async () => {
  // The endpoint being wrong is this adapter's mistake. Standing down puts the address back on the
  // route it would have taken if the adapter did not exist, which is the worst it may cost.
  for (const body of [{ error: 'not found' }, { ok: 1, data: { list: 'nope' } }, 'a login page, not JSON']) {
    expect(await weibo.fetchPage!(weiboAsk(1, () => reply(body)))).toBeUndefined()
  }
  // 微博 answering a stranger with nothing is a refusal, and that is reported as one.
  await expect(weibo.fetchPage!(weiboAsk(1, () => reply(feed([]))))).rejects.toThrow(LoginRequired)
  // Signed out it answers ok:0, and the engine still lists a profile anonymously, so this stands down.
  expect(await weibo.fetchPage!(weiboAsk(1, () => reply({ ok: 0, message: '前方有点拥堵，请登录后使用' })))).toBeUndefined()
})
