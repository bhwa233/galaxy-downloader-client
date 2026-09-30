import { Field, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
type Option = { value: string; label: string }
export function Choice({ label, value, onChange, options, hideLabel, disabled, className }: { label: string; value: string; onChange: (value: string) => void; options: Option[]; hideLabel?: boolean; disabled?: boolean; className?: string }) {
  return <Field className={className} data-disabled={disabled || undefined}>
    <FieldLabel className={cn('text-muted-foreground', hideLabel && 'sr-only')}>{label}</FieldLabel>
    <Select items={options} value={value} disabled={disabled} onValueChange={next => onChange(String(next))}>
      <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </Field>
}
