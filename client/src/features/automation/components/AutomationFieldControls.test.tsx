// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationCheckboxField, AutomationFieldLabel } from './AutomationFieldControls'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACCOUNT_HINT = '输入已登录账号的部分字符即可，如 "123****4567" 可输入 "4567"'

let container: HTMLDivElement
let root: Root

const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}

const hintTrigger = (accessibilityName: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${accessibilityName}"]`)

const tooltipOf = (trigger: HTMLButtonElement) => {
  const describedBy = trigger.getAttribute('aria-describedby')
  return describedBy ? document.getElementById(describedBy) : null
}

const dispatch = async (target: EventTarget, event: Event) => {
  await act(async () => {
    target.dispatchEvent(event)
  })
}

const isTooltipOpen = (trigger: HTMLButtonElement) => tooltipOf(trigger)?.hidden === false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AutomationFieldLabel', () => {
  it('renders the plain field label when no hint is configured', async () => {
    await render(<AutomationFieldLabel htmlFor="account-name" label="切换账号" />)

    const label = container.querySelector('label')
    expect(label?.getAttribute('for')).toBe('account-name')
    expect(label?.textContent).toBe('切换账号')
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps the hint hidden until the trigger is hovered or focused', async () => {
    await render(<AutomationFieldLabel htmlFor="account-name" label="切换账号" hint={ACCOUNT_HINT} />)

    const trigger = hintTrigger('切换账号说明')
    expect(trigger).not.toBeNull()

    const tooltip = tooltipOf(trigger!)
    expect(tooltip?.getAttribute('role')).toBe('tooltip')
    expect(tooltip?.textContent).toBe(ACCOUNT_HINT)
    expect(tooltip?.hidden).toBe(true)

    await dispatch(trigger!, new MouseEvent('mouseover', { bubbles: true }))
    expect(isTooltipOpen(trigger!)).toBe(true)

    await dispatch(trigger!, new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    expect(isTooltipOpen(trigger!)).toBe(false)

    await act(async () => trigger!.focus())
    expect(isTooltipOpen(trigger!)).toBe(true)

    await act(async () => trigger!.blur())
    expect(isTooltipOpen(trigger!)).toBe(false)
  })

  it('closes the hint with Escape', async () => {
    await render(<AutomationFieldLabel htmlFor="account-name" label="切换账号" hint={ACCOUNT_HINT} />)

    const trigger = hintTrigger('切换账号说明')!
    await act(async () => trigger.focus())
    expect(isTooltipOpen(trigger)).toBe(true)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(isTooltipOpen(trigger)).toBe(false)
  })

  it('places the tooltip below the trigger and flips it above near the viewport bottom', async () => {
    await render(<AutomationFieldLabel htmlFor="account-name" label="切换账号" hint={ACCOUNT_HINT} />)

    const trigger = hintTrigger('切换账号说明')!
    vi.stubGlobal('innerWidth', 1440)
    vi.stubGlobal('innerHeight', 900)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 120, y: 400, top: 400, bottom: 428, left: 120, right: 148, width: 28, height: 28,
      toJSON: () => ({}),
    } as DOMRect)

    await act(async () => trigger.focus())
    expect(tooltipOf(trigger)?.style.top).toBe('434px')
    expect(tooltipOf(trigger)?.style.transform).toBe('')

    vi.stubGlobal('innerHeight', 460)
    await act(async () => {
      trigger.blur()
      trigger.focus()
    })
    expect(tooltipOf(trigger)?.style.top).toBe('394px')
    expect(tooltipOf(trigger)?.style.transform).toBe('translateY(-100%)')
  })
})

describe('AutomationCheckboxField', () => {
  it('renders the checkbox row without a hint trigger by default', async () => {
    const onChange = vi.fn()
    await render(
      <AutomationCheckboxField
        id="start-game"
        label="启动游戏客户端"
        checked={false}
        disabled={false}
        onChange={onChange}
      />,
    )

    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('label')?.getAttribute('for')).toBe('start-game')

    await act(async () => container.querySelector<HTMLInputElement>('input')?.click())
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('keeps the hint trigger outside the label and apart from the checkbox toggle', async () => {
    const onChange = vi.fn()
    await render(
      <AutomationCheckboxField
        id="start-game"
        label="启动游戏客户端"
        checked
        disabled={false}
        hint="关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端"
        onChange={onChange}
      />,
    )

    const trigger = hintTrigger('启动游戏客户端说明')
    expect(trigger).not.toBeNull()
    expect(trigger?.closest('label')).toBeNull()

    await act(async () => trigger?.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(tooltipOf(trigger!)?.textContent).toBe('关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端')
  })
})
