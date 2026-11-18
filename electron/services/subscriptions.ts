import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Settings } from '../../shared/contracts'
import { i18n } from '../../shared/i18n'
import { subscriptionItemSchema, subscriptionPlatforms, subscriptionSourceSchema, type SubscriptionCandidate, type SubscriptionItem, type SubscriptionSource, type SubscriptionState, type SubscriptionType } from '../../shared/subscriptions'
import type { ResolvedSubscription, SubscriptionEntry, SubscriptionReader } from './subscription-sources'
import { LoginRequired, VerificationRequired } from './login'
import { redact } from './engine'
import { logger } from './log'

const log = logger('subscriptions')
const checkpoint = z.object({ page: z.number().int().min(2).max(500), boundary: z.array(z.string()) })
const storedSource = subscriptionSourceSchema.extend({
  aliases: z.array(z.string()).default([]),
  seen: z.record(z.string(), z.array(z.string())),
  checkpoints: z.record(z.string(), checkpoint),
  retryAt: z.number().optional(),
})
const summary = z.object({ succeeded: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() })
const polling = z.object({
  nextCheckAt: z.number(), lastCheckedAt: z.number().optional(), result: summary.optional(),
  round: summary.extend({ startedAt: z.number(), pending: z.array(z.string().uuid()), total: z.number().int().nonnegative() }).optional(),
})
const stored = z.object({ version: z.literal(1), sources: z.array(storedSource), items: z.array(subscriptionItemSchema), schedule: polling.optional() })
type StoredSource = z.infer<typeof storedSource>
type CheckOutcome = 'succeeded' | 'failed' | 'skipped' | 'partial' | 'interrupted'
const HOUR = 3_600_000
const PAGES_PER_PASS = 5

export class Subscriptions {
  private data: z.infer<typeof stored> & { schedule: z.infer<typeof polling> }
  private file: string
  private candidates = new Map<string, { at: number; value: ResolvedSubscription }>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private resolving = 0
  private active?: { id: string; controller: AbortController }
  private pending = new Set<string>()
  private stopped = true
  private interval: number
  private focus?: SubscriptionState['focus']
  private resolveLogin?: SubscriptionState['resolveLogin']
  constructor(
    directory: string, private reader: SubscriptionReader, private settings: () => Settings,
    private changed: () => void, private notify: (source: SubscriptionSource, items: SubscriptionItem[]) => void,
    private busy: () => boolean,
  ) {
    mkdirSync(directory, { recursive: true })
    this.file = path.join(directory, 'subscriptions.json')
    this.interval = settings().subscriptionIntervalHours
    let loaded: z.infer<typeof stored> = { version: 1, sources: [], items: [] }
    try {
      loaded = stored.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Preserving unreadable subscription store', error)
        try { renameSync(this.file, this.file + '.recovery-' + Date.now()) } catch { /* Keep the original if the disk is unavailable. */ }
      }
    }
    const deadlines = loaded.sources.filter(source => source.enabled).map(source => source.nextCheckAt)
    this.data = { ...loaded, schedule: loaded.schedule || { nextCheckAt: deadlines.length ? Math.min(...deadlines) : Date.now() + this.interval * HOUR } }
    for (const source of this.data.sources) {
      if (source.status === 'checking') { source.status = 'idle'; source.retryAt = Date.now() }
      if (source.retryAt === undefined && Object.keys(source.checkpoints).length && ['idle', 'partial'].includes(source.status)) source.retryAt = loaded.schedule ? Date.now() : source.nextCheckAt
    }
  }
  state(): SubscriptionState {
    const { nextCheckAt, lastCheckedAt, result, round } = this.data.schedule
    return { sources: this.data.sources.map(source => this.publicSource(source)),
      items: this.data.items, checking: Boolean(this.active || round), focus: this.focus, resolveLogin: this.resolveLogin,
      schedule: { nextCheckAt, lastCheckedAt, result, progress: round ? { completed: round.succeeded + round.failed + round.skipped, total: round.total } : undefined } }
  }
  private publicSource(source: StoredSource): SubscriptionSource {
    return subscriptionSourceSchema.parse({ ...source, nextCheckAt: source.retryAt ?? this.data.schedule.nextCheckAt })
  }
  private save(): void {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
    this.changed()
  }
  private source(id: string): StoredSource {
    const source = this.data.sources.find(source => source.id === id)
    if (!source) throw new Error(i18n.t('subscriptions:errors.sourceMissing'))
    return source
  }
  item(id: string): SubscriptionItem {
    const item = this.data.items.find(item => item.id === id)
    if (!item) throw new Error(i18n.t('subscriptions:errors.itemMissing'))
    return item
  }
  sourceFor(id: string): SubscriptionSource { return this.publicSource(this.source(id)) }
  start(): void { this.stopped = false; this.settleRound(); this.save(); this.schedule() }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.active?.controller.abort() }
  interrupt(): void { this.active?.controller.abort() }
  focusSource(id: string): void { this.source(id); this.focus = { token: randomUUID(), sourceId: id }; this.changed() }
  reschedule(): void {
    const next = this.settings().subscriptionIntervalHours
    if (next !== this.interval) {
      const anchor = this.data.schedule.round?.startedAt || this.data.schedule.lastCheckedAt || Date.now()
      this.data.schedule.nextCheckAt = anchor + next * HOUR
      this.interval = next
      this.save()
    }
    this.schedule()
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (this.stopped || this.running) return
    const enabled = this.data.sources.filter(source => source.enabled)
    const round = this.data.schedule.round
    const deadlines = enabled.flatMap(source => this.pending.has(source.id) || round?.pending.includes(source.id)
      ? [this.pending.has(source.id) ? Date.now() : source.retryAt ?? Date.now()] : source.retryAt !== undefined ? [source.retryAt] : [])
    if (!round && enabled.length && this.settings().subscriptionAutomatic) deadlines.push(this.data.schedule.nextCheckAt)
    if (!deadlines.length) return
    const next = Math.min(...deadlines)
    // A short heartbeat also catches sleep/wake and clock changes without a renderer timer.
    this.timer = setTimeout(() => this.drain(), this.busy() || this.resolving ? 10_000 : Math.min(60_000, Math.max(100, next - Date.now())))
    this.timer.unref()
  }
  check(id?: string): void {
    if (id) { if (this.source(id).enabled) this.pending.add(id) }
    else this.beginRound()
    this.drain()
  }
  private beginRound(): void {
    if (this.data.schedule.round) return
    const sources = this.data.sources.filter(source => source.enabled)
    if (!sources.length) return
    // Reuse the existing serialized reader and its page checkpoints. Only the shared cadence and
    // unfinished round are stored here, so an interruption cannot restart already completed authors.
    const now = Date.now()
    this.data.schedule.nextCheckAt = now + this.interval * HOUR
    this.data.schedule.round = { startedAt: now, pending: sources.map(source => source.id), total: sources.length, succeeded: 0, failed: 0, skipped: 0 }
    for (const source of sources) { delete source.retryAt; this.pending.delete(source.id) }
    this.save()
  }
  private settleRound(): void {
    const round = this.data.schedule.round
    if (!round) return
    round.pending = round.pending.filter(id => {
      if (this.data.sources.some(source => source.id === id && source.enabled)) return true
      round.skipped += 1
      return false
    })
    if (round.pending.length) return
    this.data.schedule.lastCheckedAt = Date.now()
    this.data.schedule.result = { succeeded: round.succeeded, failed: round.failed, skipped: round.skipped }
    if (this.data.schedule.nextCheckAt <= Date.now()) this.data.schedule.nextCheckAt = Date.now() + this.interval * HOUR
    delete this.data.schedule.round
  }
  private drain(): void {
    if (this.stopped || this.running) return
    if (this.busy() || this.resolving) { this.schedule(); return }
    this.running = this.run().catch(error => log.error('Subscription check failed', error)).finally(() => {
      this.running = undefined; this.changed(); this.schedule()
    })
  }
  private async run(): Promise<void> {
    if (this.settings().subscriptionAutomatic && this.data.schedule.nextCheckAt <= Date.now()) this.beginRound()
    this.settleRound()
    for (const source of [...this.data.sources]) {
      if (this.stopped || this.busy() || this.resolving) break
      if (!source.enabled || !this.data.sources.includes(source)) continue
      const requested = this.pending.delete(source.id)
      const member = this.data.schedule.round?.pending.includes(source.id)
      const retryDue = source.retryAt !== undefined && source.retryAt <= Date.now()
      if (!requested && !(member && (source.retryAt === undefined || retryDue)) && !retryDue) continue
      const outcome = await this.checkOne(source)
      const round = this.data.schedule.round
      if (round?.pending.includes(source.id) && (outcome === 'succeeded' || outcome === 'failed' || outcome === 'skipped')) {
        round.pending = round.pending.filter(id => id !== source.id)
        round[outcome] += 1
      }
      this.settleRound(); this.save()
    }
  }
  async resolve(url: string): Promise<SubscriptionCandidate> {
    this.interrupt()
    this.resolving += 1
    this.resolveLogin = undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(i18n.t('subscriptions:errors.timeout'))), 180_000)
    try {
      const identity = this.reader.identify(url)
      if (this.data.sources.some(source => source.platform === identity.platform && (source.accountId === identity.accountId || source.url === identity.url || source.aliases.includes(identity.url)))) throw new Error(i18n.t('subscriptions:errors.duplicate'))
      const value = await this.reader.resolve(url, controller.signal)
      if (this.data.sources.some(source => source.platform === value.source.platform && source.accountId === value.source.accountId)) throw new Error(i18n.t('subscriptions:errors.duplicate'))
      for (const [token, candidate] of this.candidates) if (Date.now() - candidate.at > 600_000) this.candidates.delete(token)
      if (this.candidates.size >= 8) this.candidates.delete(this.candidates.keys().next().value!)
      const token = randomUUID()
      this.candidates.set(token, { at: Date.now(), value })
      return { token, ...value.source, types: [...subscriptionPlatforms[value.source.platform].types],
        recent: Object.values(value.pages).flatMap(page => page.entries).slice(0, 5).map(({ title, thumbnail, type }) => ({ title, thumbnail, type })) }
    } catch (error) {
      if (error instanceof LoginRequired || error instanceof VerificationRequired) {
        const target = new URL(url)
        target.search = ''; target.hash = ''
        this.resolveLogin = { url: target.href, verify: error instanceof VerificationRequired }
        this.changed()
      }
      throw error
    } finally { clearTimeout(timer); this.resolving -= 1; this.schedule() }
  }
  add(token: string, types: SubscriptionType[], notify: boolean): void {
    const candidate = this.candidates.get(token)
    if (!candidate || Date.now() - candidate.at > 600_000) throw new Error(i18n.t('subscriptions:errors.candidateExpired'))
    const { source: identity, pages } = candidate.value
    if (this.data.sources.some(source => source.platform === identity.platform && source.accountId === identity.accountId)) throw new Error(i18n.t('subscriptions:errors.duplicate'))
    const allowed: readonly string[] = subscriptionPlatforms[identity.platform].types
    if (types.some(type => !allowed.includes(type))) throw new Error(i18n.t('subscriptions:errors.contentType'))
    const now = Date.now()
    const source: StoredSource = { ...identity, id: randomUUID(), types: [...new Set(types)], enabled: true, notify,
      status: 'ready', createdAt: now, lastCheckedAt: now, lastSuccessAt: now, nextCheckAt: this.data.schedule.nextCheckAt, seen: {}, checkpoints: {}, aliases: candidate.value.aliases || [] }
    // The baseline and its already-read items commit together. Historic works never trigger alerts.
    for (const stream of this.reader.streams(source, source.types)) {
      const entries = pages[stream.key]?.entries || []
      source.seen[stream.key] = entries.map(entry => entry.id)
      for (const entry of entries) if (source.types.includes(entry.type)) this.insert(source, entry, true)
    }
    source.latestTitle = Object.values(pages).flatMap(page => page.entries).find(entry => types.includes(entry.type))?.title
    this.data.sources.unshift(source)
    this.candidates.delete(token)
    this.save(); this.schedule()
  }
  update(id: string, patch: { enabled?: boolean; notify?: boolean }): void {
    const source = this.source(id)
    if (patch.enabled !== undefined) {
      source.enabled = patch.enabled
      if (!source.enabled && this.active?.id === id) this.interrupt()
      if (source.enabled) this.pending.add(id)
      else { this.pending.delete(id); delete source.retryAt }
    }
    if (patch.notify !== undefined) source.notify = patch.notify
    this.settleRound(); this.save(); this.schedule()
  }
  remove(id: string): void {
    this.source(id)
    if (this.active?.id === id) this.interrupt()
    this.pending.delete(id)
    this.data.sources = this.data.sources.filter(source => source.id !== id)
    this.data.items = this.data.items.filter(item => item.sourceId !== id)
    if (this.focus?.sourceId === id) this.focus = undefined
    this.settleRound(); this.save(); this.schedule()
  }
  read(ids: string[], read: boolean): void {
    const selected = new Set(ids)
    for (const item of this.data.items) if (selected.has(item.id)) item.read = read
    this.save()
  }
  private insert(source: StoredSource, entry: SubscriptionEntry, read: boolean): SubscriptionItem | undefined {
    if (this.data.items.some(item => item.sourceId === source.id && item.mediaId === entry.id)) return undefined
    const item = subscriptionItemSchema.parse({ id: randomUUID(), sourceId: source.id, mediaId: entry.id, url: entry.url,
      title: entry.title, type: entry.type, duration: entry.duration, thumbnail: entry.thumbnail,
      publishedAt: entry.publishedAt, discoveredAt: Date.now(), read })
    this.data.items.unshift(item)
    return item
  }
  private async checkOne(source: StoredSource): Promise<CheckOutcome> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error(i18n.t('subscriptions:errors.timeout'))) }, 180_000)
    this.active = { id: source.id, controller }
    const additions: SubscriptionItem[] = []
    let outcome: CheckOutcome = 'interrupted'
    delete source.retryAt
    source.status = 'checking'; source.lastCheckedAt = Date.now(); source.error = undefined
    this.changed()
    try {
      for (const stream of this.reader.streams(source, source.types)) {
        const held = source.checkpoints[stream.key]
        const boundary = new Set(held?.boundary || source.seen[stream.key] || [])
        const seen = new Set(source.seen[stream.key] || [])
        let page = held?.page || 1
        for (let turn = 0; turn < PAGES_PER_PASS; turn += 1, page += 1) {
          controller.signal.throwIfAborted()
          const result = await this.reader.page(source, stream, page, controller.signal)
          controller.signal.throwIfAborted()
          if (!this.data.sources.includes(source) || !source.enabled) return 'skipped'
          if (result.owner?.name) source.name = result.owner.name
          if (result.owner?.avatar?.startsWith('https://')) source.avatar = result.owner.avatar
          // Two known works near the tail establish overlap even if one old work was removed or
          // reordered. One pinned work alone cannot end a scan. Undated entries after that overlap
          // are older than our baseline, rather than newly published works.
          const tail = result.entries.slice(-3)
          const reached = tail.filter(entry => boundary.has(entry.id)).length >= 2
          const overlapEnd = reached ? result.entries.findLastIndex(entry => boundary.has(entry.id)) : -1
          const relevant = result.entries.filter(entry => source.types.includes(entry.type))
          if (page === 1 && relevant[0]) source.latestTitle = relevant[0].title
          for (const entry of relevant) {
            if (seen.has(entry.id)) continue
            const historical = entry.publishedAt !== undefined
              ? entry.publishedAt < Math.floor(source.createdAt / 1000) - 300
              : reached && result.entries.indexOf(entry) > overlapEnd
            const item = this.insert(source, entry, historical)
            if (item && !historical) additions.push(item)
          }
          for (const entry of result.entries) seen.add(entry.id)
          source.seen[stream.key] = [...seen]
          if (!result.hasMore || reached) { delete source.checkpoints[stream.key]; this.save(); break }
          if (page >= 500) throw new Error(i18n.t('subscriptions:errors.pageLimit'))
          source.checkpoints[stream.key] = { page: page + 1, boundary: [...boundary] }
          this.save()
        }
      }
      const incomplete = Object.keys(source.checkpoints).length > 0
      source.status = incomplete ? 'partial' : 'ready'
      source.error = incomplete ? i18n.t('subscriptions:backfillHint') : undefined
      if (!incomplete) source.lastSuccessAt = Date.now()
      if (incomplete) source.retryAt = Date.now() + 60_000
      outcome = incomplete ? 'partial' : 'succeeded'
    } catch (error) {
      if (!this.data.sources.includes(source)) return 'skipped'
      if (controller.signal.aborted && !timedOut) {
        source.status = 'idle'
        if (source.enabled) source.retryAt = Date.now() + 30_000
        else outcome = 'skipped'
      } else {
        source.status = error instanceof LoginRequired || error instanceof VerificationRequired ? 'needs-login' : 'failed'
        source.error = redact(error instanceof Error ? error.message : String(error))
        outcome = 'failed'
        log.warn('Check failed: ' + source.url, source.error)
      }
    } finally {
      clearTimeout(timer); this.active = undefined
      if (this.data.sources.includes(source)) {
        if (source.status === 'checking') source.status = source.lastSuccessAt ? 'ready' : 'idle'
        this.save()
        if (!this.stopped && source.enabled && additions.length && source.notify && this.settings().subscriptionNotifications) this.notify(this.publicSource(source), additions)
      }
    }
    return outcome
  }
}
