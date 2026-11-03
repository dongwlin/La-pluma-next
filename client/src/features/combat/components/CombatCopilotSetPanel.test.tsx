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
    { id: 101, name: '第一关', stage: 'MAIN-1' },
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

/** 走真实的投影与视图派生管道；running 条目所在作业就是当前项。 */
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

describe('CombatCopilotSetPanel 当前项自动定位', () => {
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
  ) => {
    await act(async () => {
      root.render(
        <CombatCopilotSetPanel
          preview={preview}
          view={view}
          selected={selected}
          isRunning
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

  /** scrollIntoView 被调用时的目标行，按调用顺序排列。 */
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
    // 没有当前项时不定位。
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

    // 用户手动滚动（距离上次定位已超过定位守卫窗口）后，紧随的当前项变化
    // 跳过一次定位，不抢滚动位置。
    nowMs += 1_000
    emitScroll()
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'running'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1'])

    // 抑制窗口（几百毫秒）过去后，下一次变化恢复定位。
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

    // 定位自身引发的 scroll 事件到达时不记作用户滚动，下一次变化仍会定位。
    emitScroll()
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'success'],
      [2, 'running'],
      [3, 'pending'],
    ]))
    expect(scrolledRows()).toEqual(['1', '2'])

    // 守卫窗口外的 scroll 事件才是用户滚动，会抑制下一次定位。
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
    // 定位跟随的是「执行中」行，而不是刚刚跳过的行。
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
})
