// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
export interface TimedTurn {
  startMs: number
  endMs: number
  speakerKey: string
}

export interface TimeInterval {
  startMs: number
  endMs: number
}

/** Turns shorter than this do not seed clusters; they inherit a neighbor. */
export const MIN_CLUSTER_TURN_MS = 400
/** Auto mode only: merge clusters shorter than this (pyannote glitches), not a % share. */
export const MIN_CLUSTER_DURATION_MS = 2_000
/** Max gap when merging a short cluster into its nearest neighbor. */
export const MAX_MERGE_GAP_MS = 30_000
/** Ignore VAD as a speech mask when it covers less than this share of the file. */
export const MIN_VAD_COVERAGE = 0.2
/** Fill timeline holes larger than this so ASR cannot stop after the first line. */
export const MAX_UNCOVERED_GAP_MS = 2_000

const durationOf = (turn: TimeInterval): number => Math.max(0, turn.endMs - turn.startMs)

const overlaps = (a: TimeInterval, b: TimeInterval): boolean =>
  Math.min(a.endMs, b.endMs) > Math.max(a.startMs, b.startMs)

const gapBetween = (a: TimeInterval, b: TimeInterval): number => {
  if (overlaps(a, b)) {
    return 0
  }
  return a.endMs <= b.startMs ? b.startMs - a.endMs : a.startMs - b.endMs
}

const nearestSpeaker = (
  targets: TimedTurn[],
  pool: TimedTurn[]
): { speakerKey: string; gap: number } | null => {
  let best: { speakerKey: string; gap: number } | null = null
  for (const target of targets) {
    for (const other of pool) {
      const gap = gapBetween(target, other)
      if (!best || gap < best.gap) {
        best = { speakerKey: other.speakerKey, gap }
      }
    }
  }
  return best
}

/**
 * Merge adjacent same-speaker turns that almost touch.
 *
 * @param turns Unsorted or overlapping speaker turns.
 */
export const mergeAdjacentTurns = (turns: TimedTurn[]): TimedTurn[] => {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: TimedTurn[] = []
  for (const turn of sorted) {
    const prev = merged.at(-1)
    if (prev && prev.speakerKey === turn.speakerKey && turn.startMs <= prev.endMs + 400) {
      prev.endMs = Math.max(prev.endMs, turn.endMs)
      continue
    }
    merged.push({ ...turn })
  }
  return merged
}

export interface RefineSpeakerOptions {
  /** When true, skip the short-cluster merge that exists to clean up auto clustering. */
  knownCount?: boolean
}

/**
 * Post-process raw diarization turns: fold sub-400ms fragments into neighbors
 * and, in auto mode, merge leftover clusters shorter than 2s. A percent-of-file
 * floor is not used — that erased low-talk guests on long videos.
 */
export const refineSpeakerTurns = (
  raw: TimedTurn[],
  _speech: TimeInterval[],
  _totalDurationMs: number,
  options?: RefineSpeakerOptions
): TimedTurn[] => {
  const speechAware = raw.map((turn) => ({ ...turn }))
  if (speechAware.length === 0) {
    return []
  }

  const long = speechAware.filter((turn) => durationOf(turn) >= MIN_CLUSTER_TURN_MS)
  const short = speechAware.filter((turn) => durationOf(turn) < MIN_CLUSTER_TURN_MS)
  for (const fragment of short) {
    const neighbor = nearestSpeaker([fragment], long)
    fragment.speakerKey = neighbor ? neighbor.speakerKey : 'unknown'
  }

  const combined = mergeAdjacentTurns([...long, ...short])
  if (options?.knownCount) {
    return combined
  }

  const keys = [...new Set(combined.map((turn) => turn.speakerKey))].filter((key) => key !== 'unknown')
  for (const key of keys) {
    const mine = combined.filter((turn) => turn.speakerKey === key)
    const dur = mine.reduce((sum, turn) => sum + durationOf(turn), 0)
    if (dur >= MIN_CLUSTER_DURATION_MS) {
      continue
    }
    const others = combined.filter((turn) => turn.speakerKey !== key && turn.speakerKey !== 'unknown')
    const neighbor = nearestSpeaker(mine, others)
    const nextKey = neighbor && neighbor.gap <= MAX_MERGE_GAP_MS ? neighbor.speakerKey : 'unknown'
    for (const turn of mine) {
      turn.speakerKey = nextKey
    }
  }

  return mergeAdjacentTurns(combined)
}

/**
 * Sum the duration of a list of intervals.
 */
export const intervalDurationMs = (intervals: TimeInterval[]): number =>
  intervals.reduce((sum, interval) => sum + durationOf(interval), 0)

/**
 * Return true when VAD spans enough of the file to use as a speech mask.
 */
export const shouldTrustSpeechIntervals = (speechMs: number, totalDurationMs: number): boolean => {
  if (speechMs <= 0 || totalDurationMs <= 0) {
    return false
  }
  return speechMs >= totalDurationMs * MIN_VAD_COVERAGE
}

/**
 * Insert unknown-speaker turns for large holes so later speech is still recognized.
 */
export const fillUncoveredTurns = (
  turns: TimedTurn[],
  totalDurationMs: number,
  maxGapMs = MAX_UNCOVERED_GAP_MS
): TimedTurn[] => {
  const total = Math.max(0, totalDurationMs)
  const sorted = [...turns]
    .filter((turn) => turn.endMs > turn.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const filled: TimedTurn[] = []
  let cursor = 0
  for (const turn of sorted) {
    if (turn.startMs - cursor > maxGapMs) {
      filled.push({ startMs: cursor, endMs: turn.startMs, speakerKey: 'unknown' })
    }
    filled.push({ ...turn })
    cursor = Math.max(cursor, turn.endMs)
  }
  if (total - cursor > maxGapMs) {
    filled.push({ startMs: cursor, endMs: total, speakerKey: 'unknown' })
  }
  if (filled.length > 0) {
    return filled
  }
  return total > 0 ? [{ startMs: 0, endMs: Math.max(1000, total), speakerKey: 'unknown' }] : []
}

/**
 * Build the speaker turns ASR will walk. Pyannote already marks speech; VAD is
 * not used as a mask. A short diarization miss cannot hide the rest of the file.
 */
export const turnsForAsr = (
  raw: TimedTurn[],
  _speech: TimeInterval[],
  totalDurationMs: number,
  options?: RefineSpeakerOptions
): TimedTurn[] => {
  const refined = refineSpeakerTurns(raw, [], totalDurationMs, options)
  const base = refined.length > 0 ? refined : raw
  return fillUncoveredTurns(base, totalDurationMs)
}
