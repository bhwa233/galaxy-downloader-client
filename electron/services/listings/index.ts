import { bilibili } from './bilibili'
import { bilibiliCollection, bilibiliVideo } from './bilibili-collection'
import { douyin, douyinCollection, douyinSeries, douyinVideo } from './douyin'
import { instagram, instagramPost } from './instagram'
import { weibo } from './weibo'
import { weixin } from './weixin'
import { x, xPost } from './x'
import { youtube } from './youtube'
import type { ProfileAdapter } from './types'

// A platform reaches the listing route by being here and nothing else: there is no generic crawl left
// behind these, so an address no adapter claims is served by yt-dlp instead.
// './xiaohongshu' is written but deliberately left out: see the note at the top of that file, and the
// refusal in parser.ts that keeps its profiles from falling through to a route that cannot serve them.
// 'bilibili-video' claims every 哔哩哔哩 video page, which is far more than it ends up listing: only the
// video itself can say whether it has parts or a collection behind it, so it reads one and stands down
// where there is nothing to list. See ProfileAdapter.fetchPage.
export const adapters: ProfileAdapter[] = [
  bilibili, bilibiliCollection, bilibiliVideo,
  douyin, douyinCollection, douyinVideo, douyinSeries,
  instagram, instagramPost, weibo, weixin, x, xPost, youtube,
]

export function findAdapter(url: string | URL): ProfileAdapter | undefined {
  let target: URL
  try { target = typeof url === 'string' ? new URL(url) : url } catch { return undefined }
  return adapters.find(adapter => adapter.matches(target))
}

export type { ListingEntry, ListingGroup, ListingPage, Pagination, ProfileAdapter } from './types'
