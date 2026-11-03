// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
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

describe('deriveExecutionProgress', () => {
  it('returns null without a tracked run', () => {
    expect(deriveExecutionProgress(null, null)).toBeNull()
  })

  it('projects a set run with step, stage and per-item counts', () => {
    const setRun = setProjection({
      itemCount: 3,
      totalCount: 3,
      successCount: 1,
      failedCount: 1,
      skippedCount: 1,
      pendingCount: 1,
      currentItemIndex: 1,
      entries: [
        {
          key: '0:101:normal',
          itemIndex: 0,
          copilotId: 101,
          stage: 'TEST-1',
          mode: 'normal',
          status: 'success',
        },
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
      progress: { name: '作业集 48990', totalSteps: 3 },
    }), setRun)

    expect(view).not.toBeNull()
    expect(view?.state).toBe('running')
    expect(view?.isActive).toBe(true)
    expect(view?.stateLabel).toBe('执行中')
    expect(view?.name).toBe('作业集 48990')
    expect(view?.stage).toBe('TEST-2')
    expect(view?.step).toEqual({ current: 2, total: 3 })
    expect(view?.counts).toEqual({ success: 1, failed: 1, stopped: 0, skipped: 1, pending: 1 })
  })

  it('numbers the step by the server queue while a set run waits', () => {
    const setRun = setProjection({
      state: 'waiting',
      isActive: true,
      isWaiting: true,
      waitingForNext: true,
      itemCount: 2,
      totalCount: 2,
      successCount: 1,
      pendingCount: 1,
      nextEntry: {
        key: '1:102:normal',
        itemIndex: 1,
        copilotId: 102,
        stage: 'TEST-2',
        mode: 'normal',
        status: 'pending',
      },
    })
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      state: 'waiting',
      progress: { currentStep: 2, totalSteps: 2 },
    }), setRun)

    expect(view?.stateLabel).toBe('等待下一关')
    expect(view?.step).toEqual({ current: 2, total: 2 })
    expect(view?.stage).toBeNull()
  })

  it('prefers the server queue position over the running item index', () => {
    const setRun = setProjection({
      itemCount: 3,
      totalCount: 3,
      currentItemIndex: 2,
    })
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: { currentStep: 2, totalSteps: 3 },
    }), setRun)

    expect(view?.step).toEqual({ current: 2, total: 3 })
  })

  it('keeps counting skipped items in the summary without breaking the step', () => {
    const setRun = setProjection({
      itemCount: 3,
      totalCount: 2,
      successCount: 1,
      skippedCount: 1,
      pendingCount: 1,
      currentItemIndex: 1,
    })
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      progress: {
        currentStep: 2,
        totalSteps: 2,
        skippedCount: 1,
        successCount: 1,
        pendingCount: 1,
      },
    }), setRun)

    expect(view?.step).toEqual({ current: 2, total: 2 })
    expect(view?.counts).toEqual({ success: 1, failed: 0, stopped: 0, skipped: 1, pending: 1 })
  })

  it('keeps stopped items visible after the run is terminated', () => {
    const setRun = setProjection({
      state: 'stopped',
      isActive: false,
      itemCount: 3,
      totalCount: 3,
      successCount: 1,
      stoppedCount: 1,
      pendingCount: 1,
    })
    const view = deriveExecutionProgress(run({
      operationId: 'run_copilot_set',
      state: 'stopped',
      progress: { totalSteps: 3, successCount: 1, stoppedCount: 1, pendingCount: 1 },
    }), setRun)

    expect(view?.counts).toEqual({ success: 1, failed: 0, stopped: 1, skipped: 0, pending: 1 })
  })

  it('projects a single task run without step, stage or counts', () => {
    const view = deriveExecutionProgress(run({
      progress: { currentTask: '自动战斗作业' },
    }), null)

    expect(view?.name).toBe('自动战斗作业')
    expect(view?.stage).toBeNull()
    expect(view?.step).toBeNull()
    expect(view?.counts).toBeNull()
    expect(view?.stateLabel).toBe('执行中')
  })

  it('degrades to null fields when the server has not projected progress', () => {
    const view = deriveExecutionProgress(run({ state: 'accepted' }), null)

    expect(view?.stateLabel).toBe('启动中')
    expect(view?.name).toBeNull()
    expect(view?.stage).toBeNull()
    expect(view?.step).toBeNull()
    expect(view?.counts).toBeNull()
    expect(view?.startedAtMs).toBeNull()
    expect(view?.durationMs).toBeNull()
  })

  it('hides counts until the set run has any entry facts', () => {
    const view = deriveExecutionProgress(
      run({ operationId: 'run_copilot_set' }),
      setProjection(),
    )

    expect(view?.counts).toBeNull()
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
