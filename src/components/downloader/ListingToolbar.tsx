import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, Search, SlidersHorizontal, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Send } from '@/App'
import type { ListingQuery, MediaGroup } from '../../../shared/contracts'
import { listingQuerySchema } from '../../../shared/contracts'
import { publicationDate } from '../../../shared/filenames'
import { Choice } from './Choice'
import { DurationFilter, type DurationChoice } from './DurationFilter'

const emptyQuery = (): ListingQuery => listingQuerySchema.parse({})
const datePresets = ['week', 'month', 'quarter', 'thisYear', 'lastYear'] as const
type DatePreset = typeof datePresets[number]

// Calendar boundaries reuse the native date inputs and existing publication-date formatter.
function presetRange(period: DatePreset): { from: string; to: string } {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const finish = new Date(start)
  if (period === 'thisYear' || period === 'lastYear') {
    start.setFullYear(start.getFullYear() - (period === 'lastYear' ? 1 : 0), 0, 1)
    finish.setFullYear(start.getFullYear(), 11, 31)
  } else start.setDate(start.getDate() - ({ week: 6, month: 29, quarter: 89 } as const)[period])
  return { from: publicationDate(start.getTime() / 1000), to: publicationDate(finish.getTime() / 1000) }
}

export function ListingToolbar({ resultId, group, send }: { resultId: string; group: MediaGroup; send: Send }) {
  const { t } = useTranslation(['result', 'common'])
  const applied = group.search?.query || emptyQuery()
  const [draft, setDraft] = useState(applied)
  const [datesOpen, setDatesOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selectedPreset, setSelectedPreset] = useState<DatePreset>()
  const [duration, setDuration] = useState<DurationChoice>(draft.durationMin !== undefined || draft.durationMax !== undefined ? 'custom' : 'all')
  const running = group.search?.status === 'running'
  const filters = (query: ListingQuery) => Boolean(query.keyword || query.since !== undefined || query.before !== undefined || query.kind !== 'all' || query.durationMin !== undefined || query.durationMax !== undefined)
  const apply = (next = draft, scan = true) => {
    const normalized = listingQuerySchema.parse(next)
    setDraft(normalized)
    void send('media:query', { resultId, groupId: group.id, query: normalized, scan })
  }
  const change = (patch: Partial<ListingQuery>) => setDraft(current => ({ ...current, ...patch }))
  const clear = (patch: Partial<ListingQuery>) => { const next = { ...draft, ...patch }; apply(next, filters(next) || next.sort !== 'original') }
  // Native date inputs provide the platform's picker and keyboard handling. Date's calendar setters
  // give local day boundaries, including DST; no custom calendar/date arithmetic library is needed.
  const since = from ? new Date(`${from}T00:00:00`).getTime() / 1000 : undefined
  const end = to ? new Date(`${to}T00:00:00`) : undefined
  if (end) end.setDate(end.getDate() + 1)
  const before = end ? end.getTime() / 1000 : undefined
  const validDates = (since === undefined || Number.isFinite(since)) && (before === undefined || Number.isFinite(before)) && (since === undefined || before === undefined || since < before)
  const openDates = () => {
    const from = publicationDate(draft.since)
    const to = publicationDate(draft.before === undefined ? undefined : draft.before - 1)
    setFrom(from); setTo(to)
    setSelectedPreset(datePresets.find(period => { const range = presetRange(period); return range.from === from && range.to === to }))
    setDatesOpen(true)
  }
  const preset = (period: DatePreset) => {
    const range = presetRange(period)
    setFrom(range.from); setTo(range.to); setSelectedPreset(period)
  }
  const hasDates = draft.since !== undefined || draft.before !== undefined
  const dateLabel = hasDates ? `${publicationDate(draft.since) || t('query.unlimited')} – ${publicationDate(draft.before === undefined ? undefined : draft.before - 1) || t('query.unlimited')}` : t('periods.all')
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)
  const progress = group.search
  return <div className="flex flex-col gap-3">
    <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); apply() }}>
      <InputGroup className="min-w-48 flex-1">
        <InputGroupInput aria-label={t('keywordLabel')} placeholder={t('query.keyword')} value={draft.keyword} maxLength={200} onChange={event => change({ keyword: event.target.value })} />
        <InputGroupAddon><Search /></InputGroupAddon>
      </InputGroup>
      <Button type="button" variant="outline" aria-label={t('published')} onClick={openDates}><CalendarDays data-icon="inline-start" />{dateLabel}</Button>
      <Choice className="w-40" label={t('query.sortLabel')} hideLabel value={draft.sort} options={(['original', 'reverse', 'newest', 'oldest'] as const).map(value => ({ value, label: t(`query.sorts.${value}`) }))} onChange={sort => { const next = { ...draft, sort: sort as ListingQuery['sort'] }; apply(next, sort !== 'original' || filters(next)) }} />
      <Button type="button" variant="outline" onClick={() => setFiltersOpen(true)}><SlidersHorizontal data-icon="inline-start" />{t('query.more')}</Button>
      <Button type="submit"><Search data-icon="inline-start" />{t('query.find')}</Button>
    </form>
    {(hasDates || draft.kind !== 'all' || draft.durationMin !== undefined || draft.durationMax !== undefined) && <div className="flex flex-wrap gap-2">
      {hasDates && <Badge variant="secondary">{dateLabel}<Button type="button" size="icon-xs" variant="ghost" aria-label={t('query.clearDates')} onClick={() => clear({ since: undefined, before: undefined })}><X /></Button></Badge>}
      {draft.kind !== 'all' && <Badge variant="secondary">{t(draft.kind === 'image' ? 'common:kinds.picture' : 'common:kinds.video')}<Button type="button" size="icon-xs" variant="ghost" aria-label={t('query.clearKind')} onClick={() => clear({ kind: 'all' })}><X /></Button></Badge>}
      {(draft.durationMin !== undefined || draft.durationMax !== undefined) && <Badge variant="secondary">{t('duration')}: {draft.durationMin === undefined ? '0' : draft.durationMin / 60}–{draft.durationMax === undefined ? '∞' : draft.durationMax / 60} {t('query.minutes')}<Button type="button" size="icon-xs" variant="ghost" aria-label={t('query.clearDuration')} onClick={() => { setDuration('all'); clear({ durationMin: undefined, durationMax: undefined }) }}><X /></Button></Badge>}
    </div>}
    {dirty && <p className="text-xs text-muted-foreground">{t('query.pending')}</p>}
    {!progress && <p className="text-xs text-muted-foreground">{t('query.scope')}</p>}
    {progress && <Item variant="muted" role="status" aria-live="polite">
      <ItemContent>
        <ItemTitle>{running && <Spinner />}{t(`query.status.${progress.status}`, { scanned: progress.scanned, matched: progress.matched })}</ItemTitle>
        {progress.total !== undefined && running && <Progress aria-label={t('query.scanProgress')} value={Math.min(100, progress.scanned / Math.max(1, progress.total) * 100)} />}
        {progress.status === 'running' && draft.sort !== 'original' && !progress.nativeOrder && <ItemDescription>{t('query.partialOrder')}</ItemDescription>}
        {progress.nativeOrder && <ItemDescription>{t('query.nativeOrder')}</ItemDescription>}
        {progress.status === 'limited' && <ItemDescription>{t('query.limitHint')}</ItemDescription>}
        {progress.missingDates > 0 && (applied.since !== undefined || applied.before !== undefined || applied.sort === 'newest' || applied.sort === 'oldest') && <ItemDescription>{t('query.missingDates', { count: progress.missingDates })}</ItemDescription>}
      </ItemContent>
      <ItemActions>{running ? <Button type="button" size="sm" variant="outline" onClick={() => void send('media:query-stop', { resultId, groupId: group.id })}>{t('query.stop')}</Button> : ['stopped', 'interrupted'].includes(progress.status) ? <Button type="button" size="sm" variant="outline" onClick={() => apply(applied)}>{t('query.continue')}</Button> : null}</ItemActions>
    </Item>}
    <Dialog open={datesOpen} onOpenChange={setDatesOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('query.dateTitle')}</DialogTitle><DialogDescription>{t('query.dateHint')}</DialogDescription></DialogHeader>
        <ToggleGroup variant="outline" size="sm" className="flex-wrap" aria-label={t('published')} value={selectedPreset ? [selectedPreset] : []} onValueChange={value => { const next = value[0] as DatePreset | undefined; if (next) preset(next) }}>
          {datePresets.map(period => <ToggleGroupItem key={period} type="button" value={period}>{t(`query.presets.${period}`)}</ToggleGroupItem>)}
        </ToggleGroup>
        <FieldGroup className="grid grid-cols-2 gap-3">
          <Field data-invalid={!validDates}><FieldLabel htmlFor="query-date-from">{t('query.from')}</FieldLabel><Input type="date" id="query-date-from" value={from} onChange={event => { setFrom(event.target.value); setSelectedPreset(undefined) }} aria-invalid={!validDates} /></Field>
          <Field data-invalid={!validDates}><FieldLabel htmlFor="query-date-to">{t('query.to')}</FieldLabel><Input type="date" id="query-date-to" value={to} min={from || undefined} onChange={event => { setTo(event.target.value); setSelectedPreset(undefined) }} aria-invalid={!validDates} /></Field>
        </FieldGroup>
        {!validDates && <FieldDescription>{t('query.invalidDates')}</FieldDescription>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { setFrom(''); setTo(''); setSelectedPreset(undefined) }}>{t('query.clearDates')}</Button>
          <Button type="button" variant="ghost" onClick={() => setDatesOpen(false)}>{t('common:cancel')}</Button>
          <Button type="button" disabled={!validDates} onClick={() => { apply({ ...draft, since, before }); setDatesOpen(false) }}>{t('query.applyFind')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('query.more')}</DialogTitle><DialogDescription>{t('query.scope')}</DialogDescription></DialogHeader>
        <FieldGroup>
          <Choice label={t('query.kind')} value={draft.kind} options={[{ value: 'all', label: t('onlyAll') }, { value: 'video', label: t('common:kinds.video') }, { value: 'image', label: t('common:kinds.picture') }]} onChange={kind => change({ kind: kind as ListingQuery['kind'] })} />
          <Field><FieldLabel>{t('duration')}</FieldLabel><DurationFilter value={duration} custom={{ min: draft.durationMin === undefined ? undefined : draft.durationMin / 60, max: draft.durationMax === undefined ? undefined : draft.durationMax / 60 }} onChange={(next, range) => {
            setDuration(next)
            change(next === 'all' ? { durationMin: undefined, durationMax: undefined } : next === 'custom' ? { durationMin: range.min === undefined ? undefined : range.min * 60, durationMax: range.max === undefined ? undefined : range.max * 60 } : next === 'short' ? { durationMin: undefined, durationMax: 60 } : next === 'medium' ? { durationMin: 60.001, durationMax: 599.999 } : { durationMin: 600, durationMax: undefined })
          }} /></Field>
        </FieldGroup>
        <DialogFooter><Button type="button" variant="ghost" onClick={() => setFiltersOpen(false)}>{t('common:close')}</Button><Button type="button" onClick={() => { apply(); setFiltersOpen(false) }}>{t('query.applyFind')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
