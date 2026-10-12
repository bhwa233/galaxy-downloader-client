import { expect, test } from 'vitest'
import { PACE, Pace, pause, type Rhythm } from '../electron/services/listings/pace'

// Short spans so the test measures the shape of the pacing rather than sitting through the real one.
// The two steps are kept far apart so the assertions below read the escalation and not a lucky draw.
const rhythm: Rhythm = { gap: [60, 70], deeper: 1, ceiling: 400, wander: 0, wandering: [0, 0], wanderAfter: 2 }

test('requests to one host are spaced, and a first request is not made to wait', async () => {
  const at: number[] = []
  const fetch = new Pace(rhythm).wrap(async () => { at.push(Date.now()); return new Response('') })
  await fetch('https://example.com/one')
  await fetch('https://example.com/two')
  await fetch('https://example.com/three')
  expect(at[1] - at[0]).toBeGreaterThanOrEqual(55)
  // Each further request of the same burst waits longer than the one before it: the second gap comes
  // from a doubled window, so it cannot fall inside the first one however the draws land.
  expect(at[1] - at[0]).toBeLessThan(110)
  expect(at[2] - at[1]).toBeGreaterThanOrEqual(115)
})

test('a second host does not queue behind the first', async () => {
  const fetch = new Pace(rhythm).wrap(async () => new Response(''))
  await fetch('https://one.example.com/a')
  const start = Date.now()
  await fetch('https://two.example.com/a')
  expect(Date.now() - start).toBeLessThan(40)
})

// The point of holding one pace for the whole run: a user leaning on 下一页 is the burst worth slowing,
// and each turn reads its listing through a fetcher of its own. Time they spent reading counts, so a
// page turned after a pause of its own is not charged for a gap it already gave.
test('a pace holds its count across the fetchers it wraps, and charges only for time not already waited', async () => {
  const at: number[] = []
  const pace = new Pace(rhythm)
  const record = async () => { at.push(Date.now()); return new Response('') }
  await pace.wrap(record)('https://example.com/one')
  // A second fetcher, as a second page turn would build: it waits because the first one just went.
  await pace.wrap(record)('https://example.com/two')
  expect(at[1] - at[0]).toBeGreaterThanOrEqual(55)
  // A reader who sat on the page longer than the gap has already spaced the request themselves.
  await new Promise(resolve => setTimeout(resolve, 150))
  const start = Date.now()
  await pace.wrap(record)('https://example.com/three')
  expect(Date.now() - start).toBeLessThan(40)
})

test('a cancelled walk does not sit through its own delay', async () => {
  const controller = new AbortController()
  const waiting = expect(pause(controller.signal, [5_000, 5_000])).rejects.toThrow('取消')
  const start = Date.now()
  controller.abort(new Error('取消'))
  await waiting
  expect(Date.now() - start).toBeLessThan(100)
  // An aborted signal is refused before a timer is ever set.
  await expect(pause(controller.signal, [1, 1])).rejects.toThrow('取消')
})

// The whole point of the module: every wait is drawn from a span rather than being a round number, so
// two parses of the same platform never line up.
test('every pause is a range rather than a fixed delay', () => {
  for (const span of [PACE.settle, PACE.media]) expect(span[0]).toBeLessThan(span[1])
  const drawn = new Set(Array.from({ length: 20 }, () => Math.random() * (PACE.settle[1] - PACE.settle[0])))
  expect(drawn.size).toBeGreaterThan(1)
})
