// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import type { AsrTierId } from './asr-tiers'
import type { PipelineSeed } from './speaker-assign'
import type { SpeakerCount } from './speaker-count'
import type { PipelineProgress, PipelineResult, PipelineSegment, TranscriptionStage } from './types'

export interface PipelineRunInput {
  sourceFilePath: string
  wavPath: string
  durationMs: number
  skipVad: boolean
  autoSkipAllowed: boolean
  signal?: AbortSignal
  onProgress?: (progress: PipelineProgress) => void
  onPartial?: (segment: PipelineSegment) => void
  manifestPath?: string
  asrTier?: AsrTierId
  /** UI/task language used for Chinese script and speaker-embedding choice. */
  language?: string
  /** Auto clustering unless the user pinned a speaker count on the detail page. */
  speakerCount?: SpeakerCount
  /** When set, re-label these ASR words instead of running recognition again. */
  existingTranscript?: PipelineSeed
}

export interface TranscriptionPipeline {
  run(input: PipelineRunInput): Promise<PipelineResult>
}

export const report = (
  input: PipelineRunInput,
  stage: TranscriptionStage,
  percent: number | null,
  message?: string
): void => {
  input.onProgress?.({ stage, percent, message })
}
