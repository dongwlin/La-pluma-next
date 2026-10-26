// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FilterMenu, { type FilterMenuOption } from './FilterMenu'
import type { OpenMenu } from '../types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const options: readonly FilterMenuOption[] = [
  { value: 'all', label: '全部' },
  { value: 'owned', label: '已拥有' },
  { value: 'unowned', label: '未拥有' },
]

const labels: Record<string, string> = {
  all: '拥有状态',
  owned: '已拥有',
  unowned: '未拥有',
}

interface HarnessProps {
  initialValue?: string
  mobileAlign?: 'start' | 'end'
  menuWidth?: number
  onSelect?: (value: string) => void
}

/** 受控包装：父级持有打开状态与当前值，与面板中的用法一致。 */
function Harness({
  initialValue = 'all',
  mobileAlign,
  menuWidth,
  onSelect,
}: HarnessProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [value, setValue] = useState(initialValue)

  return (
    <FilterMenu
      menuKey="ownership"
      label={labels[value] ?? '拥有状态'}
      value={value}
      options={options}
      isActive={value !== 'all'}
      isOpen={openMenu === 'ownership'}
      mobileAlign={mobileAlign}
      {...(menuWidth === undefined ? {} : { menuWidth })}
      onOpenChange={setOpenMenu}
      onSelect={(next) => {
        setValue(next)
        onSelect?.(next)
      }}
    />
  )
}

let container: HTMLDivElement
let root: Root

const click = async (element: HTMLElement) => {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const press = async (target: EventTarget, key: string) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

const render = async (props: HarnessProps = {}) => {
  await act(async () => root.render(<Harness {...props} />))
}

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]')
const menuItems = () => Array.from(
  document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
)

const stubTriggerRect = (triggerElement: HTMLButtonElement, rect: Partial<DOMRect>) => {
  vi.spyOn(triggerElement, 'getBoundingClientRect').mockReturnValue({
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    top: rect.top ?? 0,
    right: rect.right ?? 0,
    bottom: rect.bottom ?? 0,
    left: rect.left ?? 0,
    width: rect.width ?? (rect.right ?? 0) - (rect.left ?? 0),
    height: rect.height ?? (rect.bottom ?? 0) - (rect.top ?? 0),
    toJSON: () => ({}),
  } as DOMRect)
}

describe('FilterMenu layout and keyboard rules', () => {
  beforeEach(() => {
    window.requestAnimationFrame = vi.fn(callback => {
      callback(0)
      return 1
    })
    window.cancelAnimationFrame = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders the menu through a portal and focuses the selected option', async () => {
    await render({ initialValue: 'owned' })
    stubTriggerRect(trigger(), { left: 100, right: 212, top: 100, bottom: 144 })
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)

    await click(trigger())

    const surface = menu()!
    expect(surface).not.toBeNull()
    expect(container.contains(surface)).toBe(false)
    expect(surface.parentElement).toBe(document.body)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(surface.id)
    expect(surface.getAttribute('aria-label')).toBe('已拥有筛选')
    expect(surface.dataset.placement).toBe('bottom')
    expect(surface.style.left).toBe('100px')
    expect(surface.style.width).toBe('128px')
    expect(surface.style.top).toBe('150px')
    expect(surface.style.maxHeight).toBe('140px')
    expect(document.activeElement).toBe(menuItems()[1])
    expect(menuItems().map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('aligns end-of-row menus to the trigger edge on phones only', async () => {
    await render({ mobileAlign: 'end' })
    stubTriggerRect(trigger(), { left: 220, right: 300, top: 100, bottom: 144 })
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 568)

    await click(trigger())

    const surface = menu()!
    expect(surface.style.left).toBe('172px')
    expect(surface.style.width).toBe('128px')

    await press(document, 'Escape')
    vi.stubGlobal('innerWidth', 1024)
    await click(trigger())
    expect(menu()!.style.left).toBe('220px')
  })

  it('opens upward when there is not enough room below', async () => {
    await render()
    stubTriggerRect(trigger(), { left: 40, right: 152, top: 600, bottom: 644 })
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)

    await click(trigger())

    const surface = menu()!
    expect(surface.dataset.placement).toBe('top')
    expect(surface.style.top).toBe('594px')
    expect(surface.style.transform).toBe('translateY(-100%)')
    expect(surface.style.transformOrigin).toBe('bottom')
    expect(surface.style.maxHeight).toBe('140px')
  })

  it('cycles focus with arrows, Home and End', async () => {
    await render({ initialValue: 'owned' })
    await click(trigger())

    await press(menu()!, 'ArrowDown')
    expect(document.activeElement).toBe(menuItems()[2])

    await press(menu()!, 'ArrowDown')
    expect(document.activeElement).toBe(menuItems()[0])

    await press(menu()!, 'ArrowUp')
    expect(document.activeElement).toBe(menuItems()[2])

    await press(menu()!, 'Home')
    expect(document.activeElement).toBe(menuItems()[0])

    await press(menu()!, 'End')
    expect(document.activeElement).toBe(menuItems()[2])
  })

  it('closes with Escape and returns focus to the trigger', async () => {
    await render()
    trigger().focus()
    await click(trigger())
    expect(menu()).not.toBeNull()

    await press(document, 'Escape')

    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
  })

  it('applies the selection, closes and restores trigger focus', async () => {
    const onSelect = vi.fn()
    await render({ onSelect })

    await click(trigger())
    await click(menuItems()[2]!)

    expect(onSelect).toHaveBeenCalledWith('unowned')
    expect(menu()).toBeNull()
    expect(trigger().textContent).toContain('未拥有')
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on outside pointerdown without restoring focus', async () => {
    await render()
    await click(trigger())

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })

    expect(menu()).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens from the trigger with arrow keys and keeps aria wiring', async () => {
    await render()

    await press(trigger(), 'ArrowDown')

    const surface = menu()!
    expect(surface).not.toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(surface.id)
    expect(document.activeElement).toBe(menuItems()[0])
  })
})
