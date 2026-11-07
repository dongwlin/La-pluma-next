import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

interface AutomationFieldHintProps {
  label: string
  text: string
}

interface TooltipPosition {
  top: number
  left: number
  width: number
  placement: 'top' | 'bottom'
}

const MAX_WIDTH = 288
const GAP = 6
const VIEWPORT_MARGIN = 16
const MIN_SPACE_BELOW = 96

export default function AutomationFieldHint({ label, text }: AutomationFieldHintProps) {
  const tooltipId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const margin = Math.min(VIEWPORT_MARGIN, viewportWidth / 2)
    const width = Math.min(MAX_WIDTH, Math.max(0, viewportWidth - margin * 2))
    const left = Math.min(
      Math.max(rect.left, margin),
      Math.max(margin, viewportWidth - margin - width),
    )
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - GAP - margin)
    const spaceAbove = Math.max(0, rect.top - GAP - margin)
    const placement = spaceBelow < MIN_SPACE_BELOW && spaceAbove > spaceBelow ? 'top' : 'bottom'

    setPosition({
      top: placement === 'top' ? rect.top - GAP : rect.bottom + GAP,
      left,
      width,
      placement,
    })
  }, [])

  const show = useCallback(() => {
    updatePosition()
    setOpen(true)
  }, [updatePosition])

  const hide = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="-my-1 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-tertiary transition-colors hover:bg-(--app-surface-muted) hover:text-secondary focus-visible:ring-2 focus-visible:ring-(--app-accent) focus-visible:outline-hidden"
        aria-label={`${label}说明`}
        aria-describedby={tooltipId}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={show}
      >
        <Info className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </button>
      {/* 自动任务面板的表面会裁切溢出内容，提示层挂到 body 上才不会被圆角容器截断。 */}
      {createPortal(
        <div
          id={tooltipId}
          role="tooltip"
          hidden={!open}
          className="pointer-events-none fixed z-2000 max-h-60 max-w-72 overflow-y-auto rounded-xl px-3 py-2 text-xs leading-5 text-secondary surface-panel"
          style={open && position
            ? {
                top: position.top,
                left: position.left,
                width: position.width,
                transform: position.placement === 'top' ? 'translateY(-100%)' : undefined,
              }
            : undefined}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
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
      <AutomationFieldHint label={label} text={hint} />
    </span>
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
    <label htmlFor={id} className="group flex min-h-11 cursor-pointer items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="custom-checkbox cursor-pointer"
      />
      <span className="group-hover:text-(--app-accent) transition-colors">{label}</span>
    </label>
  )

  if (!hint) return control

  return (
    <div className="flex items-center justify-between gap-2">
      {control}
      <AutomationFieldHint label={label} text={hint} />
    </div>
  )
}
