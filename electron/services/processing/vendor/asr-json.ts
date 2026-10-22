// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import type { AsrRecognizerResult } from './asr-words'

const CONTROL_ESCAPE: Record<number, string> = {
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r'
}

/**
 * True when JSON.parse failed because a string contained a raw control char.
 *
 * @param error Thrown value from JSON.parse.
 */
export const isJsonControlCharError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /control character in string literal/i.test(message)
}

/**
 * Escape U+0000–U+001F that sherpa-onnx left raw inside JSON string literals.
 *
 * Native `getOfflineStreamResultAsJson` can emit movie-dialogue newlines
 * without `\\n`, which V8 rejects at parse time.
 *
 * @param raw JSON text from sherpa-onnx.
 */
export const escapeJsonStringControlChars = (raw: string): string => {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of raw) {
    const code = char.charCodeAt(0)
    if (!inString) {
      if (char === '"') {
        inString = true
      }
      out += char
      continue
    }
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === '\\') {
      out += char
      escaped = true
      continue
    }
    if (char === '"') {
      inString = false
      out += char
      continue
    }
    if (code <= 0x1f) {
      out += CONTROL_ESCAPE[code] ?? `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  return out
}

/**
 * Parse sherpa-onnx ASR JSON, repairing unescaped control characters first.
 *
 * @param raw JSON text from `getOfflineStreamResultAsJson`.
 */
export const parseAsrResultJson = (raw: string): AsrRecognizerResult => {
  try {
    return JSON.parse(raw) as AsrRecognizerResult
  } catch (error) {
    if (!isJsonControlCharError(error)) {
      throw error
    }
    return JSON.parse(escapeJsonStringControlChars(raw)) as AsrRecognizerResult
  }
}

/**
 * Run `fn` with JSON.parse that retries after escaping raw control characters.
 *
 * sherpa-onnx-node calls JSON.parse internally inside `getResult`.
 *
 * @param fn Callback that may invoke JSON.parse.
 */
export const withSanitizedJsonParse = <T>(fn: () => T): T => {
  const original = JSON.parse
  const patched: typeof JSON.parse = (text, reviver) => {
    try {
      return original(text, reviver)
    } catch (error) {
      if (typeof text !== 'string' || !isJsonControlCharError(error)) {
        throw error
      }
      return original(escapeJsonStringControlChars(text), reviver)
    }
  }
  JSON.parse = patched
  try {
    return fn()
  } finally {
    JSON.parse = original
  }
}

/**
 * Read one offline ASR result, repairing sherpa-onnx JSON if needed.
 *
 * @param recognizer sherpa-onnx OfflineRecognizer.
 * @param stream Stream that has already been decoded.
 */
export const readAsrResult = <TStream>(
  recognizer: { getResult: (stream: TStream) => AsrRecognizerResult },
  stream: TStream
): AsrRecognizerResult => withSanitizedJsonParse(() => recognizer.getResult(stream))
