import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Choice } from './Choice'

// 时长 narrows a list by how long each item runs: three presets and a free range for everything else.
// The presets are decided by the clock alone - 1:00 is the end of 1 分钟以内 and 10:00 the start of
// 10 分钟以上, so nothing falls between two of them. The free range includes both its ends, because
// 最长 5 分钟 should still keep the one that runs exactly 5:00.
export type DurationChoice = 'all' | 'short' | 'medium' | 'long' | 'custom'
// Minutes, either side optional: an empty side is no limit at all.
export type DurationMinutes = { min?: number; max?: number }

export const durationBucket = (seconds: number): 'short' | 'medium' | 'long' => seconds <= 60 ? 'short' : seconds < 600 ? 'medium' : 'long'

// 5 stays 5, 2.5 stays 2.5: the fields are read back as minutes and should not grow a tail.
const minutesOf = (value: number) => String(Number(value.toFixed(2)))

// A field read as minutes. Empty, unreadable or negative reads as no limit rather than as zero.
const readMinutes = (text: string): number | undefined => {
  const value = Number(text.replace(',', '.'))
  return !text.trim() || !Number.isFinite(value) || value < 0 ? undefined : value
}

export function DurationFilter({ value, custom, onChange, className }: {
  value: DurationChoice; custom: DurationMinutes
  onChange: (value: DurationChoice, custom: DurationMinutes) => void; className?: string
}) {
  const { t } = useTranslation(['result', 'common'])
  const [open, setOpen] = useState(false)
  const [shortest, setShortest] = useState('')
  const [longest, setLongest] = useState('')
  // The menu keeps the generic 自定义… row; the closed trigger names the range that was typed in -
  // 2–6 分钟, ≤ 3 分钟, ≥ 8 分钟 - so what is on can be read without opening the menu.
  const options = (['all', 'short', 'medium', 'long', 'custom'] as const).map(entry => ({ value: entry, label: t(`durations.${entry}`) }))
  const items = options.map(option => {
    if (option.value !== 'custom') return option
    const { min, max } = custom
    if (min !== undefined && max !== undefined) return { ...option, label: t('customDuration.between', { min: minutesOf(min), max: minutesOf(max) }) }
    if (max !== undefined) return { ...option, label: t('customDuration.under', { max: minutesOf(max) }) }
    if (min !== undefined) return { ...option, label: t('customDuration.over', { min: minutesOf(min) }) }
    return option
  })
  // The dialog opens on what is already set, so reopening it continues from there rather than blank.
  const start = () => {
    setShortest(custom.min === undefined ? '' : minutesOf(custom.min))
    setLongest(custom.max === undefined ? '' : minutesOf(custom.max))
    setOpen(true)
  }
  const apply = () => {
    let min = readMinutes(shortest)
    let max = readMinutes(longest)
    // A crossed pair is swapped rather than refused: the intent - between these two - is still clear.
    if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min]
    // Both sides open means no range at all, which is 全部时长.
    if (min === undefined && max === undefined) onChange('all', {})
    else onChange('custom', { min, max })
    setOpen(false)
  }
  return <>
    <Choice className={className} label={t('duration')} hideLabel value={value} options={options} items={items} onPick={next => { if (next === 'custom') start() }}
      onChange={next => { if (next === 'custom') start(); else onChange(next as DurationChoice, custom) }} />
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('customDuration.title')}</DialogTitle>
          <DialogDescription>{t('customDuration.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="duration-shortest">{t('customDuration.min')}</FieldLabel>
            <Input id="duration-shortest" inputMode="decimal" value={shortest} placeholder={t('customDuration.unlimited')} onChange={event => setShortest(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="duration-longest">{t('customDuration.max')}</FieldLabel>
            <Input id="duration-longest" inputMode="decimal" value={longest} placeholder={t('customDuration.unlimited')} onChange={event => setLongest(event.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onChange('all', {}); setOpen(false) }}>{t('durations.all')}</Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>{t('common:cancel')}</Button>
          <Button onClick={apply}>{t('customDuration.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
