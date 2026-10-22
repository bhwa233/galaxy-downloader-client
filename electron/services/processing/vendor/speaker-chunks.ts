// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import {
  CLUSTERING_THRESHOLD,
  clusterSpeakerEmbeddings,
  cosineDistance,
  l2Normalize,
  MAX_BRIDGED_SPEAKERS
} from './speaker-cluster'
import { mergeAdjacentTurns, type TimedTurn } from './speaker-refine'

/** Process this much audio per sherpa call so long podcasts stay in RAM. */
export const DIARIZE_CHUNK_MS = 10 * 60 * 1000
/** Overlap used so a speaker turn is not cut exactly at a chunk boundary. */
export const DIARIZE_OVERLAP_MS = 20_000
/** Require this much overlap before two local labels are treated as the same person. */
export const MERGE_MIN_OVERLAP_MS = 800
/** Concatenate at most this much audio when building a speaker-level embedding. */
export const SPEAKER_EMBED_MAX_MS = 8_000
/** Skip embedding extraction when a speaker has less than this much audio. */
export const SPEAKER_EMBED_MIN_MS = 300
/** Floor for duration-aware short-cluster folding. Far crumbs below this become unknown. */
export const SHORT_CLUSTER_MS = 5_000
/** Ceiling for duration-aware short-cluster folding (5% of long files would otherwise grow without bound). */
export const SHORT_CLUSTER_MAX_MS = 60_000
/** Fold candidates shorter than this fraction of total speech, after applying the floor/ceiling. */
export const SHORT_CLUSTER_SPEECH_FRACTION = 0.05
/**
 * Cosine-distance cutoff when folding a short cluster into the nearest main
 * speaker. Calibrated 2026-08-20 on 高能量 Vol.230 (two Chinese male voices:
 * same-person fragments ≈0.30, cross-person 0.741). Larger than the 0.5
 * recluster threshold so crumbs can still join a main speaker.
 */
export const SHORT_CLUSTER_FOLD_DISTANCE = 0.65

/**
 * Duration-aware fold threshold: max(5s, min(60s, 5% × total speech)).
 *
 * HTX (~428s speech) → 21.4s so a 6s host fragment folds; a 42s third speaker
 * stays. Geng mains (2364s / 1832s) sit far above the 60s ceiling.
 */
export const shortClusterFoldMs = (totalSpeechMs: number): number =>
  Math.max(
    SHORT_CLUSTER_MS,
    Math.min(SHORT_CLUSTER_MAX_MS, SHORT_CLUSTER_SPEECH_FRACTION * Math.max(0, totalSpeechMs))
  )

export interface DiarizeWindow {
  startMs: number
  endMs: number
}

export interface SpeakerEmbed {
  speakerKey: string
  vector: Float32Array
}

/**
 * Split a timeline into overlapping windows. Short files stay as one window.
 *
 * @param durationMs Audio length in milliseconds.
 */
export const diarizeChunkWindows = (durationMs: number): DiarizeWindow[] => {
  const total = Math.max(0, durationMs)
  if (total <= DIARIZE_CHUNK_MS + DIARIZE_OVERLAP_MS) {
    return total > 0 ? [{ startMs: 0, endMs: total }] : []
  }
  const windows: DiarizeWindow[] = []
  let startMs = 0
  while (startMs < total) {
    const endMs = Math.min(total, startMs + DIARIZE_CHUNK_MS)
    windows.push({ startMs, endMs })
    if (endMs >= total) {
      break
    }
    startMs = endMs - DIARIZE_OVERLAP_MS
  }
  return windows
}

/**
 * Shift turn timestamps by a chunk offset (sherpa times are relative to the slice).
 *
 * @param turns Turns whose times start at 0 for the slice.
 * @param offsetMs Chunk start on the full timeline.
 */
export const shiftTurns = (turns: TimedTurn[], offsetMs: number): TimedTurn[] =>
  turns.map((turn) => ({
    ...turn,
    startMs: turn.startMs + offsetMs,
    endMs: turn.endMs + offsetMs
  }))

const overlapMs = (left: TimedTurn, right: TimedTurn): number =>
  Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs))

const durationOf = (turn: TimedTurn): number => Math.max(0, turn.endMs - turn.startMs)

const turnsOverlap = (left: TimedTurn, right: TimedTurn): boolean =>
  Math.min(left.endMs, right.endMs) > Math.max(left.startMs, right.startMs)

const nextSpeakerIndex = (turns: TimedTurn[]): number => {
  let max = 0
  for (const turn of turns) {
    const match = /^speaker-(\d+)$/.exec(turn.speakerKey)
    const n = match ? Number.parseInt(match[1] ?? '0', 10) : 0
    if (n > max) {
      max = n
    }
  }
  return max + 1
}

/**
 * Pick the longest clean (non-overlapped) turns for one local speaker, falling
 * back to overlapping turns when no exclusive speech exists. Caps total audio.
 *
 * @param turns All turns in the chunk.
 * @param speakerKey Local speaker id.
 * @param maxMs Maximum concatenated audio.
 */
export const pickSpeakerEmbedTurns = (
  turns: readonly TimedTurn[],
  speakerKey: string,
  maxMs = SPEAKER_EMBED_MAX_MS
): TimedTurn[] => {
  const mine = turns.filter((turn) => turn.speakerKey === speakerKey && durationOf(turn) > 0)
  if (mine.length === 0) {
    return []
  }
  const others = turns.filter((turn) => turn.speakerKey !== speakerKey && turn.speakerKey !== 'unknown')
  const clean = mine.filter((turn) => !others.some((other) => turnsOverlap(turn, other)))
  const pool = [...(clean.length > 0 ? clean : mine)].sort((a, b) => durationOf(b) - durationOf(a))
  const picked: TimedTurn[] = []
  let used = 0
  for (const turn of pool) {
    if (used >= maxMs) {
      break
    }
    const take = Math.min(durationOf(turn), maxMs - used)
    picked.push({ ...turn, endMs: turn.startMs + take })
    used += take
  }
  return used >= SPEAKER_EMBED_MIN_MS ? picked : []
}

/**
 * Clip previous/next turns at a midpoint so overlapping chunks do not double-count.
 *
 * @param previous Turns already on the global timeline.
 * @param next Turns from the new chunk, already shifted to global time.
 * @param midMs Split point.
 */
export const stitchTurnsAtMidpoint = (
  previous: TimedTurn[],
  next: TimedTurn[],
  midMs: number
): TimedTurn[] => {
  const keptPrev = previous
    .map((turn) => ({ ...turn, endMs: Math.min(turn.endMs, midMs) }))
    .filter((turn) => turn.endMs > turn.startMs)
  const keptNext = next
    .map((turn) => ({ ...turn, startMs: Math.max(turn.startMs, midMs) }))
    .filter((turn) => turn.endMs > turn.startMs)
  return mergeAdjacentTurns([...keptPrev, ...keptNext])
}

/**
 * Map next-chunk speaker keys onto previous-chunk keys using the overlap region.
 * Fallback when a speaker has no embedding.
 *
 * @param previous Turns already on the global timeline.
 * @param next Turns from the new chunk, already shifted to global time.
 * @param overlapStartMs Inclusive start of the shared region.
 * @param overlapEndMs Exclusive end of the shared region.
 */
export const mergeChunkTurns = (
  previous: TimedTurn[],
  next: TimedTurn[],
  overlapStartMs: number,
  overlapEndMs: number
): TimedTurn[] => {
  const mid = Math.round((overlapStartMs + overlapEndMs) / 2)
  const keptPrev = previous
    .map((turn) => ({ ...turn, endMs: Math.min(turn.endMs, mid) }))
    .filter((turn) => turn.endMs > turn.startMs)
  const keptNext = next
    .map((turn) => ({ ...turn, startMs: Math.max(turn.startMs, mid) }))
    .filter((turn) => turn.endMs > turn.startMs)
  if (keptNext.length === 0) {
    return mergeAdjacentTurns(keptPrev)
  }
  const prevOverlap = previous.filter((turn) => turn.endMs > overlapStartMs && turn.startMs < overlapEndMs)
  const nextOverlap = next.filter((turn) => turn.endMs > overlapStartMs && turn.startMs < overlapEndMs)
  const mapping = new Map<string, string>()
  let nextIndex = nextSpeakerIndex(keptPrev)
  const localKeys = [...new Set(keptNext.map((turn) => turn.speakerKey))]
  for (const local of localKeys) {
    if (local === 'unknown') {
      mapping.set(local, 'unknown')
      continue
    }
    const mine = nextOverlap.filter((turn) => turn.speakerKey === local)
    let bestKey = ''
    let bestMs = 0
    const globalKeys = [...new Set(prevOverlap.map((turn) => turn.speakerKey))].filter(
      (key) => key !== 'unknown'
    )
    for (const global of globalKeys) {
      const theirs = prevOverlap.filter((turn) => turn.speakerKey === global)
      let sum = 0
      for (const a of mine) {
        for (const b of theirs) {
          sum += overlapMs(a, b)
        }
      }
      if (sum > bestMs) {
        bestMs = sum
        bestKey = global
      }
    }
    if (bestKey && bestMs >= MERGE_MIN_OVERLAP_MS) {
      mapping.set(local, bestKey)
      continue
    }
    mapping.set(local, `speaker-${nextIndex}`)
    nextIndex += 1
  }
  const remapped = keptNext.map((turn) => ({
    ...turn,
    speakerKey: mapping.get(turn.speakerKey) ?? turn.speakerKey
  }))
  return mergeAdjacentTurns([...keptPrev, ...remapped])
}

const embedId = (chunkIndex: number, speakerKey: string): string => `${chunkIndex}:${speakerKey}`

const meanEmbedding = (vectors: readonly Float32Array[]): Float32Array | null => {
  if (vectors.length === 0) {
    return null
  }
  const dim = vectors[0]?.length ?? 0
  if (dim === 0) {
    return null
  }
  const acc = new Float32Array(dim)
  for (const vector of vectors) {
    const unit = l2Normalize(Float32Array.from(vector))
    for (let i = 0; i < dim; i += 1) {
      acc[i] = (acc[i] ?? 0) + (unit[i] ?? 0)
    }
  }
  for (let i = 0; i < dim; i += 1) {
    acc[i] = (acc[i] ?? 0) / vectors.length
  }
  return l2Normalize(acc)
}

/**
 * Fold leftover short clusters into the nearest main speaker when the
 * speaker-level cosine distance is small enough. Used after global recluster.
 * Candidates are shorter than max(5s, min(60s, 5% × total speech)). Skipped
 * when there is no main cluster at that threshold — short files would otherwise
 * collapse to unknown. Far candidates stay unknown if <5s, otherwise remain
 * independent (possible real guests).
 *
 * @param clusters Local-id → cluster label from AHC.
 * @param chunkTurns Turns per window, already shifted to global time.
 * @param chunkEmbeds Speaker-level embeddings per window.
 * @param foldDistance Cosine-distance cutoff, default 0.65.
 */
export const foldShortClusters = (
  clusters: Map<string, number>,
  chunkTurns: readonly TimedTurn[][],
  chunkEmbeds: readonly SpeakerEmbed[][],
  foldDistance = SHORT_CLUSTER_FOLD_DISTANCE
): Map<string, number | 'unknown'> => {
  const aliased = new Map<string, number | 'unknown'>()
  const durationByCluster = new Map<number, number>()
  const vectorsByCluster = new Map<number, Float32Array[]>()
  for (let i = 0; i < chunkTurns.length; i += 1) {
    for (const turn of chunkTurns[i] ?? []) {
      const id = embedId(i, turn.speakerKey)
      const cluster = clusters.get(id)
      if (cluster === undefined) {
        continue
      }
      durationByCluster.set(cluster, (durationByCluster.get(cluster) ?? 0) + durationOf(turn))
    }
  }
  for (let i = 0; i < chunkEmbeds.length; i += 1) {
    for (const embed of chunkEmbeds[i] ?? []) {
      const cluster = clusters.get(embedId(i, embed.speakerKey))
      if (cluster === undefined) {
        continue
      }
      const list = vectorsByCluster.get(cluster) ?? []
      list.push(embed.vector)
      vectorsByCluster.set(cluster, list)
    }
  }
  const totalSpeechMs = [...durationByCluster.values()].reduce((sum, ms) => sum + ms, 0)
  const foldMs = shortClusterFoldMs(totalSpeechMs)
  const labels = [...durationByCluster.keys()]
  const mains = labels.filter((label) => (durationByCluster.get(label) ?? 0) >= foldMs)
  if (mains.length === 0) {
    for (const [id, cluster] of clusters) {
      aliased.set(id, cluster)
    }
    return aliased
  }
  const meanByCluster = new Map<number, Float32Array>()
  for (const label of labels) {
    const mean = meanEmbedding(vectorsByCluster.get(label) ?? [])
    if (mean) {
      meanByCluster.set(label, mean)
    }
  }
  const alias = new Map<number, number | 'unknown'>()
  for (const label of labels) {
    const duration = durationByCluster.get(label) ?? 0
    if (duration >= foldMs) {
      alias.set(label, label)
      continue
    }
    const own = meanByCluster.get(label)
    if (!own) {
      alias.set(label, duration < SHORT_CLUSTER_MS ? 'unknown' : label)
      continue
    }
    let best: number | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const main of mains) {
      const other = meanByCluster.get(main)
      if (!other) {
        continue
      }
      const distance = cosineDistance(own, other)
      if (distance < bestDistance) {
        bestDistance = distance
        best = main
      }
    }
    if (best !== null && bestDistance <= foldDistance) {
      alias.set(label, best)
    } else if (duration < SHORT_CLUSTER_MS) {
      alias.set(label, 'unknown')
    } else {
      alias.set(label, label)
    }
  }
  for (const [id, cluster] of clusters) {
    aliased.set(id, alias.get(cluster) ?? cluster)
  }
  return aliased
}

/**
 * After threshold clustering and short-cluster fold, keep the longest
 * `maxSpeakers` clusters. Remaining clusters fold into the nearest keeper
 * when cosine distance ≤ 0.65, otherwise become unknown.
 *
 * This replaces the old force-merge-to-k which ignored the distance threshold
 * and could merge the two real speakers before leftover fragments.
 */
export const capExcessClusters = (
  clusters: Map<string, number | 'unknown'>,
  chunkTurns: readonly TimedTurn[][],
  chunkEmbeds: readonly SpeakerEmbed[][],
  maxSpeakers = MAX_BRIDGED_SPEAKERS,
  foldDistance = SHORT_CLUSTER_FOLD_DISTANCE
): Map<string, number | 'unknown'> => {
  const durationByCluster = new Map<number, number>()
  const vectorsByCluster = new Map<number, Float32Array[]>()
  for (let i = 0; i < chunkTurns.length; i += 1) {
    for (const turn of chunkTurns[i] ?? []) {
      const mapped = clusters.get(embedId(i, turn.speakerKey))
      if (typeof mapped !== 'number') {
        continue
      }
      durationByCluster.set(mapped, (durationByCluster.get(mapped) ?? 0) + durationOf(turn))
    }
  }
  for (let i = 0; i < chunkEmbeds.length; i += 1) {
    for (const embed of chunkEmbeds[i] ?? []) {
      const mapped = clusters.get(embedId(i, embed.speakerKey))
      if (typeof mapped !== 'number') {
        continue
      }
      const list = vectorsByCluster.get(mapped) ?? []
      list.push(embed.vector)
      vectorsByCluster.set(mapped, list)
    }
  }
  const ranked = [...durationByCluster.entries()].sort((left, right) => right[1] - left[1])
  if (ranked.length <= maxSpeakers) {
    return clusters
  }
  const keepers = ranked.slice(0, maxSpeakers).map(([label]) => label)
  const keeperSet = new Set(keepers)
  const meanByCluster = new Map<number, Float32Array>()
  for (const [label] of ranked) {
    const mean = meanEmbedding(vectorsByCluster.get(label) ?? [])
    if (mean) {
      meanByCluster.set(label, mean)
    }
  }
  const alias = new Map<number, number | 'unknown'>()
  for (const label of keepers) {
    alias.set(label, label)
  }
  for (const [label] of ranked) {
    if (keeperSet.has(label)) {
      continue
    }
    const own = meanByCluster.get(label)
    if (!own) {
      alias.set(label, 'unknown')
      continue
    }
    let best: number | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const main of keepers) {
      const other = meanByCluster.get(main)
      if (!other) {
        continue
      }
      const distance = cosineDistance(own, other)
      if (distance < bestDistance) {
        bestDistance = distance
        best = main
      }
    }
    alias.set(label, best !== null && bestDistance <= foldDistance ? best : 'unknown')
  }
  const out = new Map<string, number | 'unknown'>()
  for (const [id, cluster] of clusters) {
    if (cluster === 'unknown') {
      out.set(id, 'unknown')
      continue
    }
    out.set(id, alias.get(cluster) ?? cluster)
  }
  return out
}

/**
 * Map each chunk's local speaker ids onto global ids by clustering
 * speaker-level embeddings, then stitch overlapping windows at the midpoint.
 * Runs for one window as well as many — local sherpa labels are always
 * reclustered. Auto mode then folds leftover short clusters.
 *
 * Speaker-1 is whoever appears first on the timeline. Locals without an
 * embedding keep a unique new id unless they are shorter than 5s (unknown).
 *
 * @param windows Chunk windows in order.
 * @param chunkTurns Diarization turns per window, already shifted to global time.
 * @param chunkEmbeds Speaker-level embeddings per window.
 * @param opts Auto uses `threshold`; manual `k` cuts at that speaker count.
 */
export const mergeChunkTurnsByEmbeddings = (
  windows: readonly DiarizeWindow[],
  chunkTurns: readonly TimedTurn[][],
  chunkEmbeds: readonly SpeakerEmbed[][],
  opts?: { threshold?: number; k?: number }
): TimedTurn[] => {
  const items = chunkEmbeds.flatMap((embeds, chunkIndex) =>
    embeds.map((embed) => ({ id: embedId(chunkIndex, embed.speakerKey), vector: embed.vector }))
  )
  const clustered = clusterSpeakerEmbeddings(items, {
    threshold: opts?.threshold ?? CLUSTERING_THRESHOLD,
    k: opts?.k
  })
  const resolved =
    typeof opts?.k === 'number' && opts.k >= 1
      ? clustered
      : capExcessClusters(
          foldShortClusters(clustered, chunkTurns, chunkEmbeds),
          chunkTurns,
          chunkEmbeds
        )
  const localToGlobal = new Map<string, string>()
  const clusterToGlobal = new Map<number, string>()
  let nextIndex = 1
  const assign = (id: string, speakerKey: string): string => {
    if (speakerKey === 'unknown') {
      return 'unknown'
    }
    const existing = localToGlobal.get(id)
    if (existing) {
      return existing
    }
    const cluster = resolved.get(id)
    if (cluster === 'unknown') {
      localToGlobal.set(id, 'unknown')
      return 'unknown'
    }
    if (typeof cluster === 'number') {
      const mapped = clusterToGlobal.get(cluster)
      if (mapped) {
        localToGlobal.set(id, mapped)
        return mapped
      }
      const key = `speaker-${nextIndex}`
      nextIndex += 1
      clusterToGlobal.set(cluster, key)
      localToGlobal.set(id, key)
      return key
    }
    const key = `speaker-${nextIndex}`
    nextIndex += 1
    localToGlobal.set(id, key)
    return key
  }
  for (let i = 0; i < chunkTurns.length; i += 1) {
    const ordered = [...(chunkTurns[i] ?? [])].sort((a, b) => a.startMs - b.startMs)
    for (const turn of ordered) {
      assign(embedId(i, turn.speakerKey), turn.speakerKey)
    }
  }

  let merged: TimedTurn[] = []
  for (let i = 0; i < chunkTurns.length; i += 1) {
    const remapped = (chunkTurns[i] ?? []).map((turn) => ({
      ...turn,
      speakerKey: localToGlobal.get(embedId(i, turn.speakerKey)) ?? turn.speakerKey
    }))
    if (i === 0) {
      merged = remapped
      continue
    }
    const window = windows[i]
    const mid = window ? window.startMs + Math.round(DIARIZE_OVERLAP_MS / 2) : 0
    merged = stitchTurnsAtMidpoint(merged, remapped, mid)
  }
  return mergeAdjacentTurns(merged)
}
