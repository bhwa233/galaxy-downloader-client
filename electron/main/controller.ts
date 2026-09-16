import { app, dialog, shell, net, Notification, clipboard, type BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { commandSchemas, settingsSchema, type ClientState, type Command, type Reply } from '../../shared/contracts'
import { Store } from '../services/store'
import { Engine, redact } from '../services/engine'
import { ChromeConnection } from '../services/chrome'
import { discoverProfiles, publicProfiles, type LocalProfile } from '../services/profiles'
import { Parser, ChromeRequired, type ParsePlan } from '../services/parser'
import { Queue } from '../services/queue'
import { Updates } from './update'

export class Controller {
  private store = new Store(app.getPath('userData'), app.getPath('downloads'))
  private engine = new Engine(app.getAppPath(), process.resourcesPath, app.isPackaged, () => this.store.data.settings.locale)
  private chrome = new ChromeConnection()
  private parser = new Parser(this.engine, this.chrome, (url, init) => net.fetch(url, init))
  private profiles: LocalProfile[] = []
  private plan?: ParsePlan
  private parsing?: AbortController
  private parseState: ClientState['parse'] = { status: 'idle' }
  private tools: ClientState['tools'] = { engine: { available: false, version: '' }, ffmpeg: { available: false, version: '' } }
  private queue = new Queue(this.store, this.engine, (url, init) => net.fetch(url, init), (job, signal) => this.parser.parse(job.url, this.profile(), this.store.data.settings.proxy, signal, job.method === 'chrome'), () => this.emit(), job => { if (this.store.data.settings.notifications && Notification.isSupported()) new Notification({ title: '下载完成', body: job.title }).show() })
  private updates = new Updates(() => this.emit(), () => this.queue.jobs.some(job => job.status === 'running' || job.status === 'queued'))
  constructor(private window: () => BrowserWindow | null) {}
  private profile() { const profile = this.profiles.find(item => item.id === this.store.data.settings.browserProfileId); return profile ? { browser: profile.browser, path: profile.path } : undefined }
  state(): ClientState { return { settings: this.store.data.settings, profiles: publicProfiles(this.profiles), jobs: this.queue.jobs.map(job => ({ ...job, url: redact(job.url), sourceUrl: undefined, logs: job.logs.map(redact), error: job.error ? redact(job.error) : undefined })), tools: this.tools, parse: this.parseState, chrome: { connected: this.chrome.connected }, update: this.updates.state } }
  private emit(): void { const win = this.window(); if (win && !win.isDestroyed()) win.webContents.send('desktop:state', this.state()) }
  async initialize(): Promise<void> { await this.refresh(); await this.window()!.webContents.session.setProxy(this.store.data.settings.proxy ? { proxyRules: this.store.data.settings.proxy } : { mode: 'system' }); await this.checkTools(); this.queue.pump() }
  private async refresh(): Promise<void> {
    this.profiles = await discoverProfiles()
    // Zero-configuration default: use the first available Profile; the user can change it in Settings.
    if (!this.store.data.settings.browserProfileId || !this.profiles.some(profile => profile.id === this.store.data.settings.browserProfileId)) {
      const preferred = this.profiles.find(profile => profile.available && profile.browser === 'chrome') || this.profiles.find(profile => profile.available)
      this.store.data.settings.browserProfileId = preferred?.id || null
      this.store.save()
    }
    this.emit()
  }
  private async openChromeDebugging(): Promise<void> {
    const address = 'chrome://inspect/#remote-debugging'
    const candidates = process.platform === 'win32' ? ['chrome.exe', 'chrome'] : process.platform === 'darwin' ? ['open'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    for (const executable of candidates) {
      try { const args = process.platform === 'darwin' ? ['-a', 'Google Chrome', address] : [address]; await new Promise<void>((resolve, reject) => { const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve() }) }); return } catch { /* try the next executable */ }
    }
    await dialog.showMessageBox(this.window()!, { type: 'info', title: '连接 Chrome', message: '请在 Chrome 地址栏打开 chrome://inspect/#remote-debugging', detail: '开启远程调试后，回到客户端并接受 Chrome 的授权提示。' })
  }
  private async checkTools(): Promise<void> {
    await Promise.allSettled([
      (async () => { try { const version = await this.engine.request<{ version: string }>({ operation: 'version' }); this.tools.engine = { available: true, version: version.version } } catch (error) { this.tools.engine = { available: false, version: '', error: redact(String(error)) } } })(),
      (async () => { try { const { stdout } = await promisify(execFile)(this.engine.ffmpeg, ['-version'], { timeout: 10_000, windowsHide: true }); this.tools.ffmpeg = { available: true, version: stdout.split('\n')[0] } } catch (error) { this.tools.ffmpeg = { available: false, version: '', error: redact(String(error)) } } })(),
    ])
    this.emit()
  }
  async command(name: unknown, raw: unknown): Promise<Reply> {
    try {
      if (typeof name !== 'string' || !Object.hasOwn(commandSchemas, name)) throw new Error('不支持的操作')
      const command = name as Command
      const input = commandSchemas[command].parse(raw)
      switch (command) {
        case 'state:get': break
        case 'clipboard:read': return { ok: true, state: this.state(), clipboardText: clipboard.readText().slice(0, 8192) }
        case 'browser:refresh': await this.refresh(); break
        case 'browser:connect': await this.chrome.connect(); break
        case 'browser:disconnect': await this.chrome.disconnect(); break
        case 'browser:guide': await this.openChromeDebugging(); break
        case 'browser:clear':
          this.parsing?.abort(); this.plan = undefined; this.parseState = { status: 'idle' }
          for (const job of this.queue.jobs) if (['running', 'queued'].includes(job.status)) this.queue.action(job.id, 'pause')
          this.store.data.settings.browserProfileId = null; this.store.save(); await this.chrome.disconnect(); break
        case 'media:cancel': this.parsing?.abort(); this.parsing = undefined; this.parseState = { status: 'idle' }; break
        case 'media:parse': {
          const { url, filter } = commandSchemas['media:parse'].parse(input)
          this.parsing?.abort(); const controller = new AbortController(); this.parsing = controller
          this.plan = undefined; this.parseState = { status: 'parsing' }; this.emit()
          try { const plan = await this.parser.parse(url, this.profile(), this.store.data.settings.proxy, controller.signal, false, filter); controller.signal.throwIfAborted(); this.plan = plan; this.parseState = { status: 'idle', result: plan.result } }
          catch (error) { if (this.parsing === controller && !controller.signal.aborted) this.parseState = { status: error instanceof ChromeRequired ? 'needs-chrome' : 'error', message: redact(String(error)) } }
          finally { if (this.parsing === controller) this.parsing = undefined }
          break
        }
        case 'media:download': {
          const { resultId, itemIds, format, audioOnly } = commandSchemas['media:download'].parse(input)
          if (!this.plan || this.plan.result.id !== resultId) throw new Error('解析结果已过期，请重新解析')
          const items = this.plan.result.items.filter(item => itemIds.includes(item.id))
          if (items.length !== new Set(itemIds).size) throw new Error('所选内容不存在')
          if (audioOnly && items.some(item => item.kind === 'image')) throw new Error('图文不能转换为音频')
          if (format !== 'best' && items.some(item => !item.formats.some(entry => entry.id === format))) throw new Error('画质选项已失效')
          this.queue.enqueue(this.plan, items, format, audioOnly); break
        }
        case 'settings:save': {
          const settings = { ...settingsSchema.parse(input), browserProfileId: this.store.data.settings.browserProfileId }
          if (settings.browserProfileId && !this.profiles.some(profile => profile.id === settings.browserProfileId)) throw new Error('浏览器配置已变化，请刷新')
          await this.window()!.webContents.session.setProxy(settings.proxy ? { proxyRules: settings.proxy } : { mode: 'system' })
          const reschedule = settings.concurrency !== this.store.data.settings.concurrency || settings.speedLimit !== this.store.data.settings.speedLimit
          this.store.data.settings = { ...settings, downloadDirectory: this.store.data.settings.downloadDirectory }; this.store.save(); if (reschedule) this.queue.restartActive(); else this.queue.pump(); break
        }
        case 'settings:directory': {
          const result = await dialog.showOpenDialog(this.window()!, { properties: ['openDirectory', 'createDirectory'], defaultPath: this.store.data.settings.downloadDirectory })
          if (!result.canceled && result.filePaths[0]) { this.store.data.settings.downloadDirectory = result.filePaths[0]; this.store.save() }; break
        }
        case 'jobs:action': {
          const { id, action } = commandSchemas['jobs:action'].parse(input)
          if (action !== 'reveal') this.queue.action(id, action)
          else { const job = this.queue.jobs.find(item => item.id === id); if (!job || job.status !== 'completed' || !job.files[0] || path.dirname(path.resolve(job.files[0])) !== path.resolve(job.directory)) throw new Error('找不到已完成的文件'); shell.showItemInFolder(job.files[0]) }; break
        }
        case 'jobs:batch': this.queue.batch(commandSchemas['jobs:batch'].parse(input).action); break
        case 'jobs:limit': { const { id, speedLimit } = commandSchemas['jobs:limit'].parse(input); this.queue.limit(id, speedLimit); break }
        case 'jobs:clear': this.queue.clear(); break
        case 'logs:export': {
          const result = await dialog.showSaveDialog(this.window()!, { defaultPath: 'download-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
          if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify({ version: app.getVersion(), platform: process.platform, tools: this.tools, jobs: this.queue.jobs.map(({ id, platform, status, error, logs }) => ({ id, platform, status, error, logs: logs.map(redact) })) }, null, 2), { mode: 0o600 }); break
        }
        case 'tools:check': await this.checkTools(); break
        case 'update:check': await this.updates.check(); break
        case 'update:download': await this.updates.download(); break
        case 'update:install': this.updates.install(); break
      }
      this.emit(); return { ok: true, state: this.state() }
    } catch (error) { this.emit(); return { ok: false, message: redact(error instanceof Error ? error.message : String(error)) } }
  }
  stop(): void { this.parsing?.abort(); this.queue.stop(); void this.chrome.disconnect() }
}
