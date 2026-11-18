import { app, shell } from 'electron'
import electronUpdater, { type CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { ClientState } from '../../shared/contracts'
import { redact } from '../services/engine'
import { logger } from '../services/log'
import { i18n } from '../../shared/i18n'

const log = logger('update')
const CHECK_TIMEOUT = 30_000
const SLOW_AFTER = 10_000
const STALLED_AFTER = 5_000
type UpdateState = ClientState['update']
// A downloaded installer is reusable only while the version AND published file identities agree.
const identity = (info: UpdateInfo) => JSON.stringify([info.version, info.files.map(file => [file.url, file.sha512, file.size])])

export class Updates {
  state: UpdateState = { status: 'idle', currentVersion: app.getVersion(), external: process.platform === 'darwin' }
  private updater = electronUpdater.autoUpdater
  private revision = 0
  private offered?: UpdateInfo
  private readyKey?: string
  private downloading?: { token: CancellationToken; task?: Promise<void> }
  private pulse?: ReturnType<typeof setInterval>
  private deadline?: ReturnType<typeof setTimeout>
  private stopped = false
  private lastProgress = 0
  private firstProgress = 0

  constructor(private changed: () => void, private busy: () => boolean) {
    this.updater.logger = log
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    // Promises own the final states: late events from timed-out metadata requests cannot replace
    // a newer operation. Error events still have a listener, as required by the updater emitter.
    this.updater.on('error', error => log.warn(redact(error.message)))
    this.updater.on('download-progress', info => this.progress(info))
  }
  private set(state: UpdateState): void {
    if (this.stopped) return
    this.state = { ...state, currentVersion: this.updater.currentVersion.version, external: process.platform === 'darwin' }
    this.changed()
  }
  private clearPulse(): void { clearInterval(this.pulse); this.pulse = undefined }
  private failure(error: unknown, operation: 'check' | 'download'): string {
    const message = redact(error instanceof Error ? error.message : String(error))
    log.warn(`${operation}: ${message}`)
    if (/timed? ?out|ETIMEDOUT|超时/i.test(message)) return i18n.t(operation === 'check' ? 'desktop:update.checkTimeout' : 'desktop:update.downloadTimeout')
    if (/sha512|checksum|digest|signature/i.test(message)) return i18n.t('desktop:update.verificationFailed')
    if (/EACCES|EPERM|ENOSPC/i.test(message)) return i18n.t('desktop:update.storageFailed')
    if (/net::|ECONN|ENOTFOUND|ERR_NETWORK|HttpError|network|socket|HTTP.*[45][0-9][0-9]/i.test(message)) return i18n.t('desktop:update.networkFailed')
    return message
  }
  private progress(info: ProgressInfo): void {
    if (!this.downloading || this.downloading.token.cancelled || this.stopped) return
    const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : undefined
    const downloaded = Number.isFinite(info.transferred) ? Math.max(0, info.transferred) : 0
    const total = positive(info.total), speed = positive(info.bytesPerSecond)
    const complete = total !== undefined && downloaded >= total
    this.lastProgress = Date.now()
    if (downloaded > 0 && !this.firstProgress) this.firstProgress = this.lastProgress
    this.set({ status: complete ? 'verifying' : 'downloading', version: this.offered?.version, downloaded, total,
      progress: total ? Math.min(100, downloaded / total * 100) : undefined,
      speed: complete ? undefined : speed, eta: !complete && total && speed && this.firstProgress && this.lastProgress - this.firstProgress >= 2_000 ? Math.max(0, total - downloaded) / speed : undefined })
  }

  async check(): Promise<void> {
    if (this.state.status === 'checking' || this.downloading) return
    if (!app.isPackaged && !this.updater.forceDevUpdateConfig) {
      this.set({ ...this.state, message: i18n.t('desktop:update.development') }); return
    }
    const revision = ++this.revision
    const previous = this.state
    const started = Date.now()
    this.set({ status: 'checking', version: previous.version })
    this.clearPulse()
    this.pulse = setInterval(() => {
      if (revision === this.revision && !this.state.slow && Date.now() - started >= SLOW_AFTER) this.set({ ...this.state, slow: true })
    }, 1_000)
    // Metadata checks expose no public cancellation API. Bound the UI wait; the updater itself
    // deduplicates retries, and a late result cannot overwrite this operation's timeout state.
    const timeout = new Promise<never>((_resolve, reject) => {
      this.deadline = setTimeout(() => reject(new Error(i18n.t('desktop:update.checkTimeout'))), CHECK_TIMEOUT)
    })
    try {
      const result = await Promise.race([this.updater.checkForUpdates(), timeout])
      if (revision !== this.revision || this.stopped) return
      if (!result) { this.set({ ...previous, message: i18n.t('desktop:update.development') }); return }
      if (result.isUpdateAvailable) {
        this.offered = result.updateInfo
        const ready = this.readyKey === identity(result.updateInfo)
        if (!ready) this.readyKey = undefined
        this.set({ status: ready ? 'ready' : 'available', version: result.updateInfo.version, progress: ready ? 100 : undefined })
      } else {
        this.offered = undefined; this.readyKey = undefined
        this.set({ status: 'idle', message: i18n.t('desktop:update.latest') })
      }
    } catch (error) {
      if (revision === this.revision && !this.stopped) {
        const message = this.failure(error, 'check')
        this.set(previous.status === 'ready' ? { ...previous, failedOperation: 'check', message } : { status: 'error', version: previous.version, failedOperation: 'check', message })
      }
    } finally {
      if (revision === this.revision) { clearTimeout(this.deadline); this.deadline = undefined; this.clearPulse() }
    }
  }

  async download(): Promise<void> {
    if (this.downloading) return this.downloading.task
    if (!this.offered || !(this.state.status === 'available' || this.state.status === 'error' && this.state.failedOperation === 'download')) throw new Error(i18n.t('desktop:update.checkFirst'))
    const version = this.offered.version
    if (process.platform === 'darwin') {
      await shell.openExternal(`https://github.com/bhwa233/galaxy-downloader-client/releases/tag/${version}`)
      this.set({ ...this.state, message: i18n.t('desktop:update.externalDownload') }); return
    }
    const active: NonNullable<Updates['downloading']> = { token: new electronUpdater.CancellationToken() }
    this.downloading = active
    const offeredKey = identity(this.offered)
    this.lastProgress = Date.now()
    this.firstProgress = 0
    this.set({ status: 'connecting', version, downloaded: 0 })
    this.clearPulse()
    this.pulse = setInterval(() => {
      const elapsed = Date.now() - this.lastProgress
      if (this.state.status === 'connecting' && elapsed >= SLOW_AFTER && !this.state.slow) this.set({ ...this.state, slow: true })
      if (this.state.status === 'downloading' && elapsed >= STALLED_AFTER && !this.state.waiting) this.set({ ...this.state, speed: 0, eta: undefined, waiting: true })
    }, 1_000)
    active.task = (async () => {
      try {
        await this.updater.downloadUpdate(active.token)
        if (!active.token.cancelled) {
          this.readyKey = offeredKey
          this.set({ status: 'ready', version, progress: 100 })
        } else this.set({ status: 'available', version, message: i18n.t('desktop:update.cancelled') })
      } catch (error) {
        if (active.token.cancelled) this.set({ status: 'available', version, message: i18n.t('desktop:update.cancelled') })
        else this.set({ ...this.state, status: 'error', speed: undefined, eta: undefined, slow: undefined, waiting: undefined,
          failedOperation: 'download', message: this.failure(error, 'download') })
      } finally {
        this.clearPulse()
        if (this.downloading === active) this.downloading = undefined
      }
    })()
    await active.task
  }
  async cancel(): Promise<void> {
    const active = this.downloading
    if (!active || active.token.cancelled) return
    this.set({ ...this.state, status: 'cancelling', speed: undefined, eta: undefined })
    active.token.cancel()
    await active.task
  }
  install(): void {
    if (this.state.status !== 'ready') throw new Error(i18n.t('desktop:update.notDownloaded'))
    if (this.busy()) throw new Error(i18n.t('desktop:update.pauseFirst'))
    this.updater.quitAndInstall()
  }
  stop(): void { this.stopped = true; this.revision += 1; this.clearPulse(); clearTimeout(this.deadline); this.downloading?.token.cancel() }
}
