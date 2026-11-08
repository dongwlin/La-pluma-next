// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentRun, RunTaskResult } from '@/features/task-execution'
import { readCopilotSetRunProjection } from '../model/copilotSetRun'
import { deriveCopilotSetView, type CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo, CopilotSetItem } from '../types'
import CombatCopilotSetPanel from './CombatCopilotSetPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const preview: CopilotSetInfo = {
  type: 'set',
  id: '48990',
  name: '主线作业集',
  copilots: [
    { id: 101, name: '第一关', stage: 'MAIN-1', apCost: 21 },
    { id: 102, name: '第二关', stage: 'MAIN-2' },
    { id: 103, name: '第三关', stage: 'MAIN-3' },
    { id: 104, name: '第四关', stage: 'MAIN-4' },
  ],
}

type ItemStatus = NonNullable<RunTaskResult['status']>

function entry(itemIndex: number, status: ItemStatus): RunTaskResult {
  return { itemIndex, status }
}

function runWithTaskResults(taskResults: RunTaskResult[]): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_copilot_set',
    state: 'running',
    links: { self: '/agent/runs/run-1' },
    progress: {
      setId: preview.id,
      phase: 'running',
      taskResults,
    },
  }
}

function deriveView(
  statuses: Array<[number, ItemStatus]>,
  selected: ReadonlySet<number> = new Set([0, 1, 2, 3]),
): CopilotSetView {
  const projection = readCopilotSetRunProjection(
    runWithTaskResults(statuses.map(([itemIndex, status]) => entry(itemIndex, status))),
  )
  if (!projection) throw new Error('run_copilot_set 投影不应为空')
  return deriveCopilotSetView({
    preview,
    selected,
    setRun: projection,
    dismissedRunId: null,
    raid: 'normal',
    isWaitingForNext: false,
    isAutoStopping: false,
  })
}

const plannedView = (items: CopilotSetItem[]): CopilotSetView => deriveCopilotSetView({
  preview: { ...preview, copilots: items },
  selected: new Set(),
  setRun: null,
  dismissedRunId: null,
  raid: 'normal',
  isWaitingForNext: false,
  isAutoStopping: false,
})

const noop = () => {}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('CombatCopilotSetPanel', () => {
  let container: HTMLDivElement
  let root: Root
  let scrollIntoView: Mock
  let nowMs: number
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    nowMs = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
    }
  })

  const renderPanel = async (
    view: CopilotSetView,
    selected: ReadonlySet<number> = new Set([0, 1, 2, 3]),
    options: { isRunning?: boolean; preview?: CopilotSetInfo | null } = {},
  ) => {
    await act(async () => {
      root.render(
        <CombatCopilotSetPanel
          preview={options.preview === undefined ? preview : options.preview}
          view={view}
          selected={selected}
          isRunning={options.isRunning ?? true}
          isResetting={false}
          isContinuing={false}
          automationAvailable
          unavailableMessage=""
          onToggle={noop}
          onToggleAll={noop}
          onOpenReset={noop}
          onStartNext={noop}
          onCancelSet={noop}
        />,
      )
    })
  }

  const list = () => container.querySelector<HTMLElement>('[data-copilot-set-list]')

  const scrolledRows = () =>
    scrollIntoView.mock.contexts.map(
      context => (context as HTMLElement | undefined)?.getAttribute('data-copilot-item-index'),
    )

  const emitScroll = () => list()?.dispatchEvent(new Event('scroll'))

  it('brings the running row into view whenever the current item changes', async () => {
    await renderPanel(deriveView([
      [0, 'pending'],
      [1, 'pending'],
      [2, 'pending'],
      [3, 'pending'],
    ]))
    expect(scrollIntoView).not.toHaveBeenCalled()

    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'running'],
      [2, 'pending'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1'])
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'running'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1', '2'])
  })

  it('skips one positioning right after the user scrolls and resumes afterwards', async () => {
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'running'],
      [2, 'pending'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1'])

    nowMs += 1_000
    emitScroll()
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'running'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1'])

    nowMs += 1_000
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'success'],
      [3, 'running'],
    ]))
    expect(scrolledRows()).toEqual(['1', '3'])
  })

  it('does not treat the scroll caused by its own positioning as user scrolling', async () => {
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'running'],
      [2, 'pending'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1'])

    emitScroll()
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'running'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1', '2'])

    nowMs += 1_000
    emitScroll()
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'success'],
      [3, 'running'],
    ]))
    expect(scrolledRows()).toEqual(['1', '2'])
  })

  it('labels a server-skipped item while keeping the running row current', async () => {
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'skipped'],
      [2, 'running'],
      [3, 'pending'],
    ]))

    expect(container.querySelector('[data-copilot-item-index="1"]')?.textContent).toContain('已跳过')
    expect(container.querySelector('[data-copilot-item-index="2"]')?.textContent).toContain('执行中')
    expect(scrolledRows()).toEqual(['2'])
  })

  it('counts skipped items separately instead of as completed', async () => {
    await renderPanel(deriveView([
      [0, 'skipped'],
      [1, 'running'],
      [2, 'skipped'],
      [3, 'pending'],
    ], new Set([1])), new Set([1]))

    expect(container.textContent).toContain('待 1')
    expect(container.textContent).toContain('已通关 0')
    expect(container.textContent).toContain('跳过 2')
  })

  it('labels a stopped item as terminated instead of failed', async () => {
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'stopped'],
      [2, 'pending'],
      [3, 'pending'],
    ]))

    const row = container.querySelector('[data-copilot-item-index="1"]')
    expect(row?.textContent).toContain('已终止')
    expect(row?.textContent).not.toContain('待重试')
    expect(container.textContent).toContain('已终止 1')
    expect(container.textContent).toContain('失败 0')
  })

  it('keeps an unselected unfinished item pending instead of historical', async () => {
    await renderPanel(deriveView([
      [0, 'pending'],
      [1, 'pending'],
      [2, 'pending'],
      [3, 'pending'],
    ], new Set()), new Set())

    const row = container.querySelector('[data-copilot-item-index="0"]')
    expect(row?.textContent).toContain('待执行')
    expect(row?.textContent).not.toContain('历史已通关')
    expect(container.textContent).toContain('待 0')
    expect(container.textContent).toContain('已通关 0')
  })

  it('keeps an item pending while one of its modes still waits', async () => {
    const projection = readCopilotSetRunProjection({
      runId: 'run-1',
      operationId: 'run_copilot_set',
      state: 'waiting',
      links: { self: '/agent/runs/run-1' },
      progress: {
        setId: preview.id,
        phase: 'waiting_for_next',
        currentEntry: null,
        nextEntry: { key: '0:101:raid', itemIndex: 0, copilotId: 101, displayStage: 'MAIN-1', mode: 'raid', status: 'pending' },
        taskResults: [
          { key: '0:101:normal', itemIndex: 0, copilotId: 101, displayStage: 'MAIN-1', mode: 'normal', status: 'success' },
          { key: '0:101:raid', itemIndex: 0, copilotId: 101, displayStage: 'MAIN-1', mode: 'raid', status: 'pending' },
          { key: '1:102:normal', itemIndex: 1, copilotId: 102, displayStage: 'MAIN-2', mode: 'normal', status: 'skipped' },
          { key: '1:102:raid', itemIndex: 1, copilotId: 102, displayStage: 'MAIN-2', mode: 'raid', status: 'skipped' },
          { key: '2:103:normal', itemIndex: 2, copilotId: 103, displayStage: 'MAIN-3', mode: 'normal', status: 'skipped' },
          { key: '2:103:raid', itemIndex: 2, copilotId: 103, displayStage: 'MAIN-3', mode: 'raid', status: 'skipped' },
          { key: '3:104:normal', itemIndex: 3, copilotId: 104, displayStage: 'MAIN-4', mode: 'normal', status: 'skipped' },
          { key: '3:104:raid', itemIndex: 3, copilotId: 104, displayStage: 'MAIN-4', mode: 'raid', status: 'skipped' },
        ],
      },
    })
    if (!projection) throw new Error('run_copilot_set 投影不应为空')
    const view = deriveCopilotSetView({
      preview,
      selected: new Set([0]),
      setRun: projection,
      dismissedRunId: null,
      raid: 'both',
      isWaitingForNext: true,
      isAutoStopping: false,
    })

    await renderPanel(view, new Set([0]))

    const row = container.querySelector('[data-copilot-item-index="0"]')
    expect(row?.textContent).toContain('待执行')
    expect(row?.textContent).not.toContain('已完成')
    expect(container.textContent).toContain('待 1')
    expect(container.textContent).toContain('已通关 0')
    expect(container.textContent).toContain('跳过 3')
  })

  it('shows a known stage cost and labels a missing one as unknown', async () => {
    await renderPanel(deriveView([[0, 'pending']]))

    expect(container.querySelector('[data-copilot-item-index="0"]')?.textContent).toContain('理智 21')
    expect(container.querySelector('[data-copilot-item-index="1"]')?.textContent).toContain('理智 未知')
  })

  it('marks only persisted plan progress as historical completion', async () => {
    await renderPanel(plannedView([
      { id: 101, name: '第一关', completedModes: ['normal'] },
      { id: 102, name: '第二关' },
      { id: 103, name: '第三关' },
      { id: 104, name: '第四关' },
    ]), new Set())

    expect(container.querySelector('[data-copilot-item-index="0"]')?.textContent).toContain('历史已通关')
    expect(container.querySelector('[data-copilot-item-index="1"]')?.textContent).toContain('待执行')
    expect(container.textContent).toContain('已通关 1')
    expect(container.textContent).toContain('待 0')
  })

  it('renders a single empty state for a preview without a set', async () => {
    await renderPanel(plannedView([]), new Set(), { preview: null, isRunning: false })

    const emptyStates = container.querySelectorAll('.app-empty-state')
    expect(emptyStates).toHaveLength(1)
    expect(emptyStates[0]?.textContent).toContain('等待作业')
    expect(container.querySelector('[data-copilot-set-list]')).toBeNull()
  })

  it('uses the set note as the empty description when the set has no entries', async () => {
    const emptySet: CopilotSetInfo = {
      ...preview,
      copilots: [],
      note: '这套作业集暂时没有可用作业',
    }
    const view = deriveCopilotSetView({
      preview: emptySet,
      selected: new Set(),
      setRun: null,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    await renderPanel(view, new Set(), { preview: emptySet, isRunning: false })

    expect(container.querySelectorAll('.app-empty-state')).toHaveLength(1)
    expect(container.querySelector('.app-empty-state')?.textContent).toContain('这套作业集暂时没有可用作业')
  })

  it('expands a row into an addressable detail region with its fields', async () => {
    const detailPreview: CopilotSetInfo = {
      ...preview,
      copilots: [
        { id: 101, name: '第一关', stage: 'MAIN-1', apCost: 21, presetFormation: true },
        { id: 102, name: '第二关' },
      ],
    }
    const view = deriveCopilotSetView({
      preview: detailPreview,
      selected: new Set([0, 1]),
      setRun: null,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })
    await renderPanel(view, new Set([0, 1]), { isRunning: false, preview: detailPreview })

    const expand = container.querySelector<HTMLButtonElement>(
      '[data-copilot-item-index="0"] button[aria-expanded]',
    )!
    const detailId = expand.getAttribute('aria-controls') ?? ''
    expect(detailId).not.toBe('')
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(detailId)).toBeNull()

    await click(expand)

    expect(expand.getAttribute('aria-expanded')).toBe('true')
    const detail = document.getElementById(detailId)
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toContain('第一关')
    expect(detail?.textContent).toContain('MAIN-1')
    expect(detail?.textContent).toContain('理智')
    expect(detail?.textContent).toContain('21')
    expect(detail?.textContent).toContain('预设编队')
    expect(detail?.textContent).toContain('prts://101')
    expect(detail?.textContent).not.toContain('干员')

    await click(expand)

    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(detailId)).toBeNull()
  })

  it('marks a missing stage and AP as unknown without inventing operators', async () => {
    const sparsePreview: CopilotSetInfo = {
      ...preview,
      copilots: [{ id: 103, name: '第三关' }],
    }
    const view = deriveCopilotSetView({
      preview: sparsePreview,
      selected: new Set([0]),
      setRun: null,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })
    await renderPanel(view, new Set([0]), { isRunning: false, preview: sparsePreview })

    expect(container.querySelector('[data-copilot-item-index="0"]')?.textContent).not.toContain('理智')
    const expand = container.querySelector<HTMLButtonElement>(
      '[data-copilot-item-index="0"] button[aria-expanded]',
    )!
    await click(expand)

    const detail = document.getElementById(expand.getAttribute('aria-controls') ?? '')
    expect(detail?.textContent).toContain('未知')
    expect(detail?.textContent).toContain('按执行设置自动编队')
    expect(detail?.textContent).toContain('prts://103')
    expect(detail?.textContent).not.toContain('干员')
    expect(detail?.textContent).not.toContain('预设编队')
  })

  it('labels the row selection checkbox for assistive technology', async () => {
    await renderPanel(deriveView([[0, 'pending']]), new Set([0]), { isRunning: false })

    expect(
      container.querySelector('[data-copilot-item-index="0"] button[aria-label]')?.getAttribute('aria-label'),
    ).toBe('取消选择第 1 个作业')
    expect(
      container.querySelector('[data-copilot-item-index="1"] button[aria-label]')?.getAttribute('aria-label'),
    ).toBe('选择第 2 个作业')
  })
})
