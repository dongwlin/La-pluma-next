// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogsToolbar from './LogsToolbar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ToolbarProps = ComponentProps<typeof LogsToolbar>

const baseProps = (): ToolbarProps => ({
  autoScroll: true,
  onAutoScrollChange: () => {},
  onlyCurrentRun: true,
  onOnlyCurrentRunChange: () => {},
  collapseRepeats: true,
  onCollapseRepeatsChange: () => {},
  filter: 'all',
  onFilterChange: () => {},
  search: '',
  onSearchChange: () => {},
  viewingHistory: false,
  paused: false,
  onTogglePause: () => {},
  actionBusy: false,
  canExport: true,
  onClear: () => {},
  onExport: () => {},
})

let container: HTMLDivElement
let root: Root

const renderToolbar = async (overrides: Partial<ToolbarProps> = {}) => {
  await act(async () => root.render(<LogsToolbar {...baseProps()} {...overrides} />))
  await act(async () => {
    await Promise.resolve()
  })
}

const findSwitchByLabel = (label: string) =>
  Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .find(input => input.getAttribute('aria-label') === label || container.querySelector(`label[for="${input.id}"]`)?.textContent?.includes(label))

describe('LogsToolbar', () => {
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

  it('renders the current-run switch as checked by default', async () => {
    await renderToolbar()
    const currentRunSwitch = findSwitchByLabel('只看本次执行')
    expect(currentRunSwitch).toBeTruthy()
    expect(currentRunSwitch?.checked).toBe(true)
    expect(currentRunSwitch?.disabled).toBe(false)
  })

  it('reports toggling the current-run switch', async () => {
    const onOnlyCurrentRunChange = vi.fn()
    await renderToolbar({ onlyCurrentRun: false, onOnlyCurrentRunChange })

    const currentRunSwitch = findSwitchByLabel('只看本次执行')
    expect(currentRunSwitch?.checked).toBe(false)
    await act(async () => currentRunSwitch?.click())
    expect(onOnlyCurrentRunChange).toHaveBeenCalledWith(true)
  })

  it('disables the current-run switch while viewing history', async () => {
    await renderToolbar({ viewingHistory: true })
    expect(findSwitchByLabel('只看本次执行')?.disabled).toBe(true)
    expect(findSwitchByLabel('自动滚动')?.disabled).toBe(true)
  })
})
