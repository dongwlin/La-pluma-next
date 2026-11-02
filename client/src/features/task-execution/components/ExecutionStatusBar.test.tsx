// @vitest-environment jsdom

import { act, forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import {
  ExecutionController,
  type ExecutionControllerApi,
  type ExecutionIdentityStorage,
} from '../controller/executionController'
import type { AgentRun, RunSnapshot } from '../types'
import ExecutionStatusBar from './ExecutionStatusBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  parseJsonResponse: vi.fn(),
}))

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api')>()),
  fetchWithAuth: mocks.fetchWithAuth,
  parseJsonResponse: mocks.parseJsonResponse,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function MockMotionDiv(props, ref) {
      return <div ref={ref} {...props} />
    }),
    section: forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function MockMotionSection(props, ref) {
      return <section ref={ref} {...props} />
    }),
  },
  useReducedMotion: () => true,
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

function noopStorage(): ExecutionIdentityStorage {
  return { read: () => null, write: () => undefined }
}

function createApi() {
  return {
    fetchSnapshot: vi.fn<ExecutionControllerApi['fetchSnapshot']>(),
    fetchRun: vi.fn<ExecutionControllerApi['fetchRun']>(),
    stopRun: vi.fn<ExecutionControllerApi['stopRun']>(),
  }
}

let api: ReturnType<typeof createApi>
let controller: ExecutionController
let container: HTMLDivElement
let root: Root

async function renderBar() {
  await act(async () => root.render(<ExecutionStatusBar controller={controller} />))
}

async function loadSnapshot(snapshot: RunSnapshot) {
  api.fetchSnapshot.mockResolvedValue(ok(snapshot))
  await act(async () => {
    await controller.refresh('manual')
  })
}

function bar() {
  return container.querySelector<HTMLElement>('section[aria-label="执行状态"]')
}

function stopButton() {
  return bar()?.querySelector<HTMLButtonElement>('button[aria-busy], button:not([disabled])')
}

function dialog() {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]')
}

function buttonInDialog(text: string) {
  return [...dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? []]
    .find(button => button.textContent?.includes(text))
}

describe('ExecutionStatusBar', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:02:05.000Z'))
    mocks.fetchWithAuth.mockReset().mockResolvedValue({ ok: true })
    mocks.parseJsonResponse.mockReset().mockResolvedValue({ success: true })
    api = createApi()
    controller = new ExecutionController({ api, storage: noopStorage() })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders nothing while no active run is observed', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(null))

    expect(bar()).toBeNull()
  })

  it('shows the running task, the current entry, and the elapsed time for an active run', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run({
      operationId: 'run_daily_flow',
      progress: {
        currentStep: 2,
        totalSteps: 5,
        currentTask: '领取每日奖励',
        message: '今日流程执行中',
      },
    })))

    const status = bar()
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain('日常流程 第 2/5 步')
    expect(status?.textContent).toContain('领取每日奖励')
    // startedAt 2026-01-01T00:01:00Z，当前时刻 00:02:05Z → 1:05。
    expect(status?.textContent).toContain('已用时 1:05')
    expect(status?.querySelector('button[aria-label], button')).not.toBeNull()
  })

  it('hides the stop entry only while a stop has already been acknowledged', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run({ state: 'stopping' })))

    const stopping = bar()?.querySelector<HTMLButtonElement>('button')
    expect(stopping?.disabled).toBe(true)
    expect(stopping?.textContent).toContain('正在终止')
  })

  it('degrades to the generic executing label when progress fields are missing', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run({ progress: undefined })))

    const status = bar()
    expect(status?.textContent).toContain('执行中')
    expect(status?.textContent).not.toContain('领取每日奖励')
  })

  it('removes the bar as soon as the observed run reaches a terminal state', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run()))
    expect(bar()).not.toBeNull()

    await loadSnapshot(snapshotWith(null))
    expect(bar()).toBeNull()
  })

  it('stops an observed run through the existing targeted stop endpoint after confirmation', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run()))
    mocks.parseJsonResponse.mockResolvedValue(
      ok({ stopRequested: true, deviceStopRequested: true, run: run() }),
    )

    await act(async () => stopButton()?.click())
    expect(dialog()?.textContent).toContain('终止当前执行？')
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled()

    await act(async () => {
      buttonInDialog('确认终止')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1)
    const [url, init] = mocks.fetchWithAuth.mock.calls[0]!
    expect(String(url)).toContain('/agent/actions/stop')
    expect(new URL(String(url)).searchParams.get('runId')).toBe('run-1')
    expect(init?.method).toBe('POST')
    expect(dialog()).toBeNull()
  })

  it('stops the tracked identity through the controller instead of the raw endpoint', async () => {
    api.stopRun.mockResolvedValue(ok({ stopRequested: true, deviceStopRequested: true, run: run() }))
    await renderBar()
    await act(async () => {
      controller.observeRun('run-1', 'run_task', 'combat')
    })
    await loadSnapshot(snapshotWith(run()))

    await act(async () => stopButton()?.click())
    await act(async () => {
      buttonInDialog('确认终止')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.stopRun).toHaveBeenCalledWith('run-1')
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled()
  })

  it('keeps the confirmation open with the failure message when the stop is rejected', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run()))
    mocks.parseJsonResponse.mockResolvedValue(failed('AGENT_RUN_NOT_CURRENT', '该 run 已不是当前执行'))

    await act(async () => stopButton()?.click())
    await act(async () => {
      buttonInDialog('确认终止')?.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dialog()).not.toBeNull()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('该 run 已不是当前执行')
    expect(api.fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('closes the confirmation without stopping when the user cancels', async () => {
    await renderBar()
    await loadSnapshot(snapshotWith(run()))

    await act(async () => stopButton()?.click())
    expect(dialog()).not.toBeNull()

    await act(async () => {
      buttonInDialog('取消')?.click()
      await Promise.resolve()
    })

    expect(dialog()).toBeNull()
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled()
    expect(api.stopRun).not.toHaveBeenCalled()
  })
})
