// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ExecutionController,
  type AgentRun,
  type ExecutionControllerApi,
  type RunSnapshot,
} from '@/features/task-execution'
import { useRunStatusProjection } from './useRunStatusProjection'
import { useStatusStore } from '../store/statusStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ok = <T,>(data: T) => ({ success: true as const, data })

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-1',
    operationId: 'run_daily_flow',
    state: 'running',
    links: { self: '/api/agent/runs/run-1' },
    ...overrides,
  }
}

function buildSnapshot({
  run = null,
  activeRuns = [],
  lastRun = null,
  occupancy = 'idle',
}: {
  run?: AgentRun | null
  activeRuns?: AgentRun[]
  lastRun?: AgentRun | null
  occupancy?: 'idle' | 'run' | 'external' | 'pending' | 'unknown'
} = {}): RunSnapshot {
  return {
    isRunning: Boolean(run),
    run,
    activeRuns,
    lastRun,
    occupancy: {
      state: occupancy,
      runId: run?.runId ?? null,
      runState: run?.state ?? null,
      sources: occupancy === 'idle' ? [] : ['lease'],
      lease: { state: occupancy === 'idle' ? 'free' : 'held', owner: null },
      task: { isRunning: false, taskName: null, taskType: null, stopRequested: false },
      schedule: {
        isRunning: false,
        runId: null,
        currentStep: null,
        totalSteps: 0,
        currentTask: null,
        shouldStop: false,
      },
    },
  }
}

function ProjectionHarness({ controller }: { controller: ExecutionController }) {
  useRunStatusProjection(controller)
  return null
}

let api: {
  fetchSnapshot: ReturnType<typeof vi.fn<ExecutionControllerApi['fetchSnapshot']>>
  fetchRun: ReturnType<typeof vi.fn<ExecutionControllerApi['fetchRun']>>
  stopRun: ReturnType<typeof vi.fn<ExecutionControllerApi['stopRun']>>
}
let controller: ExecutionController
let release: (() => void) | null
let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function applySnapshot(snapshot: RunSnapshot) {
  api.fetchSnapshot.mockResolvedValueOnce(ok(snapshot))
  await act(async () => controller.refresh())
  await flush()
}

describe('run status projection', () => {
  beforeEach(async () => {
    api = {
      fetchSnapshot: vi.fn<ExecutionControllerApi['fetchSnapshot']>(async () => ok(buildSnapshot())),
      fetchRun: vi.fn<ExecutionControllerApi['fetchRun']>(async (runId: string) => ok(buildRun({ runId }))),
      stopRun: vi.fn<ExecutionControllerApi['stopRun']>(),
    }
    controller = new ExecutionController({
      api,
      storage: null,
      intervals: { active: 60_000, idle: 60_000, disconnected: 60_000 },
    })
    useStatusStore.getState().applyRunStatus({ phase: 'idle', isRunning: false, runId: null, label: null, detail: null })
    release = controller.start()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<ProjectionHarness controller={controller} />))
    await flush()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    release?.()
    release = null
    useStatusStore.getState().applyRunStatus({ phase: 'idle', isRunning: false, runId: null, label: null, detail: null })
  })

  it('projects an idle snapshot as idle', () => {
    expect(useStatusStore.getState().runStatus).toEqual({
      phase: 'idle',
      isRunning: false,
      runId: null,
      label: null,
      detail: null,
    })
  })

  it('projects the running task name into the global label', async () => {
    const run = buildRun({ progress: { currentTask: '收取信用', message: '今日流程执行中' } })
    await applySnapshot(buildSnapshot({ run, activeRuns: [run], occupancy: 'run' }))

    expect(useStatusStore.getState().runStatus).toEqual({
      phase: 'running',
      isRunning: true,
      runId: 'run-1',
      label: '正在执行: 收取信用',
      detail: '今日流程执行中',
    })
  })

  it('keeps a waiting run distinct from running and completion', async () => {
    const run = buildRun({ state: 'waiting', progress: { phase: 'waiting_for_next' } })
    await applySnapshot(buildSnapshot({ run, activeRuns: [run], occupancy: 'pending' }))

    expect(useStatusStore.getState().runStatus.phase).toBe('waiting')
    expect(useStatusStore.getState().runStatus.label).toBe('等待继续')
    expect(useStatusStore.getState().runStatus.isRunning).toBe(true)
  })

  it('labels a stopping run', async () => {
    const run = buildRun({ state: 'stopping' })
    await applySnapshot(buildSnapshot({ run, activeRuns: [run], occupancy: 'run' }))

    expect(useStatusStore.getState().runStatus.label).toBe('正在停止')
  })

  it('marks unmanaged device occupancy without inventing a run', async () => {
    await applySnapshot(buildSnapshot({ occupancy: 'external' }))

    expect(useStatusStore.getState().runStatus).toEqual({
      phase: 'occupied',
      isRunning: false,
      runId: null,
      label: '设备被其他任务占用',
      detail: null,
    })
  })

  it('marks an unreadable lease as unknown rather than idle', async () => {
    await applySnapshot(buildSnapshot({ occupancy: 'unknown' }))

    expect(useStatusStore.getState().runStatus.phase).toBe('unknown')
    expect(useStatusStore.getState().runStatus.label).toBe('执行状态未知')
  })

  it('keeps the last active run and reports unknown when observation disconnects', async () => {
    const run = buildRun()
    await applySnapshot(buildSnapshot({ run, activeRuns: [run], occupancy: 'run' }))
    expect(useStatusStore.getState().runStatus.phase).toBe('running')

    api.fetchSnapshot.mockRejectedValueOnce(new Error('网络中断'))
    await act(async () => controller.refresh())
    await flush()

    const status = useStatusStore.getState().runStatus
    expect(status.phase).toBe('unknown')
    expect(status.isRunning).toBe(true)
    expect(status.runId).toBe('run-1')
    expect(status.label).toBe('执行状态未知')
  })

  it('returns to idle only after the terminal snapshot arrives', async () => {
    const run = buildRun()
    await applySnapshot(buildSnapshot({ run, activeRuns: [run], occupancy: 'run' }))
    expect(useStatusStore.getState().runStatus.phase).toBe('running')

    await applySnapshot(buildSnapshot({
      lastRun: buildRun({ state: 'succeeded' }),
    }))

    expect(useStatusStore.getState().runStatus).toEqual({
      phase: 'idle',
      isRunning: false,
      runId: null,
      label: null,
      detail: null,
    })
  })
})
