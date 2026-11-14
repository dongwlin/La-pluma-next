import { useState } from 'react'
import { Info } from 'lucide-react'
import { Checkbox } from '@/shared/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

interface FieldHintProps {
  id: string
  label: string
  hint: string
}

export function FieldHint({ id, label, hint }: FieldHintProps) {
  const [open, setOpen] = useState(false)

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={<button type="button" className="-my-1 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-tertiary transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary" />}
        aria-label={`${label}说明`}
        aria-describedby={open ? id : undefined}
        closeOnClick={false}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent id={id} role="tooltip" side="bottom" sideOffset={6}>
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

interface AutomationFieldLabelProps {
  htmlFor: string
  label: string
  hint?: string
}

export function AutomationFieldLabel({ htmlFor, label, hint }: AutomationFieldLabelProps) {
  const labelElement = <label htmlFor={htmlFor} className="automation-field-label">{label}</label>

  if (!hint) return labelElement

  return (
    <span className="inline-flex min-w-max items-center gap-1">
      {labelElement}
      <FieldHint id={`${htmlFor}-hint`} label={label} hint={hint} />
    </span>
  )
}

interface AutomationFieldLegendProps {
  label: string
  hintId: string
  hint?: string
}

export function AutomationFieldLegend({ label, hintId, hint }: AutomationFieldLegendProps) {
  if (!hint) return <legend className="automation-field-label mb-2 block">{label}</legend>

  return (
    <legend className="automation-field-label mb-2 block">
      <span className="inline-flex items-center gap-1">
        {label}
        <FieldHint id={hintId} label={label} hint={hint} />
      </span>
    </legend>
  )
}

interface AutomationCheckboxFieldProps {
  id: string
  label: string
  checked: boolean
  disabled: boolean
  hint?: string
  onChange: (checked: boolean) => void
}

export function AutomationCheckboxField({ id, label, checked, disabled, hint, onChange }: AutomationCheckboxFieldProps) {
  const control = (
    <label className="group flex min-h-11 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={nextChecked => onChange(nextChecked)}
        disabled={disabled}
      />
      <span className="group-hover:text-primary transition-colors">{label}</span>
    </label>
  )

  if (!hint) return control

  return (
    <div className="flex items-center gap-1">
      {control}
      <FieldHint id={`${id}-hint`} label={label} hint={hint} />
    </div>
  )
}
