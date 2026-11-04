import type { EmbeddedBrowser } from '../browser'
import type { Cookie } from '../engine'
import type { RawInfo } from '../media'
import { bilibiliCollection, bilibiliVideo, read, sourceOf, type ViewResponse } from './bilibili-collection'
import { device, mixin } from './bilibili'
import { signQuery } from './wbi'
import type { Fetcher, ListingPage } from './types'

type View = NonNullable<ViewResponse['data']>
type Track = { id?: number; baseUrl?: string; base_url?: string; url?: string; mimeType?: string; mime_type?: string; codecs?: string; bandwidth?: number; size?: number; height?: number; frameRate?: string; frame_rate?: string }
type PlayResponse = { code?: number; message?: string; data?: {
  quality?: number; format?: string; timelength?: number; video_codecid?: number; v_voucher?: string
  dash?: { video?: Track[]; audio?: Track[]; dolby?: { audio?: Track[] }; flac?: { audio?: Track } }
  durl?: { url?: string; size?: number; length?: number }[]
} }
type Stream = NonNullable<RawInfo['formats']>[number]
export type BilibiliPage = {
  listing?: ListingPage; metadata?: RawInfo; sampleId?: string; url: string
  cookies: Cookie[]; userAgent: string; loadFormats: (signal: AbortSignal) => Promise<RawInfo>
}

const API = 'https://api.bilibili.com'

// Reuse the collection adapters, session transport, WBI signer and media normalizer. Only Bilibili's
// playback-response conversion is new; signed stream URLs stay in main and never become UI fields.
export class BilibiliApi {
  private views = new Map<string, { data: View; at: number }>()
  constructor(private browser: EmbeddedBrowser) {}
  private fetch: Fetcher = (address, init) => this.browser.fetch(address, { ...init, credentials: 'include' })

  private async view(bvid: string, referrer: string, signal: AbortSignal): Promise<View> {
    const held = this.views.get(bvid)
    if (held && Date.now() - held.at < 60_000) return held.data
    const body = await read<ViewResponse>(this.fetch, `${API}/x/web-interface/wbi/view?bvid=${bvid}`, referrer, signal)
    if (!body.data?.pages?.length) throw new Error('Bilibili video metadata is unavailable')
    if (this.views.size >= 8) this.views.clear()
    this.views.set(bvid, { data: body.data, at: Date.now() })
    return body.data
  }

  async page(address: string, page: number, group: string | undefined, order: 'reverse' | undefined, single: boolean, signal: AbortSignal): Promise<BilibiliPage | undefined> {
    const url = new URL(address)
    if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return undefined
    const bvid = /^\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname)?.[1]
    let listing: ListingPage | undefined; let metadata: RawInfo | undefined; let sampleId: string | undefined
    let sampleUrl: string; let sampleView: View | undefined
    const request = { url, page, group, order, userAgent: this.browser.userAgent, locale: this.browser.language, signal, fetch: this.browser.listingFetch }
    if (bvid) {
      const part = url.searchParams.get('p')
      if (part && (!/^\d+$/.test(part) || Number(part) < 1)) return undefined
      sampleUrl = `https://www.bilibili.com/video/${bvid}${part ? `?p=${Number(part)}` : ''}`
      sampleView = await this.view(bvid, sampleUrl, signal)
      // Interactive branches, redirects and supporter-only previews retain the established parser.
      if (sampleView.rights?.is_stein_gate || sampleView.is_upower_exclusive || sampleView.redirect_url) return undefined
      metadata = this.metadata(sampleView, sampleUrl)
      if (!single && !(part && sampleView.pages!.length > 1)) {
        listing = await bilibiliVideo.fetchPage!({ ...request, url: new URL(sampleUrl), fetch: (target, init) => {
          // The adapter consumes the metadata already read above; it makes no second view request.
          if (target === `${API}/x/web-interface/wbi/view?bvid=${bvid}`) return Promise.resolve(Response.json({ code: 0, data: sampleView }))
          return this.browser.listingFetch(target, init)
        } })
        sampleId = listing?.groups[0]?.entries[0]?.id
      }
    } else if (!single && sourceOf(url)) {
      listing = await bilibiliCollection.fetchPage!(request)
      const first = listing?.groups[0]?.entries[0]
      if (!first) return undefined
      sampleId = first.id; sampleUrl = first.url
    } else return undefined
    const identity = await this.browser.identity(sampleUrl)
    let pending: Promise<RawInfo> | undefined
    return { listing, metadata, sampleId, url: sampleUrl, ...identity,
      loadFormats: formatSignal => pending ||= this.playback(sampleUrl, sampleView, formatSignal) }
  }

  private metadata(data: View, address: string): RawInfo {
    const bvid = data.bvid || /^\/video\/(BV[0-9A-Za-z]+)/.exec(new URL(address).pathname)?.[1]
    const part = Number(new URL(address).searchParams.get('p') || 1)
    const selected = data.pages?.[part - 1]
    if (!selected?.cid) throw new Error('Bilibili video part is unavailable')
    const title = (data.pages?.length || 0) > 1 ? `${data.title} p${String(part).padStart(2, '0')} ${selected.part || ''}` : data.title
    return { id: bvid, webpage_url: address, title, duration: selected.duration ?? data.duration,
      thumbnail: data.pic, uploader: data.owner?.name, uploader_id: data.owner?.mid ? String(data.owner.mid) : undefined,
      timestamp: data.pubdate, view_count: data.stat?.view, formats: [] }
  }

  private async playback(address: string, known: View | undefined, signal: AbortSignal): Promise<RawInfo> {
    const url = new URL(address); const bvid = /^\/video\/(BV[0-9A-Za-z]+)/.exec(url.pathname)?.[1]
    if (!bvid) throw new Error('Bilibili video identifier is unavailable')
    const data = known || await this.view(bvid, address, signal)
    const metadata = this.metadata(data, address)
    const cid = data.pages![Number(url.searchParams.get('p') || 1) - 1].cid!
    const [fingerprint, key, identity] = await Promise.all([
      this.browser.fingerprint(signal), mixin(this.fetch, undefined, signal), this.browser.identity(address),
    ])
    if (!fingerprint) throw new Error('Bilibili playback fingerprint is unavailable')
    const query = signQuery({ bvid, cid, fnval: 4048, ...device(fingerprint),
      ...(identity.cookies.some(cookie => cookie.name === 'SESSDATA') ? {} : { try_look: 1 }),
    }, key)
    const body = await read<PlayResponse>(this.fetch, `${API}/x/player/wbi/playurl?${query}`, address, signal)
    const play = body.data
    if (!play || play.v_voucher) throw new Error('Bilibili playback requires page verification')
    const formats: Stream[] = []
    const audios = [...(play.dash?.audio || []), ...(play.dash?.dolby?.audio || []), ...(play.dash?.flac?.audio ? [play.dash.flac.audio] : [])]
    for (const track of [...audios, ...(play.dash?.video || [])]) {
      const address = track.baseUrl || track.base_url || track.url
      if (!address || !/^https?:\/\//i.test(address)) continue
      const audio = audios.includes(track)
      const rate = (track.frameRate || track.frame_rate || '').split('/').map(Number)
      formats.push({ url: address, format_id: audio ? String(track.id) : /-(\d+)\.m4s(?:\?|$)/.exec(address)?.[1] || String(track.id),
        ext: audio ? 'm4a' : 'mp4', vcodec: audio ? 'none' : track.codecs, acodec: audio ? track.codecs : audios.length ? 'none' : undefined,
        height: track.height, fps: rate[0] > 0 ? rate[0] / (rate[1] || 1) : undefined,
        filesize: track.size, tbr: track.bandwidth ? track.bandwidth / 1000 : undefined,
      })
    }
    const fragments = play.durl?.filter(item => item.url && /^https?:\/\//i.test(item.url))
    if (fragments?.length) {
      const heights: Record<number, number> = { 6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080, 116: 1080, 120: 2160, 125: 2160, 126: 2160, 127: 4320 }
      formats.push({ format_id: String(play.quality), url: fragments[0].url, ext: play.format?.startsWith('flv') ? 'flv' : 'mp4',
        height: heights[play.quality || 0], filesize: fragments.every(item => item.size !== undefined) ? fragments.reduce((sum, item) => sum + item.size!, 0) : undefined,
      })
    }
    if (!formats.length) throw new Error('Bilibili playback formats are unavailable')
    // Match the engine's ascending quality/codec order before using the shared tier normalizer.
    const codec = (stream: Stream) => /^av01/.test(stream.vcodec || '') ? 3 : /^(hev|hvc)/.test(stream.vcodec || '') ? 2 : 1
    formats.sort((a, b) => (a.height || 0) - (b.height || 0) || (a.fps || 0) - (b.fps || 0) || codec(a) - codec(b) || (a.tbr || 0) - (b.tbr || 0))
    return { ...metadata, duration: metadata.duration ?? (play.timelength ? play.timelength / 1000 : undefined), formats }
  }
}
