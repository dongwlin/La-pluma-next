// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AgentRun, RunSnapshot } from '@/features/task-execution'
import {
  LEGACY_FLOW_EXECUTION_KEY,
  LEGACY_FLOW_EXECUTION_MAX_AGE_MS,
  matchLegacyFlowCheckpoint,
  migrateLegacyFlowCheckpoint,
  readLegacyFlowCheckpoint,
  type LegacyFlowCheckpoint,
  type LegacyFlowCheckpointStorage,
} from './flowCheckpoint'

const NOW = Date.parse('2026-10-25T12:00:00.000Z')

function dailyRun(
  runId: string,
  state: AgentRun['state'],
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return {
    runId,
    operationId: 'run_daily_flow',
    state,
    acceptedAt: new Date(NOW - 120_000).toISOString(),
    startedAt: new Date(NOW - 115_000).toISOString(),
    finishedAt: state === 'succeeded' || state === 'failed' || state === 'stopped' || state === 'interrupted'
      ? new Date(NOW - 30_000).toISOString()
      : null,
    links: {
      self: `/api/agent/runs/${runId}`,
      stop: `/api/agent/actions/stop?runId=${runId}`,
    },
    ...overrides,
  }
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const activeRuns = overrides.activeRuns ?? []
  const run = overrides.run ?? activeRuns[0] ?? null
  return {
    isRunning: activeRuns.length > 0,
    run,
    activeRuns,
    lastRun: overrides.lastRun ?? null,
    schedule: overrides.schedule ?? {},
    occupancy: {
      state: activeRuns.length ? 'run' : 'idle',
      runId: run?.runId ?? null,
      runState: run?.state ?? null,
      sources: activeRuns.length ? ['run'] : [],
      lease: { state: 'free', owner: null },
      task: { isRunning: false, taskName: null, taskType: null, stopRequested: false },
      schedule: {},
    },
    ...overrides,
  }
}

function rawCheckpoint(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    isExecuting: true,
    tasks: [
      { id: 'startup-1', commandId: 'startup', name: '启动游戏' },
      { id: 'fight-1', commandId: 'fight', name: '理智作战' },
    ],
    currentIndex: 1,
    startTime: NOW - 60_000,
    ...overrides,
  })
}

function validCheckpoint(): LegacyFlowCheckpoint {
  const read = readLegacyFlowCheckpoint(rawCheckpoint(), NOW)
  if (read.status !== 'valid') throw new Error('checkpoint fixture must be valid')
  return read.checkpoint
}

function memoryStorage(initial: string | null): LegacyFlowCheckpointStorage & { read(): string | null } {
  let value = initial
  return {
    getItem: () => value,
    removeItem: () => {
      value = null
    },
    read: () => value,
  }
}

describe('legacy automation checkpoint parsing', () => {
  it('treats a missing key as absent', () => {
    expect(readLegacyFlowCheckpoint(null, NOW)).toEqual({ status: 'absent' })
    expect(readLegacyFlowCheckpoint('  ', NOW)).toEqual({ status: 'absent' })
  })

  it('reads the legacy JSON shape without inventing a version', () => {
    const result = readLegacyFlowCheckpoint(rawCheckpoint(), NOW)

    expect(result).toMatchObject({
      status: 'valid',
      checkpoint: {
        version: 1,
        isExecuting: true,
        currentIndex: 1,
        startTime: NOW - 60_000,
      },
    })
  })

  it('rejects unreadable JSON and non-checkpoint payloads', () => {
    expect(readLegacyFlowCheckpoint('{', NOW)).toEqual({ status: 'invalid', reason: 'malformed' })
    expect(readLegacyFlowCheckpoint('[]', NOW)).toEqual({ status: 'invalid', reason: 'malformed' })
    expect(readLegacyFlowCheckpoint(rawCheckpoint({ isExecuting: false }), NOW))
      .toEqual({ status: 'invalid', reason: 'malformed' })
    expect(readLegacyFlowCheckpoint(rawCheckpoint({ tasks: [] }), NOW))
      .toEqual({ status: 'invalid', reason: 'malformed' })
    expect(readLegacyFlowCheckpoint(rawCheckpoint({ startTime: 'yesterday' }), NOW))
      .toEqual({ status: 'invalid', reason: 'malformed' })
    expect(readLegacyFlowCheckpoint(rawCheckpoint({ startTime: NOW + 120_000 }), NOW))
      .toEqual({ status: 'invalid', reason: 'malformed' })
  })

  it('rejects versions it does not know', () => {
    expect(readLegacyFlowCheckpoint(rawCheckpoint({ version: 2 }), NOW))
      .toEqual({ status: 'invalid', reason: 'unsupported' })
  })

  it('expires checkpoints older than the Run retention window', () => {
    const startTime = NOW - LEGACY_FLOW_EXECUTION_MAX_AGE_MS - 1
    expect(readLegacyFlowCheckpoint(rawCheckpoint({ startTime }), NOW))
      .toEqual({ status: 'invalid', reason: 'expired' })
  })
})

describe('legacy checkpoint matching', () => {
  it('associates the active flow that owns the schedule projection', () => {
    const checkpoint = validCheckpoint()
    const run = dailyRun('run-1', 'running')

    expect(matchLegacyFlowCheckpoint(checkpoint, snapshot({
      activeRuns: [run],
      schedule: { isRunning: true, runId: 'run-1', currentStep: 1 },
    }))).toEqual({ status: 'matched', checkpoint, run })
  })

  it('associates an accepted daily flow before the schedule projection exists', () => {
    const checkpoint = validCheckpoint()
    const run = dailyRun('run-1', 'accepted')

    expect(matchLegacyFlowCheckpoint(checkpoint, snapshot({ activeRuns: [run] })))
      .toEqual({ status: 'matched', checkpoint, run })
  })

  it('refuses to claim a flow without a Run identity', () => {
    expect(matchLegacyFlowCheckpoint(validCheckpoint(), snapshot({
      schedule: { isRunning: true, runId: null },
    }))).toEqual({
      status: 'conflict',
      checkpoint: validCheckpoint(),
      run: null,
      reason: 'unmanaged-flow',
    })
  })

  it('reports a conflict when another domain owns the active run', () => {
    const other = dailyRun('run-2', 'running', { operationId: 'run_task' })

    expect(matchLegacyFlowCheckpoint(validCheckpoint(), snapshot({
      activeRuns: [other],
      schedule: { isRunning: true, runId: 'run-2' },
    }))).toMatchObject({ status: 'conflict', reason: 'other-active-run', run: other })
  })

  it('reports a conflict when the page already tracks a different run', () => {
    const run = dailyRun('run-2', 'running')

    expect(matchLegacyFlowCheckpoint(validCheckpoint(), snapshot({
      activeRuns: [run],
      schedule: { isRunning: true, runId: 'run-2' },
    }), 'run-1')).toMatchObject({
      status: 'conflict',
      reason: 'other-active-run',
      run,
    })
  })

  it('associates a terminal flow that was in flight when the checkpoint was written', () => {
    const checkpoint = validCheckpoint()
    const run = dailyRun('run-1', 'succeeded', {
      result: { message: '任务流程执行完成', summary: { successCount: 2 } },
    })

    expect(matchLegacyFlowCheckpoint(checkpoint, snapshot({ lastRun: run })))
      .toEqual({ status: 'matched', checkpoint, run })
  })

  it('does not claim a terminal flow that started after the checkpoint', () => {
    const checkpoint = { ...validCheckpoint(), startTime: NOW - 600_000 }
    const run = dailyRun('run-1', 'succeeded', {
      acceptedAt: new Date(NOW - 120_000).toISOString(),
      startedAt: new Date(NOW - 115_000).toISOString(),
    })

    expect(matchLegacyFlowCheckpoint(checkpoint, snapshot({ lastRun: run })))
      .toEqual({ status: 'unmatched', checkpoint })
  })

  it('leaves an old checkpoint unmatched when nothing can be associated', () => {
    expect(matchLegacyFlowCheckpoint(validCheckpoint(), snapshot())).toEqual({
      status: 'unmatched',
      checkpoint: validCheckpoint(),
    })
  })
})

describe('legacy checkpoint migration', () => {
  it('adopts the matching run and deletes the old key', () => {
    const storage = memoryStorage(rawCheckpoint())
    const run = dailyRun('run-1', 'running')

    const result = migrateLegacyFlowCheckpoint({
      storage,
      snapshot: snapshot({ activeRuns: [run], schedule: { isRunning: true, runId: 'run-1' } }),
      now: NOW,
    })

    expect(result).toMatchObject({ status: 'adopted', run, removed: true })
    expect(storage.read()).toBeNull()
    expect(storage.getItem(LEGACY_FLOW_EXECUTION_KEY)).toBeNull()
  })

  it('deletes invalid checkpoints without producing a run', () => {
    const storage = memoryStorage('{')

    expect(migrateLegacyFlowCheckpoint({ storage, snapshot: snapshot(), now: NOW }))
      .toEqual({ status: 'invalid', reason: 'malformed', removed: true })
    expect(storage.read()).toBeNull()
  })

  it('deletes conflicting checkpoints without adopting another run', () => {
    const storage = memoryStorage(rawCheckpoint())
    const other = dailyRun('run-2', 'running', { operationId: 'run_task' })

    expect(migrateLegacyFlowCheckpoint({
      storage,
      snapshot: snapshot({ activeRuns: [other] }),
      now: NOW,
    })).toMatchObject({ status: 'conflict', reason: 'other-active-run', removed: true })
    expect(storage.read()).toBeNull()
  })

  it('keeps reporting the outcome when the old key cannot be removed', () => {
    const storage = memoryStorage(rawCheckpoint())
    storage.removeItem = () => {
      throw new Error('storage unavailable')
    }
    const run = dailyRun('run-1', 'running')

    const result = migrateLegacyFlowCheckpoint({
      storage,
      snapshot: snapshot({ activeRuns: [run] }),
      now: NOW,
    })

    expect(result).toMatchObject({ status: 'adopted', run, removed: false })
  })

  it('does nothing when storage is unavailable', () => {
    expect(migrateLegacyFlowCheckpoint({ storage: null, snapshot: snapshot(), now: NOW }))
      .toEqual({ status: 'none', removed: false })
  })
})
