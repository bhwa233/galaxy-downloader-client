// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
export const MAX_BRIDGED_SPEAKERS = 8

/**
 * Cosine-distance cutoff for sherpa FastClustering (`numClusters: -1`) and for
 * speaker-level embedding bridging across 10-minute chunks.
 *
 * Official k2-fsa example (`python-api-examples/offline-speaker-diarization.py`)
 * uses 0.5. Larger values merge more speakers. Calibrated 2026-08-20 on
 * CAM++ zh-en advanced + pyannote-segmentation-3.0:
 * - official `0-four-speakers-zh.wav`: 4 speakers at 0.5–0.7, 3 at 0.8
 * - Chinese solo (阿Test, 90s): one cluster ≥2s at 0.5 (crumbs <2s are refined away)
 * - Chinese podcast (小宇宙, 90s): two main clusters plus short guests at 0.5
 * - English clip (HTX, 90s): two clusters ≥2s at 0.6, three at 0.5
 * 0.5 is kept as the official default; it is the highest-recall value that still
 * hits 4 on the required test wav.
 */
export const CLUSTERING_THRESHOLD = 0.5

export interface SpeakerEmbedItem {
  id: string
  vector: Float32Array
}

/**
 * L2-normalize a vector in place and return it. Zero vectors stay zero.
 *
 * @param vector Speaker embedding.
 */
export const l2Normalize = (vector: Float32Array): Float32Array => {
  let sum = 0
  for (const value of vector) {
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (norm < 1e-8) {
    return vector
  }
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i]
    if (value !== undefined) {
      vector[i] = value / norm
    }
  }
  return vector
}

/**
 * Cosine distance for unit vectors: 1 - dot product, clipped to [0, 2].
 *
 * @param left First unit embedding.
 * @param right Second unit embedding.
 */
export const cosineDistance = (left: Float32Array, right: Float32Array): number => {
  const n = Math.min(left.length, right.length)
  let dot = 0
  for (let i = 0; i < n; i += 1) {
    dot += (left[i] ?? 0) * (right[i] ?? 0)
  }
  return Math.min(2, Math.max(0, 1 - dot))
}

const pairwiseDistances = (vectors: readonly Float32Array[]): number[][] => {
  const n = vectors.length
  const dist: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0))
  for (let i = 0; i < n; i += 1) {
    const left = vectors[i]
    if (!left) {
      continue
    }
    for (let j = i + 1; j < n; j += 1) {
      const right = vectors[j]
      if (!right) {
        continue
      }
      const value = cosineDistance(left, right)
      const rowI = dist[i]
      const rowJ = dist[j]
      if (rowI) {
        rowI[j] = value
      }
      if (rowJ) {
        rowJ[i] = value
      }
    }
  }
  return dist
}

const averageLinkage = (
  dist: readonly number[][],
  members: readonly number[][],
  a: number,
  b: number
): number => {
  const left = members[a]
  const right = members[b]
  if (!(left && right) || left.length === 0 || right.length === 0) {
    return Number.POSITIVE_INFINITY
  }
  let sum = 0
  let count = 0
  for (const i of left) {
    const row = dist[i]
    if (!row) {
      continue
    }
    for (const j of right) {
      sum += row[j] ?? 0
      count += 1
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count
}

const nearestPair = (
  dist: readonly number[][],
  members: readonly number[][],
  active: readonly number[]
): { a: number; b: number; distance: number } | null => {
  if (active.length < 2) {
    return null
  }
  let bestA = active[0] ?? 0
  let bestB = active[1] ?? 1
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < active.length; i += 1) {
    const a = active[i]
    if (a === undefined) {
      continue
    }
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j]
      if (b === undefined) {
        continue
      }
      const value = averageLinkage(dist, members, a, b)
      if (value < best) {
        best = value
        bestA = a
        bestB = b
      }
    }
  }
  return { a: bestA, b: bestB, distance: best }
}

const labelsFromMembers = (n: number, members: readonly number[][], active: readonly number[]): number[] => {
  const labels = Array.from({ length: n }, () => 0)
  active.forEach((clusterId, label) => {
    for (const index of members[clusterId] ?? []) {
      labels[index] = label
    }
  })
  return labels
}

/**
 * Average-linkage agglomerative clustering. Returns a label per vector in 0..k-1.
 *
 * @param vectors L2-normalized embeddings.
 * @param k Target cluster count.
 */
export const agglomerativeLabels = (vectors: readonly Float32Array[], k: number): number[] => {
  const n = vectors.length
  if (n === 0) {
    return []
  }
  const target = Math.max(1, Math.min(k, n))
  if (target === n) {
    return Array.from({ length: n }, (_, i) => i)
  }
  if (target === 1) {
    return Array.from({ length: n }, () => 0)
  }
  const dist = pairwiseDistances(vectors)
  const members: number[][] = Array.from({ length: n }, (_, i) => [i])
  const active = Array.from({ length: n }, (_, i) => i)
  while (active.length > target) {
    const pair = nearestPair(dist, members, active)
    if (!pair) {
      break
    }
    const keep = members[pair.a]
    const drop = members[pair.b]
    if (keep && drop) {
      keep.push(...drop)
    }
    members[pair.b] = []
    const next = active.filter((id) => id !== pair.b)
    active.length = 0
    active.push(...next)
  }
  return labelsFromMembers(n, members, active)
}

/**
 * Average-linkage clustering that stops merging once the next pair is farther
 * than `threshold`. Does not force a cluster-count cap — that used to merge
 * real speakers before leftover fragments. Duration-aware capping lives in
 * `mergeChunkTurnsByEmbeddings`.
 *
 * @param vectors L2-normalized embeddings.
 * @param threshold Cosine-distance cutoff. Larger → fewer clusters.
 */
export const agglomerativeLabelsByThreshold = (
  vectors: readonly Float32Array[],
  threshold: number
): number[] => {
  const n = vectors.length
  if (n === 0) {
    return []
  }
  if (n === 1) {
    return [0]
  }
  const dist = pairwiseDistances(vectors)
  const members: number[][] = Array.from({ length: n }, (_, i) => [i])
  const active = Array.from({ length: n }, (_, i) => i)
  while (active.length > 1) {
    const pair = nearestPair(dist, members, active)
    if (!pair || pair.distance > threshold) {
      break
    }
    const keep = members[pair.a]
    const drop = members[pair.b]
    if (keep && drop) {
      keep.push(...drop)
    }
    members[pair.b] = []
    const next = active.filter((id) => id !== pair.b)
    active.length = 0
    active.push(...next)
  }
  return labelsFromMembers(n, members, active)
}

/**
 * Cluster speaker-level embeddings into 0..k-1 labels keyed by item id.
 *
 * Manual `k` cuts at that count. Auto uses `threshold` only — leftover
 * fragments are folded later by duration, not by forcing k.
 *
 * @param items One embedding per local speaker (usually per chunk).
 * @param opts Threshold and optional fixed speaker count.
 */
export const clusterSpeakerEmbeddings = (
  items: readonly SpeakerEmbedItem[],
  opts?: { threshold?: number; k?: number }
): Map<string, number> => {
  const result = new Map<string, number>()
  if (items.length === 0) {
    return result
  }
  const vectors = items.map((item) => l2Normalize(Float32Array.from(item.vector)))
  const labels =
    typeof opts?.k === 'number' && opts.k >= 1
      ? agglomerativeLabels(vectors, Math.min(opts.k, vectors.length))
      : agglomerativeLabelsByThreshold(vectors, opts?.threshold ?? CLUSTERING_THRESHOLD)
  items.forEach((item, index) => {
    result.set(item.id, labels[index] ?? 0)
  })
  return result
}
