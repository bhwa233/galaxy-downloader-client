import { z } from 'zod'

export const modelIds = ['minimal', 'whisper-base', 'balanced', 'whisper-medium', 'whisper-turbo', 'sense-voice', 'sense-voice-2025', 'parakeet-v2', 'parakeet-v3', 'quality', 'qwen3-1.7b', 'fire-red-asr', 'orukeet'] as const
export const modelId = z.enum(modelIds)
export const speakerCount = z.union([z.literal('auto'), z.number().int().min(1).max(8)])
export const captionLanguages = z.array(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)).min(1).max(5).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length)
export type ModelId = typeof modelIds[number]
export type Word = { text: string; startMs: number; endMs: number }
export type Caption = { id: string; text: string; startMs: number; endMs: number; speakerId: string | null; words?: Word[] }
export type Speaker = { id: string; name: string }
export type CaptionTrack = { id: string; language: string; source: 'platform' | 'file' | 'asr'; name: string }
export type ProcessingStatus = 'idle' | 'queued' | 'running' | 'waiting-model' | 'completed' | 'failed' | 'cancelled'
export type ProcessingSummary = { id: string; title: string; sourceName: string; jobId?: string; durationSeconds: number; status: ProcessingStatus; stage?: string; progress?: number; error?: string; updatedAt: string; captionCount: number; language?: string; model?: ModelId }
export type ProcessingDocument = ProcessingSummary & { revision: number; captions: Caption[]; speakers: Speaker[]; tracks: CaptionTrack[]; activeTrack?: string; exports: { name: string; createdAt: string }[] }
export type ModelStatus = { id: ModelId | 'speaker'; name: string; family: string; ready: boolean; downloading: boolean; phase?: 'downloading' | 'unpacking' | 'verifying'; bytes: number; expectedBytes: number; progress?: number; error?: string; recommended: boolean; license: string; languages: string[] }
export type ProcessingSource = { jobId: string; title: string; sourceName: string }
export type ProcessingState = { documents: ProcessingSummary[]; sources?: ProcessingSource[]; models: ModelStatus[]; runtime: string }
export const captionPatch = z.object({ id: z.string().uuid(), revision: z.number().int().nonnegative(), captionId: z.string(), text: z.string().max(20000), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), speakerId: z.string().nullable() }).refine(value => value.endMs > value.startMs)

export type KernelState = { status: 'idle' | 'checking' | 'downloading' | 'error'; version?: string; previous?: string; progress?: number; error?: string; checkedAt?: string }
