import { useState } from 'react'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip'

interface FieldHintProps {
  id: string
  label: string
  hint: string
}

export default function FieldHint({ id, label, hint }: FieldHintProps) {
  const [open, setOpen] = useState(false)

  return (
    <Tooltip open={open} onOpenChange={setOpen} disableHoverablePopup>
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
      <TooltipContent id={id} role="tooltip" side="bottom" sideOffset={6} className="pointer-events-none">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}
