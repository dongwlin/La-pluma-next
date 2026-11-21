// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@/features/task-execution'
import {
  calculateRoguelikeSuccessRate,
  describeRoguelikeRoundOutcome,
  formatRoguelikeElapsed,
  formatRoguelikeRelativeTime,
  readRoguelikeRunProgress,
  readRoguelikeSummaryProgress,
  selectRoguelikeProgressView,
  type RoguelikeCommand,
  type RoguelikeProgressSnapshot,
} from './runProgress'
import { readRoguelikeRunSummary, type RoguelikeRunSummary } from './runSummary'

function snapshot(overrides: Partial<RoguelikeProgressSnapshot> = {}): RoguelikeProgressSnapshot {
  return {
    command: 'roguelike',
    theme: 'Phantom',
    mode: 0,
    phase: 'exploring',
    currentRound: 3,
    roundStartedAt: '2026-11-21T10:00:00.000Z',
    targetRounds: 3,
    roundsStarted: 3,
    roundsEnded: 2,
    roundsSettled: 2,
    roundsPassed: 1,
    settlementSupported: true,
    currentAction: 'StageInfo',
    lastEventKind: 'combat',
    lastEventName: '紧急作战',
    lastEventAt: '2026-11-21T10:05:00.000Z',
    combatCount: 4,
    investment: { rounds: 1, count: 10, total: 300, deposit: 100 },
    recentRounds: [
      {
        index: 2,
        outcome: 'passed',
        settled: true,
        floor: 5,
        score: 1200,
        endedAt: '2026-11-21T10:04:00.000Z',
      },
    ],
    updatedAt: '2026-11-21T10:05:01.000Z',
    degraded: false,
    observed: true,
    ...overrides,
  }
}

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...snapshot(), ...overrides }
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'running',
    links: { self: '/api/agent/runs/run-1' },
    ...overrides,
  }
}

function runWithProgress(value: unknown = snapshot(), overrides: Partial<AgentRun> = {}): AgentRun {
  return run({ progress: { roguelike: value }, ...overrides })
}

function summary(command: RoguelikeCommand = 'roguelike'): RoguelikeRunSummary {
  return {
    command,
    theme: command === 'roguelike' ? 'Phantom' : 'Reclamation',
    status: 'success',
    observed: true,
    message: '执行完成',
    settlement: null,
    investment: null,
    events: [],
    coppers: [],
    milestones: [],
    warnings: [],
    strategy: null,
    combats: 0,
    taskChain: { started: true, completed: true, failed: false, stopped: false },
  }
}

function terminalRunWithProgress(
  value: unknown,
  mode: RoguelikeCommand = 'roguelike',
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return run({
    state: 'succeeded',
    result: { summary: { ...summary(mode), progress: value } },
    ...overrides,
  })
}

describe('readRoguelikeRunProgress', () => {
  it('returns null without a run or a roguelike envelope', () => {
    expect(readRoguelikeRunProgress(null)).toBeNull()
    expect(readRoguelikeRunProgress(run())).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress(null))).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress('progress'))).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress({ command: 'combat' }))).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress([snapshot()]))).toBeNull()
  })

  it('parses a valid snapshot', () => {
    expect(readRoguelikeRunProgress(runWithProgress(snapshot()))).toEqual(snapshot())
  })

  it('keeps a missing mode as unknown without rejecting the snapshot', () => {
    const { mode: _mode, ...withoutMode } = raw()
    const parsed = readRoguelikeRunProgress(runWithProgress(withoutMode))

    expect(parsed).not.toBeNull()
    expect(parsed?.mode).toBeNull()
  })

  it('keeps a non-integer mode as unknown without rejecting the snapshot', () => {
    for (const mode of ['1', 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      const parsed = readRoguelikeRunProgress(runWithProgress(raw({ mode })))

      expect(parsed).not.toBeNull()
      expect(parsed?.mode).toBeNull()
    }
  })

  it('accepts a finite integer mode as-is', () => {
    expect(readRoguelikeRunProgress(runWithProgress(raw({ mode: 1 })))?.mode).toBe(1)
    expect(readRoguelikeRunProgress(runWithProgress(raw({ mode: 30003 })))?.mode).toBe(30003)
    expect(readRoguelikeRunProgress(runWithProgress(raw({ mode: null })))?.mode).toBeNull()
  })

  it('normalizes invalid optional fields to unknown instead of inventing values', () => {
    const parsed = readRoguelikeRunProgress(runWithProgress(raw({
      phase: 'dancing',
      currentRound: '3',
      roundStartedAt: 42,
      targetRounds: Number.NaN,
      settlementSupported: 'yes',
      currentAction: false,
      lastEventKind: 'dance',
      lastEventName: {},
      lastEventAt: [],
      investment: { rounds: 1 },
      recentRounds: 'rounds',
    })))

    expect(parsed).toMatchObject({
      phase: 'unknown',
      currentRound: null,
      roundStartedAt: null,
      targetRounds: null,
      settlementSupported: null,
      currentAction: null,
      lastEventKind: null,
      lastEventName: null,
      lastEventAt: null,
      investment: null,
      recentRounds: [],
    })
  })

  it.each(['roundsStarted', 'roundsEnded', 'roundsSettled', 'roundsPassed', 'combatCount'])(
    'rejects a snapshot whose %s is not a finite number instead of defaulting to zero',
    field => {
      expect(readRoguelikeRunProgress(runWithProgress(raw({ [field]: '2' })))).toBeNull()
      expect(readRoguelikeRunProgress(runWithProgress(raw({ [field]: Number.NaN })))).toBeNull()
      expect(readRoguelikeRunProgress(runWithProgress(raw({ [field]: Number.POSITIVE_INFINITY })))).toBeNull()
    },
  )

  it('rejects a snapshot whose required text or flags are malformed', () => {
    expect(readRoguelikeRunProgress(runWithProgress(raw({ theme: 1 })))).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress(raw({ updatedAt: 1 })))).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress(raw({ degraded: 'no' })))).toBeNull()
    expect(readRoguelikeRunProgress(runWithProgress(raw({ observed: 1 })))).toBeNull()
  })

  it('keeps a missing target as unknown instead of defaulting it', () => {
    const parsed = readRoguelikeRunProgress(runWithProgress(snapshot({ targetRounds: null })))

    expect(parsed?.targetRounds).toBeNull()
  })

  it('filters malformed recent rounds and keeps at most five valid entries', () => {
    const parsed = readRoguelikeRunProgress(runWithProgress(raw({
      recentRounds: [
        {
          index: 6,
          outcome: 'passed',
          settled: true,
          floor: 6,
          score: 1500,
          endedAt: '2026-11-21T10:06:00.000Z',
        },
        null,
        {
          index: 5,
          outcome: 'not_passed',
          settled: true,
          floor: 5,
          score: 1200,
          endedAt: '2026-11-21T10:05:00.000Z',
        },
        { index: '4', outcome: 'failed', settled: true, floor: 4, score: 900, endedAt: 7 },
        {
          index: 4,
          outcome: 'not_passed',
          settled: true,
          floor: 4,
          score: 800,
          endedAt: '2026-11-21T10:04:00.000Z',
        },
        { index: 3, outcome: 'not_passed', settled: 'yes', floor: 3, score: 400, endedAt: null },
        { index: 2, outcome: 'passed', settled: false, floor: null, score: null, endedAt: null },
        { index: 1, outcome: 'passed', settled: true, floor: 1, score: 100, endedAt: null },
        { index: 0, outcome: 'unknown', settled: true, floor: 0, score: 0, endedAt: null },
      ],
    })))

    expect(parsed?.recentRounds).toEqual([
      {
        index: 6,
        outcome: 'passed',
        settled: true,
        floor: 6,
        score: 1500,
        endedAt: '2026-11-21T10:06:00.000Z',
      },
      {
        index: 5,
        outcome: 'not_passed',
        settled: true,
        floor: 5,
        score: 1200,
        endedAt: '2026-11-21T10:05:00.000Z',
      },
      { index: null, outcome: 'unknown', settled: true, floor: 4, score: 900, endedAt: null },
      {
        index: 4,
        outcome: 'not_passed',
        settled: true,
        floor: 4,
        score: 800,
        endedAt: '2026-11-21T10:04:00.000Z',
      },
      { index: 2, outcome: 'passed', settled: false, floor: null, score: null, endedAt: null },
    ])
  })
})

describe('readRoguelikeSummaryProgress', () => {
  it('returns null without a run or nested progress', () => {
    expect(readRoguelikeSummaryProgress(null)).toBeNull()
    expect(readRoguelikeSummaryProgress(run())).toBeNull()
    expect(readRoguelikeSummaryProgress(run({ result: { summary: summary() } }))).toBeNull()
    expect(readRoguelikeSummaryProgress(run({ error: { details: { summary: summary() } } }))).toBeNull()
    expect(readRoguelikeSummaryProgress(run({ result: 'raw text' }))).toBeNull()
  })

  it('reads the final progress attached to a successful result summary', () => {
    const finalProgress = snapshot({ phase: 'ended', currentRound: null })
    const parsed = readRoguelikeSummaryProgress(
      run({ result: { summary: { ...summary(), progress: finalProgress } } }),
    )

    expect(parsed).toEqual(finalProgress)
  })

  it('falls back to the error details summary of a failed run', () => {
    const finalProgress = snapshot({ command: 'reclamation', phase: 'ended' })
    const parsed = readRoguelikeSummaryProgress(run({
      state: 'failed',
      result: undefined,
      error: {
        code: 'AGENT_RUN_FAILED',
        message: '执行失败',
        details: { summary: { ...summary('reclamation'), progress: finalProgress } },
      },
    }))

    expect(parsed).toEqual(finalProgress)
  })

  it('prefers result progress over error progress', () => {
    const resultProgress = snapshot({ command: 'roguelike' })
    const parsed = readRoguelikeSummaryProgress(run({
      state: 'stopped',
      result: { summary: { ...summary(), progress: resultProgress } },
      error: {
        details: {
          summary: { ...summary('reclamation'), progress: snapshot({ command: 'reclamation' }) },
        },
      },
    }))

    expect(parsed).toEqual(resultProgress)
  })

  it('falls back to error progress when the result progress is malformed', () => {
    const errorProgress = snapshot({ command: 'reclamation' })
    const parsed = readRoguelikeSummaryProgress(run({
      state: 'failed',
      result: { summary: { ...summary(), progress: { command: 'nope' } } },
      error: {
        details: { summary: { ...summary('reclamation'), progress: errorProgress } },
      },
    }))

    expect(parsed).toEqual(errorProgress)
  })

  it('does not let malformed nested progress invalidate the run summary', () => {
    const failedRun = run({
      state: 'failed',
      result: { summary: { ...summary(), progress: { command: 'nope' } } },
    })

    expect(readRoguelikeSummaryProgress(failedRun)).toBeNull()
    expect(readRoguelikeRunSummary(failedRun)?.command).toBe('roguelike')
  })
})

describe('selectRoguelikeProgressView', () => {
  it('returns the active snapshot when its command matches the mode', () => {
    const activeRun = runWithProgress(snapshot())
    const view = selectRoguelikeProgressView({
      mode: 'roguelike',
      run: activeRun,
      lastRun: null,
      hasSnapshot: true,
      taskName: '集成战略',
    })

    expect(view).toEqual({
      status: 'active',
      command: 'roguelike',
      progress: snapshot(),
      run: activeRun,
      summary: null,
      fromLastRun: false,
      taskName: '集成战略',
    })
  })

  it('keeps an active run without usable progress visible without inventing rounds', () => {
    const withoutProgress = run({ state: 'waiting' })
    const malformed = runWithProgress({ command: 'combat' })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: withoutProgress,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'active',
      progress: null,
      run: withoutProgress,
      summary: null,
      taskName: null,
    })
    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: malformed,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({ status: 'active', progress: null, run: malformed })
  })

  it('does not treat an active run of the other mode as this mode result', () => {
    const activeRun = runWithProgress(snapshot({ command: 'reclamation' }))

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: activeRun,
      lastRun: null,
      hasSnapshot: true,
    }).status).toBe('idle')
    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: activeRun,
      lastRun: null,
      hasSnapshot: false,
    }).status).toBe('loading')
  })

  it('uses a matching lastRun when the active run belongs to the other mode', () => {
    const activeRun = runWithProgress(snapshot({ command: 'reclamation' }))
    const lastRun = terminalRunWithProgress(snapshot({ phase: 'ended' }), 'roguelike')

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: activeRun,
      lastRun,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'terminal',
      progress: snapshot({ phase: 'ended' }),
      run: lastRun,
      summary: summary('roguelike'),
      fromLastRun: true,
    })
  })

  it('reads the final progress from a succeeded result summary', () => {
    const finalProgress = snapshot({ phase: 'ended', currentRound: null, roundsEnded: 3, roundsPassed: 2 })
    const terminalRun = terminalRunWithProgress(finalProgress)

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
      taskName: '集成战略',
    })).toEqual({
      status: 'terminal',
      command: 'roguelike',
      progress: finalProgress,
      run: terminalRun,
      summary: summary('roguelike'),
      fromLastRun: false,
      taskName: '集成战略',
    })
  })

  it('reads final progress from an error details summary', () => {
    const finalProgress = snapshot({ command: 'reclamation', phase: 'ended' })
    const failedRun = run({
      state: 'failed',
      result: undefined,
      error: {
        code: 'AGENT_RUN_FAILED',
        message: '执行失败',
        details: { summary: { ...summary('reclamation'), progress: finalProgress } },
      },
    })

    expect(selectRoguelikeProgressView({
      mode: 'reclamation',
      run: failedRun,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'terminal',
      command: 'reclamation',
      progress: finalProgress,
      run: failedRun,
      summary: summary('reclamation'),
      fromLastRun: false,
    })
  })

  it('falls back to the parsed summary when a terminal run has no final progress', () => {
    const terminalRun = run({ state: 'succeeded', result: { summary: summary('roguelike') } })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'terminal',
      progress: null,
      summary: summary('roguelike'),
      fromLastRun: false,
    })
  })

  it('keeps a terminal result when only the nested progress is malformed', () => {
    const terminalRun = run({
      state: 'succeeded',
      result: { summary: { ...summary('roguelike'), progress: 'broken' } },
    })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'terminal',
      progress: null,
      summary: summary('roguelike'),
    })
  })

  it('uses a matching summary command even when the summary body is not parseable', () => {
    const terminalRun = run({
      state: 'succeeded',
      result: { summary: { progress: snapshot({ phase: 'ended' }) } },
    })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'terminal',
      progress: snapshot({ phase: 'ended' }),
      summary: null,
    })
  })

  it('does not present a terminal run of the other mode as this mode result', () => {
    const terminalRun = terminalRunWithProgress(snapshot({ command: 'reclamation' }), 'reclamation')

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    }).status).toBe('idle')
  })

  it.each(['succeeded', 'failed', 'stopped', 'interrupted'] as const)(
    'keeps a %s tracked run visible without a summary or progress',
    state => {
      const terminalRun = run({ state })

      expect(selectRoguelikeProgressView({
        mode: 'roguelike',
        run: terminalRun,
        lastRun: null,
        hasSnapshot: true,
        taskName: '集成战略',
      })).toEqual({
        status: 'terminal',
        command: 'roguelike',
        progress: null,
        run: terminalRun,
        summary: null,
        fromLastRun: false,
        taskName: '集成战略',
      })
    },
  )

  it('keeps a terminal tracked run visible when its summary has no usable command', () => {
    const terminalRun = run({
      state: 'succeeded',
      result: { summary: { ...summary('roguelike'), command: 'combat' } },
    })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    })).toMatchObject({
      status: 'terminal',
      progress: null,
      summary: null,
      fromLastRun: false,
    })
  })

  it('does not present a terminal tracked run whose progress belongs to the other mode', () => {
    const terminalRun = run({
      state: 'succeeded',
      result: { summary: { progress: snapshot({ command: 'reclamation' }) } },
    })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    }).status).toBe('idle')
  })

  it('does not present a terminal tracked run whose summary belongs to the other mode', () => {
    const terminalRun = run({ state: 'succeeded', result: { summary: summary('reclamation') } })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    }).status).toBe('idle')
  })

  it('drops the summary when it disagrees with a progress that matches the mode', () => {
    const finalProgress = snapshot({ phase: 'ended' })
    const terminalRun = run({
      state: 'failed',
      result: { summary: { ...summary('reclamation'), progress: finalProgress } },
    })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    })).toEqual({
      status: 'terminal',
      command: 'roguelike',
      progress: finalProgress,
      run: terminalRun,
      summary: null,
      fromLastRun: false,
      taskName: null,
    })
  })

  it('drops the progress when it disagrees with a summary that matches the mode', () => {
    const terminalRun = run({
      state: 'succeeded',
      result: {
        summary: { ...summary('roguelike'), progress: snapshot({ command: 'reclamation' }) },
      },
    })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: terminalRun,
      lastRun: null,
      hasSnapshot: true,
    })).toEqual({
      status: 'terminal',
      command: 'roguelike',
      progress: null,
      run: terminalRun,
      summary: summary('roguelike'),
      fromLastRun: false,
      taskName: null,
    })
  })

  it('shows a matching lastRun as the terminal result after refresh without inheriting the tracked label', () => {
    const lastRun = terminalRunWithProgress(snapshot({ phase: 'ended' }), 'roguelike')
    const view = selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun,
      hasSnapshot: true,
      taskName: '集成战略',
    })

    expect(view).toEqual({
      status: 'terminal',
      command: 'roguelike',
      progress: snapshot({ phase: 'ended' }),
      run: lastRun,
      summary: summary('roguelike'),
      fromLastRun: true,
      taskName: null,
    })
  })

  it('does not label a matching lastRun with another mode tracked run name', () => {
    const activeRun = runWithProgress(snapshot({ command: 'reclamation' }))
    const lastRun = terminalRunWithProgress(snapshot({ phase: 'ended' }), 'roguelike')
    const view = selectRoguelikeProgressView({
      mode: 'roguelike',
      run: activeRun,
      lastRun,
      hasSnapshot: true,
      taskName: '生息演算',
    })

    expect(view).toMatchObject({
      status: 'terminal',
      fromLastRun: true,
      run: lastRun,
      taskName: null,
    })
  })

  it('ignores a lastRun from another operation', () => {
    const lastRun = terminalRunWithProgress(snapshot(), 'roguelike', { operationId: 'run_copilot_set' })

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun,
      hasSnapshot: true,
    }).status).toBe('idle')
  })

  it('ignores a lastRun of the other mode', () => {
    const lastRun = terminalRunWithProgress(snapshot({ command: 'reclamation' }), 'reclamation')

    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun,
      hasSnapshot: true,
    }).status).toBe('idle')
  })

  it('ignores a lastRun without a usable summary', () => {
    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun: run({ state: 'succeeded' }),
      hasSnapshot: true,
    }).status).toBe('idle')
    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun: run({ state: 'succeeded', result: { summary: { ...summary(), command: 'combat' } } }),
      hasSnapshot: true,
    }).status).toBe('idle')
    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun: run({
        state: 'succeeded',
        result: { summary: { progress: snapshot({ phase: 'ended' }) } },
      }),
      hasSnapshot: true,
    }).status).toBe('idle')
  })

  it('distinguishes an unobserved snapshot from an idle page', () => {
    expect(selectRoguelikeProgressView({
      mode: 'reclamation',
      run: null,
      lastRun: null,
      hasSnapshot: false,
    })).toEqual({
      status: 'loading',
      command: 'reclamation',
      progress: null,
      run: null,
      summary: null,
      fromLastRun: false,
      taskName: null,
    })
    expect(selectRoguelikeProgressView({
      mode: 'roguelike',
      run: null,
      lastRun: null,
      hasSnapshot: true,
    }).status).toBe('idle')
  })
})

describe('formatRoguelikeElapsed', () => {
  it('formats minutes and hours with second precision', () => {
    expect(formatRoguelikeElapsed(0)).toBe('00:00')
    expect(formatRoguelikeElapsed(999)).toBe('00:00')
    expect(formatRoguelikeElapsed(59_000)).toBe('00:59')
    expect(formatRoguelikeElapsed(60_000)).toBe('01:00')
    expect(formatRoguelikeElapsed(3_599_000)).toBe('59:59')
    expect(formatRoguelikeElapsed(3_600_000)).toBe('1:00:00')
    expect(formatRoguelikeElapsed(3_661_000)).toBe('1:01:01')
    expect(formatRoguelikeElapsed(36_000_000)).toBe('10:00:00')
  })

  it('returns null for missing or invalid durations', () => {
    expect(formatRoguelikeElapsed(null)).toBeNull()
    expect(formatRoguelikeElapsed(-1)).toBeNull()
    expect(formatRoguelikeElapsed(Number.NaN)).toBeNull()
    expect(formatRoguelikeElapsed(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('formatRoguelikeRelativeTime', () => {
  const now = Date.parse('2026-11-21T12:00:00.000Z')

  it('formats elapsed time in the largest whole unit', () => {
    expect(formatRoguelikeRelativeTime(now, now)).toBe('刚刚')
    expect(formatRoguelikeRelativeTime(now - 4_999, now)).toBe('刚刚')
    expect(formatRoguelikeRelativeTime(now - 5_000, now)).toBe('5 秒前')
    expect(formatRoguelikeRelativeTime(now - 59_000, now)).toBe('59 秒前')
    expect(formatRoguelikeRelativeTime(now - 60_000, now)).toBe('1 分钟前')
    expect(formatRoguelikeRelativeTime(now - 3_599_000, now)).toBe('59 分钟前')
    expect(formatRoguelikeRelativeTime(now - 3_600_000, now)).toBe('1 小时前')
    expect(formatRoguelikeRelativeTime(now - 86_400_000, now)).toBe('24 小时前')
  })

  it('returns null for future or invalid timestamps', () => {
    expect(formatRoguelikeRelativeTime(now + 1, now)).toBeNull()
    expect(formatRoguelikeRelativeTime(null, now)).toBeNull()
    expect(formatRoguelikeRelativeTime(Number.NaN, now)).toBeNull()
    expect(formatRoguelikeRelativeTime(now, Number.NaN)).toBeNull()
    expect(formatRoguelikeRelativeTime(now, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('calculateRoguelikeSuccessRate', () => {
  it('rounds the rate to a whole percentage', () => {
    expect(calculateRoguelikeSuccessRate(0, 10)).toBe(0)
    expect(calculateRoguelikeSuccessRate(3, 8)).toBe(38)
    expect(calculateRoguelikeSuccessRate(2, 3)).toBe(67)
    expect(calculateRoguelikeSuccessRate(10, 10)).toBe(100)
  })

  it('returns null when the denominator is not positive', () => {
    expect(calculateRoguelikeSuccessRate(0, 0)).toBeNull()
    expect(calculateRoguelikeSuccessRate(3, 0)).toBeNull()
    expect(calculateRoguelikeSuccessRate(3, -1)).toBeNull()
  })

  it('returns null for non-finite inputs', () => {
    expect(calculateRoguelikeSuccessRate(Number.NaN, 10)).toBeNull()
    expect(calculateRoguelikeSuccessRate(3, Number.NaN)).toBeNull()
    expect(calculateRoguelikeSuccessRate(3, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('describeRoguelikeRoundOutcome', () => {
  it('labels every round outcome', () => {
    expect(describeRoguelikeRoundOutcome('passed')).toBe('通关')
    expect(describeRoguelikeRoundOutcome('not_passed')).toBe('未通关')
    expect(describeRoguelikeRoundOutcome('unknown')).toBe('未确认')
  })
})
