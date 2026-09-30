import { setTimeout as delay } from 'node:timers/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Cookie } from './engine'
import { logger } from './log'

const log = logger('http')

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
export function cookieHeader(cookies: Cookie[], target: string, now = Date.now() / 1000): string {
  const url = new URL(target)
  return cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '')
    const matches = url.hostname === domain || (cookie.domain.startsWith('.') && url.hostname.endsWith(`.${domain}`))
    const cookiePath = cookie.path || '/'
    const matchesPath = url.pathname === cookiePath || url.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)
    return matches && matchesPath && (!cookie.secure || url.protocol === 'https:') && (cookie.expires <= 0 || cookie.expires > now)
  }).sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

export async function fetchWithCookies(fetcher: Fetcher, address: string, cookies: Cookie[], init: RequestInit = {}): Promise<Response> {
  let target = address
  for (let redirect = 0; redirect < 10; redirect++) {
    const url = new URL(target)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的媒体地址')
    const headers = new Headers(init.headers)
    headers.delete('cookie')
    const value = cookieHeader(cookies, target)
    if (value) headers.set('cookie', value)
    // The session's fetch refuses a request that sets Referer as a header - it fails with
    // net::ERR_BLOCKED_BY_CLIENT before anything is sent (measured 2026-09-23; every http download
    // carrying a Referer failed this way). The same value goes as the request's referrer instead.
    const referrer = headers.get('referer') || undefined
    headers.delete('referer')
    const response = await fetcher(target, { ...init, headers, redirect: 'manual', ...(referrer ? { referrer } : {}) })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('媒体重定向缺少地址')
    target = new URL(location, target).href
  }
  throw new Error('媒体重定向次数过多')
}

type Checkpoint = { source: string; etag?: string; modified?: string }
export async function downloadHttp(fetcher: Fetcher, url: string, destination: string, cookies: Cookie[], headers: Record<string, string>, signal: AbortSignal, progress: (fraction: number, stats?: { downloaded: number; total: number; speed: number; eta?: number }) => void, options: { speedLimit?: number; retries?: number; timeout?: number } = {}): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.part`
  const checkpointFile = `${temporary}.json`
  const source = createHash('sha256').update(url).digest('hex')
  const began = Date.now()
  let failure: unknown
  for (let attempt = 0; attempt <= (options.retries ?? 2); attempt++) {
    signal.throwIfAborted()
    const timeout = new AbortController()
    const requestSignal = AbortSignal.any([signal, timeout.signal])
    let timer: ReturnType<typeof setTimeout>
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(new Error('下载连接超时')), (options.timeout ?? 30) * 1000) }
    touch()
    try {
      let offset = 0
      let checkpoint: Checkpoint | undefined
      try {
        checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as Checkpoint
        if (checkpoint.source === source && (checkpoint.etag || checkpoint.modified)) offset = (await stat(temporary)).size
      } catch { /* A fresh download has no checkpoint. */ }
      const requestHeaders = new Headers(headers)
      if (offset && checkpoint) {
        requestHeaders.set('Range', `bytes=${offset}-`)
        requestHeaders.set('If-Range', checkpoint.etag || checkpoint.modified!)
      }
      const response = await fetchWithCookies(fetcher, url, cookies, { headers: requestHeaders, signal: requestSignal })
      log.debug(`${url} → ${response.status} · ${response.headers.get('content-type') || '无类型'} · 长度 ${response.headers.get('content-length') || '未知'}${offset ? ` · 从 ${offset} 续传` : ''}`)
      if (!response.ok || !response.body) throw new Error(`下载请求失败 (${response.status})`)
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
        if (!range || Number(range[1]) !== offset) { await response.body.cancel(); throw new Error('服务器返回了不匹配的续传范围') }
      } else offset = 0
      const etag = response.headers.get('etag') || undefined
      await writeFile(checkpointFile, JSON.stringify({ source, etag: etag?.startsWith('W/') ? undefined : etag, modified: response.headers.get('last-modified') || undefined }), { mode: 0o600 })
      const rangeTotal = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
      const length = response.headers.get('content-length')
      const total = rangeTotal ? Number(rangeTotal) : length ? Number(length) + offset : 0
      let received = offset
      const started = Date.now()
      const report = () => {
        const speed = (received - offset) / Math.max(0.001, (Date.now() - started) / 1000)
        progress(total > 0 ? Math.min(0.99, received / total) : 0, { downloaded: received, total, speed, eta: total && speed ? (total - received) / speed : undefined })
      }
      // Reuse Node stream backpressure and abortable timers; throttle only this HTTP transfer.
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        received += chunk.length
        const wait = options.speedLimit ? Math.max(0, (received - offset) / options.speedLimit * 1000 - (Date.now() - started)) : 0
        clearTimeout(timer)
        void delay(wait, undefined, { signal: requestSignal }).then(() => { touch(); report(); done(null, chunk) }, error => done(error))
      } })
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(temporary, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal: requestSignal })
      if (total > 0 && received !== total) throw new Error('媒体下载未完成，请重试')
      await rename(temporary, destination)
      await rm(checkpointFile, { force: true })
      progress(1)
      log.info(`完成 ${path.basename(destination)} · ${received} 字节 · ${Date.now() - began}ms`)
      return destination
    } catch (error) {
      signal.throwIfAborted(); failure = timeout.signal.aborted ? new Error('下载连接超时') : error
      log.warn(`第 ${attempt + 1} 次失败 ${url}`, failure)
    }
    finally { clearTimeout(timer!) }
  }
  throw failure
}
