// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import type { AgentRun, RunSnapshot } from '../types'
import { useExecutionObservation, useExecutionSnapshot } from '../hooks/useExecutionController'
import {
  ExecutionController,
  type ExecutionControllerApi,
  type ExecutionIdentity,
  type ExecutionIdentityStorage,
} from './executionController'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data })
const failed = (code: string, message: string): ApiResponse => ({
  success: false,
  error: message,
  message,
  errorInfo: { code, message },
})

function activeRun(runId: string, state: AgentRun['state'] = 'running'): AgentRun {
  return {
    runId,
    operationId: 'run_task',
    state,
    acceptedAt: '2026-10-25T00:00:00.000Z',
    links: {
      self: `/api/agent/runs/${runId}`,
      stop: `/api/agent/actions/stop?runId=${runId}`,
    },
  }
}

function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const activeRuns = overrides.activeRuns ?? []
  const run = overrides.run ?? activeRuns[0] ?? null
  return {
    isRunning: activeRuns.length > 0,
    run,
    activeRuns,
    lastRun: null,
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

function memoryStorage(initial: ExecutionIdentity | null = null) {
  let value = initial
  const storage: ExecutionIdentityStorage & { current: () => ExecutionIdentity | null } = {
    read: () => value,
    write: (identity) => {
      value = identity
    },
    current: () => value,
  }
  return storage
}

function createApi() {
  return {
    fetchSnapshot: vi.fn<ExecutionControllerApi['fetchSnapshot']>(),
    fetchRun: vi.fn<ExecutionControllerApi['fetchRun']>(),
    stopRun: vi.fn<ExecutionControllerApi['stopRun']>(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function SnapshotHarness({ controller }: { controller: ExecutionController }) {
  const state = useExecutionSnapshot(controller)
  const visibleRunId = state.trackedRunId ?? state.snapshot?.run?.runId ?? 'no-run'
  return <div data-phase={state.phase}>{visibleRunId}</div>
}

function ObservationHarness({ controller }: { controller: ExecutionController }) {
  useExecutionObservation(controller)
  return null
}

let api: ReturnType<typeof createApi>
let controller: ExecutionController
let releases: Array<() => void>
let mountedRoots: Root[]
let mountedContainers: HTMLDivElement[]

beforeEach(() => {
  vi.useFakeTimers()
  api = createApi()
  controller = new ExecutionController({
    api,
    storage: memoryStorage(),
    intervals: { active: 1_000, idle: 5_000, disconnected: 2_000 },
  })
  releases = []
  mountedRoots = []
  mountedContainers = []
})

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => root.unmount())
  }
  for (const container of mountedContainers) container.remove()
  for (const release of releases) release()
  vi.useRealTimers()
})

function start() {
  const release = controller.start()
  releases.push(release)
  return release
}

async function mountHarness() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<SnapshotHarness controller={controller} />))
  mountedRoots.push(root)
  mountedContainers.push(container)
  return container
}

describe('execution controller observation', () => {
  it('publishes the server snapshot as the single observation source', async () => {
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    start()
    await flush()

    const state = controller.getState()
    expect(state.phase).toBe('live')
    expect(state.snapshot?.activeRuns[0]?.runId).toBe('run-1')
    expect(state.hasActiveRun).toBe(true)
    expect(state.occupancy?.state).toBe('run')
  })

  it('does not let an older snapshot overwrite a newer run', async () => {
    const older = deferred<ApiResponse<RunSnapshot>>()
    const newer = deferred<ApiResponse<RunSnapshot>>()
    api.fetchSnapshot
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)

    start()
    await flush()
    const refresh = controller.refresh('poll')
    await flush()

    newer.resolve(ok(runSnapshot({ activeRuns: [activeRun('run-new')] })))
    await refresh

    older.resolve(ok(runSnapshot({ activeRuns: [activeRun('run-old')] })))
    await flush()

    expect(controller.getState().snapshot?.activeRuns[0]?.runId).toBe('run-new')
  })

  it('keeps the last active run while disconnected and resumes observation by runId', async () => {
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    start()
    await flush()

    const intent = controller.beginExecutionIntent('run_task')
    controller.settleExecutionIntent(intent, ok({ runId: 'run-1', run: activeRun('run-1') }))
    await flush()

    api.fetchSnapshot.mockRejectedValueOnce(new Error('网络中断'))
    await controller.refresh('poll')

    let state = controller.getState()
    expect(state.phase).toBe('disconnected')
    expect(state.lastError).toBe('网络中断')
    expect(state.hasActiveRun).toBe(true)
    expect(state.trackedRun?.state).toBe('running')

    api.fetchRun.mockResolvedValue(ok(activeRun('run-1', 'running')))
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    window.dispatchEvent(new Event('online'))
    await flush()

    state = controller.getState()
    expect(state.phase).toBe('live')
    expect(state.trackedRun?.state).toBe('running')
    expect(api.fetchRun).toHaveBeenCalledWith('run-1', expect.any(AbortSignal))
  })

  it('keeps observing after the subscribing page unmounts', async () => {
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    start()
    await flush()
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(1)

    const container = await mountHarness()
    expect(container.textContent).toBe('run-1')

    await act(async () => mountedRoots[0]!.unmount())
    mountedRoots = []
    container.remove()
    mountedContainers = []

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('stops polling only after every application-level observer releases', async () => {
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot()))
    const releaseFirst = controller.start()
    const releaseSecond = controller.start()
    await flush()
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(1)

    releaseFirst()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(2)

    releaseSecond()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not start observation from a snapshot subscriber', async () => {
    await mountHarness()

    expect(api.fetchSnapshot).not.toHaveBeenCalled()
    expect(controller.getState().phase).toBe('idle')
  })

  it('starts on mount and stops local observation on unmount', async () => {
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot()))

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<ObservationHarness controller={controller} />))
    await flush()
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(controller.getState().phase).toBe('live')

    await act(async () => root.unmount())
    container.remove()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(controller.getState().phase).toBe('suspended')
  })
})

describe('execution controller identity', () => {
  it('keeps the newest run when an older submission response arrives late', () => {
    const first = controller.beginExecutionIntent('run_task')
    const second = controller.beginExecutionIntent('run_task')

    controller.settleExecutionIntent(second, ok({ runId: 'run-new', run: activeRun('run-new') }))
    controller.settleExecutionIntent(first, ok({ runId: 'run-old', run: activeRun('run-old') }))

    expect(controller.getState().trackedRunId).toBe('run-new')
    expect(controller.getState().trackedRun?.runId).toBe('run-new')
  })

  it('reuses a supplied key and generates a server-valid key per intent', () => {
    expect(controller.beginExecutionIntent('run_task', { idempotencyKey: 'daily-flow-1' }).idempotencyKey)
      .toBe('daily-flow-1')
    expect(controller.beginExecutionIntent('run_task').idempotencyKey)
      .toMatch(/^run_task-[a-z0-9]+-[a-z0-9]+$/)
    expect(() => controller.beginExecutionIntent('run_task', { idempotencyKey: 'bad key' })).toThrow()
  })

  it('forwards the generated idempotency key and adopts the submitted run', async () => {
    const request = vi.fn(async () => ok({ runId: 'run-9', run: activeRun('run-9') }))

    const result = await controller.submitExecution('run_task', request)

    expect(result.data?.runId).toBe('run-9')
    expect(request).toHaveBeenCalledWith({
      idempotencyKey: expect.stringMatching(/^run_task-/),
      signal: undefined,
    })
    expect(controller.getState().trackedRunId).toBe('run-9')
  })

  it('does not fabricate identity from a legacy response without runId', () => {
    const intent = controller.beginExecutionIntent('run_task')

    expect(controller.settleExecutionIntent(intent, ok({ success: true }))).toBe(false)
    expect(controller.getState().trackedRunId).toBeNull()
    expect(controller.getState().identity).toBe('none')
    expect(controller.getState().submission).toBe('accepted')
  })

  it('reports a server rejection separately from an unknown submission', () => {
    const intent = controller.beginExecutionIntent('run_task')

    controller.settleExecutionIntent(intent, failed('AGENT_EXECUTION_BUSY', '设备正被占用'))

    expect(controller.getState().submission).toBe('rejected')
    expect(controller.getState().lastError).toBe('设备正被占用')
  })

  it('treats a locally aborted submission as unknown, not failed', () => {
    const intent = controller.beginExecutionIntent('run_task')
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })

    controller.settleExecutionIntent(intent, null, abortError)

    expect(controller.getState().submission).toBe('unknown')
    expect(controller.getState().lastError).toBeNull()
    expect(controller.getState().identity).toBe('none')
  })

  it('treats a transport failure while submitting as unknown', () => {
    const intent = controller.beginExecutionIntent('run_task')

    controller.settleExecutionIntent(intent, null, new Error('无法连接后端服务'))

    expect(controller.getState().submission).toBe('unknown')
    expect(controller.getState().lastError).toBe('无法连接后端服务')
    expect(controller.getState().trackedRunId).toBeNull()
  })

  it('marks identity unknown when the run id is no longer retained', async () => {
    const storage = memoryStorage({ runId: 'run-gone', operationId: 'run_task' })
    controller = new ExecutionController({
      api,
      storage,
      intervals: { active: 1_000, idle: 5_000, disconnected: 2_000 },
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot()))
    api.fetchRun.mockResolvedValue(failed('AGENT_RUN_NOT_FOUND', '未找到 Agent run: run-gone'))

    start()
    await flush()

    const state = controller.getState()
    expect(state.phase).toBe('live')
    expect(state.identity).toBe('unknown')
    expect(state.trackedRunId).toBe('run-gone')
    expect(state.hasActiveRun).toBe(false)
    expect(storage.current()).toBeNull()
  })
})

describe('execution controller stop semantics', () => {
  it('distinguishes stopping the server run from aborting local observation', async () => {
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    const intent = controller.beginExecutionIntent('run_task')
    controller.settleExecutionIntent(intent, ok({ runId: 'run-1', run: activeRun('run-1') }))
    start()
    await flush()

    controller.abortObservation()
    expect(controller.getState().phase).toBe('suspended')
    expect(controller.getState().hasActiveRun).toBe(true)
    expect(api.stopRun).not.toHaveBeenCalled()

    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: activeRun('run-1', 'stopping') })))
    api.fetchRun.mockResolvedValue(ok(activeRun('run-1', 'stopping')))
    api.stopRun.mockResolvedValue(ok({
      stopRequested: true,
      deviceStopRequested: true,
      run: activeRun('run-1', 'stopping'),
    }))

    const result = await controller.stopTrackedRun()

    expect(api.stopRun).toHaveBeenCalledWith('run-1')
    expect(result?.success).toBe(true)
    expect(controller.getState().trackedRun?.state).toBe('stopping')
  })

  it('never degrades a missing identity into stopping the current task', async () => {
    const result = await controller.stopTrackedRun()

    expect(result).toBeNull()
    expect(api.stopRun).not.toHaveBeenCalled()
  })
})
