// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import type { CopilotQueueRunProjection } from './copilotQueueRun'
import type { CopilotSetRunProjection } from './copilotSetRun'
import { deriveExecutionProgress, formatExecutionElapsed } from './executionProgress'

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'running',
    links: { self: '/api/agent/runs/run-1', stop: '/api/agent/actions/stop?runId=run-1' },
    ...overrides,
  }
}

function setProjection(overrides: Partial<CopilotSetRunProjection> = {}): CopilotSetRunProjection {
  return {
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
    itemCount: 0,
    totalCount: 0,
    queuedCount: 0,
    attemptedCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    stoppedCount: 0,
    pendingCount: 0,
    failures: [],
    ...overrides,
  }
}

function queueProjection(overrides: Partial<CopilotQueueRunProjection> = {}): CopilotQueueRunProjection {
  return {
    runId: 'run-1',
    state: 'running',
    isActive: true,
    isTerminal: false,
    queueId: 'copilot-queue',
    name: '作业队列',
    mode: 'continuous',
    failurePolicy: 'continue',
    phase: 'running',
    isWaiting: false,
    waitingForNext: false,
    currentClientId: null,
    currentItemIndex: null,
    nextEntry: null,
    taskResults: [],
    statuses: new Map(),
    totalCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    stoppedCount: 0,
    pendingCount: 0,
    failures: [],
    summaryErrors: [],
    ...overrides,
  }
}

describe('deriveExecutionProgress', () => {
  it('returns null without a tracked run', () => {
    expect(deriveExecutionProgress(null, null)).toBeNull()
  })

  it('projects a set run with the queue position and current stage', () => {
    const setRun = setProjection({
      itemCount: 3,
      entries: [
        {
          key: '1:102:normal',
          itemIndex: 1,
          copilotId: 102,
          stage: 'TEST-2',
          mode: 'normal',
          status: 'running',
        },
      ],
    })
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: { name: '作业集 48990', currentStep: 2, totalSteps: 3 },
    }), setRun)

    expect(view).not.toBeNull()
    expect(view?.state).toBe('running')
    expect(view?.isActive).toBe(true)
    expect(view?.stage).toBe('TEST-2')
    expect(view?.step).toEqual({ current: 2, total: 3 })
    expect(view?.mode).toBe('normal')
    expect(view?.name).toBeNull()
  })

  it('reads the running mode from the server entry for a set run', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: { currentEntry: { displayStage: 'TEST-2', mode: 'raid' }, currentStep: 3, totalSteps: 4 },
    }), setProjection())

    expect(view?.stage).toBe('TEST-2')
    expect(view?.mode).toBe('raid')
    expect(view?.step).toEqual({ current: 3, total: 4 })
  })

  it('drops a mode it cannot place instead of guessing', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: { currentEntry: { displayStage: 'TEST-2', mode: 'both' } },
    }), setProjection())

    expect(view?.mode).toBeNull()
  })

  it('projects the queue entry stage and mode from the per-item results', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_queue',
      progress: { currentStep: 3, totalSteps: 4 },
    }), null, queueProjection({
      currentClientId: 'b',
      taskResults: [
        {
          clientId: 'a',
          itemIndex: 1,
          stage: 'TEST-1',
          stageId: null,
          apCost: null,
          mode: 'normal',
          status: 'success',
        },
        {
          clientId: 'b',
          itemIndex: 1,
          stage: 'TEST-1',
          stageId: null,
          apCost: null,
          mode: 'raid',
          status: 'running',
        },
      ],
    }))

    expect(view?.name).toBeNull()
    expect(view?.stage).toBe('TEST-1')
    expect(view?.mode).toBe('raid')
    expect(view?.step).toEqual({ current: 3, total: 4 })
  })

  it('keeps the queue position but drops the mode while waiting', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_queue',
      state: 'waiting',
      progress: { currentStep: 2, totalSteps: 2 },
    }), null, queueProjection({ state: 'waiting', isWaiting: true, waitingForNext: true }))

    expect(view?.step).toEqual({ current: 2, total: 2 })
    expect(view?.stage).toBeNull()
    expect(view?.mode).toBeNull()
  })

  it('numbers the step by the server queue while a set run waits', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      state: 'waiting',
      progress: { currentStep: 2, totalSteps: 2 },
    }), setProjection({ state: 'waiting', isWaiting: true, waitingForNext: true }))

    expect(view?.step).toEqual({ current: 2, total: 2 })
    expect(view?.stage).toBeNull()
  })

  it('does not substitute the item index for the queue position', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: {},
    }), setProjection({ currentItemIndex: 2 }))

    expect(view?.step).toBeNull()
  })

  it('omits the total when the server only reports the current position', () => {
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: { currentStep: 2 },
    }), setProjection())

    expect(view?.step).toEqual({ current: 2, total: null })
  })

  it('projects a single task run without step or stage', () => {
    const view = deriveExecutionProgress(run({
      progress: { currentTask: '自动战斗作业' },
    }), null)

    expect(view?.name).toBe('自动战斗作业')
    expect(view?.stage).toBeNull()
    expect(view?.mode).toBeNull()
    expect(view?.step).toBeNull()
  })

  it('degrades to null fields when the server has not projected progress', () => {
    const view = deriveExecutionProgress(run({ state: 'accepted' }), null)

    expect(view?.name).toBeNull()
    expect(view?.stage).toBeNull()
    expect(view?.mode).toBeNull()
    expect(view?.step).toBeNull()
    expect(view?.startedAtMs).toBeNull()
    expect(view?.durationMs).toBeNull()
  })

  it('hides the stage until the set run reports an entry', () => {
    const view = deriveExecutionProgress(
      run({ operationId: 'run_copilot_set' }),
      setProjection(),
    )

    expect(view?.stage).toBeNull()
    expect(view?.step).toBeNull()
  })

  it('reads timing facts from the run', () => {
    const view = deriveExecutionProgress(run({
      startedAt: '2026-11-03T00:00:00.000Z',
      durationMs: 65_000,
    }), null)

    expect(view?.startedAtMs).toBe(Date.parse('2026-11-03T00:00:00.000Z'))
    expect(view?.durationMs).toBe(65_000)
  })
})

describe('formatExecutionElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatExecutionElapsed(0)).toBe('0 秒')
    expect(formatExecutionElapsed(59_000)).toBe('59 秒')
    expect(formatExecutionElapsed(61_000)).toBe('1 分 1 秒')
    expect(formatExecutionElapsed(3_600_000)).toBe('1 小时 0 分')
  })

  it('returns null for missing or invalid input', () => {
    expect(formatExecutionElapsed(null)).toBeNull()
    expect(formatExecutionElapsed(-1)).toBeNull()
    expect(formatExecutionElapsed(Number.NaN)).toBeNull()
  })
})
