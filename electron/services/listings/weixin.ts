// 微信公众号 article lists.
//
// This platform is not like the others, and the difference is worth stating once. 2.1 asks for "历史
// 消息列表" as the batch entry point, and on the open web that list does not exist: it is a view
// inside the WeChat client, opened from a session the app holds, and no address reaches it from a
// browser. What the open web does serve is a 合集 (album) - the author's own grouping of articles -
// at 'mp.weixin.qq.com/mp/appmsgalbum', and that is what this adapter reads.
//
// So: the 合集 link works, and a 公众号 profile does not, because there is nothing behind it to work.
// Saying so plainly is the answer; falling through to a route that was never going to serve it would
// fail for a reason that reads like a login problem.
//
// Checked against the live site on 2026-09-23: the shape below is what the album page's own request
// gets back, anonymously. A reply that is not it still makes the adapter stand down.
import { LoginRequired } from '../login'
import { isRecord, onePage, type ListingEntry, type ListingPage, type PageRequest, type ProfileAdapter } from './types'

const HOST = 'https://mp.weixin.qq.com'
// What the album page asks for in one scroll.
const COUNT = 10

type Article = { msgid?: string; itemidx?: string; title?: string; cover_img_1_1?: string; cover_img?: string; url?: string; create_time?: string; nickname?: string }
type Album = {
  base_resp?: { ret?: number; errmsg?: string }
  getalbum_resp?: { article_list?: Article[]; continue_flag?: string; album_info?: { title?: string }; base_info?: { title?: string } }
}

type Source = { biz: string; album: string }

export function albumOf(url: URL): Source | undefined {
  if (!/(^|\.)mp\.weixin\.qq\.com$/.test(url.hostname)) return undefined
  if (!/^\/mp\/appmsgalbum/.test(url.pathname)) return undefined
  const biz = url.searchParams.get('__biz') || ''
  const album = url.searchParams.get('album_id') || ''
  return biz && album ? { biz, album } : undefined
}

// A 公众号 home address. There is no list behind it on the open web, which is the whole point of
// claiming it: the user gets a sentence instead of a parse failure.
export function isHomepage(url: URL): boolean {
  return /(^|\.)mp\.weixin\.qq\.com$/.test(url.hostname) && /^\/mp\/(homepage|profile_ext)/.test(url.pathname)
}

export function entryOf(article: Article): ListingEntry | undefined {
  const address = article.url?.trim()
  if (!address) return undefined
  const posted = Number(article.create_time)
  return {
    // The article's own message id, so the same article keeps its id across pages.
    id: `${article.msgid || address}-${article.itemidx || '1'}`,
    url: address.replace(/&amp;/g, '&'),
    title: article.title?.trim() || '公众号文章',
    thumbnail: (article.cover_img_1_1 || article.cover_img || '').replace(/^http:\/\//, 'https://') || undefined,
    // An article is 图文: whatever media is inside it is found when that article is parsed.
    kind: 'image',
    author: article.nickname?.trim() || undefined,
    publishedAt: Number.isFinite(posted) && posted > 0 ? posted : undefined,
  }
}

// Where each page ended, as in the 抖音 adapter: without it, turning to page 5 walks pages 1-4 again.
// One album on screen at a time, so a second one replaces the first.
type Cursor = { msgid: string; itemidx: string }
let walked: { key: string; cursors: Map<number, Cursor> } | undefined

function resume(key: string, page: number): { from?: Cursor; at: number } {
  if (walked?.key !== key) { walked = { key, cursors: new Map() }; return { at: 1 } }
  let at = 1
  for (const reached of walked.cursors.keys()) if (reached < page && reached >= at) at = reached + 1
  return { from: at > 1 ? walked.cursors.get(at - 1) : undefined, at }
}

export const weixin: ProfileAdapter = {
  id: 'weixin',
  matches(url) { return Boolean(albumOf(url)) || isHomepage(url) },
  entryUrl(url) { return url.href },
  async fetchPage({ url, page, fetch, signal }: PageRequest): Promise<ListingPage | undefined> {
    if (isHomepage(url)) {
      throw new Error('微信公众号的历史消息列表只存在于微信客户端内，网页上没有这个入口，客户端拿不到。可以改用公众号的「合集」链接（地址里带 album_id），或者逐篇粘贴文章链接。')
    }
    const source = albumOf(url)
    if (!source) throw new Error('链接中没有合集编号')
    // The album pages by cursor: the next page starts after the msgid and itemidx of the last article
    // shown, which is what the album page itself sends (measured 2026-09-23). An offset is not a cursor
    // - 'begin_msgid=10' answers with no article_list at all.
    const { from, at } = resume(`${source.biz}|${source.album}`, page)
    let cursor = from
    let body: Album = {}
    let list: Article[] = []
    for (let reached = at; reached <= page; reached += 1) {
      signal.throwIfAborted()
      const query = new URLSearchParams({ action: 'getalbum', __biz: source.biz, album_id: source.album, count: String(COUNT), f: 'json', ...(cursor ? { begin_msgid: cursor.msgid, begin_itemidx: cursor.itemidx } : {}) })
      const response = await fetch(`${HOST}/mp/appmsgalbum?${query}`, { referrer: url.href, signal })
      const reply = await response.json().catch(() => undefined) as Album | undefined
      // Not the shape this expects: the endpoint moved, or 微信 answered with its verification page.
      // That is this adapter being wrong rather than a refusal, so it hands the address back.
      if (response.status >= 400 || !isRecord(reply) || !isRecord(reply.getalbum_resp)) return undefined
      body = reply
      const ret = body.base_resp?.ret
      if (ret) throw new Error(`微信接口返回 ${ret}${body.base_resp?.errmsg ? `：${body.base_resp.errmsg}` : ''}`)
      const found = body.getalbum_resp?.article_list
      if (!Array.isArray(found)) return undefined
      if (!found.length && reached === 1) throw new LoginRequired('没有读到这个合集里的文章。请打开登录窗口完成验证后重试。')
      list = found
      const last = found.at(-1)
      if (!last?.msgid) break
      cursor = { msgid: last.msgid, itemidx: last.itemidx || '1' }
      walked?.cursors.set(reached, cursor)
      if (body.getalbum_resp?.continue_flag !== '1') break
    }
    const entries = list.map(entryOf).filter((entry): entry is ListingEntry => Boolean(entry))
    const title = body.getalbum_resp?.album_info?.title?.trim() || body.getalbum_resp?.base_info?.title?.trim()
    return onePage('articles', title || '公众号合集', entries, {
      index: page, size: COUNT, hasMore: body.getalbum_resp?.continue_flag === '1',
    })
  },
}
