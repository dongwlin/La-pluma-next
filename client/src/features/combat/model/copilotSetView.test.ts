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

type EntryStatus = CopilotSetEntryProjection['status']

const entry = (
  itemIndex: number,
  status: EntryStatus,
  mode: 'normal' | 'raid' = 'normal',
): CopilotSetEntryProjection => ({
  key: `${itemIndex}:${101 + itemIndex}:${mode}`,
  itemIndex,
  copilotId: 101 + itemIndex,
  stage: `TEST-${itemIndex + 1}`,
  mode,
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
  skippedCount: 0,
  stoppedCount: 0,
  pendingCount: 3,
  failures: [],
  ...overrides,
})

/** 按普通模式的逐项结果构造 Run：条目与折叠状态同时给出。 */
const normalRun = (
  statuses: Array<[number, EntryStatus]>,
  overrides: Partial<CopilotSetRunProjection> = {},
): CopilotSetRunProjection => projection({
  itemStatuses: new Map(statuses),
  entries: statuses.map(([itemIndex, status]) => entry(itemIndex, status)),
  ...overrides,
})

describe('deriveCopilotSetView', () => {
  it('returns an empty view without a preview or run', () => {
    const view = deriveCopilotSetView({
      preview: null,
      selected: new Set(),
      setRun: null,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBeNull()
    expect(view.itemStatuses.size).toBe(0)
    expect(view.historyCompletedIndexes.size).toBe(0)
    expect(view.progress).toEqual({
      total: 0, completed: 0, pending: 0, failed: 0, stopped: 0, skipped: 0,
    })
    expect(view.pendingSelectedIndexes).toEqual([])
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
      raid: 'normal',
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
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBeNull()
    expect(view.pendingSelectedIndexes).toEqual([0, 1])
  })

  it('subtracts this run successes and counts folded item statuses', () => {
    const run = normalRun([
      [0, 'success'],
      [1, 'running'],
      [2, 'pending'],
    ], {
      currentItemIndex: 1,
      attemptedCount: 2,
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.activeSetRun).toBe(run)
    expect(view.pendingSelectedIndexes).toEqual([1, 2])
    expect(view.pendingSelectedCount).toBe(2)
    expect(view.selectedCount).toBe(3)
    expect(view.completedSelectedCount).toBe(1)
    expect(view.attemptedCount).toBe(2)
    expect(view.progress).toEqual({
      total: 3, completed: 1, pending: 2, failed: 0, stopped: 0, skipped: 0,
    })
    expect(view.currentIndex).toBe(1)
    expect(view.resumeIndex).toBe(1)
    expect(view.panelIndex).toBe(1)
    expect(view.panelCopilot).toBe(copilots[1])
  })

  it('counts a stopped item separately from failures', () => {
    const run = normalRun([
      [0, 'success'],
      [1, 'failed'],
      [2, 'stopped'],
    ])
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    // 主动终止仍要重打，但不属于执行失败。
    expect(view.attemptedCount).toBe(3)
    expect(view.pendingSelectedIndexes).toEqual([1, 2])
    expect(view.progress).toEqual({
      total: 3, completed: 1, pending: 2, failed: 1, stopped: 1, skipped: 0,
    })
  })

  it('treats skipped items as neither executed nor failed', () => {
    const run = normalRun([
      [0, 'success'],
      [1, 'skipped'],
      [2, 'pending'],
    ])
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.attemptedCount).toBe(1)
    expect(view.pendingSelectedIndexes).toEqual([1, 2])
    expect(view.progress).toEqual({
      total: 3, completed: 1, pending: 2, failed: 0, stopped: 0, skipped: 1,
    })
  })

  it('never counts unselected or skipped items as completed', () => {
    const run = normalRun([
      [0, 'skipped'],
      [1, 'running'],
      [2, 'skipped'],
    ], { currentItemIndex: 1 })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([1]),
      setRun: run,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.progress).toEqual({
      total: 3, completed: 0, pending: 1, failed: 0, stopped: 0, skipped: 2,
    })
    // 未选中的作业仍在计划中，不能被选择状态解释为已通关。
    expect(view.historyCompletedIndexes.size).toBe(0)
  })

  it('derives history completion from persisted plan progress, not the selection', () => {
    const planned = preview({
      copilots: [
        { id: 101, completedModes: ['normal'] },
        { id: 102 },
        { id: 103, completedModes: ['normal', 'raid'] },
      ],
    })
    const view = deriveCopilotSetView({
      preview: planned,
      selected: new Set([1]),
      setRun: null,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect([...view.historyCompletedIndexes]).toEqual([0, 2])
    expect(view.progress).toEqual({
      total: 3, completed: 2, pending: 1, failed: 0, stopped: 0, skipped: 0,
    })
  })

  it('requires both modes before a history completion counts under raid both', () => {
    const planned = preview({
      copilots: [
        { id: 101, completedModes: ['normal'] },
        { id: 102, completedModes: ['normal', 'raid'] },
        { id: 103 },
      ],
    })
    const view = deriveCopilotSetView({
      preview: planned,
      selected: new Set(),
      setRun: null,
      dismissedRunId: null,
      raid: 'both',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect([...view.historyCompletedIndexes]).toEqual([1])
    expect(view.progress).toEqual({
      total: 3, completed: 1, pending: 0, failed: 0, stopped: 0, skipped: 0,
    })
  })

  it('counts an item once when this run success is already persisted', () => {
    const planned = preview({
      copilots: [
        { id: 101, completedModes: ['normal'] },
        { id: 102 },
        { id: 103 },
      ],
    })
    const run = normalRun([[0, 'success']])
    const view = deriveCopilotSetView({
      preview: planned,
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.progress.completed).toBe(1)
    expect(view.progress.pending).toBe(2)
  })

  it('keeps a partially completed item pending while the other mode waits', () => {
    const planned = preview({
      copilots: [
        { id: 101, completedModes: ['normal'] },
        { id: 102 },
        { id: 103 },
      ],
    })
    const run = projection({
      state: 'waiting',
      isWaiting: true,
      waitingForNext: true,
      nextEntry: entry(0, 'pending', 'raid'),
      itemStatuses: new Map([[0, 'pending'], [1, 'pending'], [2, 'pending']]),
      entries: [
        entry(0, 'success', 'normal'),
        entry(0, 'pending', 'raid'),
        entry(1, 'pending', 'normal'),
        entry(1, 'pending', 'raid'),
        entry(2, 'pending', 'normal'),
        entry(2, 'pending', 'raid'),
      ],
    })
    const view = deriveCopilotSetView({
      preview: planned,
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      raid: 'both',
      isWaitingForNext: true,
      isAutoStopping: false,
    })

    // 普通已成功、突袭仍待执行：作业未满足两种模式，不能提前算作已通关。
    expect(view.runCompletedIndexes.size).toBe(0)
    expect(view.historyCompletedIndexes.has(0)).toBe(false)
    expect(view.pendingSelectedIndexes).toEqual([0, 1, 2])
    expect(view.progress).toEqual({
      total: 3, completed: 0, pending: 3, failed: 0, stopped: 0, skipped: 0,
    })
    expect(view.attemptedCount).toBe(1)
    expect(view.resumeIndex).toBe(0)
  })

  it('completes an item only after every required mode succeeded', () => {
    const twoItems = preview({
      copilots: [{ id: 101 }, { id: 102 }],
    })
    const run = projection({
      state: 'succeeded',
      isActive: false,
      itemStatuses: new Map([[0, 'success'], [1, 'pending']]),
      entries: [
        entry(0, 'success', 'normal'),
        entry(0, 'success', 'raid'),
        entry(1, 'success', 'normal'),
        entry(1, 'pending', 'raid'),
      ],
    })
    const view = deriveCopilotSetView({
      preview: twoItems,
      selected: new Set([0, 1]),
      setRun: run,
      dismissedRunId: null,
      raid: 'both',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect([...view.runCompletedIndexes]).toEqual([0])
    expect(view.pendingSelectedIndexes).toEqual([1])
    expect(view.progress).toEqual({
      total: 2, completed: 1, pending: 1, failed: 0, stopped: 0, skipped: 0,
    })
  })

  it('does not treat a normal-only success as completion under raid both', () => {
    const run = projection({
      itemStatuses: new Map([[0, 'success']]),
      entries: [entry(0, 'success', 'normal')],
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0]),
      setRun: run,
      dismissedRunId: null,
      raid: 'both',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.runCompletedIndexes.size).toBe(0)
    expect(view.pendingSelectedIndexes).toEqual([0])
    expect(view.progress.completed).toBe(0)
  })

  it('uses the waiting entry as next target and resolves its copilot', () => {
    const next = entry(2, 'pending')
    const run = normalRun([
      [0, 'success'],
      [1, 'failed'],
      [2, 'pending'],
    ], {
      state: 'waiting',
      isWaiting: true,
      waitingForNext: true,
      nextEntry: next,
    })
    const view = deriveCopilotSetView({
      preview: preview(),
      selected: new Set([0, 1, 2]),
      setRun: run,
      dismissedRunId: null,
      raid: 'normal',
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
      raid: 'normal',
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
      raid: 'normal',
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
      raid: 'normal',
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
      raid: 'normal',
      isWaitingForNext: false,
      isAutoStopping: false,
    })

    expect(view.panelCopilot).toBeNull()
    expect(view.waitingCopilot).toBeNull()
    expect(view.resumeIndex).toBe(0)
  })
})
