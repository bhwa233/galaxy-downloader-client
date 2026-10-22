// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from './atomic-file'
import type { TimedTurn } from './speaker-refine'
import type {
  PipelineSegment,
  PipelineSpeaker,
  TranscriptRecord,
  TranscriptSourceKind,
  TranscriptWord
} from './types'

export const SEED_TRANSCRIPT_FILE = 'seed-transcript.json'

export interface PipelineSeed {
  language: string | null
  modelVersion: string
  asrTier: string | null
  sourceKind?: TranscriptSourceKind
  speakers: PipelineSpeaker[]
  segments: PipelineSegment[]
}

interface LabeledToken extends TranscriptWord {
  confidence: number | null
  speakerKey: string | null
  /** False when this token is a whole caption line without ASR word timings. */
  timed: boolean
}

const SENTENCE_END = /[。！？!?….]["'"」』]*$/u
const CJK_CHAR = /[\u4e00-\u9fff]/
const TRAILING_QUOTES = /["'"」』]/
const SECONDARY_PUNCT_PARTS = /[^，、,;：]+[，、,;：]+|[^，、,;：]+/gu

/** Split when the next token starts after this much silence. */
export const PARAGRAPH_GAP_MS = 1500
/** Split when the open segment already has this many characters. */
export const MAX_SEGMENT_CHARS = 150
/** Split when the open segment already spans this duration. */
export const MAX_SEGMENT_MS = 30_000
/** Wordless pieces longer than this are split again so majority-vote stays local. */
export const GIANT_TOKEN_MS = 30_000
/** Wordless pieces with more than this many characters are split again. */
export const GIANT_TOKEN_CHARS = 300
/** Last-resort window size when a giant piece still has no usable punctuation. */
export const FALLBACK_TOKEN_CHARS = 50

const charCount = (text: string): number => [...text].length

const isAsciiSentencePeriod = (text: string, index: number): boolean => {
  if (text[index] !== '.') {
    return false
  }
  const prev = text[index - 1]
  const next = text[index + 1]
  if (prev !== undefined && /\d/.test(prev) && next !== undefined && /\d/.test(next)) {
    return false
  }
  return next === undefined || /\s/.test(next) || TRAILING_QUOTES.test(next)
}

/**
 * True when this caption line already closed a sentence.
 */
const endsCaptionSentence = (text: string): boolean => SENTENCE_END.test(text.trimEnd())

/**
 * Split a caption line on CJK/terminal punctuation so one speaker turn is not one wall of text.
 * ASCII '.' counts as a sentence end when it is followed by space, quotes, or end-of-text,
 * but not inside decimals such as 3.5.
 */
const splitCaptionSentences = (text: string): string[] => {
  const source = text.trim()
  if (!source) {
    return []
  }
  const parts: string[] = []
  let start = 0
  const push = (end: number): void => {
    const part = source.slice(start, end).trim()
    if (part) {
      parts.push(part)
    }
    start = end
  }
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? ''
    if (ch === '\n') {
      push(i)
      start = i + 1
      continue
    }
    if (/[。！？!?]/.test(ch) || isAsciiSentencePeriod(source, i)) {
      let end = i + 1
      while (end < source.length && TRAILING_QUOTES.test(source[end] ?? '')) {
        end += 1
      }
      push(end)
      i = end - 1
    }
  }
  if (start < source.length) {
    push(source.length)
  }
  return parts.length > 0 ? parts : [source]
}

/**
 * Join two caption fragments, adding a space only when Latin words would otherwise jam.
 */
const joinCaptionText = (left: string, right: string): string => {
  if (!left) {
    return right
  }
  if (!right) {
    return left
  }
  if (/\s$/.test(left) || /^\s/.test(right)) {
    return `${left}${right}`
  }
  if (/[。！？!?…,，、；;：:]$/.test(left)) {
    return `${left}${right}`
  }
  const leftChar = left.trimEnd().at(-1) ?? ''
  const rightChar = right.trimStart().at(0) ?? ''
  if (CJK_CHAR.test(leftChar) && CJK_CHAR.test(rightChar)) {
    return `${left}${right}`
  }
  return `${left} ${right}`
}

/**
 * Build a one-speaker turn covering the whole timeline.
 *
 * @param endMs Exclusive end of the last known word or segment.
 */
export const singleSpeakerTurns = (endMs: number): TimedTurn[] => [
  { startMs: 0, endMs: Math.max(1, endMs), speakerKey: 'speaker-1' }
]

/**
 * True when imported captions still need a speaker overlay pass.
 *
 * Rows committed by rediarize use the worker task id, so they are not retried
 * even if clustering found no named speakers.
 *
 * @param record Current transcript, if any.
 */
export const captionRecordNeedsSpeakers = (record: TranscriptRecord | null): boolean =>
  Boolean(
    record &&
      record.sourceKind === 'captions' &&
      record.resultKind === 'transcript' &&
      record.segments.length > 0 &&
      record.speakers.length === 0 &&
      record.transcriptionTaskId.startsWith('captions:')
  )

/**
 * Latest finished ASR transcript for a download, if one has words or segments.
 *
 * @param store Store that can list every transcript for a download.
 * @param downloadTaskId Parent download id.
 */
export const latestAsrSeed = (
  store: { listForDownload: (downloadTaskId: string) => TranscriptRecord[] },
  downloadTaskId: string
): PipelineSeed | null => {
  const record = store
    .listForDownload(downloadTaskId)
    .find(
      (row) =>
        row.sourceKind === 'asr' && row.resultKind === 'transcript' && row.segments.length > 0
    )
  return pipelineSeedFromRecord(record ?? null)
}

const isOriginalCaptionImport = (row: TranscriptRecord): boolean =>
  row.transcriptionTaskId.startsWith('captions:') &&
  row.resultKind === 'transcript' &&
  row.segments.length > 0

/**
 * Original subtitle-import row for a download: newest `captions:` task, matching
 * `language` when that exists. History is newest-first from `listForDownload`.
 */
const originalCaptionImportSeed = (
  store: { listForDownload: (downloadTaskId: string) => TranscriptRecord[] },
  downloadTaskId: string,
  language: string | null
): PipelineSeed | null => {
  const rows = store.listForDownload(downloadTaskId).filter(isOriginalCaptionImport)
  const matched = language ? rows.find((row) => row.language === language) : undefined
  return pipelineSeedFromRecord(matched ?? rows[0] ?? null)
}

/**
 * Seed speaker overlay from the current transcript, captions or ASR.
 *
 * Caption rediarize prefers the original subtitle-import row (`captions:` task
 * id) so a collapsed overlay cannot poison the next pass. ASR rediarize still
 * uses the latest ASR row.
 *
 * @param store Store that can read the current row and list history.
 * @param downloadTaskId Parent download id.
 */
export const latestTranscriptSeed = (
  store: {
    getLatestForDownload?: (downloadTaskId: string) => TranscriptRecord | null
    listForDownload: (downloadTaskId: string) => TranscriptRecord[]
  },
  downloadTaskId: string
): PipelineSeed | null => {
  const latest = store.getLatestForDownload?.(downloadTaskId) ?? null
  if (latest?.sourceKind === 'captions') {
    const original = originalCaptionImportSeed(store, downloadTaskId, latest.language)
    if (original) {
      return original
    }
  }
  return pipelineSeedFromRecord(latest) ?? latestAsrSeed(store, downloadTaskId)
}

/**
 * Flatten a stored ASR record into the seed the pipeline overlays speakers on.
 *
 * @param record Latest ASR transcript, or null when nothing is reusable.
 */
export const pipelineSeedFromRecord = (record: TranscriptRecord | null): PipelineSeed | null => {
  if (record?.resultKind !== 'transcript' || record.segments.length === 0) {
    return null
  }
  const speakerKeyById = new Map(record.speakers.map((speaker) => [speaker.id, speaker.speakerKey]))
  return {
    language: record.language,
    modelVersion: record.modelVersion,
    asrTier: record.asrTier,
    sourceKind: record.sourceKind,
    speakers: record.speakers.map((speaker) => ({
      speakerKey: speaker.speakerKey,
      displayName: speaker.displayName
    })),
    segments: record.segments.map((segment) => ({
      speakerKey: segment.speakerId ? (speakerKeyById.get(segment.speakerId) ?? null) : null,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      words: segment.words,
      confidence: segment.confidence
    }))
  }
}

/**
 * Persist a seed next to the worker work dir.
 *
 * @param filePath Destination JSON path.
 * @param seed Existing ASR transcript.
 */
export const writePipelineSeed = (filePath: string, seed: PipelineSeed): void => {
  atomicWriteJson(filePath, seed)
}

/**
 * Load a seed written for a rediarize worker job.
 *
 * @param filePath Seed JSON path.
 */
export const loadPipelineSeed = (filePath: string): PipelineSeed | null => {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PipelineSeed
    if (!Array.isArray(parsed?.segments) || parsed.segments.length === 0) {
      return null
    }
    return {
      language: parsed.language ?? null,
      modelVersion: typeof parsed.modelVersion === 'string' ? parsed.modelVersion : '',
      asrTier: parsed.asrTier ?? null,
      sourceKind:
        parsed.sourceKind === 'captions' || parsed.sourceKind === 'asr'
          ? parsed.sourceKind
          : undefined,
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers : [],
      segments: parsed.segments
    }
  } catch {
    return null
  }
}

/**
 * Exclusive end of the last seed segment, used when audio is not extracted.
 *
 * @param seed Existing ASR transcript.
 */
export const seedDurationMs = (seed: PipelineSeed): number =>
  seed.segments.reduce((max, segment) => Math.max(max, segment.endMs), 0)

/**
 * Re-label an existing transcript with new diarization turns. Words are kept.
 *
 * @param segments Finished ASR segments.
 * @param turns Fresh speaker turns from diarization.
 */
export const assignSpeakersToSegments = (
  segments: PipelineSegment[],
  turns: TimedTurn[]
): { speakers: PipelineSpeaker[]; segments: PipelineSegment[] } => {
  const endMs = segments.reduce((max, segment) => Math.max(max, segment.endMs), 0)
  const effectiveTurns = turns.length > 0 ? turns : singleSpeakerTurns(endMs)
  const tokens = flattenTokens(segments)
  const labeled = tokens.map((token) => ({
    ...token,
    speakerKey: speakerForInterval(effectiveTurns, token.startMs, token.endMs)
  }))
  const next = groupTokens(labeled)
  return { speakers: speakersFromSegments(next), segments: next }
}

const isGiantPiece = (text: string, durationMs: number): boolean =>
  durationMs > GIANT_TOKEN_MS || charCount(text) > GIANT_TOKEN_CHARS

const splitSecondaryPunctuation = (text: string): string[] => {
  const parts = text.match(SECONDARY_PUNCT_PARTS)
  if (!parts) {
    return [text]
  }
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

const splitEvenWindows = (text: string, parts: number): string[] => {
  const chars = [...text]
  if (parts <= 1 || chars.length === 0) {
    return text ? [text] : []
  }
  const size = Math.max(1, Math.ceil(chars.length / parts))
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(''))
  }
  return out
}

/**
 * Last-resort split for a wordless giant piece: secondary punctuation, then
 * ~50-character windows (and extra slices if duration would still exceed 30s).
 */
const splitOversizedPiece = (text: string, durationMs: number): string[] => {
  const punctuated = splitSecondaryPunctuation(text)
  const pieces = punctuated.length > 0 ? punctuated : [text]
  const totalWeight = pieces.reduce((sum, part) => sum + charCount(part), 0) || 1
  const out: string[] = []
  for (const piece of pieces) {
    const share = (Math.max(1, charCount(piece)) / totalWeight) * durationMs
    if (!isGiantPiece(piece, share)) {
      out.push(piece)
      continue
    }
    const windows = Math.max(
      Math.ceil(charCount(piece) / FALLBACK_TOKEN_CHARS),
      Math.ceil(share / GIANT_TOKEN_MS),
      1
    )
    out.push(...splitEvenWindows(piece, windows))
  }
  return out.length > 0 ? out : [text]
}

const apportionWordless = (
  segment: PipelineSegment,
  pieces: readonly string[]
): LabeledToken[] => {
  const duration = Math.max(1, segment.endMs - segment.startMs)
  const totalWeight = pieces.reduce((sum, part) => sum + charCount(part), 0) || 1
  const tokens: LabeledToken[] = []
  let seen = 0
  for (const part of pieces) {
    const weight = Math.max(1, charCount(part))
    const startMs = segment.startMs + (seen / totalWeight) * duration
    seen += weight
    const endMs = segment.startMs + (seen / totalWeight) * duration
    tokens.push({
      startMs: Math.round(startMs),
      endMs: Math.round(Math.max(startMs + 1, endMs)),
      text: part,
      confidence: segment.confidence,
      speakerKey: segment.speakerKey,
      timed: false
    })
  }
  return tokens
}

/**
 * Turn stored segments into a time-ordered token stream (words, or the whole line).
 *
 * @param segments Existing ASR segments.
 */
const flattenTokens = (segments: PipelineSegment[]): LabeledToken[] => {
  const tokens: LabeledToken[] = []
  for (const segment of segments) {
    if (segment.words && segment.words.length > 0) {
      for (const word of segment.words) {
        tokens.push({
          startMs: word.startMs,
          endMs: word.endMs,
          text: word.text,
          confidence: segment.confidence,
          speakerKey: segment.speakerKey,
          timed: true
        })
      }
      continue
    }
    const duration = Math.max(1, segment.endMs - segment.startMs)
    const sentences = splitCaptionSentences(segment.text)
    const pieces = sentences.length > 0 ? sentences : segment.text.trim() ? [segment.text] : []
    const sentenceWeight = pieces.reduce((sum, part) => sum + charCount(part), 0) || 1
    const expanded: string[] = []
    for (const piece of pieces) {
      const share = (Math.max(1, charCount(piece)) / sentenceWeight) * duration
      if (isGiantPiece(piece, share)) {
        expanded.push(...splitOversizedPiece(piece, share))
      } else {
        expanded.push(piece)
      }
    }
    tokens.push(...apportionWordless(segment, expanded.length > 0 ? expanded : pieces))
  }
  return tokens.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/**
 * Pick the speaker whose turn overlaps this interval the most.
 *
 * @param turns Diarization turns.
 * @param startMs Token start.
 * @param endMs Token end.
 */
const speakerForInterval = (turns: TimedTurn[], startMs: number, endMs: number): string | null => {
  let bestKey: string | null = null
  let bestOverlap = 0
  for (const turn of turns) {
    const overlap = Math.min(endMs, turn.endMs) - Math.max(startMs, turn.startMs)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestKey = turn.speakerKey
    }
  }
  if (bestOverlap > 0) {
    return bestKey === 'unknown' ? null : bestKey
  }
  const mid = (startMs + endMs) / 2
  let nearestKey: string | null = null
  let nearestGap = Number.POSITIVE_INFINITY
  for (const turn of turns) {
    const gap = mid < turn.startMs ? turn.startMs - mid : mid > turn.endMs ? mid - turn.endMs : 0
    if (gap < nearestGap) {
      nearestGap = gap
      nearestKey = turn.speakerKey
    }
  }
  return nearestKey === 'unknown' ? null : nearestKey
}

/**
 * True when this token should open a new display row instead of merging.
 */
const shouldStartNewSegment = (last: PipelineSegment, token: LabeledToken): boolean => {
  if (last.speakerKey !== token.speakerKey) {
    return true
  }
  if (endsCaptionSentence(last.text)) {
    return true
  }
  if (token.startMs - last.endMs > PARAGRAPH_GAP_MS) {
    return true
  }
  if ([...last.text].length >= MAX_SEGMENT_CHARS) {
    return true
  }
  return last.endMs - last.startMs >= MAX_SEGMENT_MS
}

/**
 * Merge consecutive same-speaker tokens back into display segments.
 *
 * @param tokens Words (or whole lines) with a speaker label.
 */
const groupTokens = (tokens: LabeledToken[]): PipelineSegment[] => {
  const segments: PipelineSegment[] = []
  for (const token of tokens) {
    const last = segments.at(-1)
    const lastTimed = Boolean(last?.words && last.words.length > 0)
    if (last && !shouldStartNewSegment(last, token)) {
      last.endMs = token.endMs
      if (lastTimed && token.timed) {
        const words = last.words ?? []
        words.push({ startMs: token.startMs, endMs: token.endMs, text: token.text })
        last.words = words
        last.text = words.map((word) => word.text).join('')
      } else {
        last.words = []
        last.text = joinCaptionText(last.text, token.text)
      }
      continue
    }
    segments.push({
      speakerKey: token.speakerKey,
      startMs: token.startMs,
      endMs: token.endMs,
      text: token.text,
      words: token.timed ? [{ startMs: token.startMs, endMs: token.endMs, text: token.text }] : [],
      confidence: token.confidence
    })
  }
  return segments
}

/**
 * Number speakers in first-appearance order for the transcript UI.
 *
 * @param segments Relabeled segments.
 */
const speakersFromSegments = (segments: PipelineSegment[]): PipelineSpeaker[] => {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const segment of segments) {
    if (segment.speakerKey && !seen.has(segment.speakerKey)) {
      seen.add(segment.speakerKey)
      keys.push(segment.speakerKey)
    }
  }
  return keys.map((speakerKey, index) => ({
    speakerKey,
    displayName: speakerKey === 'unknown' ? 'Unknown speaker' : `Speaker ${index + 1}`
  }))
}
