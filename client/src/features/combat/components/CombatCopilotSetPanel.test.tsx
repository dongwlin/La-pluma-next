// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, RunTaskResult } from '@/features/task-execution'
import { readCopilotSetRunProjection } from '../model/copilotSetRun'
import { deriveCopilotSetView, type CopilotSetView } from '../model/copilotSetView'
import type { CopilotSetInfo } from '../types'
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

function entry(itemIndex: number, status: ItemStatus, error?: string): RunTaskResult {
  return {
    key: `${itemIndex}:${101 + itemIndex}:normal`,
    itemIndex,
    copilotId: 101 + itemIndex,
    displayStage: `MAIN-${itemIndex + 1}`,
    mode: 'normal',
    status,
    ...(error ? { error } : {}),
  }
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

const noop = () => {}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('CombatCopilotSetPanel', () => {
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

  const renderPanel = async (
    view: CopilotSetView,
    options: {
      preview?: CopilotSetInfo
      isRunning?: boolean
      isResetting?: boolean
      onOpenReset?: () => void
    } = {},
  ) => {
    await act(async () => {
      root.render(
        <CombatCopilotSetPanel
          preview={options.preview === undefined ? preview : options.preview}
          view={view}
          isRunning={options.isRunning ?? false}
          isResetting={options.isResetting ?? false}
          onOpenReset={options.onOpenReset ?? noop}
        />,
      )
    })
  }

  it('summarizes the set without rendering a second job list', async () => {
    await renderPanel(deriveView([
      [0, 'success'],
      [1, 'pending'],
      [2, 'pending'],
      [3, 'pending'],
    ], new Set([1, 2, 3])))

    const section = container.querySelector('section[aria-label="作业集摘要"]')
    expect(section).not.toBeNull()
    expect(section?.textContent).toContain('待 3')
    expect(section?.textContent).toContain('本次成功 1')
    expect(section?.textContent).toContain('历史已通关 0')
    expect(section?.textContent).toContain('续跑目标')
    expect(section?.textContent).toContain('prts://102')
    expect(section?.textContent).toContain('MAIN-2')
    expect(section?.querySelector('[role="list"]')).toBeNull()
    expect(section?.querySelector('[data-copilot-item-index]')).toBeNull()
  })

  it('offers the progress reset in the summary', async () => {
    const onOpenReset = vi.fn()
    await renderPanel(deriveView([[0, 'pending']]), { onOpenReset })

    const reset = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === '重置进度')
    expect(reset).not.toBeUndefined()
    await click(reset!)

    expect(onOpenReset).toHaveBeenCalledOnce()
  })

  it('hides the reset while the set is running', async () => {
    await renderPanel(deriveView([[0, 'running']]), { isRunning: true })

    const reset = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === '重置进度')
    expect(reset).toBeUndefined()
  })

  it('renders full failure reasons from the run summary', async () => {
    const projection = readCopilotSetRunProjection(runWithTaskResults([
      entry(1, 'failed', '缺少干员：桃金娘\n请检查 box 后重试'),
    ]))
    if (!projection) throw new Error('run_copilot_set 投影不应为空')
    const view = deriveCopilotSetView({
      preview,
      selected: new Set([1]),
      setRun: projection,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    await renderPanel(view)

    expect(container.textContent).toContain('失败原因')
    expect(container.textContent).toContain('MAIN-2')
    expect(container.textContent).toContain('缺少干员：桃金娘')
    expect(container.textContent).toContain('请检查 box 后重试')
    expect(container.textContent).toContain('失败 1')
  })

  it('describes the waiting entry', async () => {
    const projection = readCopilotSetRunProjection({
      runId: 'run-1',
      operationId: 'run_copilot_set',
      state: 'waiting',
      links: { self: '/agent/runs/run-1' },
      progress: {
        setId: preview.id,
        phase: 'waiting_for_next',
        currentEntry: null,
        nextEntry: entry(1, 'pending'),
        taskResults: [entry(0, 'success'), entry(1, 'pending')],
      },
    })
    if (!projection) throw new Error('run_copilot_set 投影不应为空')
    const view = deriveCopilotSetView({
      preview,
      selected: new Set([1, 2, 3]),
      setRun: projection,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: true,
      isAutoStopping: false,
    })

    await renderPanel(view)

    expect(container.textContent).toContain('下一关')
    expect(container.textContent).toContain('第 2 / 4 关')
    expect(container.textContent).toContain('prts://102')
    expect(container.textContent).toContain('MAIN-2')
    expect(container.textContent).toContain('请在游戏中进入下一关界面后点击「开始下一关」。')
  })

  it('shows the explanation for a preview without a usable set', async () => {
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

    await renderPanel(view, { preview: emptySet, isRunning: false })

    expect(container.textContent).toContain('这套作业集暂时没有可用作业')
    expect(container.querySelector('[role="list"]')).toBeNull()
  })

  it('marks a missing set as unknown without inventing summary facts', async () => {
    const sparseSet: CopilotSetInfo = {
      ...preview,
      copilots: [],
    }
    const view = deriveCopilotSetView({
      preview: sparseSet,
      selected: new Set(),
      setRun: null,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    await renderPanel(view, { preview: sparseSet })

    expect(container.textContent).toContain('暂无作业明细')
    expect(container.textContent).not.toContain('理智')
  })
})
