// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
export interface AsrWord {
  endMs: number
  startMs: number
  text: string
}

export interface AsrRecognizerResult {
  durations?: number[]
  text?: string
  timestamps?: number[]
  tokens?: string[]
}

const CJK_CHAR = /[\u4e00-\u9fff]/
const PUNCT_ONLY = /^[^\s\u4e00-\u9fffA-Za-z0-9]+$/

/**
 * Normalize a SentencePiece-style token into display text.
 */
const normalizeToken = (token: string): string => token.replace(/^▁/u, ' ')

/**
 * Return whether this token should open a new word.
 */
const startsWord = (token: string, empty: boolean): boolean => {
  if (empty) {
    return true
  }
  const normalized = normalizeToken(token)
  if (normalized.startsWith(' ') || normalized.startsWith('\n')) {
    return true
  }
  const trimmed = normalized.trim()
  if (!trimmed || PUNCT_ONLY.test(trimmed)) {
    return false
  }
  return CJK_CHAR.test(trimmed)
}

/**
 * Build word timings from sherpa-onnx tokens and timestamps.
 *
 * Timestamps are seconds relative to the recognized chunk.
 */
export const wordsFromAsrResult = (
  result: AsrRecognizerResult,
  chunkStartMs: number,
  chunkEndMs: number
): AsrWord[] => {
  const tokens = result.tokens ?? []
  const timestamps = result.timestamps ?? []
  if (tokens.length === 0 || tokens.length !== timestamps.length) {
    return []
  }

  const groups: Array<{ startMs: number; text: string }> = []
  for (const [index, token] of tokens.entries()) {
    const startMs = chunkStartMs + Math.round((timestamps[index] ?? 0) * 1000)
    const text = normalizeToken(token)
    const last = groups.at(-1)
    if (last && !startsWord(token, false)) {
      last.text += text
      continue
    }
    groups.push({ startMs: Math.max(chunkStartMs, startMs), text })
  }

  return groups
    .filter((group) => group.text.length > 0)
    .map((group, index, all) => {
      const next = all[index + 1]
      const endMs = Math.max(
        group.startMs + 1,
        Math.min(chunkEndMs, next ? next.startMs : chunkEndMs)
      )
      return { endMs, startMs: group.startMs, text: group.text }
    })
}

/**
 * Pick the most recently started word at the playhead.
 *
 * Rounding avoids `ms / 1000 * 1000` landing just before a token start, which
 * would highlight the previous word after a click. Later overlapping starts win.
 */
export const activeWordIndex = (words: AsrWord[], currentMs: number): number | null => {
  const t = Math.round(currentMs)
  let last = -1
  for (const [index, word] of words.entries()) {
    if (word.startMs <= t) {
      last = index
    }
  }
  return last >= 0 ? last : null
}
