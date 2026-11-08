// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopilotSetItem } from '../types'
import CombatCopilotQueueRow from './CombatCopilotQueueRow'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item: CopilotSetItem = {
  id: 101,
  name: '第一关',
  stage: 'MAIN-1',
  apCost: 21,
}

type RowProps = Parameters<typeof CombatCopilotQueueRow>[0]

const baseProps: RowProps = {
  copilot: item,
  index: 0,
  selected: false,
  disabled: false,
  expanded: false,
  detailId: 'combat-copilot-detail-48990-0',
  isCurrent: false,
  isSuccess: false,
  isFailed: false,
  isStopped: false,
  isSkipped: false,
  isHistoryDone: false,
  onToggle: () => {},
  onToggleExpanded: () => {},
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('CombatCopilotQueueRow', () => {
  let container: HTMLDivElement
  let root: Root

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

  const renderRow = async (overrides: Partial<RowProps> = {}) => {
    await act(async () => {
      root.render(<CombatCopilotQueueRow {...baseProps} {...overrides} />)
    })
  }

  it.each([
    ['执行中', { isCurrent: true }],
    ['已跳过', { isSkipped: true }],
    ['待重试', { isFailed: true }],
    ['已终止', { isStopped: true }],
    ['已完成', { isSuccess: true }],
    ['历史已通关', { isHistoryDone: true }],
    ['待执行', {}],
  ] as const)('labels the row as %s', async (label, state) => {
    await renderRow(state)

    expect(container.querySelector('[data-copilot-item-index="0"]')?.textContent).toContain(label)
  })

  it('shows the stage cost and hides the stage line when the stage is unknown', async () => {
    await renderRow()
    expect(container.textContent).toContain('MAIN-1 · 理智 21')
    expect(container.textContent).toContain('prts://101')

    await renderRow({ copilot: { ...item, apCost: null } })
    expect(container.textContent).toContain('MAIN-1 · 理智 未知')

    await renderRow({ copilot: { id: 102, name: '第二关' } })
    expect(container.textContent).not.toContain('理智')
    expect(container.textContent).toContain('prts://102')
  })

  it('names the selection checkbox for assistive technology and reports the toggle', async () => {
    const onToggle = vi.fn()
    await renderRow({ onToggle })

    const checkbox = container.querySelector<HTMLButtonElement>('button[aria-label="选择第 1 个作业"]')
    expect(checkbox).not.toBeNull()
    await click(checkbox!)

    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('exposes the selected state and disabled state through the checkbox', async () => {
    await renderRow({ selected: true })
    expect(container.querySelector('button[aria-label="取消选择第 1 个作业"]')).not.toBeNull()

    await renderRow({ selected: true, disabled: true })
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="取消选择第 1 个作业"]')?.disabled)
      .toBe(true)
  })

  it('connects the expand button to the detail region it controls', async () => {
    const onToggleExpanded = vi.fn()
    await renderRow({ onToggleExpanded })

    const expand = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(expand).not.toBeNull()
    expect(expand?.getAttribute('aria-expanded')).toBe('false')
    expect(expand?.getAttribute('aria-controls')).toBe('combat-copilot-detail-48990-0')
    expect(document.getElementById('combat-copilot-detail-48990-0')).toBeNull()

    await click(expand!)

    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })

  it('renders stage, AP, preset formation and URI in the expanded detail', async () => {
    await renderRow({
      expanded: true,
      copilot: { ...item, presetFormation: true },
    })

    const detail = document.getElementById('combat-copilot-detail-48990-0')
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toContain('第一关')
    expect(detail?.textContent).toContain('MAIN-1')
    expect(detail?.textContent).toContain('21')
    expect(detail?.textContent).toContain('预设编队 · 仅普通')
    expect(detail?.textContent).toContain('prts://101')
    expect(detail?.textContent).not.toContain('干员')
  })

  it('shows operators only when the payload provides them', async () => {
    await renderRow({ expanded: true, copilot: { ...item, operators: '能天使、德克萨斯' } })

    const detail = document.getElementById('combat-copilot-detail-48990-0')
    expect(detail?.textContent).toContain('干员')
    expect(detail?.textContent).toContain('能天使、德克萨斯')
  })

  it('keeps the row controls as full-size buttons rather than inner icons', async () => {
    const onToggle = vi.fn()
    const onToggleExpanded = vi.fn()
    await renderRow({ onToggle, onToggleExpanded })

    const checkbox = container.querySelector<HTMLButtonElement>('button[aria-label="选择第 1 个作业"]')!
    const expand = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!

    expect(checkbox.tagName).toBe('BUTTON')
    expect(expand.tagName).toBe('BUTTON')
    expect(checkbox.querySelectorAll('button, a, input')).toHaveLength(0)
    expect(expand.querySelectorAll('button, a, input')).toHaveLength(0)

    await click(checkbox)
    await click(expand)

    expect(onToggle).toHaveBeenCalledOnce()
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })
})
