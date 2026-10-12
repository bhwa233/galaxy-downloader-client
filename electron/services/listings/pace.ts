import { logger } from '../log'
import type { Fetcher } from './types'

const log = logger('pace')

// Timing is one of the signals risk control reads: a listing walked at a fixed interval, or a page of
// requests fired back to back, is a machine however complete the cookies are. Every wait here is drawn
// at random and tied to the parse's own signal, so cancelling never has to sit through one.
export type Span = readonly [min: number, max: number]

export const PACE = {
  // After a page loads, before anything touches it or asks it anything.
  settle: [1_200, 3_500] as Span,
  // How long a media page is left to start playing before it is read.
  media: [1_800, 3_600] as Span,
} as const

export type Rhythm = {
  // Between two requests to the same host.
  gap: Span
  // Each further request of one burst waits longer than the last, up to the ceiling.
  deeper: number
  ceiling: number
  // The chance of a pause long enough to look like attention going elsewhere, and how long it lasts.
  // Only ever drawn once a burst is already several requests deep: a page the user asked for is one
  // request, and making them wait five seconds while the client pretends to be distracted spends their
  // time to imitate something they are in fact doing.
  wander: number
  wandering: Span
  // How deep a burst has to be before the long pause is considered at all.
  wanderAfter: number
}

export const RHYTHM: Rhythm = { gap: [900, 2_400], deeper: 0.15, ceiling: 5_000, wander: 0.1, wandering: [3_000, 7_000], wanderAfter: 2 }

// Never a round number: a delay of exactly one second is as much of a signature as no delay at all.
const between = ([min, max]: Span) => min + Math.random() * (max - min)

// Always rejects rather than throwing: a caller that is already cancelled and one that is cancelled
// mid-wait have to be caught the same way.
export async function pause(signal: AbortSignal | undefined, span: Span): Promise<void> {
  signal?.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(done, between(span))
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const hostOf = (address: string) => { try { return new URL(address).hostname } catch { return address } }

// Spaces requests per host. Held for as long as the client runs rather than built per walk: the thing
// worth spacing is how often this client talks to a platform, and a pace that starts over on every
// page turn throttles one walk's own pages while letting a user leaning on 下一页 through untouched.
// The first request to a quiet host goes out immediately - someone opening a page does not wait first.
export class Pace {
  private queues = new Map<string, Promise<void>>()
  private bursts = new Map<string, { issued: number; at: number }>()
  constructor(private rhythm: Rhythm = RHYTHM) {}

  // Wraps a fetcher in this pace. Several fetchers may be wrapped over a run - each listing walks
  // inside its own page - and they all queue behind the same per-host state.
  wrap(fetch: Fetcher): Fetcher {
    return async (address, init) => {
      const host = hostOf(address)
      const turn = (this.queues.get(host) || Promise.resolve()).then(async () => {
        const previous = this.bursts.get(host)
        // How long this host has been left alone already. Nothing has to be paid for time that has
        // passed on its own: a page read for half a minute has spaced itself, and asking the reader to
        // wait again on top of that spends their time to buy a gap they had already given.
        const since = previous ? Date.now() - previous.at : Infinity
        const deep = previous?.issued || 0
        const factor = 1 + this.rhythm.deeper * Math.max(0, deep - 1)
        const max = Math.min(this.rhythm.gap[1] * factor, this.rhythm.ceiling)
        const owed = between([Math.min(this.rhythm.gap[0] * factor, max), max]) - since
        // A request that needed no wait was not part of a burst, so the escalation starts over with it.
        // That is also what lets a long-lived pace off the ceiling: nothing to forget, nothing to reset.
        const issued = owed > 0 ? deep + 1 : 1
        if (owed > 0) {
          log.debug(`${host} 等待 ${Math.round(owed)}ms · 连续第 ${issued} 个请求`)
          await pause(init?.signal, [owed, owed])
          if (issued > this.rhythm.wanderAfter && Math.random() < this.rhythm.wander) {
            log.debug(`${host} 插入一次长停顿`)
            await pause(init?.signal, this.rhythm.wandering)
          }
        }
        // Stamped after the waiting, so the next gap is measured from when this request actually left.
        this.bursts.set(host, { issued, at: Date.now() })
      })
      // A refused turn must not wedge the queue behind it; the rejection still reaches this caller.
      this.queues.set(host, turn.catch(() => {}))
      await turn
      return await fetch(address, init)
    }
  }
}
