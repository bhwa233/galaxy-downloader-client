// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
export const SPEAKER_COUNT_CHOICES = ['auto', 1, 2, 3, 4, 5, 6, 7, 8] as const

export type SpeakerCount = (typeof SPEAKER_COUNT_CHOICES)[number]

export const DEFAULT_SPEAKER_COUNT: SpeakerCount = 'auto'

export const MAX_SPEAKER_COUNT = 8

/**
 * Return true when the value is a supported speaker-count setting.
 *
 * @param value Raw setting or task option.
 */
export const isSpeakerCount = (value: unknown): value is SpeakerCount => {
  if (value === 'auto') {
    return true
  }
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SPEAKER_COUNT
  )
}

/**
 * Coerce an unknown setting/task value to a speaker count. Default is auto.
 *
 * @param value Raw setting or task option.
 * @param fallback Value used when parsing fails.
 */
export const parseSpeakerCount = (
  value: unknown,
  fallback: SpeakerCount = DEFAULT_SPEAKER_COUNT
): SpeakerCount => {
  if (value === 'auto' || value === '' || value == null) {
    return 'auto'
  }
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (n === 0) {
    return 'auto'
  }
  if (Number.isInteger(n) && n >= 1 && n <= MAX_SPEAKER_COUNT) {
    return n as SpeakerCount
  }
  return fallback
}

/**
 * Map a product speaker count onto sherpa `numClusters` (-1 means auto).
 *
 * @param count Parsed speaker-count setting.
 */
export const sherpaNumClusters = (count: SpeakerCount): number => (count === 'auto' ? -1 : count)
