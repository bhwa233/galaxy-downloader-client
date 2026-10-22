// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import type { TranscriptWord } from './types'

/** CT-Transformer window size: one addPunct call per batch, not per cue. */
export const PUNCT_WINDOW_CHARS = 600

/** Trigger restoration when sentence-end marks are rarer than this. */
export const PUNCT_SENTENCE_DENSITY_CHARS = 200

const CJK_OR_LATIN = /[\u4e00-\u9fffA-Za-z]/u
const SENTENCE_END = /[。！？!?…]/gu

export interface Punctuator {
  addPunct: (text: string) => string
}

/**
 * True when the text looks like speech and is missing usable sentence punctuation.
 *
 * SenseVoice and human captions already carry marks, so they skip restoration.
 */
export const needsPunctuation = (text: string): boolean => {
  if (!CJK_OR_LATIN.test(text)) {
    return false
  }
  const chars = [...text].length
  if (chars === 0) {
    return false
  }
  const ends = text.match(SENTENCE_END)?.length ?? 0
  if (ends === 0) {
    return true
  }
  return chars / ends > PUNCT_SENTENCE_DENSITY_CHARS
}

/**
 * Treat `original` as a strict character subsequence of `punctuated`.
 *
 * Returns insertions of length `original.length + 1` (prefix, then after each
 * original character). Null when a character was rewritten or dropped.
 */
export const alignInsertions = (original: string, punctuated: string): string[] | null => {
  const source = [...original]
  const target = [...punctuated]
  const insertions = Array.from({ length: source.length + 1 }, () => '')
  let cursor = 0
  for (const [index, char] of source.entries()) {
    const start = cursor
    while (cursor < target.length && target[cursor] !== char) {
      cursor += 1
    }
    if (cursor >= target.length) {
      return null
    }
    insertions[index] = target.slice(start, cursor).join('')
    cursor += 1
  }
  insertions[source.length] = target.slice(cursor).join('')
  return insertions
}

/**
 * Run addPunct and keep the original text when alignment fails.
 */
export const punctuateText = (punct: Punctuator, text: string): string => {
  if (!needsPunctuation(text)) {
    return text
  }
  try {
    const punctuated = punct.addPunct(text)
    if (typeof punctuated !== 'string' || punctuated.length === 0) {
      return text
    }
    if (!alignInsertions(text, punctuated)) {
      return text
    }
    return punctuated
  } catch {
    return text
  }
}

/**
 * Attach inserted punctuation to the previous word. Timestamps stay as-is so
 * `words.map((word) => word.text).join('') === text` still holds.
 */
export const punctuateWords = (
  punct: Punctuator,
  text: string,
  words: TranscriptWord[] | undefined
): { text: string; words: TranscriptWord[] | undefined } => {
  if (!needsPunctuation(text)) {
    return { text, words }
  }
  if (!words || words.length === 0) {
    return { text: punctuateText(punct, text), words }
  }
  const joined = words.map((word) => word.text).join('')
  if (joined !== text) {
    return { text, words }
  }
  const punctuated = punctuateText(punct, text)
  if (punctuated === text) {
    return { text, words }
  }
  const insertions = alignInsertions(text, punctuated)
  if (!insertions) {
    return { text, words }
  }
  const nextWords = applyInsertions(
    words.map((word) => word.text),
    insertions
  ).map((next, index) => {
    const word = words[index]
    return word ? { ...word, text: next } : { startMs: 0, endMs: 0, text: next }
  })
  return { text: nextWords.map((word) => word.text).join(''), words: nextWords }
}

/**
 * Punctuate caption cues in windows so half-sentence rows are not each closed
 * with a period. Insertions at a cue boundary land on the previous cue's tail.
 */
export const punctuateCues = <T extends { text: string }>(punct: Punctuator, cues: T[]): T[] => {
  if (cues.length === 0) {
    return cues
  }
  const joined = cues.map((cue) => cue.text).join('')
  if (!needsPunctuation(joined)) {
    return cues
  }
  const next = cues.map((cue) => ({ ...cue }))
  let index = 0
  while (index < next.length) {
    let size = [...(next[index]?.text ?? '')].length
    let end = index + 1
    while (end < next.length) {
      const extra = [...(next[end]?.text ?? '')].length
      if (size + extra > PUNCT_WINDOW_CHARS) {
        break
      }
      size += extra
      end += 1
    }
    punctuateCueWindow(punct, next.slice(index, end))
    index = end
  }
  return next
}

/**
 * Rewrite one window of cue texts in place from a single addPunct call.
 */
const punctuateCueWindow = <T extends { text: string }>(punct: Punctuator, window: T[]): void => {
  if (window.length === 0) {
    return
  }
  const original = window.map((cue) => cue.text).join('')
  const punctuated = punctuateText(punct, original)
  if (punctuated === original) {
    return
  }
  const insertions = alignInsertions(original, punctuated)
  if (!insertions) {
    return
  }
  const texts = applyInsertions(
    window.map((cue) => cue.text),
    insertions
  )
  for (const [offset, cue] of window.entries()) {
    const text = texts[offset]
    if (text !== undefined) {
      cue.text = text
    }
  }
}

/**
 * Splice insertion strings into consecutive text parts (words or cues).
 */
const applyInsertions = (parts: string[], insertions: string[]): string[] => {
  let charIndex = 0
  let prefix = insertions[0] ?? ''
  return parts.map((part) => {
    const chars = [...part]
    let built = prefix
    prefix = ''
    for (const char of chars) {
      built += char + (insertions[charIndex + 1] ?? '')
      charIndex += 1
    }
    return built
  })
}
