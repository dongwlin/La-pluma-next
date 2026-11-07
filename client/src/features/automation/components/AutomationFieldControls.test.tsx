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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('AutomationFieldLabel', () => {
  it('renders the plain field label when no hint is configured', async () => {
    await render(<AutomationFieldLabel htmlFor="account-name" label="切换账号" />)

    const label = container.querySelector('label')
    expect(label?.getAttribute('for')).toBe('account-name')
    expect(label?.textContent).toBe('切换账号')
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('p')).toBeNull()
  })

  it('wires the hint tooltip to the label without a persistent helper paragraph', async () => {
    await render(<AutomationFieldLabel htmlFor="account-name" label="切换账号" hint={ACCOUNT_HINT} />)

    const label = container.querySelector('label')
    const trigger = hintTrigger('切换账号说明')
    expect(label?.textContent).toBe('切换账号')
    expect(trigger).not.toBeNull()

    const tooltip = tooltipOf(trigger!)
    expect(tooltip?.getAttribute('role')).toBe('tooltip')
    expect(tooltip?.textContent).toBe(ACCOUNT_HINT)
    expect(tooltip?.hidden).toBe(true)
    expect(container.querySelector('p')).toBeNull()

    await act(async () => trigger!.focus())
    expect(tooltip?.hidden).toBe(false)

    await act(async () => trigger!.blur())
    expect(tooltip?.hidden).toBe(true)
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
    const LAUNCH_HINT = '关闭后只连接设备并进入已有游戏的主界面，不会启动游戏客户端'
    await render(
      <AutomationCheckboxField
        id="start-game"
        label="启动游戏客户端"
        checked
        disabled={false}
        hint={LAUNCH_HINT}
        onChange={onChange}
      />,
    )

    const label = container.querySelector('label')
    const trigger = hintTrigger('启动游戏客户端说明')
    expect(label?.textContent).toBe('启动游戏客户端')
    expect(trigger).not.toBeNull()
    expect(trigger?.closest('label')).toBeNull()
    expect(tooltipOf(trigger!)?.textContent).toBe(LAUNCH_HINT)

    await act(async () => trigger?.click())
    expect(onChange).not.toHaveBeenCalled()
  })
})
