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
  runId: '',
  runIds: ['run-1'],
  onRunIdChange: () => {},
  events: 'key',
  onEventsChange: () => {},
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

  it('offers all logs or a specific run independently of the event filter', async () => {
    await renderToolbar()
    const scope = container.querySelector<HTMLSelectElement>('[aria-label="执行范围"]')
    expect(scope?.value).toBe('')
    expect(Array.from(scope?.options || []).map(option => option.text)).toEqual(['全部执行与未关联日志', 'Run · run-1'])
    expect(container.querySelector<HTMLSelectElement>('[aria-label="事件范围"]')?.value).toBe('key')
  })

  it('reports an explicit run selection', async () => {
    const onRunIdChange = vi.fn()
    await renderToolbar({ onRunIdChange })
    const scope = container.querySelector<HTMLSelectElement>('[aria-label="执行范围"]')!
    await act(async () => {
      scope.value = 'run-1'
      scope.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onRunIdChange).toHaveBeenCalledWith('run-1')
  })

  it('disables run scope and following for files and keeps event selection available', async () => {
    await renderToolbar({ viewingHistory: true })
    expect(container.querySelector<HTMLSelectElement>('[aria-label="执行范围"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLSelectElement>('[aria-label="事件范围"]')?.disabled).toBe(false)
    expect(findSwitchByLabel('自动滚动')?.disabled).toBe(true)
  })

  it('distinguishes clearing the screen and exporting selected records', async () => {
    const onClear = vi.fn()
    await renderToolbar({ onClear })
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    await act(async () => buttons.find(button => button.textContent?.trim() === '清屏')?.click())
    expect(onClear).toHaveBeenCalledOnce()
    expect(buttons.some(button => button.textContent === '导出筛选结果')).toBe(true)
  })
})
