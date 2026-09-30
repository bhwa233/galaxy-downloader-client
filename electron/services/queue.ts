import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Job, MediaItem, Settings } from '../../shared/contracts'
import { Store } from './store'
import { asAccessDenied } from './access'
import { LoginRequired } from './login'
import { Engine, redact } from './engine'
import { downloadHttp, type Fetcher } from './http-download'
import { checkCover } from './cover'
import { logger } from './log'
import type { ParsePlan } from './parser'

const log = logger('queue')

// Adapted from src/utils/string-utils.ts without the remote image proxy imports.
// Cut by bytes, not characters: filesystems cap a name at 255 bytes and a Chinese character is three
// of them, so 100 characters of a 抖音 caption was already 300 (measured 2026-09-23: "File name too
// long" on every episode of a 短剧 whose caption is its synopsis). 150 leaves room for the id, the date
// and whatever the engine appends - '.part', '.f137', a subtitle language, the extension.
const NAME_BYTES = 150
function filename(title: string): string {
  let name = ''
  // eslint-disable-next-line no-control-regex -- Windows filenames must exclude ASCII control characters.
  for (const char of Array.from(title.replace(/[<>:"/\\|?*\x00-\x1f%]/g, '_').trim()).slice(0, 100)) {
    if (Buffer.byteLength(name + char) > NAME_BYTES) break
    name += char
  }
  return name.trim() || 'media'
}

// The name every file of a job is built from, which is the stem the engine is given. Shared with the
// removal path, because a job that never finished has files on disk that its own record never learnt
// about: the part file it was still writing, and the separate video and audio it had got as far as.
function stemOf(job: Job): string {
  const id = job.id.slice(0, 8)
  const name = job.filenameTemplate === 'id-title' ? `${id}-${filename(job.title)}`
    : job.filenameTemplate === 'date-title-id' ? `${job.createdAt.slice(0, 10)}-${filename(job.title)}-${id}`
    : `${filename(job.title)}-${id}`
  return path.join(job.directory, name)
}

// Where a job's files land. A collection or a multi-part video is one thing split into files, so its
// parts are kept together under a directory named after it - the same cleaning the filenames get, since
// the name comes from the same place. Stacked under the platform's directory rather than beside it, so
// both settings on gives '<下载目录>/<平台>/<合集名>/'. A single work has no collection and keeps to the
// directory it always used.
export function directoryFor(settings: Settings, plan: ParsePlan, item: MediaItem): string {
  const collection = settings.organizeByCollection
    ? plan.result.groups?.find(group => group.itemIds.includes(item.id))?.directory
    : undefined
  return path.join(settings.downloadDirectory,
    ...(settings.organizeByPlatform ? [filename(plan.result.platform)] : []),
    ...(collection ? [filename(collection)] : []))
}

// What a job should do about the cover, decided once when it is made. A picture post is skipped both
// ways: its cover is the work itself, so saving one would write the same picture twice, and an image
// file has no cover track to embed anything into.
export function thumbnailsFor(settings: Settings, kind: MediaItem['kind'], audioOnly: boolean): Pick<Job, 'saveThumbnail' | 'embedThumbnail' | 'thumbnailFormat'> {
  if (kind === 'image') return { saveThumbnail: false, embedThumbnail: false }
  return {
    saveThumbnail: settings.saveThumbnail,
    embedThumbnail: audioOnly ? settings.embedThumbnailInAudio : settings.embedThumbnailInVideo,
    thumbnailFormat: settings.thumbnailFormat,
  }
}

// Used when the subtitle language setting is left empty. Requesting every language would pull the
// dozens of machine translations YouTube offers for a single video.
const SUBTITLE_LANGUAGES: Record<Settings['locale'], string> = {
  zh: 'zh-Hans,zh-CN,zh,en', 'zh-tw': 'zh-Hant,zh-TW,zh,en', ja: 'ja,en', en: 'en',
}

// How long to leave a broken download alone before picking it up again, one wait per attempt. A CDN
// that has just cut a transfer off will cut the next one off too if it arrives immediately - the
// measured failure retried after five seconds three times and was refused each time, then succeeded
// on its own a minute later. Resuming costs almost nothing, so waiting is the cheaper move.
const RESUME_AFTER = [20_000, 60_000]

export class Queue {
  private running = new Map<string, AbortController>()
  // Breaks waiting to be picked up again, so that stopping or touching a job can call them off.
  private resuming = new Map<string, NodeJS.Timeout>()
  private stopping = false
  // 'trash' is injected because removing a file is the host's business, not this module's: it keeps
  // electron out of here, which is also what lets the queue be tested without one.
  constructor(private store: Store, private engine: Engine, private fetcher: Fetcher, private resolve: (job: Job, signal: AbortSignal) => Promise<ParsePlan>, private changed: () => void, private completed: (job: Job) => void = () => {}, private trash: (file: string) => Promise<void> = async () => {}) {}
  get jobs(): Job[] { return this.store.data.jobs }
  private log(job: Job, message: string): void {
    // The job's own log is what the window shows; the file keeps it beyond the last 150 lines and beside
    // everything else that happened at the time.
    log.info(`[${job.id.slice(0, 8)} ${job.platform}] ${message}`)
    job.logs = [...job.logs, `${new Date().toLocaleTimeString()} ${redact(message)}`].slice(-150)
  }

  // Queueing the same thing twice downloads it twice, and the two copies then compete for the same
  // CDN: two jobs on one 334 MiB video were measured starving each other down to 22 KiB/s until the
  // edge cut them both off. A job still to finish already covers the request, so it is left to do it.
  // 'audioOnly' belongs in the key: asking for the audio of a video that is downloading right now is
  // the same address and the same item, and only this tells the two apart. The files cannot collide -
  // every stem carries eight characters of the job's own id.
  // A cover is a third thing to want of the same post, told apart the same way.
  private pending(url: string, itemId: string, audioOnly: boolean, coverOnly = false): boolean {
    return this.jobs.some(job => job.url === url && job.itemId === itemId && job.audioOnly === audioOnly && Boolean(job.coverOnly) === coverOnly && ['queued', 'running', 'paused'].includes(job.status))
  }

  // One call, one batch. The batch is only worth naming when it holds more than one task: a single
  // download has nothing to be grouped with and a header above it would be noise.
  enqueue(plan: ParsePlan, items: MediaItem[], format: string, audioOnly: boolean, coverOnly = false): number {
    const settings = this.store.data.settings
    // Only what has a cover to save, when covers are all that is wanted.
    const wanted = coverOnly ? items.filter(item => item.thumbnail && /^https?:\/\//i.test(item.thumbnail)) : items
    const batchId = wanted.length > 1 ? randomUUID() : undefined
    // Named for what it holds when that is not the media itself, so a video batch and its audio or
    // cover batch beside it in the task list can be told apart.
    const batchTitle = coverOnly ? `${plan.result.title} · 封面` : audioOnly ? `${plan.result.title} · 音频` : plan.result.title
    let added = 0
    for (const item of wanted) {
      const source = plan.sources.get(item.id)
      // Every item of a listing is a post with a page of its own, so the job is made against that page
      // rather than against the listing it was picked from.
      const url = plan.result.listing && source?.kind === 'engine' ? source.request.url! : plan.result.url
      const itemId = plan.result.listing ? '*' : item.id
      const wantsAudio = !coverOnly && item.kind !== 'image' && audioOnly
      if (this.pending(url, itemId, wantsAudio, coverOnly)) continue
      added += 1
      this.jobs.unshift({
        id: randomUUID(), url, itemId, coverOnly: coverOnly || undefined,
        title: item.title, platform: plan.result.platform, method: plan.result.method,
        kind: coverOnly || item.kind === 'image' ? 'image' : audioOnly ? 'audio' : item.kind, thumbnail: item.thumbnail, duration: coverOnly ? undefined : item.duration,
        views: item.views, danmaku: item.danmaku, comments: item.comments, likes: item.likes, author: item.author, publishedAt: item.publishedAt,
        format: coverOnly || item.kind === 'image' ? 'best' : format, audioOnly: wantsAudio,
        speedLimit: settings.taskSpeedLimit, filenameTemplate: settings.filenameTemplate, videoQuality: settings.videoQuality, audioFormat: settings.audioFormat,
        subtitles: settings.subtitles, subtitleLanguages: settings.subtitleLanguages || SUBTITLE_LANGUAGES[settings.locale], subtitleAutoGenerated: settings.subtitleAutoGenerated,
        ...(coverOnly ? {} : thumbnailsFor(settings, item.kind, wantsAudio)),
        status: 'queued', progress: 0, files: [],
        directory: directoryFor(settings, plan, item),
        batchId, batchTitle: batchId ? batchTitle : undefined,
        createdAt: new Date().toISOString(), logs: [],
      })
    }
    this.persist(); this.pump()
    return added
  }
  action(id: string, action: 'pause' | 'resume' | 'retry' | 'cancel'): void {
    const job = this.jobs.find(item => item.id === id)
    if (!job) throw new Error('下载任务不存在')
    // Whatever the user just asked for replaces a wait the client had scheduled for itself.
    this.forget(id)
    if (action === 'pause' || action === 'cancel') {
      if (job.status === 'completed') throw new Error('已完成的任务不能暂停或取消')
      job.status = action === 'pause' ? 'paused' : 'cancelled'
      job.speed = undefined; job.eta = undefined
      this.running.get(id)?.abort()
    } else {
      if (this.running.has(id)) throw new Error('任务正在停止，请稍后重试')
      if (!['paused', 'failed', 'cancelled'].includes(job.status)) throw new Error('当前任务不能重试')
      // Asking by hand starts the automatic attempts over: this break is being treated as a new one.
      job.status = 'queued'; job.error = undefined; job.attempts = undefined
    }
    this.log(job, { pause: '任务已暂停', cancel: '任务已取消，保留部分文件', resume: '任务等待继续下载', retry: '任务等待重新尝试' }[action])
    this.persist(); this.pump()
  }
  // One cover, saved because the user asked for it rather than because a setting said so. It does not
  // go through the engine: the address is already on the job record, which is why this still works
  // after a restart, when the parse that produced it is long gone. Allowed whatever state the job is
  // in - the picture has nothing to do with whether the media finished, and 复制链接 is no stricter.
  async thumbnail(id: string): Promise<void> {
    const job = this.jobs.find(item => item.id === id)
    if (!job) throw new Error('下载任务不存在')
    if (!job.thumbnail || !/^https?:\/\//i.test(job.thumbnail)) throw new Error('这个任务没有记录封面地址')
    const extension = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i.exec(job.thumbnail)?.[1]?.toLowerCase() || 'jpg'
    await mkdir(job.directory, { recursive: true })
    // Beside the job's own files and sharing their stem, so it is cleaned up with them and reads as
    // belonging to this task rather than as a loose picture in the download folder.
    const file = `${stemOf(job)}-cover.${extension === 'jpeg' ? 'jpg' : extension}`
    const saved = await checkCover(await downloadHttp(this.fetcher, job.thumbnail, file, [], {}, AbortSignal.timeout(60_000), () => {}))
    if (!job.files.includes(saved)) job.files.push(saved)
    this.log(job, '已保存封面')
    this.persist()
  }

  // A second job for the same post, audio only. The address and the item are the ones this job already
  // resolved, so nothing is re-parsed here: the new job pays for its own extraction when it runs, and
  // a parse that fails - deleted, gated, or changed since - fails as that job's error rather than as a
  // dialog with nothing behind it. The job it was asked on is not touched.
  audio(id: string): void {
    const source = this.jobs.find(item => item.id === id)
    if (!source) throw new Error('下载任务不存在')
    if (source.audioOnly) throw new Error('这已经是一个音频任务')
    if (source.kind === 'image') throw new Error('图文作品没有可下载的音频')
    if (this.pending(source.url, source.itemId, true)) throw new Error('这个作品的音频已在下载队列中')
    const settings = this.store.data.settings
    this.jobs.unshift({
      ...source,
      id: randomUUID(), status: 'queued', progress: 0, files: [], logs: [], error: undefined, attempts: undefined,
      speed: undefined, eta: undefined, downloaded: undefined, total: undefined, completedAt: undefined,
      kind: 'audio', audioOnly: true, format: 'best', audioFormat: settings.audioFormat,
      // An audio file has nowhere to put a subtitle track, and its cover follows the audio setting.
      subtitles: 'off', ...thumbnailsFor(settings, source.kind || 'video', true),
      createdAt: new Date().toISOString(),
    })
    this.log(this.jobs[0], '按原任务追加的音频下载')
    this.persist(); this.pump()
  }

  // Without a batchId this is the whole list, which is what 开始全部 / 暂停全部 have always been; with
  // one it is that batch. Either way every task keeps its own controls - a batch action is a shortcut
  // for doing the same thing to each of them, not a state the tasks lose their own say in.
  // The other media files of a post that turned out to hold several, each as a task of its own. They
  // join the batch the post came in with, or start one with it - a post that split into nine pictures
  // is a batch by any reading, even when the user only ticked one row.
  private split(source: Job, rest: MediaItem[]): void {
    const batchId = source.batchId || randomUUID()
    if (!source.batchId) { source.batchId = batchId; source.batchTitle = source.batchTitle || source.title }
    for (const item of rest) {
      if (this.pending(source.url, item.id, source.audioOnly)) continue
      this.jobs.unshift({
        ...source,
        id: randomUUID(), itemId: item.id, title: item.title,
        kind: item.kind === 'image' ? 'image' : source.audioOnly ? 'audio' : item.kind,
        thumbnail: item.thumbnail || source.thumbnail, duration: item.duration,
        // A picture is never an audio conversion and never carries a quality choice.
        audioOnly: item.kind !== 'image' && source.audioOnly, format: item.kind === 'image' ? 'best' : source.format,
        batchId, batchTitle: source.batchTitle || source.title,
        status: 'queued', progress: 0, files: [], logs: [], error: undefined, attempts: undefined,
        speed: undefined, eta: undefined, downloaded: undefined, total: undefined, completedAt: undefined,
        createdAt: new Date().toISOString(),
      })
      this.log(this.jobs[0], '作品中的一个媒体文件')
    }
  }

  async batch(action: 'pause' | 'resume' | 'retry' | 'cancel' | 'remove', batchId?: string, deleteFiles = false): Promise<void> {
    const targets = batchId ? this.jobs.filter(job => job.batchId === batchId) : [...this.jobs]
    if (batchId && !targets.length) throw new Error('这一批任务已经不存在')
    if (action === 'remove') {
      for (const job of targets) { this.forget(job.id); this.running.get(job.id)?.abort(); job.status = 'cancelled' }
      const removed = new Set(targets.map(job => job.id))
      this.store.data.jobs = this.jobs.filter(job => !removed.has(job.id))
      this.persist()
      if (deleteFiles) await Promise.allSettled(targets.map(job => this.discard(job)))
      return
    }
    // Mutate the entire batch before pumping so pausing cannot start a waiting job.
    for (const job of targets) {
      // Whatever is being asked for replaces a wait the client had scheduled for itself.
      this.forget(job.id)
      if (action === 'pause' && ['queued', 'running'].includes(job.status)) {
        job.status = 'paused'; job.speed = undefined; job.eta = undefined
        this.running.get(job.id)?.abort(); this.log(job, '任务已暂停')
      } else if (action === 'cancel' && ['queued', 'running', 'paused'].includes(job.status)) {
        job.status = 'cancelled'; job.speed = undefined; job.eta = undefined
        this.running.get(job.id)?.abort(); this.log(job, '任务已取消，保留部分文件')
      } else if (action === 'resume' && ['paused', 'failed'].includes(job.status)) {
        job.status = 'queued'; job.error = undefined; this.log(job, '任务等待继续下载')
      } else if (action === 'retry' && ['paused', 'failed', 'cancelled'].includes(job.status)) {
        // Asking by hand starts the automatic attempts over, exactly as it does for one task. A job
        // whose abort has not finished unwinding is queued anyway rather than quietly skipped: pump
        // will not start it while it is still in 'running', and picks it up when that clears.
        job.status = 'queued'; job.error = undefined; job.attempts = undefined; this.log(job, '任务等待重新尝试')
      }
    }
    this.persist(); this.pump()
  }
  limit(id: string, speedLimit: number): void {
    const job = this.jobs.find(item => item.id === id)
    if (!job) throw new Error('下载任务不存在')
    if (job.status === 'running') throw new Error('请先暂停任务再修改限速')
    job.speedLimit = speedLimit; this.persist()
  }
  restartActive(): void {
    for (const job of this.jobs) if (job.status === 'running') { job.status = 'queued'; this.running.get(job.id)?.abort(); this.log(job, '下载参数已更新，等待继续') }
    this.persist(); this.pump()
  }
  // One record, gone. A job still working is stopped first: asking for it to be removed is asking for
  // it to stop, and leaving it running against a record that no longer exists would strand it.
  async remove(id: string, deleteFiles = false): Promise<void> {
    const job = this.jobs.find(item => item.id === id)
    if (!job) throw new Error('下载任务不存在')
    this.forget(id)
    this.running.get(id)?.abort()
    job.status = 'cancelled'
    this.store.data.jobs = this.jobs.filter(item => item.id !== id)
    this.persist()
    if (deleteFiles) await this.discard(job)
  }

  async clear(deleteFiles = false): Promise<void> {
    const kept = this.jobs.filter(job => ['running', 'queued', 'paused'].includes(job.status))
    const dropped = this.jobs.filter(job => !kept.includes(job))
    // A break waiting to be resumed belongs to a job that is about to stop existing.
    for (const job of dropped) this.forget(job.id)
    this.store.data.jobs = kept
    this.persist()
    // The list is cleared either way; the files only when that was asked for as well.
    if (deleteFiles) await Promise.allSettled(dropped.map(job => this.discard(job)))
  }

  // What a removed job left on disk: the files it recorded, plus anything in its own directory that
  // its stem produced. The stem carries eight characters of the job's id, so nothing that did not come
  // from this job can match it, and nothing outside its directory is ever looked at.
  private async discard(job: Job): Promise<void> {
    const stem = path.basename(stemOf(job))
    const found = await readdir(job.directory).catch(() => [] as string[])
    const targets = new Set([...job.files, ...found.filter(entry => entry.startsWith(stem)).map(entry => path.join(job.directory, entry))])
    // Sent to the trash rather than unlinked: the record is gone from the client either way, and a
    // file removed by a checkbox is one a user can still want back.
    for (const file of targets) await this.trash(file).catch(() => {})
    // A collection's own directory goes with its last task, and only then: rmdir refuses a directory
    // that still holds anything, which is exactly the condition wanted. Never the download directory
    // itself, which is the user's and was not made by this client.
    if (path.resolve(job.directory) !== path.resolve(this.store.data.settings.downloadDirectory)) await rmdir(job.directory).catch(() => {})
  }
  private persist(): void { this.store.save(); this.changed() }
  stop(): void {
    this.stopping = true
    for (const id of [...this.resuming.keys()]) this.forget(id)
    for (const controller of this.running.values()) controller.abort()
    this.store.save()
  }
  // A download that broke is picked up again on its own. It is safe to do so because it resumes: the
  // engine keeps the part file and the output path is the same every time, so an attempt costs the
  // bytes still missing rather than the whole file. The job stays 'failed' while it waits, which is
  // what the user sees, and says in its error when it will try again.
  private resumeLater(job: Job): void {
    const attempt = job.attempts || 0
    const wait = RESUME_AFTER[attempt]
    if (wait === undefined) return
    job.attempts = attempt + 1
    job.error = `${job.error || '下载中断'}（${Math.round(wait / 1000)} 秒后自动续传，第 ${job.attempts}/${RESUME_AFTER.length} 次）`
    this.forget(job.id)
    this.resuming.set(job.id, setTimeout(() => {
      this.resuming.delete(job.id)
      // Anything the user did in the meantime wins: only a job still sitting where it broke is taken.
      if (this.stopping || job.status !== 'failed') return
      job.status = 'queued'; job.error = undefined
      this.log(job, '自动续传'); this.persist(); this.pump()
    }, wait))
  }

  private forget(id: string): void {
    const timer = this.resuming.get(id)
    if (timer) { clearTimeout(timer); this.resuming.delete(id) }
  }

  pump(): void {
    if (this.stopping) return
    for (const job of [...this.jobs].reverse()) {
      if (this.running.size >= this.store.data.settings.concurrency) break
      if (job.status !== 'queued' || this.running.has(job.id)) continue
      const controller = new AbortController()
      this.running.set(job.id, controller)
      job.status = 'running'; job.speed = undefined; job.eta = undefined
      this.log(job, '正在解析作品并准备下载'); this.persist()
      void this.execute(job, controller.signal).catch(error => {
        if (controller.signal.aborted) return
        // A permission wall is not a broken transfer. Saying which wall it is beats the engine's own
        // wording, and waiting twenty seconds to run into the same wall again helps nobody - the
        // account's entitlement is not going to change while the client counts.
        const denied = asAccessDenied(error)
        job.status = 'failed'; job.error = denied ? denied.message : redact(String(error)); this.log(job, job.error)
        job.wall = denied?.wall ?? (error instanceof LoginRequired ? 'login' : undefined)
        if (!denied) this.resumeLater(job)
      }).finally(() => { this.running.delete(job.id); job.speed = undefined; job.eta = undefined; this.persist(); this.pump() })
    }
  }
  private async execute(job: Job, signal: AbortSignal): Promise<void> {
    const settings = { ...this.store.data.settings }
    const budget = settings.speedLimit ? settings.speedLimit / settings.concurrency : Infinity
    const rate = Math.min(budget, job.speedLimit || Infinity)
    const speedLimit = Number.isFinite(rate) ? Math.max(1, Math.floor(rate * 1024)) : 0
    // A cover task already holds the one address it needs; the post is not resolved again for it.
    if (job.coverOnly) {
      if (!job.thumbnail || !/^https?:\/\//i.test(job.thumbnail)) throw new Error('这个作品没有封面地址')
      const extension = /\.(jpe?g|png|webp|gif|avif)(\?|$|@)/i.exec(new URL(job.thumbnail).pathname)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'jpg'
      await mkdir(job.directory, { recursive: true })
      job.files = [await checkCover(await downloadHttp(this.fetcher, job.thumbnail, `${stemOf(job)}.${extension}`, [], {}, signal, value => { job.progress = value; this.changed() }, { speedLimit, retries: settings.retries, timeout: settings.timeout }))]
      signal.throwIfAborted()
      const bytes = (await stat(job.files[0])).size
      job.status = 'completed'; job.progress = 1; job.attempts = undefined
      job.downloaded = bytes; job.total = bytes; job.completedAt = new Date().toISOString()
      this.log(job, '封面已保存'); this.completed(job)
      return
    }
    const plan = await this.resolve(job, signal)
    signal.throwIfAborted()
    let items = job.itemId === '*' ? plan.result.items : plan.result.items.filter(item => item.id === job.itemId)
    if (!items.length) throw new Error('内容已变化，请重新解析')
    // 2.4: one media file, one task. A listing hands over a post, not a file count - a 抖音 图文 holds
    // nine pictures and says so nowhere until it is parsed - so the split can only happen here, the
    // first time anyone knows. This task keeps the first file and hands the rest to tasks of their
    // own, in the same batch, each of which resolves the same post from the parse cache rather than
    // parsing it again. Every one of them is then a row the user can pause, retry or delete.
    if (job.itemId === '*' && items.length > 1) {
      this.split(job, items.slice(1))
      items = [items[0]]
      job.itemId = items[0].id
      job.title = items[0].title
      job.kind = items[0].kind === 'image' ? 'image' : job.audioOnly ? 'audio' : items[0].kind
      job.thumbnail = items[0].thumbnail || job.thumbnail
    }
    await mkdir(job.directory, { recursive: true })
    const base = stemOf(job)
    let lastProgress = 0
    let completedBytes = 0
    job.files = []
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted()
      const source = plan.sources.get(item.id)
      // A whole collection is expanded before it is queued and is never a task's file.
      if (!source || source.kind === 'collection') throw new Error('内容已变化，请重新解析')
      const stem = `${base}${items.length > 1 ? `-${index + 1}` : ''}`
      const progress = (value: number, stats?: { downloaded: number; total: number; speed?: number; eta?: number }) => {
        job.progress = (index + value) / items.length
        if (stats) { job.downloaded = completedBytes + stats.downloaded; job.total = items.length === 1 ? stats.total || undefined : undefined; job.speed = stats.speed; job.eta = items.length === 1 ? stats.eta : undefined }
        if (Date.now() - lastProgress > 250 || value === 1) { lastProgress = Date.now(); this.changed() }
      }
      this.log(job, `开始下载第 ${index + 1} / ${items.length} 个文件`)
      if (source.kind === 'http' && !(job.audioOnly && item.kind === 'video')) {
        job.files.push(await downloadHttp(this.fetcher, source.url, `${stem}.${source.extension}`, source.cookies, source.headers, signal, progress, { speedLimit, retries: settings.retries, timeout: settings.timeout }))
      } else {
        // A tier this video does not have - one picked off a listing's first video, which a later video
        // lacks - is downloaded at the best this video has rather than failing the task.
        const selected = item.formats.find(format => format.id === job.format)
        if (job.format !== 'best' && !selected) this.log(job, `这个视频没有所选的画质档位，改按最高画质下载`)
        const height = job.videoQuality && job.videoQuality !== 'best' ? `[height<=${job.videoQuality}]` : ''
        const best = `bv*${height}+ba/b${height}`
        // The tier's own format first; should the platform refuse it at download time, the best instead.
        const format = !selected ? best : selected.audioOnly ? job.format : `${job.format}+ba/${job.format}/${best}`
        const request = source.kind === 'engine' ? source.request : { operation: 'download' as const, url: source.url, cookies: source.cookies, headers: source.headers }
        const output = await this.engine.request<{ files: string[] }>({ ...request, format, audioOnly: job.audioOnly, audioFormat: job.audioFormat, speedLimit, retries: settings.retries, timeout: settings.timeout, output: `${stem}.%(ext)s`,
          subtitles: job.subtitles, subtitleLanguages: job.subtitleLanguages, subtitleAutoGenerated: job.subtitleAutoGenerated,
          saveThumbnail: job.saveThumbnail, embedThumbnail: job.embedThumbnail, thumbnailFormat: job.thumbnailFormat }, signal, event => {
          if (event.kind === 'progress') progress(event.total ? Math.min(0.99, (event.downloaded || 0) / event.total) : 0, { downloaded: event.downloaded || 0, total: event.total || 0, speed: event.speed, eta: event.eta })
          if (event.kind === 'log' && event.message) this.log(job, event.message)
        })
        if (!output.files.length) throw new Error('引擎没有返回已保存的文件')
        for (const file of output.files) {
          if (path.dirname(path.resolve(file)) !== path.resolve(job.directory) || !path.basename(file).startsWith(path.basename(stem))) throw new Error('下载文件路径不匹配')
          if (!(await stat(file)).isFile()) throw new Error('下载文件不存在')
        }
        job.files.push(...output.files)
      }
      completedBytes = (await Promise.all(job.files.map(file => stat(file)))).reduce((sum, file) => sum + file.size, 0)
      progress(1)
    }
    signal.throwIfAborted()
    job.method = plan.result.method; job.status = 'completed'; job.progress = 1; job.attempts = undefined
    job.downloaded = completedBytes; job.total = completedBytes; job.completedAt = new Date().toISOString()
    this.log(job, '下载完成'); this.completed(job)
  }
}
