import { z } from 'zod'
import type { Format, Settings } from './contracts'

export const videoTierSchema = z.object({
  edge: z.number().int().positive(),
  fps: z.number().positive().optional(),
  variant: z.string().min(1).max(40).optional(),
})

export type VideoTier = z.infer<typeof videoTierSchema>
type Dimensions = Pick<Format, 'width' | 'height'>
export type ExactVideoQuality = Required<Dimensions> & Pick<Format, 'fps' | 'variant'>
const nominalRates = [24, 25, 30, 48, 50, 60, 90, 100, 120, 144, 240]

export function videoRateClass(fps?: number): number | undefined {
  return fps === undefined ? undefined : nominalRates.find(rate => Math.abs(fps - rate) <= rate * 0.02) ?? fps
}

function shortEdge({ width, height }: Dimensions): number | undefined {
  return width && height ? Math.min(width, height) : undefined
}

function fitsVideoCap({ width, height }: Dimensions, cap?: number): boolean {
  return cap === undefined || Math.min(width ?? Infinity, height ?? Infinity) <= cap
}

export function videoTierOf(format: Format): VideoTier | undefined {
  const edge = shortEdge(format)
  return edge ? { edge, fps: videoRateClass(format.fps), variant: format.variant } : undefined
}

export function exactVideoQualityOf({ width, height, fps, variant }: Format): ExactVideoQuality | undefined {
  return width && height ? { width, height, fps: videoRateClass(fps), variant } : undefined
}

export function videoTierKey({ edge, fps, variant }: VideoTier): string {
  return `${edge}:${fps ?? ''}:${variant ?? ''}`
}

export function compareVideoFormats(first: Format, second: Format): number {
  const edge = (format: Format) => shortEdge(format) ?? (format.height || format.width || 0)
  return edge(second) - edge(first)
    || Number(Boolean(shortEdge(second))) - Number(Boolean(shortEdge(first)))
    || (videoRateClass(second.fps) ?? 0) - (videoRateClass(first.fps) ?? 0)
    || Math.max(second.width ?? 0, second.height ?? 0) - Math.max(first.width ?? 0, first.height ?? 0)
    || Number(Boolean(second.variant)) - Number(Boolean(first.variant))
}

export function chooseVideoFormat(formats: Format[], { cap, formatId = 'best', exact, target, preference = 'best' }: {
  cap?: number; formatId?: string; exact?: ExactVideoQuality; target?: VideoTier; preference?: Settings['videoQuality']
} = {}): Format | undefined {
  const eligible = cap === undefined ? formats : formats.filter(format => fitsVideoCap(format, cap))
  if (exact) {
    const matches = eligible.filter(format => format.width === exact.width && format.height === exact.height
      && videoRateClass(format.fps) === exact.fps && format.variant === exact.variant)
    return matches.find(format => format.id === formatId) ?? matches[0]
  }
  if (formatId !== 'best') return eligible.find(format => format.id === formatId)
  if (!target) {
    const described = eligible.filter(format => format.width || format.height || format.fps || format.variant)
    return preference === 'lowest' ? described.at(-1) : described[0]
  }
  return eligible.find(format => {
    const tier = videoTierOf(format)
    return tier && videoTierKey(tier) === videoTierKey(target)
  }) ?? eligible.find(format => {
    const tier = videoTierOf(format)
    return tier && tier.edge <= target.edge
      && (tier.edge < target.edge || target.fps === undefined || tier.fps !== undefined && tier.fps <= target.fps)
      && (!tier.variant || tier.variant === target.variant)
  })
}
