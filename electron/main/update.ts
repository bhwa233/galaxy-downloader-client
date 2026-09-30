import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import type { ClientState } from '../../shared/contracts'
import { redact } from '../services/engine'
import { logger } from '../services/log'

export class Updates {
  state: ClientState['update'] = { status: 'idle' }
  private updater = electronUpdater.autoUpdater
  constructor(private changed: () => void, private busy: () => boolean) {
    this.updater.logger = logger('update')
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.on('checking-for-update', () => this.set({ status: 'checking' }))
    this.updater.on('update-available', info => this.set({ status: 'available', version: info.version }))
    this.updater.on('update-not-available', () => this.set({ status: 'idle', message: '已是最新版本' }))
    this.updater.on('download-progress', info => this.set({ ...this.state, status: 'downloading', progress: info.percent }))
    this.updater.on('update-downloaded', info => this.set({ status: 'ready', version: info.version }))
    this.updater.on('error', error => this.set({ status: 'error', message: redact(error.message) }))
  }
  private set(state: ClientState['update']): void { this.state = state; this.changed() }
  async check(): Promise<void> {
    if (!app.isPackaged) { this.set({ status: 'idle', message: '开发版不检查更新，正式版通过 GitHub Releases 更新应用和本地引擎。' }); return }
    if (['checking', 'downloading'].includes(this.state.status)) return
    await this.updater.checkForUpdates()
  }
  async download(): Promise<void> {
    if (this.state.status !== 'available') throw new Error('请先检查更新')
    // Unsigned mac builds cannot self-update, so hand the user the release page instead.
    if (process.platform === 'darwin') { await shell.openExternal(`https://github.com/bhwa233/galaxy-downloader-client/releases/tag/${this.state.version}`); return }
    await this.updater.downloadUpdate()
  }
  install(): void { if (this.state.status !== 'ready') throw new Error('更新尚未下载完成'); if (this.busy()) throw new Error('请先暂停下载任务再安装更新'); this.updater.quitAndInstall() }
}
