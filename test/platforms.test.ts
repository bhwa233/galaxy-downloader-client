import { expect, test } from 'vitest'
import { douyin, douyinCollection, douyinSeries, douyinVideo } from '../electron/services/listings/douyin'
import { instagram } from '../electron/services/listings/instagram'
import { weixin } from '../electron/services/listings/weixin'
import { x } from '../electron/services/listings/x'
import { findAdapter } from '../electron/services/listings'
import { LoginRequired } from '../electron/services/login'
import type { ListingEntry, PageRequest } from '../electron/services/listings/types'

const reply = (body: unknown, status = 200) => Promise.resolve({ status, json: async () => body, text: async () => JSON.stringify(body) } as Response)
const ask = (address: string, over: Partial<PageRequest> = {}): PageRequest => ({
  url: new URL(address), page: 1, fetch: (() => reply({})) as never,
  userAgent: 'UA', locale: 'zh', signal: AbortSignal.timeout(5_000), ...over,
})

// Every adapter in this file was written without a captured response to work from - see the note at
// the top of each one. What can still be pinned is the part that decides whether being wrong is
// cheap: the URLs each claims, and that an unexpected reply makes it stand down rather than fail.

test('each platform claims its listings and leaves single works to the engine', () => {
  // 抖音
  expect(findAdapter('https://www.douyin.com/user/MS4wLjABAAAAsec')?.id).toBe('douyin')
  expect(findAdapter('https://www.douyin.com/collection/7123456789')?.id).toBe('douyin-collection')
  expect(findAdapter('https://www.douyin.com/video/7616654667153467482')?.id).toBe('douyin-video')
  expect(findAdapter('https://www.douyin.com/series')?.id).toBe('douyin-series')
  // An episode link was already rewritten to '/video/<id>' by normalizeUrl, so nothing claims this.
  expect(douyinSeries.matches(new URL('https://www.douyin.com/series?modal_id=76763299'))).toBe(false)
  // X
  expect(findAdapter('https://x.com/elonmusk')?.id).toBe('x')
  expect(findAdapter('https://twitter.com/FinanceYF5')?.id).toBe('x')
  // A single post is read for its pictures, which the engine has no extractor for.
  expect(findAdapter('https://x.com/FinanceYF5/status/2101585391140905034')?.id).toBe('x-post')
  expect(findAdapter('https://x.com/home')).toBeUndefined()
  // Instagram
  expect(findAdapter('https://www.instagram.com/instagram/')?.id).toBe('instagram')
  expect(findAdapter('https://www.instagram.com/instagram/reels/')?.id).toBe('instagram')
  // A '/p/' post may be pictures, which the engine cannot read; a reel is always a video.
  expect(findAdapter('https://www.instagram.com/p/DdUG_iuEf3E/')?.id).toBe('instagram-post')
  expect(findAdapter('https://www.instagram.com/reel/DdcI4o0Prsz/')).toBeUndefined()
  // 微信公众号: the 合集 is reachable on the web, a single article belongs to the engine.
  expect(findAdapter('https://mp.weixin.qq.com/mp/appmsgalbum?__biz=Mz123&album_id=456')?.id).toBe('weixin')
  expect(findAdapter('https://mp.weixin.qq.com/s/OHPkIAjecIO-AH8jicfXKQ')).toBeUndefined()
})

test('a reply an adapter does not recognise is handed back, never guessed at', async () => {
  const unexpected = [{ unrelated: true }, { data: 'not an object' }, []]
  for (const body of unexpected) {
    expect(await douyinVideo.fetchPage!(ask('https://www.douyin.com/video/7616654667153467482', { fetch: (() => reply(body)) as never }))).toBeUndefined()
    expect(await instagram.fetchPage!(ask('https://www.instagram.com/instagram/', { fetch: (() => reply(body)) as never }))).toBeUndefined()
    expect(await weixin.fetchPage!(ask('https://mp.weixin.qq.com/mp/appmsgalbum?__biz=Mz123&album_id=456', { fetch: (() => reply(body)) as never }))).toBeUndefined()
  }
  // A 404 is the endpoint being wrong, which is this client's mistake rather than a refusal.
  expect(await douyinCollection.fetchPage!(ask('https://www.douyin.com/collection/7123456789', { fetch: (() => reply({}, 404)) as never }))).toBeUndefined()
  // X cannot even start without a way to read the page: no token and no operation ids live out here.
  expect(await x.fetchPage!(ask('https://x.com/elonmusk'))).toBeUndefined()
})

test('a douyin profile tab is read as the tab it names, with a walk of its own', async () => {
  // The old behaviour rewrote every tab to 'post', so 喜欢 answered with the user's own uploads.
  const liked = 'https://www.douyin.com/user/MS4wLjABAAAAtab?showTab=like'
  expect(douyin.entryUrl(new URL(liked))).toBe(liked)
  expect(douyin.entryUrl(new URL('https://www.douyin.com/user/MS4wLjABAAAAtab'))).toBe('https://www.douyin.com/user/MS4wLjABAAAAtab?showTab=post')
  const paths: string[] = []
  const post = { aweme_id: 'a1', desc: '作品', author: { nickname: '天爱Talk' }, video: { duration: 1000 }, statistics: {} }
  const fetch = (address: string) => {
    paths.push(new URL(address).pathname)
    return reply({ status_code: 0, aweme_list: [post], has_more: 1, max_cursor: Number(new URL(address).searchParams.get('max_cursor')) + 100 })
  }
  const likes = (await douyin.fetchPage!(ask(liked, { fetch: fetch as never })))!
  expect(paths).toEqual(['/aweme/v1/web/aweme/favorite/'])
  expect(likes.title).toBe('天爱Talk的喜欢')
  // The cursor cache is keyed by user *and* tab: walking 喜欢 must not hand 作品 its place in the walk.
  paths.length = 0
  await douyin.fetchPage!(ask('https://www.douyin.com/user/MS4wLjABAAAAtab?showTab=post', { page: 2, fetch: fetch as never }))
  // Page 2 of 作品 is walked from the top, not resumed from 喜欢's page 1 cursor.
  expect(paths).toEqual(['/aweme/v1/web/aweme/post/', '/aweme/v1/web/aweme/post/'])
})

test('抖音 my-own-page is a sign-in problem rather than a user called "self"', async () => {
  // The literal 'self' is not a sec_user_id, and handing it to the API asks about nobody.
  const asked: string[] = []
  const answering = (self: unknown) => (address: string) => {
    asked.push(new URL(address).pathname)
    return reply(address.includes('/user/profile/self/') ? self : { status_code: 0, aweme_list: [] })
  }
  // Signed out, the site cannot say who 'self' is, and the listing is never asked for.
  await expect(douyin.fetchPage!(ask('https://www.douyin.com/user/self?showTab=post', { fetch: answering({ status_code: 8 }) as never }))).rejects.toThrow(LoginRequired)
  expect(asked).toEqual(['/aweme/v1/web/user/profile/self/'])
  // Signed in, the site's own answer names the user - never an id picked out of page storage.
  asked.length = 0
  const listed: string[] = []
  const signedIn = (address: string) => { listed.push(address); return answering({ user: { sec_uid: 'MS4wLjABAAAAmyself0000' } })(address) }
  await douyin.fetchPage!(ask('https://www.douyin.com/user/self?showTab=post', { fetch: signedIn as never, storage: { 'some-key': '{"uid":"MS4wLjABAAAAstranger"}' } })).catch(() => undefined)
  expect(new URL(listed[1]).searchParams.get('sec_user_id')).toBe('MS4wLjABAAAAmyself0000')
})

test('抖音 短剧 index lists each show as the whole 合集 it is', async () => {
  const catalogue = { status_code: 0, has_more: true, card_list: [{ series: { series_id: '7300', series_name: ' 逆袭 ', stats: { total_episode: 80 } } }, {}] }
  const listing = (await douyinSeries.fetchPage!(ask('https://www.douyin.com/series', { fetch: (() => reply(catalogue)) as never })))!
  expect(listing.groups[0].entries).toMatchObject([{ id: '7300', url: 'https://www.douyin.com/collection/7300', whole: true, title: '逆袭（80 集）' }])
  expect(listing.groups[0].pagination.hasMore).toBe(true)
  // An empty first page means the catalogue was withheld, which is a sign-in problem.
  await expect(douyinSeries.fetchPage!(ask('https://www.douyin.com/series', { fetch: (() => reply({ status_code: 0, card_list: [] })) as never }))).rejects.toThrow(LoginRequired)
})

test('a 公众号 profile is refused with the reason, and its 合集 is listed', async () => {
  // 历史消息列表 does not exist on the open web at all, so there is nothing to fall through to.
  await expect(weixin.fetchPage!(ask('https://mp.weixin.qq.com/mp/homepage?__biz=Mz123'))).rejects.toThrow('微信客户端')
  const album = {
    base_resp: { ret: 0 },
    getalbum_resp: {
      album_info: { title: '每周一曲' },
      continue_flag: '1',
      article_list: [{ msgid: '2247483', itemidx: '1', title: ' 第一篇 ', cover_img: 'http://mmbiz.qpic.cn/a.jpg', url: 'https://mp.weixin.qq.com/s?__biz=Mz123&amp;mid=1', create_time: '1757740000', nickname: '夏天SIA' }],
    },
  }
  const listing = (await weixin.fetchPage!(ask('https://mp.weixin.qq.com/mp/appmsgalbum?__biz=Mz123&album_id=456', { fetch: (() => reply(album)) as never })))!
  expect(listing.groups[0].entries).toEqual<ListingEntry[]>([{
    id: '2247483-1', url: 'https://mp.weixin.qq.com/s?__biz=Mz123&mid=1', title: '第一篇',
    thumbnail: 'https://mmbiz.qpic.cn/a.jpg', kind: 'image', author: '夏天SIA', publishedAt: 1_757_740_000,
  }])
  expect(listing.groups[0].title).toBe('每周一曲')
})
