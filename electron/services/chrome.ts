import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Browser, type Response } from 'playwright-core'
import { browserRoots } from './profiles'
import type { Cookie } from './engine'

export type BrowserMedia = { title: string; url: string; videos: string[]; images: string[]; thumbnail?: string; cookies: Cookie[]; userAgent: string }

export class ChromeConnection {
  private browser?: Browser
  get connected(): boolean { return Boolean(this.browser?.isConnected()) }

  async connect(): Promise<void> {
    if (this.connected) return
    const endpoints: string[] = []
    for (const root of browserRoots().chrome) {
      try {
        const [port, endpoint] = (await readFile(path.join(root, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
        if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint)) endpoints.push(`ws://127.0.0.1:${port}${endpoint}`)
      } catch { /* Try the next known Chrome directory. */ }
    }
    endpoints.push('http://127.0.0.1:9222')
    for (const endpoint of [...new Set(endpoints)]) {
      try {
        this.browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000, noDefaults: true })
        return
      } catch { /* No endpoint or the user has not accepted the browser dialog. */ }
    }
    throw new Error('请在 Chrome 的 chrome://inspect/#remote-debugging 开启浏览器连接，再点击连接并接受 Chrome 的授权提示。')
  }

  async disconnect(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    // For a connected Playwright browser, close disconnects the client; it does not close the user's Chrome.
    await browser?.close()
  }

  async inspectProfile(url: string, signal: AbortSignal): Promise<{ title: string; entries: { url: string; title: string; thumbnail?: string; kind: 'video' | 'audio' | 'image' }[]; cookies: Cookie[]; userAgent: string }> {
    await this.connect(); signal.throwIfAborted()
    const context = this.browser!.contexts()[0]; if (!context) throw new Error('Chrome 没有可用的浏览器会话')
    const page = await context.newPage(); const cancel = () => { void page.close().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
    const apiEntries = new Map<string, { url: string; title: string; thumbnail?: string; kind: 'video' | 'audio' | 'image' }>()
    const apiResponses = new Set<Promise<void>>()
    const responseHandler = (response: Response) => {
      const address = response.url()
      // Both listings render their grid from JavaScript, so the API response carries metadata the DOM never shows.
      const douyin = address.includes('/aweme/v1/web/aweme/post/')
      const xiaohongshu = address.includes('/api/sns/web/v1/user_posted')
      if (!douyin && !xiaohongshu) return
      const pending = (async () => {
        try {
          if (douyin) {
            const payload = await response.json() as { aweme_list?: Record<string, unknown>[]; data?: { aweme_list?: Record<string, unknown>[] } }
            const list = payload.aweme_list || payload.data?.aweme_list || []
            for (const item of list) {
              const id = typeof item.aweme_id === 'string' ? item.aweme_id : ''
              if (!id) continue
              const video = item.video as { cover?: { url_list?: string[] }; play_addr?: { url_list?: string[] } } | undefined
              const images = Array.isArray(item.images) ? item.images as { url_list?: string[] }[] : []
              const title = typeof item.desc === 'string' && item.desc.trim() ? item.desc.trim() : `抖音作品 ${id}`
              const thumbnail = video?.cover?.url_list?.[0] || images[0]?.url_list?.[0]
              apiEntries.set(id, { url: `https://www.douyin.com/video/${id}`, title, thumbnail, kind: images.length && !video?.play_addr ? 'image' : 'video' })
            }
            return
          }
          const payload = await response.json() as { data?: { notes?: Record<string, unknown>[] } }
          for (const note of payload.data?.notes || []) {
            const id = typeof note.note_id === 'string' ? note.note_id : ''
            if (!id) continue
            const token = typeof note.xsec_token === 'string' ? note.xsec_token : ''
            const cover = note.cover as { url_default?: string; url_pre?: string; info_list?: { url?: string }[] } | undefined
            const thumbnail = cover?.url_default || cover?.url_pre || cover?.info_list?.find(entry => entry.url)?.url
            const title = typeof note.display_title === 'string' && note.display_title.trim() ? note.display_title.trim() : `小红书笔记 ${id}`
            apiEntries.set(id, {
              // The note page returns an error without the access token the listing issued alongside the id.
              url: `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user` : ''}`,
              // Covers are served over plain HTTP; the renderer and the file loader both prefer TLS.
              title, thumbnail: thumbnail?.replace(/^http:\/\//, 'https://'), kind: note.type === 'video' ? 'video' : 'image',
            })
          }
        } catch { /* Some responses are empty or protected; DOM remains a metadata fallback. */ }
      })().finally(() => apiResponses.delete(pending))
      apiResponses.add(pending)
    }
    page.on('response', responseHandler)
    try {
      const target = new URL(url)
      if (target.hostname.endsWith('douyin.com')) target.searchParams.set('showTab', 'post')
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      for (let index = 0; index < 12; index += 1) { signal.throwIfAborted(); await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(900) }
      await Promise.allSettled(apiResponses)
      const data = await page.evaluate(() => {
        const absolute = (value: string) => { try { return new URL(value, location.href).href } catch { return '' } }
        const entries = new Map<string, { url: string; title: string; thumbnail?: string; kind: 'video' | 'audio' | 'image' }>()
        for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
          const href = absolute(anchor.href); if (!href || href === location.href || !/^https?:/.test(href)) continue
          const host = location.hostname
          const valid = host.includes('xiaohongshu')
            ? /\/(explore|discovery\/item)\/[A-Za-z0-9]+/.test(href)
            : host.includes('bilibili')
              ? /\/video\/BV[0-9A-Za-z]+|\/opus\/[0-9]+|\/bangumi\/play\//.test(href)
              : /douyin\.com\/(video|note)\/[A-Za-z0-9]+/.test(href)
          if (!valid || href === location.href) continue
          const imageElement = anchor.querySelector<HTMLImageElement>('img')
          const image = imageElement?.src || imageElement?.dataset.src || imageElement?.dataset.original || imageElement?.getAttribute('data-lazy-src') || undefined
          // Bilibili splits a post across a cover anchor and a title anchor, so merge every anchor
          // that points at the same post and reject the play-count/duration overlay as a title.
          const meaningful = (value: string) => Boolean(value) && !/^[\d.,:\s万亿kmKM+]+$/.test(value)
          const candidate = (imageElement?.alt || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || anchor.textContent || '').replace(/\s+/g, ' ').trim()
          const previous = entries.get(href)
          const title = meaningful(candidate) ? candidate : previous?.title || candidate || '未命名内容'
          const kind = host.includes('bilibili')
            // A bilibili space mixes videos with /opus/ picture posts; the cover anchor holds an img either way.
            ? /\/opus\//.test(href) ? 'image' : 'video'
            : /音频|音乐|song|music/i.test(title) ? 'audio' : /图文|笔记|image/i.test(title) || Boolean(image && !anchor.querySelector('video')) ? 'image' : 'video'
          entries.set(href, { url: href, title, thumbnail: (image ? absolute(image) : undefined) || previous?.thumbnail, kind })
        }
        return { title: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title, entries: [...entries.values()], userAgent: navigator.userAgent }
      })
      const entries = apiEntries.size ? [...apiEntries.values()] : data.entries
      const addresses = [page.url(), ...entries.map(entry => entry.url)].filter(Boolean); const cookies = await context.cookies(addresses)
      return { ...data, entries, cookies }
    } finally { signal.removeEventListener('abort', cancel); page.off('response', responseHandler); await page.close().catch(() => {}) }
  }

  async inspect(url: string, signal: AbortSignal): Promise<BrowserMedia> {
    await this.connect(); signal.throwIfAborted()
    const context = this.browser!.contexts()[0]
    if (!context) throw new Error('Chrome 没有可用的浏览器会话')
    const page = await context.newPage()
    const videos = new Set<string>(); const requests = new Set<Promise<void>>()
    const capture = (response: Response) => {
      const pending = (async () => { const type = response.headers()['content-type'] || ''; const address = response.url(); if (response.ok() && /^https?:/.test(address) && !/\.(ts|m4s)(\?|$)/i.test(address) && (/mpegurl|dash\+xml|video\/mp4|audio\/mpeg/.test(type) || /\.(m3u8|mpd)(\?|$)/i.test(address))) videos.add(address) })().catch(() => {}).finally(() => requests.delete(pending)); requests.add(pending)
    }
    page.on('response', capture)
    const cancel = () => { void page.close().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(2500)
      const data = await page.evaluate(() => {
        const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[property="${name}"],meta[name="${name}"]`)?.content || ''
        const images = new Set<string>(); const media = new Set<string>(); const state = (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__; let title = meta('og:title') || document.title
        const visited = new WeakSet<object>()
        const findMap = (value: unknown): Record<string, { note?: Record<string, unknown> }> | undefined => {
          if (!value || typeof value !== 'object') return undefined; const object = value as object; if (visited.has(object)) return undefined; visited.add(object)
          try { const record = value as Record<string, unknown>; const map = record.noteDetailMap; if (map && typeof map === 'object') return map as Record<string, { note?: Record<string, unknown> }>; for (const key of Object.keys(record)) { let child: unknown; try { child = record[key] } catch { continue }; const found = findMap(child); if (found) return found } } catch { /* reactive proxy */ }; return undefined
        }
        const noteMap = findMap(state); const note = noteMap && Object.values(noteMap)[0]?.note
        if (note) { title = typeof note.title === 'string' ? note.title : title; const list = Array.isArray(note.imageList) ? note.imageList as { urlDefault?: string; url?: string }[] : []; for (const image of list) if (image.urlDefault || image.url) images.add(image.urlDefault || image.url!); const video = note.video as { media?: { stream?: Record<string, { masterUrl?: string }[]> } } | undefined; for (const variants of Object.values(video?.media?.stream || {})) for (const variant of variants) if (variant.masterUrl) media.add(variant.masterUrl) }
        for (const element of document.querySelectorAll<HTMLMediaElement>('video, audio')) if (element.currentSrc && !element.currentSrc.startsWith('blob:')) media.add(element.currentSrc)
        for (const element of document.querySelectorAll<HTMLSourceElement>('video source, audio source')) if (element.src) media.add(element.src)
        for (const key of ['og:video', 'og:video:url', 'og:video:secure_url']) if (meta(key)) media.add(meta(key))
        return { title, images: [...images], media: [...media], thumbnail: meta('og:image'), userAgent: navigator.userAgent }
      })
      await Promise.allSettled(requests); for (const address of data.media) videos.add(new URL(address, page.url()).href)
      const addresses = [page.url(), ...videos, ...data.images].filter(address => /^https?:/.test(address)); const cookies = await context.cookies(addresses)
      return { title: data.title, url: page.url(), videos: [...videos], images: data.images, thumbnail: data.thumbnail, userAgent: data.userAgent, cookies }
    } finally { signal.removeEventListener('abort', cancel); page.off('response', capture); await page.close().catch(() => {}) }
  }

}
