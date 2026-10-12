import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Heart, Image, MessageCircle, MessageSquare, Music2, Play, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn, formatCount, formatDate, formatDuration } from '@/lib/utils'
import type { MediaStats } from '../../../shared/contracts'

export type MediaKind = 'video' | 'audio' | 'image'
export type MediaCardProps = MediaStats & {
  title: string
  kind: MediaKind
  thumbnail?: string
  duration?: number
  selected: boolean
  onSelectedChange: (selected: boolean) => void
  // Whatever the surface wants on the right of the row: a quality badge, a status, an action.
  trailing?: ReactNode
  // Why this item cannot be picked, when it cannot - a paid episode. It is shown dimmed with the
  // reason on it, and a click reaches onLocked instead of the checkbox.
  locked?: string
  onLocked?: () => void
  // The download's size at the chosen quality, already worded ('约 12.3 MB'); left off where unknown.
  size?: string
  // Watching the item before downloading it; left off where there is nothing to watch.
  onPreview?: () => void
  // What the item is called on screen where its kind alone would say the wrong thing: a video shown
  // as its cover is a '封面', not a '图片'.
  label?: string
  className?: string
}

// A locked item's click is caught before the label hands it to the checkbox.
const lockedClick = (locked: string | undefined, onLocked: (() => void) | undefined) =>
  locked ? (event: React.MouseEvent) => { event.preventDefault(); onLocked?.() } : undefined

// The preview button sits inside the card's label, so its click must not also tick the checkbox.
const previewClick = (onPreview: () => void) => (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); onPreview() }

// The picked card is the one the eye should land on first, so it carries the only hue on the screen.
// Rings rather than borders, so a card can sit on any surface without its own edge shifting the layout.
export const cardOutline = (selected = false) => cn(
  'transition',
  selected ? 'ring-2 ring-selection' : 'ring-1 ring-border-strong hover:ring-selection/50',
)

// Every surface shows the same cover: the platform's thumbnail while it loads, its kind once it cannot.
// The caller owns the size: a cover that sized itself to its parent would grow to the whole card once
// the grid stretched that card, and swallow the text below it.
export function MediaCover({ kind, thumbnail, alt = '', className, children }: { kind: MediaKind; thumbnail?: string; alt?: string; className?: string; children?: ReactNode }) {
  const [broken, setBroken] = useState(false)
  const source = thumbnail && /^https?:/.test(thumbnail) ? thumbnail : undefined
  const Icon = kind === 'image' ? Image : kind === 'audio' ? Music2 : Video
  return <div className={cn('relative grid place-items-center overflow-hidden bg-muted text-muted-foreground', className)}>
    {!broken && source
      ? <img className="size-full object-cover" src={source} referrerPolicy="no-referrer" alt={alt} loading="lazy" onError={() => setBroken(true)} />
      : <Icon className="size-5" aria-hidden="true" />}
    {children}
  </div>
}

// One column rule for every card grid: the window decides how many fit, not a table of breakpoints.
export function MediaGrid({ minWidth, className, children }: { minWidth: string; className?: string; children: ReactNode }) {
  return <div className={cn('grid gap-3', className)} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}, 1fr))` }}>{children}</div>
}

function Stat({ icon, value }: { icon: ReactNode; value: number }) {
  return <span className="inline-flex items-center gap-0.5">{icon}{formatCount(value)}</span>
}

// Counts the platform did not report are left out rather than shown as zero, which would be a claim.
export function MediaStatsRow({ views, danmaku, comments, likes, className }: MediaStats & { className?: string }) {
  const stats = [
    views !== undefined && <Stat key="views" icon={<Play className="size-3 fill-current" />} value={views} />,
    danmaku !== undefined && <Stat key="danmaku" icon={<MessageSquare className="size-3" />} value={danmaku} />,
    comments !== undefined && <Stat key="comments" icon={<MessageCircle className="size-3" />} value={comments} />,
    likes !== undefined && <Stat key="likes" icon={<Heart className="size-3" />} value={likes} />,
  ].filter(Boolean)
  if (!stats.length) return null
  // '139万' breaks between the digits and the unit if the line is allowed to wrap, so it never is.
  return <span className={cn('inline-flex items-center gap-2 overflow-hidden text-[11px] whitespace-nowrap tabular-nums', className)}>{stats}</span>
}

export function MediaCard({ title, kind, thumbnail, duration, selected, onSelectedChange, trailing, className, locked, onLocked, size, onPreview, label, ...stats }: MediaCardProps) {
  const { t } = useTranslation(['result', 'common'])
  const hasOverlay = duration !== undefined || [stats.views, stats.danmaku, stats.comments, stats.likes].some(value => value !== undefined)
  // No author on a card: a listing is one creator's, and the result's title already says whose.
  const footer = stats.publishedAt ? formatDate(stats.publishedAt) : ''
  return <label aria-disabled={locked ? true : undefined} onClick={lockedClick(locked, onLocked)} className={cn('group block cursor-pointer overflow-hidden rounded-xl bg-card', cardOutline(selected), locked && 'cursor-not-allowed opacity-60 hover:ring-border-strong', className)}>
    <MediaCover kind={kind} thumbnail={thumbnail} alt={title} className={cn('[&_img]:transition [&_img]:group-hover:scale-105', kind === 'image' ? 'aspect-square' : 'aspect-video')}>
      <Checkbox
        className="absolute top-2 left-2 z-10 border-white/80 bg-black/55 text-white shadow-sm shadow-black/40 data-checked:border-selection data-checked:bg-selection data-checked:text-selection-foreground dark:bg-black/55 dark:data-checked:bg-selection"
        checked={selected && !locked} disabled={Boolean(locked)} onCheckedChange={checked => onSelectedChange(checked === true)} aria-label={t('card.select', { title })}
      />
      {/* What the file is, on every card: a listing mixes pictures and clips, and the cover alone does
          not say which. A locked card's reason sits beside it. */}
      <span className="absolute top-2 right-2 z-10 flex gap-1 text-[11px] text-white">
        {locked && <span className="rounded-md bg-black/65 px-1.5 py-0.5">{locked}</span>}
        <span className="rounded-md bg-black/65 px-1.5 py-0.5">{label ?? t(`common:kinds.${kind === 'image' ? 'picture' : kind}`)}</span>
      </span>
      {onPreview && <button
        type="button" aria-label={t('card.preview', { title })} title={t('preview')} onClick={previewClick(onPreview)}
        className="absolute top-1/2 left-1/2 z-10 grid size-10 -translate-1/2 place-items-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/80 focus-visible:opacity-100"
      ><Play className="size-4 fill-current" /></button>}
      {/* One gradient carries both the counts and the duration, the way a listing thumbnail reads on the platform itself. */}
      {hasOverlay && <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1.5 bg-gradient-to-t from-black/75 to-transparent px-2 pt-6 pb-1.5 text-white">
        <MediaStatsRow {...stats} className="min-w-0" />
        {duration !== undefined && <span className="shrink-0 text-[11px] whitespace-nowrap tabular-nums">{formatDuration(duration)}</span>}
      </div>}
    </MediaCover>
    <div className="grid gap-1 p-2">
      <p className="line-clamp-2 text-xs font-medium">{title}</p>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{footer || label || t(`common:kinds.${kind}`)}</span>
        {size && <span className="shrink-0 tabular-nums">{size}</span>}
        {trailing}
      </div>
    </div>
  </label>
}

export function MediaRow({ title, kind, thumbnail, duration, selected, onSelectedChange, trailing, className, locked, onLocked, size, onPreview, label, ...stats }: MediaCardProps) {
  const { t } = useTranslation(['result', 'common'])
  const meta = [duration !== undefined ? formatDuration(duration) : label || t(`common:kinds.${kind}`), size, stats.publishedAt ? formatDate(stats.publishedAt) : ''].filter(Boolean).join(' · ')
  return <label aria-disabled={locked ? true : undefined} onClick={lockedClick(locked, onLocked)} className={cn('flex cursor-pointer items-center gap-3 rounded-lg p-3', cardOutline(selected), selected && 'bg-selection/5', !selected && !locked && 'hover:bg-muted/50', locked && 'cursor-not-allowed opacity-60 hover:ring-border-strong', className)}>
    <Checkbox
      className="data-checked:border-selection data-checked:bg-selection data-checked:text-selection-foreground dark:data-checked:bg-selection"
      checked={selected && !locked} disabled={Boolean(locked)} onCheckedChange={checked => onSelectedChange(checked === true)} aria-label={t('card.select', { title })}
    />
    <MediaCover kind={kind} thumbnail={thumbnail} className={cn('shrink-0 rounded-md', kind === 'image' ? 'size-14' : 'h-14 w-20')} />
    <span className="min-w-0 flex-1">
      <span className="line-clamp-2 text-sm">{title}</span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{meta}</span>
        <MediaStatsRow {...stats} />
      </span>
    </span>
    {onPreview && <Button variant="ghost" size="icon-sm" aria-label={t('card.preview', { title })} title={t('preview')} onClick={previewClick(onPreview)}><Play /></Button>}
    {locked ? <span className="shrink-0 text-xs text-muted-foreground">{locked}</span> : trailing}
  </label>
}
