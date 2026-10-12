import { expect, test, vi } from 'vitest'
import { bilibili } from '../electron/services/listings/bilibili'
import { douyin } from '../electron/services/listings/douyin'
import { LoginRequired } from '../electron/services/login'
import { notesOf, xiaohongshu } from '../electron/services/listings/xiaohongshu'
import { harvest, youtube } from '../electron/services/listings/youtube'
import { countOf, seconds } from '../electron/services/listings/text'
import { findAdapter } from '../electron/services/listings'
import type { Fingerprint, ListingEntry, ListingPage } from '../electron/services/listings/types'

// Every adapter but the one for 哔哩哔哩 video pages serves a single group, so these read that one and
// keep the listing's own title beside it.
const only = (page: ListingPage | undefined) => ({ ...page!.groups[0], title: page!.title })

const nav = { data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } }
const PS = 40
const page = (pn: number, count: number) => ({ code: 0, data: { list: { vlist: Array.from({ length: Math.min(PS, count - (pn - 1) * PS) }, (_, index) => ({ bvid: `BV${pn}${index}`, title: ` 作品 ${pn}-${index} `, pic: `//i1.hdslb.com/${pn}-${index}.jpg`, author: '严肃传播圣女因子中', play: 2091, video_review: 0, comment: 72, length: '01:15', created: 1_757_740_000 })) }, page: { pn, ps: PS, count } } })
const reply = (body: unknown) => Promise.resolve({ json: async () => body } as Response)
// Taken off a live 投稿 request: the strings a real graphics stack reports on this platform.
const print: Fingerprint = {
  glVersion: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
  glRenderer: 'ANGLE (AMD, AMD Radeon 780M Graphics (0x00001900) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  glVendor: 'Google Inc. (AMD)', width: 1280, height: 900,
}
const ask = (page: number, over: Partial<Parameters<NonNullable<typeof bilibili.fetchPage>>[0]> = {}) => ({
  url: new URL('https://space.bilibili.com/242020511/upload/video'), page,
  fetch: (() => reply(nav)) as never, userAgent: 'UA', locale: 'zh' as const,
  fingerprint: print, signal: AbortSignal.timeout(5_000), ...over,
})

test('a bilibili space is recognised and sent to its 投稿 tab', () => {
  expect(findAdapter('https://space.bilibili.com/3546914735786087/?spm_id_from=333.788')?.id).toBe('bilibili')
  // A video page belongs to the adapter that reads its 分P and 合集, never to the 投稿 grid's.
  expect(bilibili.matches(new URL('https://www.bilibili.com/video/BV1xx411c7mD'))).toBe(false)
  // The site redirects a bare /video there anyway, so the tab is named the way the page ends up.
  expect(bilibili.entryUrl(new URL('https://space.bilibili.com/242020511/?spm_id_from=333.788'))).toBe('https://space.bilibili.com/242020511/upload/video?spm_id_from=333.788')
  // A tab the user picked themselves is left alone.
  expect(bilibili.entryUrl(new URL('https://space.bilibili.com/242020511/dynamic'))).toBe('https://space.bilibili.com/242020511/dynamic')
})

test('a listing page is signed, parsed, and reports whether another page follows', async () => {
  const called: string[] = []
  const fetch = (url: string) => { called.push(url); return reply(url.includes('/x/web-interface/nav') ? nav : page(2, 90)) }
  const listing = only(await bilibili.fetchPage!(ask(2, { fetch })))
  const search = called.find(url => url.includes('arc/search'))!
  const query = new URL(search).searchParams
  expect(query.get('mid')).toBe('242020511')
  expect(query.get('pn')).toBe('2')
  expect(query.get('ps')).toBe('40')
  // wbi: every request carries a timestamp and the signature of its own sorted query.
  expect(query.get('w_rid')).toMatch(/^[0-9a-f]{32}$/)
  expect(Number(query.get('wts'))).toBeGreaterThan(1_700_000_000)
  // 'video_review' is the danmaku count and 'length' a display string, so both are translated on the way in.
  expect(listing.entries.slice(0, 1)).toEqual<ListingEntry[]>([{
    id: 'BV20', url: 'https://www.bilibili.com/video/BV20', title: '作品 2-0', thumbnail: 'https://i1.hdslb.com/2-0.jpg', kind: 'video',
    duration: 75, views: 2091, danmaku: 0, comments: 72, author: '严肃传播圣女因子中', publishedAt: 1_757_740_000,
  }])
  expect(listing.pagination).toEqual({ index: 2, size: 40, total: 90, hasMore: true })
  expect(only(await bilibili.fetchPage!(ask(3, { fetch }))).pagination.hasMore).toBe(false)
})

// 风控 reads the client's graphics stack off the request: a correctly signed call carrying the site's
// own visitor cookies is still answered -352 without these, which is what made the fast route dead.
test('a listing request names the graphics stack the way the page itself does', async () => {
  const called: string[] = []
  const fetch = (url: string) => { called.push(url); return reply(url.includes('/x/web-interface/nav') ? nav : page(1, 40)) }
  await bilibili.fetchPage!(ask(1, { fetch }))
  const query = new URL(called.find(url => url.includes('arc/search'))!).searchParams
  expect(query.get('dm_img_list')).toBe('[]')
  // base64 of what WebGL reports, padding stripped, exactly as the page writes it.
  expect(query.get('dm_img_str')).toBe('V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ')
  // Renderer and vendor joined, then cut short: a full-length value is a different string.
  expect(query.get('dm_cover_img_str')).toBe('QU5HTEUgKEFNRCwgQU1EIFJhZGVvbiA3ODBNIEdyYXBoaWNzICgweDAwMDAxOTAwKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKUdvb2dsZSBJbmMuIChBTU')
  expect(query.get('dm_cover_img_str')).toHaveLength(130)
  expect(JSON.parse(query.get('dm_img_inter')!)).toEqual({ ds: [], wh: [1280, 900, 0], of: [0, 0, 0] })
  // The spm has to be the 投稿 tab's own, and it is signed along with everything else.
  expect(query.get('web_location')).toBe('333.1387')
  expect(JSON.parse(query.get('x-bili-device-req-json')!).spmid).toBe('333.1387')
})

// The locale travels with the request so this field cannot disagree with the session's Accept-Language.
test('the language the client asks in follows the locale it was given', async () => {
  const locales = ['zh', 'en'] as const
  const asked = []
  for (const locale of locales) {
    const called: string[] = []
    const fetch = (url: string) => { called.push(url); return reply(url.includes('/x/web-interface/nav') ? nav : page(1, 40)) }
    await bilibili.fetchPage!(ask(1, { fetch, locale }))
    asked.push(JSON.parse(new URL(called.find(url => url.includes('arc/search'))!).searchParams.get('x-bili-locale-json')!).c_locale)
  }
  expect(asked).toEqual([
    { language: 'zh', script: 'Hans' }, { language: 'en', script: 'Latn' },
  ])
})

// Without a page to read the strings off there is nothing to send, so the route closes and the caller
// falls back to the window rather than making a request that is certain to be refused.
test('a listing is not requested at all when the graphics stack is unknown', async () => {
  const called: string[] = []
  const fetch = (url: string) => { called.push(url); return reply(nav) }
  await expect(bilibili.fetchPage!(ask(1, { fetch, fingerprint: undefined }))).rejects.toThrow('指纹')
  expect(called).toEqual([])
})

// Read off a live bilibili origin: the keys are kept both joined and apart, and the client has already
// paid for them by loading a page, so asking nav again would be a request for something it is holding.
const kept = {
  wbi_img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  wbi_sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  wbi_img_urls: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png-https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
}

test('signing keys come from the page the client already loaded, not from another request', async () => {
  // The keys are cached for half an hour in module scope, so each route is given a fresh copy of the
  // adapter; the clock is held still so the three signatures are of the same query, not of three times.
  vi.useFakeTimers()
  vi.setSystemTime(1_789_889_819_000)
  const signed = async (storage: Record<string, string> | undefined) => {
    vi.resetModules()
    const { bilibili: fresh } = await import('../electron/services/listings/bilibili')
    const called: string[] = []
    const fetch = (url: string) => { called.push(url); return reply(url.includes('/x/web-interface/nav') ? nav : page(1, 40)) }
    await fresh.fetchPage!(ask(1, { fetch, storage }))
    return { called, rid: new URL(called.find(url => url.includes('arc/search'))!).searchParams.get('w_rid') }
  }
  const stored = await signed(kept)
  expect(stored.called.some(url => url.includes('nav'))).toBe(false)
  // The joined form alone is enough: it is split at the boundary between the two URLs.
  const joined = await signed({ wbi_img_urls: kept.wbi_img_urls })
  expect(joined.called.some(url => url.includes('nav'))).toBe(false)
  // An origin that was never visited, or kept nothing, still has nav to fall back on.
  const asked = await signed(undefined)
  expect(asked.called.some(url => url.includes('nav'))).toBe(true)
  // All three routes reach the same keys, so they sign the same query the same way.
  expect(new Set([stored.rid, joined.rid, asked.rid]).size).toBe(1)
  vi.useRealTimers()
})

test('risk control is reported instead of being read as an empty profile', async () => {
  const fetch = (url: string) => reply(url.includes('/x/web-interface/nav') ? nav : { code: -352, message: '风控校验失败' })
  await expect(bilibili.fetchPage!(ask(1, { fetch }))).rejects.toThrow('-352')
})

test('display numbers are read as plain numbers whichever way a platform writes them', () => {
  expect(seconds('01:15')).toBe(75)
  expect(seconds('1:02:03')).toBe(3723)
  expect(seconds('直播中')).toBeUndefined()
  expect(countOf('1,234 views')).toBe(1234)
  expect(countOf('1.2万')).toBe(12_000)
  expect(countOf('2.1M views')).toBe(2_100_000)
  expect(countOf(0)).toBe(0)
  expect(countOf('No views')).toBeUndefined()
})

// 抖音: shapes taken from a live /aweme/v1/web/aweme/post/ reply.
const post = (id: string, over: Record<string, unknown> = {}) => ({
  aweme_id: id, desc: ` 作品 ${id} `, create_time: 1_773_390_609, media_type: 4,
  video: { cover: { url_list: [`https://p9-pc-sign.douyinpic.com/${id}.jpeg`] }, duration: 1_177_556 },
  author: { nickname: '天爱Talk' }, statistics: { digg_count: 402_770, comment_count: 8_649, play_count: 0 },
  ...over,
})
const posts = (ids: string[], more: number, cursor: number) => ({ status_code: 0, aweme_list: ids.map(id => post(id)), has_more: more, max_cursor: cursor })
const douyinAsk = (page: number, fetch: unknown) => ({
  url: new URL('https://www.douyin.com/user/MS4wLjABAAAAsec'), page, fetch: fetch as never,
  userAgent: 'UA', locale: 'zh' as const, signal: AbortSignal.timeout(5_000),
})

test('a douyin profile is recognised and its listing is asked for without reproducing a_bogus', async () => {
  expect(findAdapter('https://www.douyin.com/user/MS4wLjABAAAAsec')?.id).toBe('douyin')
  // A work's own page now belongs to the adapter that reads whether a 合集 is behind it, never to
  // the profile grid's - and that one stands down for an ordinary video.
  expect(douyin.matches(new URL('https://www.douyin.com/video/7616654667153467482'))).toBe(false)
  expect(douyin.entryUrl(new URL('https://www.douyin.com/user/MS4wLjABAAAAsec'))).toBe('https://www.douyin.com/user/MS4wLjABAAAAsec?showTab=post')
  const called: string[] = []
  const fetch = (url: string) => { called.push(url); return Promise.resolve({ json: async () => posts(['a1', 'a2'], 1, 1_782_894_776_000) } as Response) }
  const listing = only(await douyin.fetchPage!(douyinAsk(1, fetch)))
  const query = new URL(called[0]).searchParams
  expect(query.get('sec_user_id')).toBe('MS4wLjABAAAAsec')
  expect(query.get('max_cursor')).toBe('0')
  // The signature is the page's to add, so none of these are sent: reproducing them is the whole thing
  // this route exists to avoid.
  for (const name of ['a_bogus', 'msToken', 'x-secsdk-web-signature', 'verifyFp']) expect(query.get(name)).toBeNull()
  expect(listing.title).toBe('天爱Talk的作品')
  expect(listing.entries[0]).toEqual<ListingEntry>({
    id: 'a1', url: 'https://www.douyin.com/video/a1', title: '作品 a1', kind: 'video',
    thumbnail: 'https://p9-pc-sign.douyinpic.com/a1.jpeg', duration: 1178,
    likes: 402_770, comments: 8_649, author: '天爱Talk', publishedAt: 1_773_390_609,
  })
  // 'play_count' is zero on every web listing, so it is left off rather than reported as no plays.
  expect(listing.entries[0].views).toBeUndefined()
  expect(listing.pagination).toEqual({ index: 1, size: 2, hasMore: true })
})

test('a douyin picture post is linked as a note and carries no duration', async () => {
  const picture = post('p1', { media_type: 2, images: [{ url_list: ['https://p3-pc-sign.douyinpic.com/p1.jpeg'] }], video: { duration: 0 } })
  const fetch = () => Promise.resolve({ json: async () => ({ status_code: 0, aweme_list: [picture], has_more: 0 }) } as Response)
  const listing = only(await douyin.fetchPage!(douyinAsk(1, fetch)))
  expect(listing.entries[0]).toMatchObject({ id: 'p1', url: 'https://www.douyin.com/note/p1', kind: 'image', thumbnail: 'https://p3-pc-sign.douyinpic.com/p1.jpeg' })
  expect(listing.entries[0].duration).toBeUndefined()
  expect(listing.pagination.hasMore).toBe(false)
})

// A profile of its own, so the walk starts from nothing rather than from what an earlier test read.
const walkAsk = (page: number, fetch: unknown) => ({ ...douyinAsk(page, fetch), url: new URL('https://www.douyin.com/user/MS4wLjABAAAAwalk') })

test('a later douyin page is walked by cursor, and the page after it resumes instead of walking again', async () => {
  const cursors: string[] = []
  const fetch = (url: string) => {
    const cursor = new URL(url).searchParams.get('max_cursor')!
    cursors.push(cursor)
    return Promise.resolve({ json: async () => posts([`c${cursor}`], 1, Number(cursor) + 100) } as Response)
  }
  const listing = only(await douyin.fetchPage!(walkAsk(3, fetch)))
  // Reaching page 3 for the first time costs the two before it, each handing the next its cursor.
  expect(cursors).toEqual(['0', '100', '200'])
  expect(listing.entries.map(entry => entry.id)).toEqual(['c200'])
  // Page 4 is one step on from a page already read, so it starts where page 3 ended: one request.
  cursors.length = 0
  const next = only(await douyin.fetchPage!(walkAsk(4, fetch)))
  expect(cursors).toEqual(['300'])
  expect(next.entries.map(entry => entry.id)).toEqual(['c300'])
  // Going back to a page already behind us walks only from the page before it, never from the start.
  cursors.length = 0
  await douyin.fetchPage!(walkAsk(2, fetch))
  expect(cursors).toEqual(['100'])
  // A reply holding nothing but its status code is 抖音 refusing a signed-out visitor a second page.
  // Raised as a sign-in rather than a plain failure, which is what puts the login window in front of
  // the user instead of an error they can do nothing about.
  const refused = () => Promise.resolve({ json: async () => ({ status_code: 0 }) } as Response)
  await expect(douyin.fetchPage!(douyinAsk(1, refused))).rejects.toThrow(LoginRequired)
  await expect(douyin.fetchPage!(douyinAsk(1, refused))).rejects.toThrow('登录')
  // Risk control is not a sign-in: a login does not reliably lift it, so it stays a plain error.
  const risk = () => Promise.resolve({ json: async () => ({ status_code: 2_154, status_msg: '请求过于频繁' }) } as Response)
  await expect(douyin.fetchPage!(douyinAsk(1, risk))).rejects.not.toThrow(LoginRequired)
})

// 小红书
const posted = {
  data: {
    has_more: true,
    notes: [
      {
        note_id: 'n1', display_title: ' 笔记一 ', type: 'video', xsec_token: 'tok/1',
        cover: { info_list: [{ url: 'http://sns-img.xhscdn.com/a.jpg' }] },
        interact_info: { liked_count: '1.2万' }, user: { nick_name: '某位作者' },
      },
      { note_id: 'n2', type: 'normal', cover: { url_default: 'https://sns-img.xhscdn.com/b.jpg' }, interact_info: { liked_count: '0' } },
    ],
  },
}

test('the xiaohongshu adapter is written but switched off, and still maps a listing when it returns', () => {
  // Not registered, so nothing routes to it; parser.ts refuses those profiles outright instead. It has
  // no fetchPage either, which is the only route there is, so the mapping is all that is kept warm.
  expect(findAdapter('https://www.xiaohongshu.com/user/profile/6a2174510000000002002401')).toBeUndefined()
  expect(xiaohongshu.matches(new URL('https://www.xiaohongshu.com/user/profile/6a2174510000000002002401'))).toBe(true)
  expect(xiaohongshu.fetchPage).toBeUndefined()
  expect(notesOf(posted)).toEqual<ListingEntry[]>([
    {
      id: 'n1', url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok%2F1&xsec_source=pc_user', title: '笔记一', kind: 'video',
      thumbnail: 'https://sns-img.xhscdn.com/a.jpg', likes: 12_000, author: '某位作者',
    },
    { id: 'n2', url: 'https://www.xiaohongshu.com/explore/n2', title: '小红书笔记 n2', kind: 'image', thumbnail: 'https://sns-img.xhscdn.com/b.jpg', likes: 0, author: undefined },
  ])
})

// YouTube: the channel grid is built from view models, which is what the live pages send today.
const videoItem = (id: string, title: string, views: string, length?: string) => ({
  richItemRenderer: { content: { lockupViewModel: {
    contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: {
      image: { sources: [{ url: 'https://i.ytimg.com/small.jpg', width: 360 }, { url: '//i.ytimg.com/large.jpg', width: 720 }] },
      overlays: length ? [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: length } }] } }] : [],
    } },
    metadata: { lockupMetadataViewModel: {
      title: { content: title },
      metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: views } }, { text: { content: '4 days ago' } }] }] } },
    } },
  } } },
})
const continuationItem = (token: string) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } })
const initialData = (token?: string) => ({
  contents: { twoColumnBrowseResultsRenderer: { tabs: [
    { tabRenderer: { selected: false, content: { sectionListRenderer: { contents: [continuationItem('SHELF-TOKEN')] } } } },
    { tabRenderer: { selected: true, content: { richGridRenderer: { contents: [
      // A title holding '};' would end a regular-expression read of the page early.
      videoItem('v1', '第一页 };', '1,234 views', '1:02:03'),
      ...(token ? [continuationItem(token)] : []),
    ] } } } },
  ] } },
  metadata: { channelMetadataRenderer: { title: 'Fatcat' } },
})
const channelHtml = (token?: string) => `<!doctype html><html><script>var ytInitialData = ${JSON.stringify(initialData(token))};</script>`
  + `<script>window.ytcfg.set({"INNERTUBE_API_KEY":"AIza-test","INNERTUBE_CLIENT_VERSION":"2.20990101.00.00"});</script></html>`
const appended = (token?: string) => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
  videoItem('v2', '第二页', '2.1M views'),
  ...(token ? [continuationItem(token)] : []),
] } }] })

test('a youtube channel is recognised and sent to its uploads tab', () => {
  expect(findAdapter('https://www.youtube.com/@Fatcat996')?.id).toBe('youtube')
  expect(findAdapter('https://www.youtube.com/channel/UCabc-123')?.id).toBe('youtube')
  expect(findAdapter('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined()
  expect(youtube.entryUrl(new URL('https://www.youtube.com/@Fatcat996'))).toBe('https://www.youtube.com/@Fatcat996/videos')
  expect(youtube.entryUrl(new URL('https://www.youtube.com/channel/UCabc-123/'))).toBe('https://www.youtube.com/channel/UCabc-123/videos')
  // A tab the user picked themselves is left alone.
  expect(youtube.entryUrl(new URL('https://www.youtube.com/@Fatcat996/streams'))).toBe('https://www.youtube.com/@Fatcat996/streams')
})

test('the first youtube page is read out of the channel page itself', async () => {
  const called: string[] = []
  const fetch = (url: string) => { called.push(url); return Promise.resolve({ text: async () => channelHtml('TOKEN1') } as Response) }
  const listing = only(await youtube.fetchPage!({ url: new URL('https://www.youtube.com/@Fatcat996'), page: 1, fetch, userAgent: 'UA', locale: 'zh', signal: AbortSignal.timeout(5_000) }))
  expect(called).toEqual(['https://www.youtube.com/@Fatcat996/videos?hl=en&gl=US'])
  expect(listing.title).toBe('Fatcat的视频')
  expect(listing.entries).toEqual<ListingEntry[]>([{
    id: 'v1', url: 'https://www.youtube.com/watch?v=v1', title: '第一页 };', kind: 'video',
    thumbnail: 'https://i.ytimg.com/large.jpg', duration: 3723, views: 1234, author: 'Fatcat',
  }])
  expect(listing.pagination).toEqual({ index: 1, size: 1, hasMore: true })
})

test('the other two youtube shapes are read as well: a short, and the older video renderer', () => {
  const sink = new Map<string, ListingEntry>()
  harvest({ contents: [
    { shortsLockupViewModel: {
      entityId: 'shorts-shelf-item-s1', onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 's1', thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/s1/frame0.jpg', width: 1080 }] } } } },
      overlayMetadata: { primaryText: { content: '一条短片' }, secondaryText: { content: '13M views' } },
    } },
    { videoRenderer: {
      videoId: 'r1', title: { runs: [{ text: '旧版渲染器' }] }, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/r1/hq.jpg', width: 480 }] },
      lengthText: { simpleText: '2:05' }, viewCountText: { simpleText: '1,000 views' }, ownerText: { runs: [{ text: '某频道' }] },
    } },
  ] }, sink)
  expect([...sink.values()]).toEqual<ListingEntry[]>([
    { id: 's1', url: 'https://www.youtube.com/shorts/s1', title: '一条短片', thumbnail: 'https://i.ytimg.com/vi/s1/frame0.jpg', kind: 'video', views: 13_000_000 },
    { id: 'r1', url: 'https://www.youtube.com/watch?v=r1', title: '旧版渲染器', thumbnail: 'https://i.ytimg.com/vi/r1/hq.jpg', kind: 'video', duration: 125, views: 1000, author: '某频道' },
  ])
})

test('a later youtube page is walked with the continuation token the page before it handed out', async () => {
  const called: { url: string; body?: string }[] = []
  const fetch = (url: string, init?: { body?: string }) => {
    called.push({ url, body: init?.body })
    return Promise.resolve({ text: async () => channelHtml('TOKEN1'), json: async () => appended(undefined) } as Response)
  }
  const listing = only(await youtube.fetchPage!({ url: new URL('https://www.youtube.com/@Fatcat996/videos'), page: 2, fetch, userAgent: 'UA', locale: 'zh', signal: AbortSignal.timeout(5_000) }))
  const browse = called.find(call => call.url.includes('/youtubei/v1/browse'))!
  expect(browse.url).toBe('https://www.youtube.com/youtubei/v1/browse?key=AIza-test')
  // The token has to be the grid's own; another shelf on the page offers one that leads nowhere.
  expect(JSON.parse(browse.body!)).toEqual({ context: { client: { clientName: 'WEB', clientVersion: '2.20990101.00.00', hl: 'en', gl: 'US' } }, continuation: 'TOKEN1' })
  // The pages walked on the way there are paid for and dropped: only the page asked for is returned.
  expect(listing.entries.map(entry => entry.id)).toEqual(['v2'])
  expect(listing.entries[0].views).toBe(2_100_000)
  expect(listing.pagination).toEqual({ index: 2, size: 1, hasMore: false })
})
