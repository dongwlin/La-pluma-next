import { describe, expect, it } from 'vitest'
import type { CopilotSetInfo, CopilotSetItem } from '../types'
import type { CopilotSetEntryProjection, CopilotSetRunProjection } from './copilotSetRun'
import { deriveCopilotSetView } from './copilotSetView'

const copilots: CopilotSetItem[] = [
  { id: 101, stage: 'TEST-1' },
  { id: 102, stage: 'TEST-2' },
  { id: 103, stage: 'TEST-3' },
]

const preview = (overrides: Partial<CopilotSetInfo> = {}): CopilotSetInfo => ({
  type: 'set',
  id: '48990',
  name: '作业集',
  copilots,
  ...overrides,
})

const entry = (
  itemIndex: number,
  status: CopilotSetEntryProjection['status'],
): CopilotSetEntryProjection => ({
  key: `${itemIndex}:${101 + itemIndex}:normal`,
  itemIndex,
  copilotId: 101 + itemIndex,
  stage: `TEST-${itemIndex + 1}`,
  mode: 'normal',
  status,
})

const projection = (
  overrides: Partial<CopilotSetRunProjection> = {},
): CopilotSetRunProjection => ({
  runId: 'run-1',
  state: 'running',
  isActive: true,
  setId: '48990',
  name: '作业集 48990',
  mode: 'continuous',
  raid: 'normal',
  phase: 'running',
  isWaiting: false,
  waitingForNext: false,
  currentItemIndex: null,
  nextEntry: null,
  entries: [],
  itemStatuses: new Map(),
  itemCount: 3,
  totalCount: 3,
  attemptedCount: 0,
  successCount: 0,
  failedCount: 0,
  stoppedCount: 0,
  pendingCount: 3,
  failures: [],
  ...overrides,
})

describe('deriveCopilotSetView', () => {
  it('returns an empty view without a preview or run', () => {
    const view = deriveCopilotSetView({
      preview: null,
      selected: new Set(),
      setRun: null,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBeNull()
    expect(view.itemStatuses.size).toBe(0)
    expect(view.pendingSelectedIndexes).toEqual([])
    expect(view.failedCount).toBe(0)
    expect(view.attemptedCount).toBe(0)
    expect(view.waitingEntry).toBeNull()
    expect(view.resumeIndex).toBe(-1)
    expect(view.panelIndex).toBe(0)
    expect(view.panelCopilot).toBeNull()
  })

  it('keeps a run only when it belongs to the previewed set', () => {
    const otherSet = projection({ setId: '11111' })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1]),
      setRun: otherSet,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBeNull()
    expect(view.itemStatuses.size).toBe(0)
    // 选择仍在，但没有本次 Run 的成功项可以扣除。
    expect(view.pendingSelectedIndexes).toEqual([0, 1])
  })

  it('ignores the run dismissed by a progress reset', () => {
    const run = projection({ itemStatuses: new Map([[0, 'success']]) })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1]),
      setRun: run,
      dismissedRunId: 'run-1',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBeNull()
    expect(view.pendingSelectedIndexes).toEqual([0, 1])
  })

  it('subtracts this run successes and counts folded item statuses', () => {
    const run = projection({
      currentItemIndex: 1,
      itemStatuses: new Map([
        [0, 'success'],
        [1, 'running'],
        [2, 'pending'],
      ]),
      attemptedCount: 2,
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBe(run)
    expect(view.pendingSelectedIndexes).toEqual([1, 2])
    expect(view.pendingSelectedCount).toBe(2)
    expect(view.selectedCount).toBe(3)
    expect(view.completedSelectedCount).toBe(1)
    expect(view.attemptedCount).toBe(2)
    expect(view.failedCount).toBe(0)
    expect(view.currentIndex).toBe(1)
    expect(view.resumeIndex).toBe(1)
    expect(view.panelIndex).toBe(1)
    expect(view.panelCopilot).toBe(copilots[1])
  })

  it('reports failed and stopped items as failures', () => {
    const run = projection({
      itemStatuses: new Map([
        [0, 'success'],
        [1, 'failed'],
        [2, 'stopped'],
      ]),
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.failedCount).toBe(2)
    expect(view.attemptedCount).toBe(3)
    expect(view.pendingSelectedIndexes).toEqual([1, 2])
  })

  it('uses the waiting entry as next target and resolves its copilot', () => {
    const next = entry(2, 'pending')
    const run = projection({
      state: 'waiting',
      isWaiting: true,
      waitingForNext: true,
      nextEntry: next,
      itemStatuses: new Map([
        [0, 'success'],
        [1, 'failed'],
        [2, 'pending'],
      ]),
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      isWaitingForNext: true,
      isAutoStopping: false,
    })

    expect(view.waitingEntry).toBe(next)
    expect(view.waitingEntryIndex).toBe(2)
    expect(view.waitingCopilot).toBe(copilots[2])
    expect(view.resumeIndex).toBe(2)
    expect(view.panelIndex).toBe(2)
  })

  it('hides the waiting entry while the failure policy stops the run', () => {
    const run = projection({
      state: 'waiting',
      isWaiting: true,
      nextEntry: entry(2, 'pending'),
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      isWaitingForNext: true,
      isAutoStopping: true,
    })

    expect(view.waitingEntry).toBeNull()
    expect(view.waitingEntryIndex).toBeNull()
    expect(view.waitingCopilot).toBeNull()
    expect(view.resumeIndex).toBe(0)
  })

  it('falls back to the first copilot and the first pending index without a current run item', () => {
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([2]),
      setRun: null,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.resumeIndex).toBe(2)
    expect(view.panelIndex).toBe(2)
    expect(view.panelCopilot).toBe(copilots[2])

    const emptySelection = deriveCopilotSetView({
      preview: preview(),
      selected: new Set(),
      setRun: null,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })
    expect(emptySelection.resumeIndex).toBe(-1)
    expect(emptySelection.panelIndex).toBe(0)
    expect(emptySelection.panelCopilot).toBe(copilots[0])
  })

  it('does not expose a copilot for a single preview', () => {
    const view = deriveCopilotSetView({
      preview: { type: 'single', id: '1234', name: '单作业' },
      selected: new Set([0]),
      setRun: null,
      dismissedRunId: null,
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.panelCopilot).toBeNull()
    expect(view.waitingCopilot).toBeNull()
    expect(view.resumeIndex).toBe(0)
  })
})
