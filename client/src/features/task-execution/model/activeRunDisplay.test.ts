// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import {
  ExecutionController,
  type ExecutionControllerApi,
  type ExecutionControllerState,
} from '../controller/executionController'
import type { AgentRun, RunSnapshot } from '../types'
import {
  formatExecutionElapsed,
  readActiveExecutionView,
  stopActiveExecutionRun,
  type ActiveExecutionView,
} from './activeRunDisplay'

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  parseJsonResponse: vi.fn(),
}))

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  fetchWithAuth: mocks.fetchWithAuth,
  parseJsonResponse: mocks.parseJsonResponse,
}))

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data })
const failed = (code: string, message: string): ApiResponse => ({
  success: false,
  error: message,
  message,
  errorInfo: { code, message },
})

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_task',
    state: 'running',
    acceptedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:01:00.000Z',
    links: {
      self: '/api/agent/runs/run-1',
      stop: '/api/agent/actions/stop?runId=run-1',
    },
    ...overrides,
  }
}

function snapshotWith(activeRun: AgentRun | null): RunSnapshot {
  return {
    isRunning: Boolean(activeRun),
    run: activeRun,
    activeRuns: activeRun ? [activeRun] : [],
    lastRun: null,
    occupancy: {
      state: activeRun ? 'run' : 'idle',
      runId: activeRun?.runId ?? null,
      runState: activeRun?.state ?? null,
      sources: activeRun ? ['run'] : [],
      lease: { state: 'free', owner: null },
      task: { isRunning: false, taskName: null, taskType: null, stopRequested: false },
      schedule: {},
    },
  }
}

function controllerState(overrides: Partial<ExecutionControllerState> = {}): ExecutionControllerState {
  return Object.freeze({
    phase: 'live' as const,
    identity: 'none' as const,
    submission: 'idle' as const,
    snapshot: null,
    trackedRunId: null,
    trackedScope: null,
    trackedRun: null,
    lastError: null,
    lastSyncedAt: null,
    hasActiveRun: false,
    occupancy: null,
    ...overrides,
  })
}

function expectView(state: ExecutionControllerState): ActiveExecutionView {
  const view = readActiveExecutionView(state)
  expect(view).not.toBeNull()
  return view!
}

describe('readActiveExecutionView', () => {
  it('returns null when neither the snapshot nor the tracked identity has an active run', () => {
    expect(readActiveExecutionView(controllerState())).toBeNull()
    expect(readActiveExecutionView(controllerState({
      snapshot: snapshotWith(null),
    }))).toBeNull()
    expect(readActiveExecutionView(controllerState({
      snapshot: snapshotWith(null),
      trackedRun: run({ state: 'succeeded' }),
      trackedRunId: 'run-1',
      identity: 'tracked',
    }))).toBeNull()
  })

  it('describes a daily flow by its step progress and the running task', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({
        operationId: 'run_daily_flow',
        progress: {
          currentStep: 2,
          totalSteps: 5,
          currentTask: '领取每日奖励',
          message: '今日流程执行中',
        },
      })),
    }))

    expect(view.runId).toBe('run-1')
    expect(view.title).toBe('日常流程 第 2/5 步')
    expect(view.currentEntry).toBe('领取每日奖励')
    expect(view.message).toBe('今日流程执行中')
    expect(view.state).toBe('running')
    expect(view.isStopping).toBe(false)
    expect(view.phaseLabel).toBeNull()
  })

  it('describes a daily flow without published steps by the flow label only', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({
        operationId: 'run_daily_flow',
        state: 'accepted',
        progress: { currentStep: null, totalSteps: null, currentTask: null, message: '等待执行权' },
      })),
    }))

    expect(view.title).toBe('日常流程')
    expect(view.currentEntry).toBeNull()
    expect(view.phaseLabel).toBe('等待开始')
  })

  it('prefers the copilot set name for the title and keeps the current entry line', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({
        operationId: 'run_copilot_set',
        progress: {
          name: '周一刷图集',
          currentStep: 3,
          totalSteps: 4,
          currentTask: '第 3 项 1-7',
          currentEntry: { displayStage: '1-7', stageId: 'main_01-7' },
          message: '正在执行作业',
        },
      })),
    }))

    expect(view.title).toBe('周一刷图集 第 3/4 项')
    expect(view.currentEntry).toBe('第 3 项 1-7')
  })

  it('falls back to the copilot entry stage when the current task is missing', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({
        operationId: 'run_copilot_set',
        state: 'waiting',
        progress: {
          name: '周一刷图集',
          currentStep: 3,
          totalSteps: 4,
          currentTask: null,
          currentEntry: null,
          nextEntry: { displayStage: '1-8' },
          message: '等待开始下一关',
        },
      })),
    }))

    expect(view.title).toBe('周一刷图集 第 3/4 项')
    expect(view.currentEntry).toBeNull()
    expect(view.phaseLabel).toBe('等待继续')
  })

  it('uses the task name as the title for generic runs without duplicating the entry line', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({
        operationId: 'run_task',
        progress: { currentTask: '1-7 每日一次', message: '任务执行中' },
      })),
    }))

    expect(view.title).toBe('1-7 每日一次')
    expect(view.currentEntry).toBeNull()
  })

  it('degrades to the generic executing label when the progress fields are missing', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({ progress: undefined })),
    }))

    expect(view.title).toBe('执行中')
    expect(view.currentEntry).toBeNull()
    expect(view.message).toBeNull()
  })

  it('falls back to the copilot entry stage when only currentTask is absent', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({
        operationId: 'run_copilot_set',
        progress: {
          name: '周一刷图集',
          currentStep: null,
          totalSteps: null,
          currentTask: null,
          currentEntry: { displayStage: '1-7' },
        },
      })),
    }))

    expect(view.title).toBe('周一刷图集')
    expect(view.currentEntry).toBe('1-7')
  })

  it('marks stopping runs and keeps no phase label for them', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run({ state: 'stopping' })),
    }))

    expect(view.isStopping).toBe(true)
    expect(view.phaseLabel).toBeNull()
  })

  it('flags the display as unknown while observation is disconnected but keeps the last known run', () => {
    const view = expectView(controllerState({
      phase: 'disconnected',
      snapshot: snapshotWith(run()),
    }))

    expect(view.runId).toBe('run-1')
    expect(view.phaseLabel).toBe('执行状态未知')
  })

  it('falls back to the tracked run when the snapshot has no active run yet', () => {
    const trackedRun = run({ progress: { currentTask: '基建换班' } })
    const view = expectView(controllerState({
      snapshot: snapshotWith(null),
      trackedRun,
      trackedRunId: 'run-1',
      identity: 'tracked',
      hasActiveRun: true,
    }))

    expect(view.title).toBe('基建换班')
  })

  it('picks the active run from the list when the current run is not active', () => {
    const view = expectView(controllerState({
      snapshot: {
        ...snapshotWith(null),
        run: run({ runId: 'run-old', state: 'stopped' }),
        activeRuns: [run({ runId: 'run-2', progress: { currentTask: '剿灭作战' } })],
      },
    }))

    expect(view.runId).toBe('run-2')
    expect(view.title).toBe('剿灭作战')
  })

  it('reads the start time from startedAt and falls back to acceptedAt', () => {
    const view = expectView(controllerState({
      snapshot: snapshotWith(run()),
    }))
    expect(view.startedAt).toBe(Date.parse('2026-01-01T00:01:00.000Z'))

    const acceptedView = expectView(controllerState({
      snapshot: snapshotWith(run({ startedAt: null })),
    }))
    expect(acceptedView.startedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))

    const unknownView = expectView(controllerState({
      snapshot: snapshotWith(run({ startedAt: 'not-a-date', acceptedAt: undefined })),
    }))
    expect(unknownView.startedAt).toBeNull()
  })
})

describe('formatExecutionElapsed', () => {
  it('formats minutes and seconds below one hour', () => {
    expect(formatExecutionElapsed(0)).toBe('0:00')
    expect(formatExecutionElapsed(5_000)).toBe('0:05')
    expect(formatExecutionElapsed(65_000)).toBe('1:05')
    expect(formatExecutionElapsed(3_599_000)).toBe('59:59')
  })

  it('formats hours once the execution runs longer', () => {
    expect(formatExecutionElapsed(3_600_000)).toBe('1:00:00')
    expect(formatExecutionElapsed(3_661_000)).toBe('1:01:01')
  })

  it('never reports a negative elapsed time', () => {
    expect(formatExecutionElapsed(-1_000)).toBe('0:00')
  })
})

describe('stopActiveExecutionRun', () => {
  function createApi() {
    return {
      fetchSnapshot: vi.fn<ExecutionControllerApi['fetchSnapshot']>(),
      fetchRun: vi.fn<ExecutionControllerApi['fetchRun']>(),
      stopRun: vi.fn<ExecutionControllerApi['stopRun']>(),
    }
  }

  beforeEach(() => {
    mocks.fetchWithAuth.mockReset().mockResolvedValue({ ok: true })
    mocks.parseJsonResponse.mockReset().mockResolvedValue({ success: true })
  })

  it('stops a tracked run through the controller without touching the raw endpoint', async () => {
    const api = createApi()
    api.stopRun.mockResolvedValue(ok({ stopRequested: true, deviceStopRequested: true, run: run() }))
    const controller = new ExecutionController({ api })
    controller.observeRun('run-1', 'run_task', 'combat')

    await stopActiveExecutionRun(controller, 'run-1')

    expect(api.stopRun).toHaveBeenCalledTimes(1)
    expect(api.stopRun).toHaveBeenCalledWith('run-1')
    expect(api.fetchSnapshot).not.toHaveBeenCalled()
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled()
  })

  it('stops an observed run by id through the existing endpoint and refreshes the snapshot', async () => {
    const api = createApi()
    api.stopRun.mockResolvedValue(ok({ stopRequested: true, deviceStopRequested: true, run: run() }))
    api.fetchSnapshot.mockResolvedValue(ok(snapshotWith(run({ runId: 'run-9' }))))
    const controller = new ExecutionController({ api })

    await stopActiveExecutionRun(controller, 'run-9')

    // 未持有身份的 run 直接走既有目标停止端点，不经过控制器的目标停止。
    expect(api.stopRun).not.toHaveBeenCalled()
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1)
    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(String(url)).toContain('/agent/actions/stop')
    expect(new URL(String(url)).searchParams.get('runId')).toBe('run-9')
    expect(init?.method).toBe('POST')
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('surfaces stop failures to the caller instead of reporting success', async () => {
    const api = createApi()
    api.stopRun.mockResolvedValue(failed('AGENT_RUN_NOT_CURRENT', '该 run 已不是当前执行'))
    const controller = new ExecutionController({ api })
    controller.observeRun('run-1', 'run_task', 'combat')

    await expect(stopActiveExecutionRun(controller, 'run-1'))
      .rejects.toThrow('该 run 已不是当前执行')
    expect(api.fetchSnapshot).not.toHaveBeenCalled()
  })

  it('does not refresh the snapshot when the direct stop fails', async () => {
    const api = createApi()
    api.fetchSnapshot.mockResolvedValue(ok(snapshotWith(null)))
    const controller = new ExecutionController({ api })
    mocks.parseJsonResponse.mockResolvedValue(failed('MAA_STOP_FAILED', '设备停止失败'))

    await expect(stopActiveExecutionRun(controller, 'run-9'))
      .rejects.toThrow('设备停止失败')
    expect(api.fetchSnapshot).not.toHaveBeenCalled()
  })
})
