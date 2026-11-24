import type { ComponentProps } from 'react'
import { Checkbox } from '@/shared/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'

export function ConfigFieldInput({
  id,
  label,
  hint,
  className,
  ...inputProps
}: {
  id: string
  label: string
  hint?: string
  className?: string
} & ComponentProps<'input'>) {
  const hintId = `${id}-hint`
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id} className="text-muted-foreground">{label}</FieldLabel>
      <Input id={id} autoComplete="off" aria-describedby={hint ? hintId : undefined} {...inputProps} />
      {hint && <FieldDescription id={hintId} className="text-xs leading-5 text-muted-foreground">{hint}</FieldDescription>}
    </Field>
  )
}

export interface ConfigFieldSelectProps {
  id: string
  label: string
  items: ReadonlyArray<{ value: string; label: string }>
  value: string
  hint?: string
  disabled?: boolean
  className?: string
  onValueChange: (value: string) => void
}

export function ConfigFieldSelect({
  id,
  label,
  items,
  value,
  hint,
  disabled,
  className,
  onValueChange,
}: ConfigFieldSelectProps) {
  const hintId = `${id}-hint`
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id} className="text-muted-foreground">{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next, details) => { if (details.reason === 'none' || next === null) return; onValueChange(next) }}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-describedby={hint ? hintId : undefined} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map(item => (
            <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <FieldDescription id={hintId} className="text-xs leading-5 text-muted-foreground">{hint}</FieldDescription>}
    </Field>
  )
}

export function ConfigFieldCheckbox({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Label className="group min-h-11 cursor-pointer gap-2 text-sm leading-5 font-normal text-muted-foreground">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      <span className="transition-colors group-hover:text-primary">{label}</span>
    </Label>
  )
}
