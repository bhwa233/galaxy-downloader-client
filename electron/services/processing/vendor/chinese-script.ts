// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import { Converter } from 'opencc-js'
import type { PipelineResult, PipelineSegment } from './types'

export type ChineseScript = 'hans' | 'hant'

const CJK = /[\u4e00-\u9fff]/
const JAPANESE_KANA = /[\u3040-\u309f\u30a0-\u30ff]/
const HANGUL = /[\uac00-\ud7af]/

let toHans: ((text: string) => string) | null = null
let toHant: ((text: string) => string) | null = null

/**
 * Return Simplified vs Traditional for a Chinese tag, or null when it is not Chinese.
 */
export const chineseScriptOf = (language: string): ChineseScript | null => {
  const normalized = language.trim().toLowerCase().replaceAll('_', '-')
  const base = normalized.split('-')[0] ?? ''
  if (base !== 'zh' && base !== 'cmn' && base !== 'zho' && base !== 'chi') {
    return null
  }
  if (
    normalized.includes('hant') ||
    normalized.endsWith('-tw') ||
    normalized.includes('-tw-') ||
    normalized.endsWith('-hk') ||
    normalized.includes('-hk-') ||
    normalized.endsWith('-mo') ||
    normalized.includes('-mo-')
  ) {
    return 'hant'
  }
  return 'hans'
}

/**
 * Keep Simplified vs Traditional Chinese as a post-ASR script preference.
 */
export const chineseScriptHint = (language?: string | null): string | undefined => {
  if (!language?.trim()) {
    return undefined
  }
  const script = chineseScriptOf(language)
  if (script === 'hant') {
    return 'zh-TW'
  }
  if (script === 'hans') {
    return 'zh'
  }
  return undefined
}

/**
 * True when this text looks like Chinese, not Japanese or Korean.
 */
export const looksLikeChinese = (text: string): boolean => {
  if (!CJK.test(text)) {
    return false
  }
  return !(JAPANESE_KANA.test(text) || HANGUL.test(text))
}

/**
 * Count how many characters differ between two equal-length strings, extra tail included.
 *
 * @param from Original sample.
 * @param to Converted sample.
 */
const changedChars = (from: string, to: string): number => {
  const limit = Math.max(from.length, to.length)
  let count = 0
  for (let index = 0; index < limit; index += 1) {
    if (from[index] !== to[index]) {
      count += 1
    }
  }
  return count
}

/**
 * Infer Simplified vs Traditional from caption text. Null when the text is not Chinese.
 *
 * @param text Caption document or joined cue text.
 */
export const chineseScriptFromText = (text: string): ChineseScript | null => {
  if (!looksLikeChinese(text)) {
    return null
  }
  const sample = text.replace(/\s+/g, ' ').trim().slice(0, 500)
  const asHans = applyChineseScript(sample, 'hans')
  const asHant = applyChineseScript(sample, 'hant')
  const hansChanged = changedChars(sample, asHans)
  const hantChanged = changedChars(sample, asHant)
  if (hansChanged > hantChanged) {
    return 'hant'
  }
  if (hantChanged > hansChanged) {
    return 'hans'
  }
  return 'hans'
}

/**
 * Convert Chinese text to Simplified or Traditional. Other languages are left unchanged.
 */
export const applyChineseScript = (
  text: string,
  script: ChineseScript | null | undefined
): string => {
  if (!(text && script && looksLikeChinese(text))) {
    return text
  }
  if (script === 'hant') {
    toHant ??= Converter({ from: 'cn', to: 'tw' })
    return toHant(text)
  }
  toHans ??= Converter({ from: 't', to: 'cn' })
  return toHans(text)
}

/**
 * Convert one transcript segment, including word timings, to the UI Chinese script.
 */
export const applyChineseScriptToSegment = (
  segment: PipelineSegment,
  script: ChineseScript | null | undefined
): PipelineSegment => {
  if (!script) {
    return segment
  }
  return {
    ...segment,
    text: applyChineseScript(segment.text, script),
    words: segment.words?.map((word) => ({
      ...word,
      text: applyChineseScript(word.text, script)
    }))
  }
}

/**
 * Language tag to store after Chinese script conversion.
 */
export const languageAfterChineseScript = (
  segments: Array<{ text: string }>,
  script: ChineseScript | null | undefined
): string | null => {
  if (!segments.some((segment) => looksLikeChinese(segment.text))) {
    return null
  }
  return script === 'hant' ? 'zh-TW' : 'zh'
}

/**
 * Convert Chinese segments in a pipeline result to the UI script preference.
 */
export const applyChineseScriptToResult = (
  result: PipelineResult,
  script: ChineseScript | null | undefined
): PipelineResult => {
  if (!script) {
    const language = languageAfterChineseScript(result.segments, null)
    return language && language !== result.language ? { ...result, language } : result
  }
  const segments = result.segments.map((segment) => applyChineseScriptToSegment(segment, script))
  return {
    ...result,
    language: languageAfterChineseScript(segments, script) ?? result.language,
    segments
  }
}
