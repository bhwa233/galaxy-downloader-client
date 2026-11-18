import { z } from 'zod'

// The UI gets capabilities from this catalogue; platform request rules remain in main.
export const subscriptionPlatforms = {
  bilibili: { types: ['video'] },
  douyin: { types: ['video', 'image'] },
  youtube: { types: ['video', 'shorts'] },
} as const
export type SubscriptionPlatform = keyof typeof subscriptionPlatforms
export const subscriptionType = z.enum(['video', 'image', 'shorts'])
export type SubscriptionType = z.infer<typeof subscriptionType>
const webUrl = z.url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
})
export const subscriptionSourceSchema = z.object({
  id: z.string().uuid(), platform: z.enum(['bilibili', 'douyin', 'youtube']),
  accountId: z.string().min(1).max(300), url: webUrl, name: z.string().min(1).max(300),
  avatar: webUrl.optional(), types: z.array(subscriptionType).min(1).max(3),
  enabled: z.boolean(), notify: z.boolean(), createdAt: z.number(),
  lastCheckedAt: z.number().optional(), lastSuccessAt: z.number().optional(), nextCheckAt: z.number(),
  status: z.enum(['idle', 'checking', 'ready', 'needs-login', 'failed', 'partial']),
  error: z.string().optional(), latestTitle: z.string().optional(),
})
export type SubscriptionSource = z.infer<typeof subscriptionSourceSchema>
export const subscriptionItemSchema = z.object({
  id: z.string().uuid(), sourceId: z.string().uuid(), mediaId: z.string().min(1).max(500),
  url: webUrl, title: z.string().max(3000), thumbnail: webUrl.optional(),
  type: subscriptionType, duration: z.number().nonnegative().optional(),
  publishedAt: z.number().optional(), discoveredAt: z.number(), read: z.boolean(),
})
export type SubscriptionItem = z.infer<typeof subscriptionItemSchema>
export type SubscriptionCandidate = {
  token: string; platform: SubscriptionPlatform; accountId: string; url: string; name: string;
  avatar?: string; types: SubscriptionType[]; recent: Pick<SubscriptionItem, 'title' | 'thumbnail' | 'type'>[];
}
export type SubscriptionState = {
  sources: SubscriptionSource[]; items: SubscriptionItem[]; checking: boolean;
  schedule?: {
    nextCheckAt: number; lastCheckedAt?: number;
    result?: { succeeded: number; failed: number; skipped: number };
    progress?: { completed: number; total: number };
  };
  focus?: { token: string; sourceId: string };
  resolveLogin?: { url: string; verify: boolean };
}
