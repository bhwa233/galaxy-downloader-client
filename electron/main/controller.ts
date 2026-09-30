import { app, dialog, shell, Notification, clipboard, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commandSchemas, settingsSchema, type ClientState, type Command, type HistoryEntry, type JobFile, type Reply } from '../../shared/contracts'
import { Store } from '../services/store'
import { Engine, redact } from '../services/engine'
import { EmbeddedBrowser } from '../services/browser'
import { discoverProfiles, publicProfiles, type LocalProfile } from '../services/profiles'
import { normalizeUrl } from '../services/media'
import { Parser, type ParsePlan } from '../services/parser'
import { previewPage } from '../services/preview'
import { asAccessDenied } from '../services/access'
import { LoginRequired, VerificationRequired } from '../services/login'
import { Queue } from '../services/queue'
import { downloadHttp } from '../services/http-download'
import { checkCover } from '../services/cover'
import { Updates } from './update'
import { logDirectory, logger, recentLog, setVerbose } from '../services/log'

const log = logger('controller')

// What a failed parse is reported as. Four refusals are told apart from one another and from an
// ordinary failure: a sign-in fixes the first, an entitled account the next two, and nothing the last.
// Anything that named no wall keeps its own message rather than being dressed up as a permission
// problem. The login window opens on the page that failed, which is where the platform's own prompt
// is - offered for the three walls a different account could lift, and not for 'encrypted', where it
// would be an offer that changes nothing.
function refusal(error: unknown, url: string): ClientState['parse'] {
  const denied = asAccessDenied(error)
  const login = !denied && error instanceof LoginRequired
  // A challenge page is answered in the same window as a login, on the page that was being read.
  const verify = !denied && error instanceof VerificationRequired
  let target: string | undefined
  try { target = normalizeUrl(url) } catch { /* Keep the generic login window. */ }
  if (denied) return { status: 'error', message: denied.message, wall: denied.wall, loginUrl: denied.wall === 'encrypted' ? undefined : target }
  // The message alone: String(error) would put JavaScript's 'Error: ' in front of what the user reads.
  const message = error instanceof Error ? error.message : String(error)
  return { status: login || verify ? 'needs-login' : 'error', message: redact(message), wall: login ? 'login' : undefined, verify: verify || undefined, loginUrl: login || verify ? target : undefined }
}

export class Controller {
  private store = new Store(app.getPath('userData'), app.getPath('downloads'))
  private engine = new Engine(app.getAppPath(), process.resourcesPath, app.isPackaged, () => this.store.data.settings.locale)
  private browser = new EmbeddedBrowser(() => this.store.data.settings.locale)
  // Both go through the browser's own session: an image or a direct file has to be fetched by the same
  // visitor, with the same cookies and headers, that the parse was made by.
  private parser = new Parser(this.engine, this.browser, (url, init) => this.browser.fetch(url, init))
  private browserSites = 0
  private profiles: LocalProfile[] = []
  private plan?: ParsePlan
  private previewing?: ClientState['preview']
  private parsing?: AbortController
  private parseState: ClientState['parse'] = { status: 'idle' }
  // The page a sign-in was offered for, kept until the login window closes so the turn the user asked
  // for can be made again without them asking twice. Only ever set by a refusal a login could lift.
  private pendingPage?: { resultId: string; page: number; groupId?: string }
  private tools: ClientState['tools'] = { engine: { available: false, version: '' }, ffmpeg: { available: false, version: '' } }
  // A job re-resolves the one post it was made from. 'single' says so: its URL can itself be a listing
  // the client would otherwise expand - a 哔哩哔哩 video that turned out to have 分P - and downloading
  // all of them under one job is not what the user picked.
  private queue = new Queue(this.store, this.engine, (url, init) => this.browser.fetch(url, init), (job, signal) => this.parser.parse(job.url, this.profile(), signal, { browserOnly: job.method === 'browser', single: job.itemId === '*' }), () => this.emit(), job => { if (this.store.data.settings.notifications && Notification.isSupported()) new Notification({ title: '下载完成', body: job.title }).show() }, file => shell.trashItem(file))
  private updates = new Updates(() => this.emit(), () => this.queue.jobs.some(job => job.status === 'running' || job.status === 'queued'))
  constructor(private window: () => BrowserWindow | null) {}
  private profile() { const profile = this.profiles.find(item => item.id === this.store.data.settings.browserProfileId); return profile ? { browser: profile.browser, path: profile.path } : undefined }
  state(): ClientState { return { settings: this.store.data.settings, profiles: publicProfiles(this.profiles), jobs: this.queue.jobs.map(job => ({ ...job, url: redact(job.url), sourceUrl: undefined, logs: job.logs.map(redact), error: job.error ? redact(job.error) : undefined })), tools: this.tools, parse: this.parseState, browser: { sites: this.browserSites }, update: this.updates.state, history: this.store.data.history, preview: this.previewing } }
  // A successful parse goes to the top of 解析历史: one entry per address, the newest 50 kept. Only
  // successes - a list of failures would bury the entries worth parsing again.
  private remember(plan: ParsePlan): void {
    if (!this.store.data.settings.keepHistory) return
    const { result } = plan
    const entry: HistoryEntry = {
      url: result.url, title: result.title, platform: result.platform,
      listing: result.groups?.some(group => group.id === 'parts') ? 'parts' : result.listing,
      count: result.groups?.[0]?.pagination?.total ?? result.items.length,
      thumbnail: result.items.find(item => item.thumbnail && /^https?:/.test(item.thumbnail))?.thumbnail,
      parsedAt: new Date().toISOString(),
    }
    this.store.data.history = [entry, ...this.store.data.history.filter(held => held.url !== entry.url)].slice(0, 50)
    this.store.save()
  }
  // A listing's entries carry no quality tiers - the listing endpoints do not say - so its first video
  // is read once, in the background, and its tiers are offered for the whole listing. One request, not
  // one per entry: reading every entry would be dozens of requests to one platform in a burst. The
  // listing is already on screen; the tiers appear in the quality menu when they arrive.
  private async sampleTiers(plan: ParsePlan): Promise<void> {
    if (!plan.result.listing) return
    const first = plan.result.items.find(item => item.kind === 'video' && !item.wall && item.url)
    if (!first?.url) return
    try {
      const sample = await this.parser.parse(first.url, this.profile(), new AbortController().signal, { single: true })
      const formats = sample.result.items[0]?.formats
      // Only onto the listing it was read for: the user may have parsed something else meanwhile.
      if (!formats?.length || this.plan !== plan) return
      plan.result.formats = formats
      if (this.parseState.result?.id === plan.result.id) this.parseState = { ...this.parseState, result: plan.result }
      this.emit()
    } catch (error) { log.warn('读取清晰度样本失败', error) }
  }
  private emit(): void { const win = this.window(); if (win && !win.isDestroyed()) win.webContents.send('desktop:state', this.state()) }
  async initialize(): Promise<void> { setVerbose(this.store.data.settings.verboseLogging); await this.refresh(); await this.checkTools(); this.queue.pump() }
  // The login window closing is the only signal the client gets that a sign-in is over; whether it
  // succeeded is not knowable from here. So the page that asked for it is simply asked for again, and
  // reports whatever it is given this time - including the same refusal, if the window was closed
  // without signing in. Cleared first, so a second close does not turn the page a second time.
  private async afterLogin(): Promise<void> {
    this.browserSites = await this.browser.sites()
    const pending = this.pendingPage
    this.pendingPage = undefined
    if (!pending) { this.emit(); return }
    await this.command('media:page', pending)
  }
  private async refresh(): Promise<void> {
    this.profiles = await discoverProfiles()
    this.browserSites = await this.browser.sites()
    // Zero-configuration default: use the first available Profile; the user can change it in Settings.
    if (!this.store.data.settings.browserProfileId || !this.profiles.some(profile => profile.id === this.store.data.settings.browserProfileId)) {
      const preferred = this.profiles.find(profile => profile.available && profile.browser === 'chrome') || this.profiles.find(profile => profile.available)
      this.store.data.settings.browserProfileId = preferred?.id || null
      this.store.save()
    }
    this.emit()
  }
  private async checkTools(): Promise<void> {
    await Promise.allSettled([
      (async () => { try { const version = await this.engine.request<{ version: string }>({ operation: 'version' }); this.tools.engine = { available: true, version: version.version } } catch (error) { log.warn('解析引擎不可用', error); this.tools.engine = { available: false, version: '', error: redact(String(error)) } } })(),
      (async () => { try { const { stdout } = await promisify(execFile)(this.engine.ffmpeg, ['-version'], { timeout: 10_000, windowsHide: true }); this.tools.ffmpeg = { available: true, version: stdout.split('\n')[0] } } catch (error) { log.warn('FFmpeg 不可用', error); this.tools.ffmpeg = { available: false, version: '', error: redact(String(error)) } } })(),
    ])
    this.emit()
  }
  async command(name: unknown, raw: unknown): Promise<Reply> {
    let added: number | undefined
    let files: JobFile[] | undefined
    const started = Date.now()
    // Polled by the window; a line per poll would drown out everything else.
    const quiet = name === 'state:get' || name === 'clipboard:read'
    try {
      if (typeof name !== 'string' || !Object.hasOwn(commandSchemas, name)) throw new Error('不支持的操作')
      const command = name as Command
      const input = commandSchemas[command].parse(raw)
      switch (command) {
        case 'state:get': break
        case 'clipboard:read': return { ok: true, state: this.state(), clipboardText: clipboard.readText().slice(0, 8192) }
        case 'browser:refresh': await this.refresh(); break
        case 'browser:login': {
          // The visible window shares its partition with the hidden one that parses, so the user
          // logs in once and the next parse carries it.
          this.browser.openLogin(commandSchemas['browser:login'].parse(input).url || this.parseState.loginUrl || '', () => void this.afterLogin())
          break
        }
        case 'browser:clear':
          this.parsing?.abort(); this.plan = undefined; this.parseState = { status: 'idle' }
          for (const job of this.queue.jobs) if (['running', 'queued'].includes(job.status)) this.queue.action(job.id, 'pause')
          this.store.data.settings.browserProfileId = null; this.store.save()
          await this.browser.clear(); this.browserSites = 0; break
        case 'media:cancel': this.parsing?.abort(); this.parsing = undefined; this.parseState = { status: 'idle' }; break
        case 'media:parse': {
          const { url } = commandSchemas['media:parse'].parse(input)
          this.parsing?.abort(); const controller = new AbortController(); this.parsing = controller
          this.plan = undefined; this.parseState = { status: 'parsing' }; this.emit()
          try {
            const plan = await this.parser.parse(url, this.profile(), controller.signal)
            controller.signal.throwIfAborted(); this.plan = plan; this.parseState = { status: 'idle', result: plan.result }
            this.browserSites = await this.browser.sites()
            this.remember(plan)
            void this.sampleTiers(plan)
          }
          catch (error) {
            if (this.parsing === controller && !controller.signal.aborted) {
              // Reported through parseState rather than thrown, so the catch at the end of this method
              // never sees it; without this line a failed parse is invisible outside the window.
              log.error(`解析失败 ${url}`, error)
              this.parseState = { ...refusal(error, url), result: undefined }
            }
          }
          finally { if (this.parsing === controller) this.parsing = undefined }
          break
        }
        case 'media:page': {
          const { resultId, page, groupId } = commandSchemas['media:page'].parse(input)
          const current = this.plan
          if (!current || current.result.id !== resultId) throw new Error('解析结果已过期，请重新解析')
          this.parsing?.abort(); const controller = new AbortController(); this.parsing = controller
          try {
            const next = await this.parser.parse(current.result.url, this.profile(), controller.signal, { page, group: groupId })
            controller.signal.throwIfAborted()
            // 加载更多: the next page is added to what is on screen rather than replacing it, so every
            // post read so far stays listed, stays ticked and still downloads. Each tab grows on its own;
            // a post a later page repeats is kept once, where it first appeared.
            for (const [id, source] of next.sources) current.sources.set(id, source)
            for (const [id, item] of next.catalog) current.catalog.set(id, item)
            const known = new Set(current.result.items.map(item => item.id))
            const items = [...current.result.items, ...next.result.items.filter(item => !known.has(item.id))]
            const groups = next.result.groups?.map(found => {
              const before = current.result.groups?.find(existing => existing.id === found.id)
              if (!before || found.id !== (groupId || current.result.groups?.[0]?.id)) return before || found
              return { ...found, itemIds: [...before.itemIds, ...found.itemIds.filter(id => !before.itemIds.includes(id))] }
            })
            current.result = { ...next.result, id: current.result.id, title: current.result.title, items, groups, formats: current.result.formats }
            this.parseState = { status: 'idle', result: current.result }
            this.pendingPage = undefined
          }
          catch (error) {
            if (this.parsing === controller && !controller.signal.aborted) {
              log.error(`第 ${page} 页读取失败 ${current.result.url}`, error)
              // The page already on screen is kept. A listing that empties itself because the page
              // after it was refused takes away what the user had and answers nothing.
              this.parseState = { ...refusal(error, current.result.url), result: current.result }
              // Only worth returning to if signing in could change the answer.
              this.pendingPage = this.parseState.status === 'needs-login' ? { resultId, page, groupId } : undefined
            }
          }
          finally { if (this.parsing === controller) this.parsing = undefined }
          break
        }
        case 'media:download': {
          const { resultId, itemIds, format, kinds } = commandSchemas['media:download'].parse(input)
          if (!this.plan || this.plan.result.id !== resultId) throw new Error('解析结果已过期，请重新解析')
          const items = [...new Set(itemIds)].map(id => this.plan!.catalog.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
          if (items.length !== new Set(itemIds).size) throw new Error('所选内容不存在')
          // The window keeps these from being picked; this keeps them from being queued however asked.
          if (items.some(item => item.wall === 'purchase')) throw new Error('所选内容里有需要单独购买的，无法下载')
          // A tier is either one of the item's own, or on a listing one of the tiers read off its first
          // video - which a later video may lack, and is then downloaded at its best. Only the media
          // itself has a tier; audio and covers ignore it.
          const offered = (item: typeof items[number]) => item.formats.some(entry => entry.id === format) || Boolean(this.plan?.result.listing && this.plan.result.formats?.some(entry => entry.id === format))
          if (kinds.includes('video') && format !== 'best' && items.some(item => item.kind !== 'image' && !offered(item))) throw new Error('画质选项已失效')
          // Each kind asked for is queued on its own, from the items it applies to: a picture has no
          // audio, and is skipped for it rather than failing the rest.
          const enqueue = (from: ParsePlan, picked: typeof items) => kinds.reduce((sum, kind) => {
            const applicable = kind === 'audio' ? picked.filter(item => item.kind !== 'image') : picked
            return applicable.length ? sum + this.queue.enqueue(from, applicable, kind === 'video' ? format : 'best', kind === 'audio', kind === 'cover') : sum
          }, 0)
          // A whole collection picked from a catalogue (a 短剧 from the 短剧 list) is not a file: it is
          // walked now, every page, and each of its items queued as a task of its own - one batch and
          // one directory per collection.
          const plan = this.plan
          const whole = items.filter(item => plan.sources.get(item.id)?.kind === 'collection')
          const files = items.filter(item => !whole.includes(item))
          // Anything already waiting to be downloaded is left to do it, so the reply reports what this
          // actually started rather than what was asked for.
          added = files.length ? enqueue(plan, files) : 0
          for (const item of whole) {
            const source = plan.sources.get(item.id)
            if (source?.kind !== 'collection') continue
            const expanded = await this.parser.expand(source.url, this.profile(), new AbortController().signal)
            added += enqueue(expanded, expanded.result.items)
          }
          break
        }
        case 'media:preview': {
          const { resultId, itemId } = commandSchemas['media:preview'].parse(input)
          if (!this.plan || this.plan.result.id !== resultId) throw new Error('解析结果已过期，请重新解析')
          const page = previewPage(this.plan, itemId)
          const window = this.window()
          if (!window || window.isDestroyed()) break
          this.previewing = { title: page.title }
          this.browser.openPreview(window, page.url, () => { this.previewing = undefined; this.emit() })
          break
        }
        // Sent on every move and resize of the dialog, so it answers without broadcasting the state.
        case 'preview:place': this.browser.placePreview(commandSchemas['preview:place'].parse(input)); return { ok: true, state: this.state() }
        case 'preview:close': this.browser.closePreview(); break
        case 'settings:save': {
          const settings = { ...settingsSchema.parse(input), browserProfileId: this.store.data.settings.browserProfileId }
          if (settings.browserProfileId && !this.profiles.some(profile => profile.id === settings.browserProfileId)) throw new Error('浏览器配置已变化，请刷新')
          const reschedule = settings.concurrency !== this.store.data.settings.concurrency || settings.speedLimit !== this.store.data.settings.speedLimit
          this.store.data.settings = { ...settings, downloadDirectory: this.store.data.settings.downloadDirectory }; this.store.save(); setVerbose(settings.verboseLogging); if (reschedule) this.queue.restartActive(); else this.queue.pump(); break
        }
        case 'settings:directory': {
          const result = await dialog.showOpenDialog(this.window()!, { properties: ['openDirectory', 'createDirectory'], defaultPath: this.store.data.settings.downloadDirectory })
          if (!result.canceled && result.filePaths[0]) { this.store.data.settings.downloadDirectory = result.filePaths[0]; this.store.save() }; break
        }
        case 'jobs:action': {
          const { id, action } = commandSchemas['jobs:action'].parse(input)
          // Both of these add something next to the job rather than changing it, so they are their own
          // entry points instead of another state on the job.
          if (action === 'thumbnail') { await this.queue.thumbnail(id); break }
          if (action === 'audio') { this.queue.audio(id); break }
          if (!['open', 'reveal', 'copy-link', 'open-page', 'copy-path', 'login'].includes(action)) { this.queue.action(id, action as 'pause' | 'resume' | 'retry' | 'cancel'); break }
          const job = this.queue.jobs.find(item => item.id === id)
          if (!job) throw new Error('下载任务不存在')
          if (action === 'copy-link') { clipboard.writeText(job.url); break }
          // The page the job failed on is where the platform's own sign-in prompt is.
          if (action === 'login') { this.browser.openLogin(/^https?:\/\//i.test(job.url) ? job.url : '', () => void this.afterLogin()); break }
          // Only ever the page the job was made from, which this client fetched itself and which the
          // schema for a pasted link has already held to http(s).
          if (action === 'open-page') {
            if (!/^https?:\/\//i.test(job.url)) throw new Error('这个任务没有可打开的网页链接')
            await shell.openExternal(job.url); break
          }
          // These speak for a file on disk, so all want one that is there and is the job's own.
          const file = job.files[0]
          if (!file || job.status !== 'completed' || path.dirname(path.resolve(file)) !== path.resolve(job.directory)) throw new Error('找不到已完成的文件')
          if (action === 'copy-path') clipboard.writeText(file)
          else if (action === 'open') {
            // The system's own default application for the file. It reports a failure as a message
            // rather than throwing - no application for the type, or the file gone since.
            const failure = await shell.openPath(file)
            if (failure) throw new Error(`无法打开文件：${failure}`)
          }
          else shell.showItemInFolder(file)
          break
        }
        case 'jobs:batch': { const { action, batchId, deleteFiles } = commandSchemas['jobs:batch'].parse(input); await this.queue.batch(action, batchId, deleteFiles); break }
        case 'jobs:limit': { const { id, speedLimit } = commandSchemas['jobs:limit'].parse(input); this.queue.limit(id, speedLimit); break }
        case 'jobs:clear': await this.queue.clear(commandSchemas['jobs:clear'].parse(input).deleteFiles); break
        case 'history:remove': {
          const { url } = commandSchemas['history:remove'].parse(input)
          this.store.data.history = this.store.data.history.filter(entry => entry.url !== url); this.store.save(); break
        }
        case 'history:clear': commandSchemas['history:clear'].parse(input); this.store.data.history = []; this.store.save(); break
        case 'media:cover': {
          const { url, title } = commandSchemas['media:cover'].parse(input)
          const extension = /\.(jpe?g|png|webp|gif|avif)(\?|$|@)/i.exec(new URL(url).pathname + new URL(url).search)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'jpg'
          const name = `${title.replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_').trim().slice(0, 80) || '封面'}.${extension}`
          const chosen = await dialog.showSaveDialog(this.window()!, { defaultPath: path.join(this.store.data.settings.downloadDirectory, name) })
          if (chosen.canceled || !chosen.filePath) break
          // Through the client's own session, so a cover the platform only serves to its own visitors
          // is fetched as one of them.
          await checkCover(await downloadHttp((address, init) => this.browser.fetch(address, init), url, chosen.filePath, [], {}, AbortSignal.timeout(60_000), () => {}))
          break
        }
        case 'jobs:files': {
          const job = this.queue.jobs.find(item => item.id === commandSchemas['jobs:files'].parse(input).id)
          if (!job) throw new Error('下载任务不存在')
          files = await Promise.all(job.files.map(async file => {
            const found = await stat(file).catch(() => undefined)
            return { path: file, exists: Boolean(found?.isFile()), size: found?.isFile() ? found.size : undefined }
          }))
          break
        }
        case 'jobs:remove': {
          const { id, deleteFiles } = commandSchemas['jobs:remove'].parse(input)
          await this.queue.remove(id, deleteFiles)
          break
        }
        case 'clipboard:write': clipboard.writeText(commandSchemas['clipboard:write'].parse(input).text); break
        // The address has already been held to http(s) by its schema, so this cannot be asked to open
        // a file or hand anything to another scheme's handler.
        case 'shell:open': await shell.openExternal(commandSchemas['shell:open'].parse(input).url); break
        case 'logs:export': {
          const result = await dialog.showSaveDialog(this.window()!, { defaultPath: 'download-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
          if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify({ version: app.getVersion(), platform: process.platform, tools: this.tools, jobs: this.queue.jobs.map(({ id, platform, status, error, logs }) => ({ id, platform, status, error, logs: logs.map(redact) })), log: await recentLog() }, null, 2), { mode: 0o600 }); break
        }
        case 'logs:open': { const failed = await shell.openPath(logDirectory()); if (failed) throw new Error(failed); break }
        case 'tools:check': await this.checkTools(); break
        case 'update:check': await this.updates.check(); break
        case 'update:download': await this.updates.download(); break
        case 'update:install': this.updates.install(); break
      }
      if (!quiet) log.debug(`${command} ${Date.now() - started}ms`)
      this.emit(); return { ok: true, state: this.state(), added, files }
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error))
      // The renderer shows this to the user, and until now that was the only place it went: a failure
      // the user could not screenshot left no trace anywhere. Redacted, because it is the same string
      // that is already safe enough to put on screen.
      log.error(`${String(name)} ${Date.now() - started}ms：${message}`)
      this.emit(); return { ok: false, message }
    }
  }
  stop(): void { this.parsing?.abort(); this.queue.stop(); this.browser.close() }
}
