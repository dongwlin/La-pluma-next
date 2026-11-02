// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogContentModeTabs from './LogContentModeTabs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TabsProps = ComponentProps<typeof LogContentModeTabs>

let container: HTMLDivElement
let root: Root

const renderTabs = async (overrides: Partial<TabsProps> = {}) => {
  await act(async () => root.render(
    <LogContentModeTabs mode="readable" onChange={() => {}} {...overrides} />,
  ))
  await act(async () => {
    await Promise.resolve()
  })
}

const getTabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))

describe('LogContentModeTabs', () => {
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

  it('renders the three content modes with readable as the described default tier', async () => {
    await renderTabs()
    const tabs = getTabs()
    expect(tabs.map(tab => tab.textContent)).toEqual([
      '易读语义与生命周期',
      '详细可展开原始内容',
      '原始原样输出',
    ])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map(tab => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })

  it('marks the active mode and reports clicks as mode changes', async () => {
    const onChange = vi.fn()
    await renderTabs({ mode: 'detailed', onChange })

    const tabs = getTabs()
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])

    await act(async () => tabs[2]?.click())
    expect(onChange).toHaveBeenCalledWith('raw')
  })

  it('moves the selection with arrow keys across the three modes', async () => {
    const onChange = vi.fn()
    await renderTabs({ mode: 'raw', onChange })
    const tabs = getTabs()
    expect(tabs).toHaveLength(3)

    await act(async () => tabs[2]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ))
    expect(onChange).toHaveBeenCalledWith('readable')

    await act(async () => tabs[2]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    ))
    expect(onChange).toHaveBeenCalledWith('detailed')
  })
})
