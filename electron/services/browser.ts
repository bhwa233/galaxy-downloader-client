import { BrowserWindow, WebContentsView, session, type Rectangle, type Session, type WebContents } from 'electron'
import type { ListingKind, Settings } from '../../shared/contracts'
import type { Cookie } from './engine'
import { acceptLanguageFor, chromeUserAgent, clientHints, fetchMetadata, relatedTo } from './identity'
import { findAdapter } from './listings'
import { PACE, Pace, pause } from './listings/pace'
import { LoginRequired } from './login'
import { head, logger } from './log'
import type { Fetcher, Fingerprint, ListingGroup, ProfileAdapter } from './listings/types'

// 'article' says the page is prose with media in it rather than a player page, which decides whether
// pictures and video are two kinds of the same result or two candidates for one.
// A player on the page as the page shows it: its poster, and - when it sits inside a card linking to a
// post - that post's address and text. What a stream caught off the network is matched against.
export type Poster = { poster: string; link?: string; text?: string }
export type BrowserMedia = { title: string; url: string; videos: string[]; images: string[]; posters: Poster[]; article: boolean; thumbnail?: string; cookies: Cookie[]; userAgent: string }
// 'area' is where the window's preview dialog wants the page; 'host' is the window it is shown in,
// left off while the preview is closed.
type PreviewView = { view: WebContentsView; host?: BrowserWindow; area: Rectangle; fullscreen: boolean; onClosed?: () => void }
export type Listing = { title: string; kind: ListingKind | 'post'; groups: ListingGroup[]; cookies: Cookie[]; userAgent: string }
export type { ListingEntry, ListingGroup, Pagination } from './listings/types'

const log = logger('browser')

// Login state lives in the client's own partition instead of another browser's cookie database:
// Chrome 127+ seals its cookies with App-Bound Encryption, and driving a running Chrome over CDP needs
// a --remote-debugging-port that cannot be set on a browser the client did not start.
const PARTITION = 'persist:media'
// How long a visit to a site's front page counts for before the next walk pays for another one.
const WARM_AFTER = 12 * 60 * 60 * 1_000
// The most loads a cold profile is given to finish minting its visitor credentials. Three is what an
// anonymous 哔哩哔哩 profile was measured needing; a site that mints nothing stops after two.
const VISITS = 3
// How long a listing's window is kept open for the next page of the same listing. A page turn measured
// a second of loading and a further two waiting for the page to settle, all of which is already paid
// for on a window that is still standing. Long enough to cover reading a page, short enough that a
// listing left behind does not keep a renderer and a live site page alive for the rest of the run.
const REUSE_FOR = 5 * 60 * 1_000

function toCookies(cookies: Electron.Cookie[]): Cookie[] {
  return cookies.map(cookie => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain || '', path: cookie.path || '/',
    secure: Boolean(cookie.secure), expires: cookie.expirationDate ? Math.floor(cookie.expirationDate) : -1,
  }))
}

type Watcher = { json?: { matches: (url: string) => boolean; consume: (payload: unknown) => void }; response?: (url: string, mimeType: string, status: number) => void }
type Attached = { evaluate: <T>(expression: string) => Promise<T>; settle: () => Promise<void> }

// Response bodies and player requests are only observable through the protocol, and a per-page
// debugger keeps concurrent parses independent - a session-wide webRequest listener would not.
// The protocol also evaluates scripts out of the page's own CSP, which webContents.executeJavaScript
// does not: a site that forbids 'unsafe-eval' - bilibili does - rejects every script sent that way.
function watch(contents: WebContents, watcher: Watcher): Attached {
  const pending = new Set<Promise<void>>()
  const viaPage = async <T>(expression: string) => await contents.executeJavaScript(expression, true) as T
  try { contents.debugger.attach('1.3') } catch { return { evaluate: viaPage, settle: async () => {} } }
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    if (method !== 'Network.responseReceived') return
    const response = params.response as { url?: string; mimeType?: string; status?: number } | undefined
    if (!response?.url) return
    watcher.response?.(response.url, response.mimeType || '', response.status ?? 0)
    if (!watcher.json?.matches(response.url)) return
    const task = (async () => {
      try {
        const { body, base64Encoded } = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }) as { body: string; base64Encoded: boolean }
        watcher.json!.consume(JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body))
      } catch { /* Some responses are empty or already evicted; the DOM remains a metadata fallback. */ }
    })().finally(() => pending.delete(task))
    pending.add(task)
  }
  contents.debugger.on('message', onMessage)
  void contents.debugger.sendCommand('Network.enable').catch(() => {})
  let settled = false
  return {
    evaluate: async <T>(expression: string) => {
      if (settled) return viaPage<T>(expression)
      const { result, exceptionDetails } = await contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }
      if (exceptionDetails) throw new Error(`${exceptionDetails.text} ${exceptionDetails.exception?.description || ''}`.trim())
      return result.value
    },
    settle: async () => {
      if (settled) return
      settled = true
      await Promise.allSettled([...pending])
      contents.debugger.off('message', onMessage)
      try { contents.debugger.detach() } catch { /* The page may already be gone. */ }
    },
  }
}

export class EmbeddedBrowser {
  private loginWindow: BrowserWindow | null = null
  private preview?: PreviewView
  private prepared = false
  // When each host was last visited for its own sake, so a walk that starts cold pays for one visit
  // rather than one per page. Kept in memory: a fresh run warms a host again the first time it is used.
  private warmed = new Map<string, number>()
  // The graphics strings this machine reports, read once. They do not change while the client runs,
  // and 'asked' records the attempt so a machine without WebGL is not sent to look for it every page.
  private print: Fingerprint | undefined
  private asked = false
  // What each origin's own pages keep in localStorage, taken during the warm-up visit. 哔哩哔哩 leaves
  // the day's signing keys there, and reading them back costs nothing where a page has already run.
  private stored = new Map<string, Record<string, string>>()
  // How often this client talks to each platform, held across every walk rather than per walk: see Pace.
  private pace = new Pace()
  // The window a listing was last read in, kept for the next page of the same listing.
  private open?: { address: string; window: BrowserWindow; page: Attached; timer: NodeJS.Timeout }

  constructor(private locale: () => Settings['locale'] = () => 'zh') {}

  private get session(): Session {
    const partition = session.fromPartition(PARTITION)
    if (!this.prepared) {
      this.prepared = true
      // A third-party page gets no capability beyond rendering itself - and filling the screen, which
      // is what a player's own fullscreen button asks for in the preview window.
      partition.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'))
      partition.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen')
      // The client saves files through its own engine; a page must never start a download of its own.
      partition.on('will-download', event => event.preventDefault())
      // Electron's default user agent announces both this application and Electron, which several
      // platforms reject outright and all of them can remember.
      partition.setUserAgent(chromeUserAgent(partition.getUserAgent()), acceptLanguageFor(this.locale()))
      // A page load carries Chrome's own client hints; a fetch issued by the main process carries none,
      // which contradicts the agent it sends. Anything the request already states is left alone.
      const hints = clientHints(process.versions.chrome || '', process.platform)
      partition.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders }
        const stated = Object.keys(headers).map(key => key.toLowerCase())
        for (const [key, value] of Object.entries({ ...hints, ...fetchMetadata(details.url, headers.Referer || headers.referer) })) {
          if (!stated.includes(key)) headers[key] = value
        }
        callback({ requestHeaders: headers })
      })
    }
    return partition
  }

  get userAgent(): string { return this.session.getUserAgent() }
  // Every request the client makes outside a page goes through here, so that it leaves from the same
  // session - the same cookies, agent and headers - as the pages the user signed in on.
  async fetch(address: string, init?: RequestInit): Promise<Response> { return await this.session.fetch(address, init) }
  // How many sites the partition holds cookies for. Cookies are not proof of a login - a visited page
  // hands out visitor cookies too - so this is reported as sites with a session, never as "signed in".
  async sites(): Promise<number> {
    const domains = new Set((await this.session.cookies.get({})).map(cookie => (cookie.domain || '').replace(/^\./, '')).filter(Boolean))
    return domains.size
  }
  close(): void {
    this.release()
    this.closePreview(); this.preview?.view.webContents.close(); this.preview = undefined
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.destroy()
    this.loginWindow = null
  }
  async clear(): Promise<void> { this.close(); await this.session.clearStorageData() }

  // The visible counterpart of the hidden parsing window: the same partition, so a login completed
  // here is the login the next parse uses.
  openLogin(url: string, onClosed: () => void = () => {}): void {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.show(); this.loginWindow.focus()
      if (url) void this.loginWindow.loadURL(url)
      return
    }
    const window = new BrowserWindow({
      title: '登录', width: 1100, height: 800, backgroundColor: '#ffffff',
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    // Platform login flows open their own windows; keep them in this one rather than dropping them.
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) void window.loadURL(target)
      return { action: 'deny' }
    })
    // The login only becomes visible to the client once the user is done with the window.
    window.on('closed', () => { this.loginWindow = null; onClosed() })
    this.loginWindow = window
    void window.loadURL(url || 'about:blank')
  }

  // An item's own page, shown inside the client's window where its preview dialog is: a view laid
  // over the window rather than a frame, because platform pages refuse to be framed. One view, reused;
  // closing takes it off the window and blanks it, which is what stops the playback. The same
  // partition as the login window, so the page plays for the account the client parses with.
  openPreview(host: BrowserWindow, url: string, onClosed: () => void): void {
    const preview = this.preview ??= this.previewView()
    if (preview.host !== host) {
      this.closePreview()
      preview.host = host
      // Nothing is shown until the window says where its dialog is.
      preview.area = { x: 0, y: 0, width: 0, height: 0 }
      this.fitPreview()
      host.contentView.addChildView(preview.view)
      host.on('resize', this.fitPreview)
      host.on('closed', this.releasePreview)
    }
    preview.onClosed = onClosed
    void preview.view.webContents.loadURL(url)
    preview.view.webContents.focus()
  }
  // Where the dialog's page area is, in the window's own coordinates.
  placePreview(area: Rectangle): void {
    if (!this.preview) return
    this.preview.area = area
    this.fitPreview()
  }
  closePreview(): void {
    const preview = this.preview
    if (!preview?.host) return
    const { host, onClosed } = preview
    preview.host = undefined; preview.onClosed = undefined; preview.fullscreen = false
    host.off('resize', this.fitPreview); host.off('closed', this.releasePreview)
    if (!host.isDestroyed()) host.contentView.removeChildView(preview.view)
    void preview.view.webContents.loadURL('about:blank')
    onClosed?.()
  }
  private releasePreview = (): void => this.closePreview()
  // A player in fullscreen fills the whole window rather than the dialog it sits in.
  private fitPreview = (): void => {
    const preview = this.preview
    if (!preview?.host || preview.host.isDestroyed()) return
    const [width, height] = preview.host.getContentSize()
    preview.view.setBounds(preview.fullscreen ? { x: 0, y: 0, width, height } : preview.area)
  }
  private previewView(): PreviewView {
    const view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    view.setBackgroundColor('#000000')
    const preview: PreviewView = { view, area: { x: 0, y: 0, width: 0, height: 0 }, fullscreen: false }
    const contents = view.webContents
    // A link the page opens in a new tab stays in the preview instead.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void contents.loadURL(url)
      return { action: 'deny' }
    })
    // Esc pressed while the page has focus never reaches the window's dialog, so it is caught here -
    // except in fullscreen, where it is the player's own way out.
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !preview.fullscreen) { event.preventDefault(); this.closePreview() }
    })
    contents.on('enter-html-full-screen', () => { preview.fullscreen = true; this.fitPreview() })
    contents.on('leave-html-full-screen', () => { preview.fullscreen = false; this.fitPreview() })
    return preview
  }

  private hidden(): BrowserWindow {
    const window = new BrowserWindow({
      show: false, width: 1280, height: 900,
      // A hidden window has its timers throttled, which starves the scroll loop a listing needs.
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return window
  }

  private async load(window: BrowserWindow, url: string, signal: AbortSignal): Promise<void> {
    const abort = () => { if (!window.isDestroyed()) window.destroy() }
    signal.addEventListener('abort', abort, { once: true })
    const started = Date.now()
    // A page that cancels its own navigation still leaves usable content behind.
    try { await window.webContents.loadURL(url) } catch (error) {
      if (!String(error).includes('ERR_ABORTED')) { log.warn(`加载失败 ${url} ${Date.now() - started}ms`, error); throw error }
    }
    finally { signal.removeEventListener('abort', abort) }
    signal.throwIfAborted()
    // Where the page ended up, not only where it was sent: a redirect to a challenge shows up here.
    const landed = window.isDestroyed() ? '' : window.webContents.getURL()
    log.debug(`加载 ${url} ${Date.now() - started}ms${landed && landed !== url ? ` → ${landed}` : ''}`)
  }

  private async cookiesFor(addresses: string[]): Promise<Cookie[]> {
    const found = new Map<string, Cookie>()
    for (const address of new Set(addresses.filter(value => /^https?:/.test(value)))) {
      for (const cookie of toCookies(await this.session.cookies.get({ url: address }))) {
        found.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie)
      }
    }
    return [...found.values()]
  }

  // The identity this client has on a site: what the user signed in as here, including the cookies the
  // platform keeps on its other hosts. Handed to the engine so a download leaves as the same visitor
  // the parse did, rather than as an anonymous one.
  async identity(url: string): Promise<{ cookies: Cookie[]; userAgent: string }> {
    return { cookies: await this.cookiesFor([url, ...relatedTo(url)]), userAgent: this.userAgent }
  }

  // Visitor cookies - 哔哩哔哩's buvid and ticket, YouTube's consent - are handed out by the site's own
  // front page and by nothing else. An API call made before that visit is a request from someone who
  // has never been to the site, which is exactly what risk control is looking for.
  //
  // One visit is not always enough. 哔哩哔哩 mints its credentials in JavaScript rather than handing them
  // over in Set-Cookie - a fingerprint call, a ticket call, then a two-step challenge - and a cold
  // anonymous profile was measured needing three loads before a listing came back at all. So the page is
  // shown again while each visit still changes the cookie jar, which is what minting looks like from
  // outside, and stops as soon as one changes nothing. Naming no platform's cookies keeps this general.
  async warm(url: string, signal: AbortSignal): Promise<void> {
    let origin: string; let host: string
    try { const target = new URL(url); origin = target.origin; host = target.hostname } catch { return }
    if (Date.now() - (this.warmed.get(host) || 0) < WARM_AFTER) return
    const known = await this.session.cookies.get({ url: origin })
    // Nothing to do for a site the user already carries live cookies for; a visitor cookie that has run
    // out, or none at all, is what a visit fixes. 哔哩哔哩's ticket lasts days, not weeks.
    const stale = known.some(cookie => cookie.expirationDate && cookie.expirationDate * 1_000 < Date.now() + 3_600_000)
    this.warmed.set(host, Date.now())
    if (known.length && !stale) { log.debug(`预热跳过 ${host}：已有 ${known.length} 个有效 cookie`); return }
    log.info(`预热 ${origin}：${known.length ? '有 cookie 即将过期' : '没有 cookie'}`)
    const window = this.hidden()
    // A front page that will not load says nothing about the media the user actually asked for.
    try {
      let before = ''
      for (let visit = 0; visit < VISITS; visit += 1) {
        await this.load(window, `${origin}/`, signal)
        await pause(signal, PACE.settle)
        // Whatever the site left for its own pages is worth keeping: the next request may be for
        // something it is already holding, and a visit is the only chance to read it.
        this.stored.set(origin, await window.webContents.executeJavaScript(STORAGE) as Record<string, string>)
        const jar = await this.session.cookies.get({ url: origin })
        const after = jar.map(cookie => `${cookie.name}=${cookie.value}`).sort().join('\n')
        // Names only: which credentials a visit minted is the useful part, and the values are secrets.
        log.debug(`预热 ${host} 第 ${visit + 1} 次：${jar.length} 个 cookie${after === before ? '，没有变化' : ''} [${jar.map(cookie => cookie.name).join(', ')}]`)
        if (after === before) break
        before = after
      }
    } catch (error) { signal.throwIfAborted(); log.warn(`预热 ${origin} 失败`, error) }
    finally { if (!window.isDestroyed()) window.destroy() }
  }

  // 哔哩哔哩 asks the client to name its graphics stack, and the strings it wants exist only where a page
  // has run. A blank document is enough - they describe the machine, not the site - so this costs one
  // window per run rather than a visit to anyone. A machine with no WebGL answers with empty names
  // rather than with nothing, because that is what it has to say and the API accepts it.
  private async fingerprint(signal: AbortSignal): Promise<Fingerprint | undefined> {
    if (this.asked) return this.print
    this.asked = true
    const window = this.hidden()
    try {
      await this.load(window, 'about:blank', signal)
      this.print = await window.webContents.executeJavaScript(`(${fingerprintScript})()`) as Fingerprint
      log.debug(`指纹 ${this.print.glRenderer || '无 WebGL'} · ${this.print.width}x${this.print.height}`)
    } catch (error) { signal.throwIfAborted(); log.warn('读取浏览器指纹失败', error) }
    finally { if (!window.isDestroyed()) window.destroy() }
    return this.print
  }

  // Page 1 unless asked otherwise: a listing is only read further when the user turns the page.
  //
  // One route, not a ladder. The platform's own listing API is called from inside a page of its site,
  // so the cookies, the Origin, the Referer, the client hints and the TLS handshake are supplied by the
  // browser and are true rather than asserted. There is no grid-walking behind it: scrolling a listing
  // is the behaviour risk control watches for, and a refusal is worth more to the caller reported as a
  // refusal than dressed up as a profile with fewer posts than it has.
  //
  // 'undefined' is the adapter standing down after reading the address - see ProfileAdapter.fetchPage -
  // and means this route has nothing to offer, not that it failed.
  // One read at a time. There is one listing window, and a second read arriving while the first is
  // still in it - a download re-resolving its post while the user parses something else, or two
  // downloads of one post at once - would replace the window under the first (measured: "Object has
  // been destroyed", a page load aborted mid-way). So they queue behind each other.
  private reading: Promise<unknown> = Promise.resolve()

  async inspectProfile(url: string, index: number, group: string | undefined, signal: AbortSignal): Promise<Listing | undefined> {
    const turn = this.reading.then(() => this.inspectNow(url, index, group, signal))
    this.reading = turn.catch(() => {})
    return await turn
  }

  private async inspectNow(url: string, index: number, group: string | undefined, signal: AbortSignal): Promise<Listing | undefined> {
    signal.throwIfAborted()
    const adapter = findAdapter(url)
    if (!adapter?.fetchPage) throw new Error('暂不支持这个平台的主页解析，请改用单个作品链接。')
    const address = adapter.entryUrl(new URL(url))
    const reused = this.open?.address === address && !this.open.window.isDestroyed()
    try { return await this.readListing(adapter, url, address, index, group, signal) }
    catch (error) {
      signal.throwIfAborted()
      // A page held open since the last turn can have been discarded, navigated by the site, or simply
      // gone stale. That is not something to report to the user, so the window is thrown away and the
      // listing asked for once more on a fresh one. A refusal is not retried: it would be refused again.
      if (!reused || error instanceof LoginRequired) throw error
      log.warn(`[listing ${adapter.id}] 复用的窗口不可用，重开一次`, error)
      this.release()
      return await this.readListing(adapter, url, address, index, group, signal)
    }
  }

  // Closes the listing window, whether it is being replaced or simply has not been used for a while.
  private release(): void {
    if (!this.open) return
    const { window, page, timer } = this.open
    this.open = undefined
    clearTimeout(timer)
    void page.settle().catch(() => {}).finally(() => { if (!window.isDestroyed()) window.destroy() })
  }

  private async readListing(adapter: ProfileAdapter, url: string, address: string, index: number, group: string | undefined, signal: AbortSignal): Promise<Listing | undefined> {
    const opened = Date.now()
    let warmed = opened
    let loaded = opened
    // A window still standing on this very listing has already paid for the load and the pause after
    // it; asking it for the next page is the whole of the work.
    if (this.open?.address !== address || this.open.window.isDestroyed()) {
      this.release()
      // The page is opened as someone who has been to the site, never as this client's first request.
      await this.warm(url, signal)
      warmed = Date.now()
      const window = this.hidden()
      // Nothing to listen for, but the protocol is what evaluates out of the page's own CSP.
      const page = watch(window.webContents, {})
      this.open = { address, window, page, timer: setTimeout(() => this.release(), REUSE_FOR) }
      try {
        await this.load(window, address, signal)
        loaded = Date.now()
        // A page is looked at before it is asked anything.
        await pause(signal, PACE.settle)
      } catch (error) { this.release(); throw error }
    }
    const held = this.open!
    // Every turn puts the window's closing back, so a listing being read stays open and one abandoned
    // mid-way does not.
    clearTimeout(held.timer)
    held.timer = setTimeout(() => this.release(), REUSE_FOR)
    const settled = Date.now()
    const listing = await adapter.fetchPage!({
      // Paced by the browser's own Pace, which counts every request this client makes to the host
      // rather than only the ones belonging to this walk.
      url: new URL(url), page: index, group, fetch: this.pace.wrap(pageFetch(held.page.evaluate)), evaluate: held.page.evaluate, userAgent: this.userAgent,
      locale: this.locale(), fingerprint: await this.fingerprint(signal),
      // Read off the page that is open rather than from the warm-up's record of an earlier visit.
      storage: await held.page.evaluate<Record<string, string>>(STORAGE).catch(() => undefined), signal,
    })
    signal.throwIfAborted()
    const asked = Date.now()
    if (!listing) {
      log.info(`[listing ${adapter.id}] 读完后放弃接管，交回引擎解析`)
      return undefined
    }
    const entries = listing.groups.flatMap(group => group.entries)
    log.info(`[listing ${adapter.id} 第 ${index} 页] 预热 ${warmed - opened}ms · 加载 ${loaded - warmed}ms · 停顿 ${settled - loaded}ms · 取数 ${asked - settled}ms · 合计 ${asked - opened}ms · ${entries.length} 条`)
    return {
      title: listing.title || '主页作品', kind: listing.kind || 'profile', groups: listing.groups, userAgent: this.userAgent,
      cookies: await this.cookiesFor([held.window.webContents.getURL(), ...relatedTo(url), ...entries.map(entry => entry.url)]),
    }
  }

  // Pages whose media is prose rather than a player: the pictures are laid out in the article body and
  // there is no data model to read them from. Named rather than guessed at, because sweeping every
  // page for <img> would answer with thumbnails and page furniture, and a page that answers with
  // pictures is never given the engine attempt that would have found its video.
  private static readonly ARTICLES = /(^|\.)mp\.weixin\.qq\.com$/

  // Media that lives inside a frame rather than in the document: 微信公众号 embeds its music card that
  // way, and the article itself holds no audio address at all. Every subframe is asked, and none of
  // them is required to answer - a cross-origin frame, or one whose CSP refuses an injected script,
  // is a frame with nothing to say rather than a failure of the page.
  private async framesMedia(window: BrowserWindow, signal: AbortSignal): Promise<string[]> {
    const found: string[] = []
    if (window.isDestroyed()) return found
    for (const frame of window.webContents.mainFrame.framesInSubtree) {
      if (signal.aborted || frame === window.webContents.mainFrame) continue
      try {
        for (const address of await frame.executeJavaScript(`(${frameMediaScript})()`) as string[]) {
          try { found.push(new URL(address, frame.url).href) } catch { /* Not an address this frame could resolve. */ }
        }
      } catch { /* A frame that will not run the script has nothing to contribute. */ }
    }
    return found
  }

  async inspect(url: string, signal: AbortSignal): Promise<BrowserMedia> {
    signal.throwIfAborted()
    const window = this.hidden()
    const videos = new Set<string>()
    // Manifests and progressive media are fetched by the player itself, so they appear as responses
    // and never in the DOM.
    const page = watch(window.webContents, { response: (address, mimeType, status) => {
      if (status >= 400) log.debug(`[inspect] 响应 ${status} ${mimeType} ${address}`)
      if (status < 400 && /^https?:/.test(address) && !/\.(ts|m4s)(\?|$)/i.test(address)
        && (/mpegurl|dash\+xml|video\/mp4|audio\/mpeg/.test(mimeType) || /\.(m3u8|mpd)(\?|$)/i.test(address))) videos.add(address)
    } })
    try {
      await this.load(window, url, signal)
      // Long enough for a player to ask for its manifest, and never the same length twice.
      await pause(signal, PACE.media)
      signal.throwIfAborted()
      const article = EmbeddedBrowser.ARTICLES.test(new URL(url).hostname)
      const data = await page.evaluate<{ title: string; images: string[]; media: string[]; posters: Poster[]; thumbnail: string; userAgent: string }>(`(${mediaScript})(${article})`)
      // A 微信公众号 music card is an iframe: the article names the song and the player, and the audio
      // address is only inside that frame. Asked of every frame rather than of that one - a page's
      // media living in a frame is not special to one platform - and best-effort, because a frame
      // from another origin, or one whose CSP refuses the script, simply answers nothing.
      for (const found of await this.framesMedia(window, signal)) data.media.push(found)
      await page.settle()
      const address = window.webContents.getURL()
      // The counterpart of the listing log: when a page answers with nothing, this is what says
      // whether the page never arrived or arrived and held nothing.
      log.info(`[inspect] ${address} · 标题「${data.title.slice(0, 40)}」· 视频 ${data.media.length} · 图片 ${data.images.length} · 响应里的媒体 ${videos.size}${article ? ' · 按文章处理' : ''}`)
      for (const found of data.media) videos.add(new URL(found, address).href)
      return { title: data.title, url: address, videos: [...videos], images: data.images, posters: data.posters, article, thumbnail: data.thumbnail, userAgent: data.userAgent, cookies: await this.cookiesFor([address, ...relatedTo(address), ...videos, ...data.images]) }
    } finally { await page.settle().catch(() => {}); if (!window.isDestroyed()) window.destroy() }
  }
}

// A page that forbids storage throws rather than answering, and an origin with nothing kept is the
// same to the caller as one that was never visited.
const STORAGE = `(() => { try { return { ...localStorage } } catch { return {} } })()`

// These carry no body however much a server wants to send one, and the Response constructor rejects
// the pairing rather than dropping it.
const EMPTY = new Set([101, 103, 204, 205, 304])

// A fetcher whose requests leave from the page itself rather than from the main process. Everything
// the client would otherwise have to claim - the cookies, the Origin and Referer, the client hints,
// the TLS handshake - is supplied by the browser and is true by construction. The reply crosses the
// protocol as a plain value and is rebuilt into a Response here, because that is what an adapter takes.
function pageFetch(evaluate: <T>(expression: string) => Promise<T>): Fetcher {
  return async (address, init) => {
    const method = init?.method || 'GET'
    const sent = JSON.stringify({ method, headers: init?.headers || {}, body: init?.body })
    const started = Date.now()
    // Runs in the page, so it names nothing from here; the address and the init travel as literals.
    const reply = await evaluate<{ status: number; body: string } | { failed: string }>(`(async () => {
      try {
        const response = await fetch(${JSON.stringify(address)}, { ...${sent}, credentials: 'include' })
        return { status: response.status, body: await response.text() }
      } catch (error) { return { failed: String(error) } }
    })()`)
    // A page that could not reach the host at all is a different thing from one that was refused, and
    // an adapter is owed the difference: a refusal it can read, or an error it cannot mistake for one.
    if ('failed' in reply) { log.warn(`[fetch] ${method} ${address} 未发出 ${Date.now() - started}ms：${reply.failed}`); throw new Error(`页面内请求未发出：${reply.failed}`) }
    const line = `[fetch] ${method} ${address} → ${reply.status} · ${reply.body.length} 字符 · ${Date.now() - started}ms`
    // Every listing API answers JSON. Anything else - a challenge page, an error page, a 412 - is the
    // thing a failed parse has to be diagnosed from, so its opening is kept.
    if (reply.status >= 400 || (reply.body && !/^s*[[{]/.test(reply.body))) log.warn(`${line} · 响应开头：${head(reply.body)}`)
    else log.debug(line)
    return new Response(EMPTY.has(reply.status) ? null : reply.body, { status: reply.status })
  }
}

// What this machine can say about its graphics stack, which on some of them is nothing: a headless or
// software-rendered Chromium answers no WebGL context at all, and one without the debug extension
// answers only the masked names. Reporting the empty case as empty is the honest answer and an accepted
// one - 哔哩哔哩 checks that the parameters are present, not what they hold - so this never refuses.
const fingerprintScript = function () {
  const canvas = document.createElement('canvas')
  const size = { width: window.innerWidth, height: window.innerHeight }
  const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
  if (!gl) return { glVersion: '', glRenderer: '', glVendor: '', ...size }
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const named = (unmasked: number, masked: number) => String(gl.getParameter(debug ? unmasked : masked) || '')
  return {
    glVersion: String(gl.getParameter(gl.VERSION) || ''),
    // The site's own page reads the unmasked names; the masked ones are what a browser without the
    // extension would have sent in their place.
    glRenderer: named(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER, gl.RENDERER),
    glVendor: named(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR, gl.VENDOR),
    ...size,
  }
}

// Run inside a subframe. Only the media addresses: the frame's title and pictures belong to the
// player's own chrome, not to the page the user asked for.
const frameMediaScript = function () {
  const found = new Set<string>()
  for (const element of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (element.currentSrc && !element.currentSrc.startsWith('blob:')) found.add(element.currentSrc)
  }
  for (const element of document.querySelectorAll<HTMLSourceElement>('video source, audio source')) if (element.src) found.add(element.src)
  // A player that has not been pressed has no currentSrc yet, but says what it would play.
  for (const name of ['og:audio', 'og:audio:url', 'og:audio:secure_url', 'og:video', 'og:video:url']) {
    const stated = document.querySelector<HTMLMetaElement>(`meta[property="${name}"],meta[name="${name}"]`)?.content
    if (stated) found.add(stated)
  }
  return [...found]
}

// Serialized into the page, so this runs with no reference to anything in the main process.
// 'article' asks for the pictures laid out in the prose as well. Only where the caller knows the page
// is an article: on an ordinary media page the same sweep would pick up thumbnails and chrome, and a
// page that answers with pictures never gets the engine attempt that would have found its video.
const mediaScript = function (article: boolean) {
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[property="${name}"],meta[name="${name}"]`)?.content || ''
  const images = new Set<string>(); const media = new Set<string>(); const state = (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__; let title = meta('og:title') || document.title
  // An article is pictures in prose rather than a gallery with a data model behind it: 微信公众号 keeps
  // them in the document as lazy <img data-src>, which is the address, while 'src' is a placeholder
  // until the reader scrolls. Only pictures big enough to be the article's own: avatars, qr codes and
  // tracking pixels are declared small, and one of those saved as a download is a wrong file rather
  // than a small one. Sized only where the page says so - an undeclared picture is kept.
  if (article) {
    // The article body, where the page has one: outside it are the author's avatar and the site's own
    // guide pictures, both big enough to pass the size check (measured 2026-09-23 on a 公众号 article
    // whose only picture in the body was missed while those two were taken).
    const body = document.querySelector('#js_content') || document
    for (const element of body.querySelectorAll<HTMLImageElement>('img[data-src], img[src]')) {
      const address = element.getAttribute('data-src') || element.getAttribute('src') || ''
      if (!address || address.startsWith('data:')) continue
      // A lazy picture not yet scrolled to is showing a 1x1 placeholder, so its natural size says
      // nothing about it. 微信 writes the original's width into data-w; otherwise only a picture that
      // actually loaded from its own address is measured.
      const loaded = !element.getAttribute('data-src') || element.currentSrc === address
      const width = Number(element.getAttribute('data-w')) || (loaded ? element.naturalWidth : 0) || Number(element.getAttribute('width')) || 0
      const height = (loaded ? element.naturalHeight : 0) || Number(element.getAttribute('height')) || 0
      if ((width && width < 200) || (height && height < 200)) continue
      // Measured on a live 微信公众号 article: the same picture is written as http on one element and
      // https on another, so without this the one file arrives twice under two addresses.
      try { images.add(new URL(address, location.href).href.replace(/^http:\/\//, 'https://')) } catch { /* A relative address the page built wrong. */ }
    }
  }
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
  // Every player's poster, and the post it belongs to. A timeline plays blob: streams, so the addresses
  // come off the network with nothing to say which post each is - the poster is what ties them back.
  // The post is the nearest ancestor holding a '/status/'-style link; its longest line is taken as the
  // text, since the new X markup marks nothing up (measured 2026-09-23: no lang, no data-testid).
  const posters: { poster: string; link?: string; text?: string }[] = []
  for (const element of document.querySelectorAll<HTMLVideoElement>('video[poster]')) {
    let card: HTMLElement | null = element
    while (card && card !== document.body && !card.querySelector('a[href*="/status/"]')) card = card.parentElement
    const found = card && card !== document.body ? card.querySelector<HTMLAnchorElement>('a[href*="/status/"]') : null
    const text = found ? (card!.innerText || '').split('\n').map(line => line.trim()).sort((a, b) => b.length - a.length)[0] : undefined
    posters.push({ poster: element.poster, link: /^[^?#]*?\/status\/\d+/.exec(found?.href || '')?.[0], text: text?.slice(0, 80) || undefined })
  }
  return { title, images: [...images], media: [...media], posters, thumbnail: meta('og:image'), userAgent: navigator.userAgent }
}
