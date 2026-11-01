import { Field, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
type Option = { value: string; label: string }
// `options` fills the menu; `items` only changes what the closed trigger reads, for a value whose menu
// row should stay generic (自定义…) while the trigger names the range that was typed in. `onPick` fires
// for a row even when it is already the selected one, where there is no change to report.
export function Choice({ label, value, onChange, options, items, onPick, hideLabel, disabled, placeholder, className }: { label: string; value: string; onChange: (value: string) => void; options: Option[]; items?: Option[]; onPick?: (value: string) => void; hideLabel?: boolean; disabled?: boolean; placeholder?: string; className?: string }) {
  return <Field className={className} data-disabled={disabled || undefined}>
    <FieldLabel className={cn('text-muted-foreground', hideLabel && 'sr-only')}>{label}</FieldLabel>
    <Select items={items ?? options} value={value || null} disabled={disabled} onValueChange={next => { if (next !== null) onChange(String(next)) }}>
      <SelectTrigger aria-label={label} className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value} onClick={onPick ? () => onPick(option.value) : undefined}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </Field>
}
