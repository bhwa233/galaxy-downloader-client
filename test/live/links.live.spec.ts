import path from 'node:path'
import { expect, test, _electron as electron } from '@playwright/test'
import type { MediaResult } from '../../shared/contracts'

// Drives the real client over every link in docs/test-links.md. Run with `pnpm test:live:links`.
//
// Like the profile probe beside it, this uses the real user data directory so it sees whatever the
// user signed into through 设置 → 浏览器 → 打开登录窗口, and it only ever parses - nothing is queued
// and nothing is downloaded.
//
// Two kinds of case. 'must' is something that has to hold on this machine no matter who is signed in:
// the 哔哩哔哩 endpoints answer anonymously, and address rewriting happens before any network call.
// 'report' is everything whose answer depends on a login or on a platform this client has never been
// probed against - those are printed with whatever they said, because "抖音 refused a stranger" is a
// result, not a failure of the code.
const root = path.resolve(import.meta.dirname, '../..')

type Outcome = { ok: true; result: MediaResult } | { ok: false; message: string }
type Case = {
  name: string
  url: string
  must?: (outcome: Outcome) => void
  report?: true
}

const groupIds = (result: MediaResult) => (result.groups || []).map(group => group.id)
const entriesOf = (result: MediaResult, id: string) => result.groups?.find(group => group.id === id)?.itemIds.length ?? 0

const CASES: Case[] = [
  // 哔哩哔哩. Every one of these is reachable anonymously, so they are the ones that must hold.
  {
    name: '哔哩哔哩 分P 主样本 BV1bK411W797（23 个分P）',
    url: 'https://www.bilibili.com/video/BV1bK411W797',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(groupIds(outcome.result)).toContain('parts')
      expect(entriesOf(outcome.result, 'parts')).toBe(23)
    },
  },
  {
    name: '哔哩哔哩 分P 小样本 BV1uT4y1P7CX（2 个分P）',
    url: 'https://www.bilibili.com/video/BV1uT4y1P7CX',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(entriesOf(outcome.result, 'parts')).toBe(2)
    },
  },
  {
    name: '哔哩哔哩 单P 反例 BV1xx411c7mD（适配器应当放弃并回落引擎）',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      // Standing down means this never became a listing at all.
      expect(outcome.result.listing).toBeUndefined()
      expect(outcome.result.groups).toBeUndefined()
      expect(outcome.result.items.length).toBe(1)
    },
  },
  {
    name: '哔哩哔哩 合集链接 lists/8566628（18 集，不应列出全部投稿）',
    url: 'https://space.bilibili.com/3494376638516086/lists/8566628?type=season',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.listing).toBe('collection')
      expect(entriesOf(outcome.result, 'collection')).toBe(18)
      // The collection's own name is what its downloads get filed under.
      expect(outcome.result.groups?.[0].directory).toBeTruthy()
    },
  },
  {
    name: '哔哩哔哩 合集链接 lists/4940048（3 集）',
    url: 'https://space.bilibili.com/339087866/lists/4940048?type=season',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(entriesOf(outcome.result, 'collection')).toBe(3)
    },
  },
  {
    name: '哔哩哔哩 视频页展开 ugc_season BV1Ps421u7ju',
    url: 'https://www.bilibili.com/video/BV1Ps421u7ju',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(groupIds(outcome.result)).toContain('collection')
    },
  },
  {
    name: '哔哩哔哩 视频页展开 ugc_season BV11dbH6LEm2',
    url: 'https://www.bilibili.com/video/BV11dbH6LEm2',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (outcome.ok) expect(entriesOf(outcome.result, 'collection')).toBe(18)
    },
  },
  {
    name: '哔哩哔哩 投稿主页 space/242020511',
    url: 'https://space.bilibili.com/242020511',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      // A 投稿 grid, not a collection: the one the 合集 links used to be answered with.
      expect(outcome.result.listing).toBe('profile')
      expect(groupIds(outcome.result)).toEqual(['uploads'])
      expect(outcome.result.groups?.[0].pagination?.total).toBeGreaterThan(100)
    },
  },
  {
    name: '哔哩哔哩 追番 ss113506（番剧走引擎，客户端不另写解析）',
    url: 'https://www.bilibili.com/bangumi/play/ss113506',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.method).toBe('direct')
      expect(outcome.result.items.length).toBeGreaterThan(1)
    },
  },

  // 抖音. The rewriting happens before any request, so it holds whoever is signed in; the listings
  // themselves are 抖音's to refuse.
  {
    name: '抖音 短剧 modal_id 改写成 /video/<id>，并展开所属合集',
    url: 'https://www.douyin.com/series?modal_id=7676329918745054500',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      // The address the client worked on has to be the episode's, not the 短剧 index page's.
      expect(outcome.result.url).toBe('https://www.douyin.com/video/7676329918745054500')
      // And the episode turns out to belong to a 合集, which is the 剧集 list this platform has.
      expect(groupIds(outcome.result)).toEqual(['collection'])
      expect(entriesOf(outcome.result, 'collection')).toBeGreaterThan(1)
    },
  },
  {
    name: '抖音 短剧列表页 /series（应当如实说明列不出，而不是含糊失败）',
    url: 'https://www.douyin.com/series',
    must: outcome => {
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.message).toContain('分享')
    },
  },
  {
    name: '抖音 分享短链被跟随到落地地址',
    // A share short link resolves with the sharer's own u_code, device and install ids, so none is
    // kept in the repository: paste one you copied yourself into LIVE_DOUYIN_SHARE_LINK. Left unset,
    // this case is skipped.
    url: process.env.LIVE_DOUYIN_SHARE_LINK || '',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      // A shortener says nothing about what is behind it, and everything downstream routes on the
      // address, so it has to have been followed before any of this ran.
      if (outcome.ok) expect(outcome.result.platform).toBe('抖音')
    },
  },
  {
    name: '抖音 作品页读出所属合集 7331258875343113512',
    url: 'https://www.douyin.com/video/7331258875343113512',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(groupIds(outcome.result)).toEqual(['collection'])
      expect(entriesOf(outcome.result, 'collection')).toBeGreaterThan(1)
    },
  },
  {
    name: '抖音 用户主页（作品）',
    url: 'https://www.douyin.com/user/MS4wLjABAAAAiDM_L0EfQosQEKfhAPkrFau6cBPMtNu1d3E2em0hzUZ6I1VGFH5oS6NuV4cfsd2o',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (outcome.ok) expect(outcome.result.title).toContain('的作品')
    },
  },
  {
    name: '抖音 用户主页（喜欢）列出的必须是喜欢，不是这个人的投稿',
    url: 'https://www.douyin.com/user/MS4wLjABAAAAiDM_L0EfQosQEKfhAPkrFau6cBPMtNu1d3E2em0hzUZ6I1VGFH5oS6NuV4cfsd2o?showTab=like',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      // The old behaviour rewrote every tab to 'post' and answered with the user's own uploads. The
      // liked posts belong to whoever made them, so the title naming a different author is the proof
      // that a different listing was read.
      expect(outcome.result.title).toContain('的喜欢')
    },
  },

  // YouTube
  {
    name: 'YouTube 频道 @MrBeast',
    url: 'https://www.youtube.com/@MrBeast',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.listing).toBe('profile')
      expect(outcome.result.items.length).toBeGreaterThan(10)
    },
  },
  { name: 'YouTube Shorts 单条', url: 'https://www.youtube.com/shorts/T_SMf9j50uc', report: true },  {
    name: 'YouTube 播放列表（5 条）',
    url: 'https://www.youtube.com/watch?v=oBeBVjOBZPs&list=PLZOc7e59B5BY',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.items.length).toBe(5)
      // Short of the limit, so nothing was cut and nothing is claimed to have been.
      expect(outcome.result.truncated).toBeUndefined()
    },
  },
  {
    name: 'YouTube Mix（100 条上限必须被说出来，而不是静默截断）',
    url: 'https://www.youtube.com/watch?v=l54zu9rjpYc&list=RDl54zu9rjpYc&start_radio=1',
    must: outcome => {
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
      if (!outcome.ok) return
      expect(outcome.result.items.length).toBe(100)
      expect(outcome.result.truncated?.shown).toBe(100)
    },
  },

  // 微信公众号
  { name: '微信公众号 图片+音乐卡片', url: 'https://mp.weixin.qq.com/s/kgrMPE4Sl6oXVTYGKCnzdQ', report: true },
  { name: '微信公众号 视频', url: 'https://mp.weixin.qq.com/s/OHPkIAjecIO-AH8jicfXKQ', report: true },
  // X / Instagram / 微博: single posts go to the engine, the profiles go to the new adapters.
  { name: 'X 单条（图片帖）', url: 'https://x.com/Russell3402/status/2101991269291741588', report: true },
  { name: 'X 单条（视频帖）', url: 'https://x.com/FinanceYF5/status/2101585391140905034', report: true },
  { name: 'X 用户时间线（新适配器）', url: 'https://x.com/FinanceYF5', report: true },
  { name: 'Instagram Reels 单条', url: 'https://www.instagram.com/reel/DdcI4o0Prsz/', report: true },
  { name: 'Instagram 帖子单条', url: 'https://www.instagram.com/p/DdUG_iuEf3E/', report: true },
  { name: 'Instagram 用户主页（新适配器）', url: 'https://www.instagram.com/instagram/', report: true },
  { name: '微博 单条 RixTsFiDJ', url: 'https://weibo.com/7285442599/RixTsFiDJ', report: true },
  { name: '微博 用户主页（新适配器）', url: 'https://weibo.com/u/7285442599', report: true },
]

test('every link in docs/test-links.md is parsed by the real client', async () => {
  test.setTimeout(CASES.length * 120_000)
  const env = { ...process.env }
  // Windows treats an empty value as set, which would start Electron as plain Node and never open a window.
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: root, env })
  const page = await app.firstWindow()
  const failures: string[] = []
  try {
    // The engine is checked once so a missing yt-dlp is reported as itself rather than as every link
    // on the list failing for reasons of its own.
    const tools = await page.evaluate(() => window.desktopApi.command('tools:check', null))
    const engine = tools.ok ? tools.state.tools.engine : undefined
    console.log(`engine: ${engine?.available ? engine.version : `不可用 ${engine?.error || ''}`}`)
    expect(engine?.available, '本地引擎不可用，下面的结果说明不了任何事').toBe(true)

    for (const item of CASES.filter(entry => entry.url)) {
      const reply = await page.evaluate(url => window.desktopApi.command('media:parse', { url }), item.url)
      const state = reply.ok ? reply.state.parse : undefined
      const outcome: Outcome = state?.result
        ? { ok: true, result: state.result }
        : { ok: false, message: state?.message || (reply.ok ? '没有解析结果' : reply.message) }
      if (outcome.ok) {
        const result = outcome.result
        const shape = result.groups?.length
          ? result.groups.map(group => `${group.id}:${group.itemIds.length}${group.pagination?.total ? `/${group.pagination.total}` : ''}`).join(' ')
          : `${result.items.length} 项`
        console.log(`✅ ${item.name}\n     ${result.platform} · ${result.method} · listing=${result.listing || '—'} · ${shape}${result.truncated ? ` · 截断于 ${result.truncated.shown}` : ''} · 标题「${result.title.slice(0, 30)}」`)
        console.log(`     ${result.items.slice(0, 2).map(entry => `${entry.kind} ${entry.title.slice(0, 34)}`).join(' | ') || '(无条目)'}`)
      } else {
        console.log(`❌ ${item.name}\n     ${state?.wall ? `[${state.wall}] ` : ''}${outcome.message}`)
      }
      if (!item.must) continue
      try { item.must(outcome) } catch (error) { failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  } finally { await app.close() }
  expect(failures, `\n${failures.join('\n')}`).toEqual([])
})
