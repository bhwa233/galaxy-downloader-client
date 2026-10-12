import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { settingsSchema, type HistoryEntry, type Settings, type Job } from '../../shared/contracts'

// 'history' arrived after version 1 was already on disk, so it is optional in what is read back.
type StoredState = { version: 1; settings: Settings; jobs: Job[]; history: HistoryEntry[] }

// The app has one main-process writer. Atomic replace is sufficient for this local settings/queue store.
export class Store {
  data: StoredState
  private file: string
  // 'locale' is the language a first start takes, before anything has been saved: the system's.
  constructor(directory: string, downloadDirectory: string, locale: Settings['locale'] = 'zh') {
    mkdirSync(directory, { recursive: true })
    this.file = path.join(directory, 'state.json')
    this.data = { version: 1, settings: { ...settingsSchema.parse({}), locale, downloadDirectory }, jobs: [], history: [] }
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as StoredState
      if (saved.version !== 1 || !Array.isArray(saved.jobs)) throw new Error('Unsupported saved state')
      this.data.settings = { ...settingsSchema.parse(saved.settings), downloadDirectory: typeof saved.settings.downloadDirectory === 'string' ? saved.settings.downloadDirectory : downloadDirectory }
      this.data.history = Array.isArray(saved.history) ? saved.history.filter(entry => typeof entry?.url === 'string' && typeof entry.title === 'string') : []
      this.data.jobs = saved.jobs.filter(job => typeof job.id === 'string' && typeof job.url === 'string').map(job => {
        // Older profile jobs stored a position in the listing; retain the original post instead.
        const profileJob = job.sourceUrl && /^https?:/.test(job.sourceUrl) && /(?:\/user\/(?:profile\/)?|space\.bilibili\.com\/|bilibili\.com\/space\/)/.test(job.url)
        return { ...job, url: profileJob ? job.sourceUrl! : job.url, itemId: profileJob ? '*' : job.itemId, sourceUrl: undefined,
          // Jobs saved before the Chrome CDP route became the client's own browser session.
          method: (job.method as string) === 'chrome' ? 'browser' : job.method,
          kind: job.kind || (job.audioOnly ? 'audio' : 'video'), speed: undefined, eta: undefined, logs: job.logs || [],
          status: job.status === 'running' || job.status === 'queued' ? (this.data.settings.resumeOnStart ? 'queued' : 'paused') : job.status }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try { renameSync(this.file, `${this.file}.recovery-${Date.now()}`) } catch { /* Preserve startup when the disk is unavailable. */ }
      }
    }
    this.save()
  }
  save(): void {
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
