import { Field, FieldContent, FieldDescription, FieldLabel } from '@/shared/ui/field'
import { Switch } from '@/shared/ui/switch'

export interface SwitchSettingRowProps {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly disabled?: boolean
}

export default function SwitchSettingRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: SwitchSettingRowProps) {
  return (
    <Field orientation="horizontal" className="min-h-11 gap-3.5">
      <FieldContent className="gap-1">
        <FieldLabel htmlFor={id} className="text-sm font-medium text-foreground">{label}</FieldLabel>
        <FieldDescription className="text-xs leading-5 text-muted-foreground">{description}</FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="self-center"
      />
    </Field>
  )
}
