import { useSyncExternalStore } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import type { OpenMenu } from '../types'

export type FilterMenuKey = Exclude<OpenMenu, null>

export interface FilterMenuOption {
  value: string
  label: string
}

interface OperatorFilterMenuProps {
  menuKey: FilterMenuKey
  label: string
  value: string
  options: readonly FilterMenuOption[]
  isActive: boolean
  open: boolean
  mobileAlign?: 'start' | 'end'
  menuWidth?: number
  onOpenChange: (open: boolean) => void
  onSelect: (value: string) => void
}

const PHONE_QUERY = '(max-width: 639px)'

function subscribePhone(callback: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(PHONE_QUERY)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

function getPhoneSnapshot() {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches
}

const filterButtonClass = (isActive: boolean) =>
  `flex min-h-11 w-full items-center justify-center gap-1 rounded-full px-2 text-xs font-medium transition-[background,color,box-shadow,transform] duration-200 active:scale-[0.97] sm:w-auto sm:gap-1.5 sm:px-3 ${
    isActive
      ? 'brand-action-subtle'
      : 'control-surface text-muted-foreground'
  }`

export default function OperatorFilterMenu({
  menuKey,
  label,
  value,
  options,
  isActive,
  open,
  mobileAlign = 'start',
  menuWidth = 128,
  onOpenChange,
  onSelect,
}: OperatorFilterMenuProps) {
  const isPhone = useSyncExternalStore(subscribePhone, getPhoneSnapshot, () => false)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger
        data-filter-menu={menuKey}
        className={filterButtonClass(isActive)}
      >
        <span className="truncate">{label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-none transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={isPhone && mobileAlign === 'end' ? 'end' : 'start'}
        sideOffset={6}
        aria-label={`${label}筛选`}
        className="max-h-80 min-w-0 overflow-y-auto overscroll-contain"
        style={{ width: menuWidth, maxWidth: 'calc(100vw - 2rem)' }}
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={next => onSelect(String(next))}
        >
          {options.map(option => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              closeOnClick
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
