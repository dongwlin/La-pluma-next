// @vitest-environment jsdom

import { Activity, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import {
  ExecutionController,
  type AgentRun,
  type RunProgress,
  type RunSnapshot,
  type RunTaskResult,
  type StopRunResult,
} from '@/features/task-execution'
import { userConfigCoordinator } from '@/features/user-config'
import CombatTasks from './CombatTasks'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  controller: { current: null as unknown as ExecutionController },
  executePredefinedTaskArgs: vi.fn(),
  executeCopilotSetPlan: vi.fn(),
  continueCopilotSet: vi.fn(),
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
  getCopilotInfo: vi.fn(),
  getCopilotSet: vi.fn(),
  getCopilotSetPlan: vi.fn(),
  resetCopilotSetProgress: vi.fn(),
  searchCopilot: vi.fn(),
  searchParadoxCopilot: vi.fn(),
  setMessage: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const motionComponent = (tag: 'button' | 'div' | 'span') => React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, whileHover: _whileHover, whileTap: _whileTap, ...props }, ref) =>
      React.createElement(tag, { ...props, ref }, children as ReactNode),
  )
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: {
      button: motionComponent('button'),
      div: motionComponent('div'),
      span: motionComponent('span'),
    },
    useReducedMotion: () => true,
  }
})

vi.mock('@/shared/api', () => ({
  API_BASE_URL: '/api',
  fetchWithAuth: vi.fn(),
  parseJsonResponse: vi.fn(),
  getErrorMessage: (result: { message?: string; error?: string }) => result.message || result.error || '未知错误',
}))

vi.mock('@/features/task-execution', async () => {
  const actual = await vi.importActual<typeof import('@/features/task-execution')>('@/features/task-execution')
  return {
    ...actual,
    get executionController() {
      return mocks.controller.current
    },
    executePredefinedTaskArgs: mocks.executePredefinedTaskArgs,
    useExecutionSnapshot: () => actual.useExecutionSnapshot(mocks.controller.current),
  }
})

vi.mock('@/features/user-config', async () => {
  const actual = await vi.importActual<typeof import('@/features/user-config')>('@/features/user-config')
  return {
    ...actual,
    loadUserConfig: mocks.loadUserConfig,
    saveUserConfig: mocks.saveUserConfig,
  }
})

vi.mock('../api', () => ({
  executeCopilotSetPlan: mocks.executeCopilotSetPlan,
  continueCopilotSet: mocks.continueCopilotSet,
  getCopilotInfo: mocks.getCopilotInfo,
  getCopilotSet: mocks.getCopilotSet,
  getCopilotSetPlan: mocks.getCopilotSetPlan,
  resetCopilotSetProgress: mocks.resetCopilotSetProgress,
  searchCopilot: mocks.searchCopilot,
  searchParadoxCopilot: mocks.searchParadoxCopilot,
}))

vi.mock('@/features/runtime-status', () => ({
  useStatusStore: () => ({ setMessage: mocks.setMessage }),
  FloatingStatusIndicator: () => null,
  useAutomationAvailability: () => ({ isAvailable: true, unavailableMessage: '' }),
}))

vi.mock('@/features/device-mirror', () => ({ ScreenMonitor: () => <div data-testid="screen-monitor" /> }))

const CONTROLLER_INTERVALS = { active: 1_000, idle: 5_000, disconnected: 2_000 }

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data })
const failed = (code: string, message: string): ApiResponse => ({
  success: false,
  error: message,
  message,
  errorInfo: { code, message },
})

function activeRun(
  runId: string,
  state: AgentRun['state'] = 'running',
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return {
    runId,
    operationId: 'run_task',
    state,
    acceptedAt: '2026-10-25T00:00:00.000Z',
    links: {
      self: `/api/agent/runs/${runId}`,
      stop: `/api/agent/actions/stop?runId=${runId}`,
    },
    ...overrides,
  }
}

function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const activeRuns = overrides.activeRuns ?? []
  const run = overrides.run ?? activeRuns[0] ?? null
  return {
    isRunning: activeRuns.length > 0,
    run,
    activeRuns,
    lastRun: overrides.lastRun ?? null,
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

type ItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'stopped'

/** 服务端作业集逐项结果的一条；同一作业在突袭/普通模式下会有多条。 */
function planEntry(
  itemIndex: number,
  status: ItemStatus,
  overrides: Partial<RunTaskResult> = {},
): RunTaskResult {
  return {
    key: `${itemIndex}:${101 + itemIndex}:normal`,
    itemIndex,
    copilotId: 101 + itemIndex,
    stageId: `test_${itemIndex + 1}`,
    displayStage: `TEST-${itemIndex + 1}`,
    stage: `TEST-${itemIndex + 1}`,
    mode: 'normal',
    presetFormation: false,
    status,
    ...overrides,
  }
}

function setProgress(
  taskResults: RunTaskResult[],
  overrides: Partial<RunProgress> = {},
): RunProgress {
  const count = (status: ItemStatus) => taskResults.filter(entry => entry.status === status).length
  return {
    setId: '48990',
    name: '作业集 48990',
    mode: 'continuous',
    phase: 'running',
    currentStep: taskResults.length - count('pending'),
    totalSteps: taskResults.length,
    currentTask: null,
    currentEntry: taskResults.find(entry => entry.status === 'running') ?? null,
    nextEntry: null,
    shouldStop: false,
    successCount: count('success'),
    failedCount: count('failed'),
    stoppedCount: count('stopped'),
    pendingCount: count('pending'),
    message: '作业集执行中',
    taskResults,
    ...overrides,
  }
}

function setResult(
  taskResults: RunTaskResult[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const count = (status: ItemStatus) => taskResults.filter(entry => entry.status === status).length
  return {
    success: true,
    stopped: false,
    finished: true,
    mode: 'continuous',
    setId: '48990',
    name: '作业集 48990',
    raid: 'normal',
    message: '作业集执行完成',
    plan: { items: [], entries: [] },
    completed: [],
    pending: [],
    results: [],
    summary: {
      setId: '48990',
      name: '作业集 48990',
      mode: 'continuous',
      raid: 'normal',
      totalEntries: taskResults.length,
      attemptedCount: taskResults.length - count('pending'),
      alreadyCompletedCount: 0,
      successCount: count('success'),
      failedCount: count('failed'),
      stoppedCount: count('stopped'),
      pendingCount: count('pending'),
      durationMs: 5_000,
      errors: taskResults
        .filter(entry => entry.status === 'failed')
        .map(entry => ({ key: entry.key, stage: entry.displayStage, error: entry.error })),
      taskResults,
    },
    ...overrides,
  }
}

function setRun(
  runId: string,
  state: AgentRun['state'],
  options: { progress?: RunProgress; result?: Record<string, unknown>; error?: AgentRun['error'] } = {},
): AgentRun {
  return activeRun(runId, state, {
    operationId: 'run_copilot_set',
    ...(options.progress ? { progress: options.progress } : {}),
    ...(options.result ? { result: options.result } : {}),
    ...(options.error ? { error: options.error } : {}),
  })
}

interface TestExecutionIdentity {
  runId: string
  operationId: string | null
  scope?: string | null
}

function createApi() {
  return {
    fetchSnapshot: vi.fn<(signal?: AbortSignal) => Promise<ApiResponse<RunSnapshot>>>(),
    fetchRun: vi.fn<(runId: string, signal?: AbortSignal) => Promise<ApiResponse<AgentRun>>>(),
    stopRun: vi.fn<(runId: string) => Promise<ApiResponse<StopRunResult>>>(),
  }
}

function memoryStorage(initial: TestExecutionIdentity | null = null) {
  let value = initial
  return {
    read: () => value,
    write: (identity: TestExecutionIdentity | null) => {
      value = identity
    },
  }
}

let api: ReturnType<typeof createApi>
let controller: ExecutionController
let releases: Array<() => void>
let container: HTMLDivElement
let root: Root

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

const buttonsByText = (text: string) => Array.from(document.querySelectorAll('button'))
  .filter(button => button.textContent?.trim() === text) as HTMLButtonElement[]

const buttonByText = (text: string) => buttonsByText(text)[0]

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const keyDown = async (element: HTMLElement, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => {
    element.dispatchEvent(event)
  })
  return event
}

const useIdentity = (identity: TestExecutionIdentity | null) => {
  controller = new ExecutionController({
    api,
    storage: memoryStorage(identity),
    intervals: CONTROLLER_INTERVALS,
  })
  mocks.controller.current = controller
}

const startController = () => {
  const release = controller.start()
  releases.push(release)
}

const refreshController = async (reason: 'poll' | 'reconnect' = 'poll') => {
  await act(async () => {
    await controller.refresh(reason)
  })
  await flush()
}

const renderComponent = async () => {
  await act(async () => {
    root.render(<CombatTasks />)
  })
  await flush()
}

const renderActivityMode = async (mode: 'visible' | 'hidden') => {
  await act(async () => {
    root.render(
      <Activity mode={mode}>
        <CombatTasks />
      </Activity>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
}

const setInputValue = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const selectValue = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const setModeSelect = () => container.querySelector<HTMLSelectElement>('#combat-copilot-set-mode')!

const mockSetPlan = () => mocks.getCopilotSetPlan.mockResolvedValue({
  success: true,
  data: {
    items: [
      { id: 101, stage: 'TEST-1', stageId: 'test_1', supportsRaid: true },
      { id: 102, stage: 'TEST-2', stageId: 'test_2', supportsRaid: true },
    ],
    entries: [],
  },
})

const previewSet = async (uri = 'prts://s48990') => {
  mockSetPlan()
  await setInputValue(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!, uri)
  await click(buttonByText('预览')!)
  await flush()
}

describe('CombatTasks execution', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    // 协调器是应用级单例：每个用例从空通道与空存储开始，避免跨用例沿用草稿/队列。
    userConfigCoordinator.dispose()
    localStorage.clear()
    mocks.executePredefinedTaskArgs.mockReset().mockResolvedValue({ success: true })
    mocks.executeCopilotSetPlan.mockReset().mockResolvedValue({ success: true })
    mocks.continueCopilotSet.mockReset().mockResolvedValue({ success: true, data: { accepted: true } })
    mocks.loadUserConfig.mockReset().mockResolvedValue({ success: false })
    mocks.saveUserConfig.mockReset().mockResolvedValue({ success: true })
    mocks.getCopilotInfo.mockReset()
    mocks.getCopilotSet.mockReset()
    mocks.getCopilotSetPlan.mockReset()
    mocks.resetCopilotSetProgress.mockReset()
    mocks.searchCopilot.mockReset()
    mocks.searchParadoxCopilot.mockReset()
    mocks.setMessage.mockReset()

    api = createApi()
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot()))
    api.fetchRun.mockResolvedValue(failed('AGENT_RUN_NOT_FOUND', '未找到 Agent run'))
    api.stopRun.mockResolvedValue(ok({
      stopRequested: true,
      deviceStopRequested: true,
      run: activeRun('run-1', 'stopping'),
    }))
    useIdentity(null)
    releases = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    for (const release of releases) release()
    document.body.style.overflow = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('submits one idempotent continuous set run for the default cli mode', async () => {
    const submission = deferred<ApiResponse>()
    mocks.executeCopilotSetPlan.mockReturnValueOnce(submission.promise)
    await renderComponent()
    await previewSet()
    expect(setModeSelect().value).toBe('cli')

    await click(buttonByText('立即执行')!)

    expect(mocks.executeCopilotSetPlan).toHaveBeenCalledOnce()
    expect(mocks.executeCopilotSetPlan).toHaveBeenCalledWith(
      '48990',
      expect.objectContaining({
        mode: 'continuous',
        waitForCompletion: false,
        raid: 'normal',
        selectedIndexes: [0, 1],
      }),
      { idempotencyKey: expect.stringMatching(/^run_copilot_set-/) },
    )
    expect(buttonByText('正在启动')?.disabled).toBe(true)

    // 提交在途时重复点击（含直接派发）不会产生第二个请求。
    await act(async () => {
      buttonByText('正在启动')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => submission.resolve(ok({
      runId: 'run-set-1',
      state: 'accepted',
      run: setRun('run-set-1', 'accepted'),
    })))
    await flush()

    expect(mocks.executeCopilotSetPlan).toHaveBeenCalledOnce()
    expect(buttonByText('终止执行')).toBeDefined()
  })

  it('maps the legacy app execution mode to a continuous server run', async () => {
    await renderComponent()
    await previewSet()
    await selectValue(setModeSelect(), 'app')

    await click(buttonByText('立即执行')!)

    expect(mocks.executeCopilotSetPlan).toHaveBeenCalledWith(
      '48990',
      expect.objectContaining({ mode: 'continuous', selectedIndexes: [0, 1] }),
      expect.anything(),
    )
    expect(mocks.executePredefinedTaskArgs).not.toHaveBeenCalled()
  })

  it('starts a manual set, waits for the server next entry, and continues it', async () => {
    const submission = deferred<ApiResponse>()
    mocks.executeCopilotSetPlan.mockReturnValueOnce(submission.promise)
    await renderComponent()
    await previewSet()
    await selectValue(setModeSelect(), 'manual')

    await click(buttonByText('立即执行')!)
    expect(mocks.executeCopilotSetPlan).toHaveBeenCalledWith(
      '48990',
      expect.objectContaining({ mode: 'manual', selectedIndexes: [0, 1] }),
      expect.anything(),
    )

    const waiting = setRun('run-set-2', 'waiting', {
      progress: setProgress(
        [planEntry(0, 'success'), planEntry(1, 'pending')],
        {
          mode: 'manual',
          phase: 'waiting_for_next',
          nextEntry: planEntry(1, 'pending'),
          currentEntry: null,
          message: '等待开始下一关',
        },
      ),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [waiting] })))
    await act(async () => submission.resolve(ok({ runId: 'run-set-2', state: 'waiting', run: waiting })))
    await flush()

    expect(container.textContent).toContain('下一关')
    expect(container.textContent).toContain('第 2 / 2 关')
    expect(buttonByText('开始下一关')).toBeDefined()
    expect(buttonByText('终止执行')).toBeDefined()

    await click(buttonByText('开始下一关')!)

    expect(mocks.continueCopilotSet).toHaveBeenCalledOnce()
    expect(mocks.continueCopilotSet).toHaveBeenCalledWith('run-set-2', { waitForCompletion: false })
    expect(mocks.executeCopilotSetPlan).toHaveBeenCalledOnce()
  })

  it('keeps the waiting set when the device is busy and allows retry', async () => {
    useIdentity({ runId: 'run-set-3', operationId: 'run_copilot_set', scope: 'combat' })
    const waiting = setRun('run-set-3', 'waiting', {
      progress: setProgress(
        [planEntry(0, 'success'), planEntry(1, 'pending')],
        { mode: 'manual', phase: 'waiting_for_next', nextEntry: planEntry(1, 'pending'), currentEntry: null },
      ),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [waiting] })))
    api.fetchRun.mockResolvedValue(ok(waiting))
    startController()
    await flush()
    await renderComponent()
    await previewSet()
    await flush()

    mocks.continueCopilotSet.mockResolvedValueOnce(failed('MAA_EXECUTION_BUSY', '设备正在被其他任务占用'))
    await click(buttonByText('开始下一关')!)
    await flush()

    expect(mocks.setMessage).toHaveBeenCalledWith('设备正被其他任务占用，请稍后重试', 'warning')
    expect(buttonByText('开始下一关')?.disabled).toBe(false)
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()

    mocks.continueCopilotSet.mockResolvedValueOnce(ok({ success: true, accepted: true }))
    await click(buttonByText('开始下一关')!)
    await flush()

    expect(mocks.continueCopilotSet).toHaveBeenCalledTimes(2)
  })

  it('reports the failure summary of a failed set run', async () => {
    useIdentity({ runId: 'run-set-4', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-4', 'running', {
      progress: setProgress([planEntry(0, 'success'), planEntry(1, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()
    await flush()
    expect(buttonByText('终止执行')).toBeDefined()

    const failedRun = setRun('run-set-4', 'failed', {
      result: setResult([planEntry(0, 'success'), planEntry(1, 'failed', { error: '作战失败' })]),
      error: { code: 'COPILOT_PLAN_FAILED', message: '作业集执行失败，1 项未完成' },
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: failedRun })))
    api.fetchRun.mockResolvedValue(ok(failedRun))
    await refreshController()

    expect(mocks.setMessage).toHaveBeenCalledWith(
      '作业集执行失败: 作业集执行失败，1 项未完成',
      'error',
    )
    expect(container.textContent).toContain('失败 1')
    expect(buttonByText('立即执行')).toBeDefined()
  })

  it('stops the tracked run and does not submit any further entry', async () => {
    useIdentity({ runId: 'run-set-5', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-5', 'running', {
      progress: setProgress([planEntry(0, 'success'), planEntry(1, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()
    await flush()

    await click(buttonByText('终止执行')!)

    expect(api.stopRun).toHaveBeenCalledOnce()
    expect(api.stopRun).toHaveBeenCalledWith('run-set-5')
    expect(mocks.setMessage).toHaveBeenCalledWith('正在终止自动战斗...', 'warning')

    const stopped = setRun('run-set-5', 'stopped', {
      result: setResult([planEntry(0, 'success'), planEntry(1, 'pending')], {
        stopped: true,
        message: '作业集已被终止',
      }),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: stopped })))
    api.fetchRun.mockResolvedValue(ok(stopped))
    await refreshController()

    expect(mocks.setMessage).toHaveBeenCalledWith('作业集已终止：1/2 成功', 'warning')
    expect(buttonByText('立即执行')).toBeDefined()
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()
    expect(mocks.executePredefinedTaskArgs).not.toHaveBeenCalled()
  })

  it('unlocks the stop action when confirmation times out so it can be retried', async () => {
    vi.useFakeTimers()
    useIdentity({ runId: 'run-set-6', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-6', 'running', {
      progress: setProgress([planEntry(0, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()
    await flush()

    // 停止请求被接受但 run 仍显示 running：确认超时后必须解锁重试。
    api.stopRun.mockResolvedValueOnce(ok({
      stopRequested: true,
      deviceStopRequested: true,
      run: running,
    }))
    await click(buttonByText('终止执行')!)
    expect(buttonByText('正在终止')?.disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    await flush()

    expect(mocks.setMessage).toHaveBeenCalledWith(
      '终止失败: 终止请求已发送，但尚未确认任务停止',
      'error',
    )
    expect(buttonByText('终止执行')?.disabled).toBe(false)

    await click(buttonByText('终止执行')!)
    expect(api.stopRun).toHaveBeenCalledTimes(2)
  })

  it('keeps running state across Activity hide/show without stopping or resubmitting', async () => {
    useIdentity({ runId: 'run-set-7', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-7', 'running', {
      progress: setProgress([planEntry(0, 'success'), planEntry(1, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()

    await renderActivityMode('visible')
    await previewSet()
    expect(buttonByText('终止执行')).toBeDefined()

    await renderActivityMode('hidden')
    expect(api.stopRun).not.toHaveBeenCalled()
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()

    const stopped = setRun('run-set-7', 'stopped', {
      result: setResult([planEntry(0, 'success'), planEntry(1, 'stopped', { error: '已终止' })], {
        stopped: true,
      }),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: stopped })))
    api.fetchRun.mockResolvedValue(ok(stopped))

    await renderActivityMode('visible')
    await refreshController()

    expect(buttonByText('立即执行')).toBeDefined()
    expect(api.stopRun).not.toHaveBeenCalled()
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()
    expect(mocks.setMessage).not.toHaveBeenCalledWith(expect.stringContaining('执行完成'), 'success')
  })

  it('keeps the last running state when a snapshot fails and recovers on reconnect', async () => {
    useIdentity({ runId: 'run-set-8', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-8', 'running', {
      progress: setProgress([planEntry(0, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()

    api.fetchSnapshot.mockRejectedValueOnce(new Error('network down'))
    await refreshController('reconnect')

    expect(controller.getState().phase).toBe('disconnected')
    expect(buttonByText('终止执行')).toBeDefined()

    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    await refreshController('reconnect')

    expect(controller.getState().phase).toBe('live')
    expect(buttonByText('终止执行')).toBeDefined()
    expect(api.fetchRun).toHaveBeenLastCalledWith('run-set-8', expect.anything())
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()
  })

  it('recovers its own set run identity after a refresh without resubmitting', async () => {
    useIdentity({ runId: 'run-set-9', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-9', 'running', {
      progress: setProgress([planEntry(0, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()

    await renderComponent()

    expect(buttonByText('终止执行')).toBeDefined()
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()
    expect(mocks.executePredefinedTaskArgs).not.toHaveBeenCalled()
  })

  it('stops a manual set from the failure strategy instead of offering the next entry', async () => {
    mocks.getCopilotSetPlan.mockResolvedValue({
      success: true,
      data: {
        items: [
          { id: 101, stage: 'TEST-1', stageId: 'test_1', supportsRaid: true },
          { id: 102, stage: 'TEST-2', stageId: 'test_2', supportsRaid: true },
          { id: 103, stage: 'TEST-3', stageId: 'test_3', supportsRaid: true },
        ],
        entries: [],
      },
    })
    useIdentity({ runId: 'run-set-manual', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-manual', 'running', {
      progress: setProgress([planEntry(0, 'running'), planEntry(1, 'pending'), planEntry(2, 'pending')], {
        mode: 'manual',
        totalSteps: 3,
      }),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()

    const strategySelect = Array.from(container.querySelectorAll<HTMLSelectElement>('select'))
      .find(select => Array.from(select.options).some(option => option.value === 'stop'))!
    await selectValue(strategySelect, 'stop')

    const waitingAfterFailure = setRun('run-set-manual', 'waiting', {
      progress: setProgress(
        [planEntry(0, 'success'), planEntry(1, 'failed', { error: '作战失败' }), planEntry(2, 'pending')],
        {
          mode: 'manual',
          phase: 'waiting_for_next',
          totalSteps: 3,
          nextEntry: planEntry(2, 'pending'),
        },
      ),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [waitingAfterFailure] })))
    api.fetchRun.mockResolvedValue(ok(waitingAfterFailure))
    await refreshController()

    expect(mocks.setMessage).toHaveBeenCalledWith('作业 2/3 执行失败: 作战失败，已按队列策略停止', 'error')
    expect(api.stopRun).toHaveBeenCalledWith('run-set-manual')
    expect(buttonByText('开始下一关')).toBeUndefined()
  })

  it('keeps the new run when an older terminal record is also in the snapshot', async () => {
    useIdentity({ runId: 'run-set-new', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-new', 'running', {
      progress: setProgress([planEntry(0, 'running')]),
    })
    const olderTerminal = setRun('run-set-old', 'failed', {
      result: setResult([planEntry(0, 'failed', { error: '旧的失败' })]),
      error: { message: '旧的执行失败' },
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({
      activeRuns: [running],
      lastRun: olderTerminal,
    })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()

    expect(buttonByText('终止执行')).toBeDefined()
    expect(mocks.setMessage).not.toHaveBeenCalledWith(expect.stringContaining('旧的执行失败'), 'error')
    expect(controller.getState().trackedRunId).toBe('run-set-new')
  })

  it('does not turn an unknown run identity into completion or a resubmission', async () => {
    useIdentity({ runId: 'run-set-now', operationId: 'run_copilot_set', scope: 'combat' })
    const running = setRun('run-set-now', 'running', {
      progress: setProgress([planEntry(0, 'running')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [running] })))
    api.fetchRun.mockResolvedValue(ok(running))
    startController()
    await flush()
    await renderComponent()
    await previewSet()

    const otherTerminal = setRun('run-set-old', 'succeeded', {
      result: setResult([planEntry(0, 'success')]),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: otherTerminal })))
    api.fetchRun.mockResolvedValue(failed('AGENT_RUN_NOT_FOUND', '未找到 Agent run'))
    await refreshController()

    expect(controller.getState().identity).toBe('unknown')
    expect(buttonByText('立即执行')).toBeDefined()
    expect(mocks.setMessage).not.toHaveBeenCalledWith(expect.stringContaining('作业集执行完成'), 'success')
    expect(mocks.setMessage).not.toHaveBeenCalledWith(expect.stringContaining('作业集执行失败'), 'error')
    expect(mocks.executeCopilotSetPlan).not.toHaveBeenCalled()
  })

  it('does not present another domain run as a combat execution', async () => {
    useIdentity({ runId: 'run-rogue', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-rogue')] })))
    api.fetchRun.mockResolvedValue(ok(activeRun('run-rogue')))
    startController()
    await flush()

    await renderComponent()

    expect(buttonByText('终止执行')).toBeUndefined()
    expect(buttonByText('立即执行')).toBeDefined()
  })

  it('does not show another set run next entry for the previewed set', async () => {
    useIdentity({ runId: 'run-set-other', operationId: 'run_copilot_set', scope: 'combat' })
    const otherWaiting = setRun('run-set-other', 'waiting', {
      progress: setProgress([planEntry(0, 'success'), planEntry(1, 'pending')], {
        setId: '11111',
        mode: 'manual',
        phase: 'waiting_for_next',
        nextEntry: planEntry(1, 'pending'),
      }),
    })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [otherWaiting] })))
    api.fetchRun.mockResolvedValue(ok(otherWaiting))
    startController()
    await flush()

    await renderComponent()
    await previewSet()

    expect(buttonByText('开始下一关')).toBeUndefined()
    expect(buttonByText('终止执行')).toBeDefined()
    expect(container.textContent).not.toContain('执行中')
  })

  it('runs a single task as a tracked run_task without waiting for completion', async () => {
    const execution = deferred<ApiResponse>()
    mocks.executePredefinedTaskArgs.mockReturnValueOnce(execution.promise)
    await renderComponent()

    await setInputValue(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!, 'prts://1234')
    await click(buttonByText('立即执行')!)

    expect(mocks.executePredefinedTaskArgs).toHaveBeenCalledOnce()
    expect(mocks.executePredefinedTaskArgs).toHaveBeenCalledWith(
      'copilot',
      expect.arrayContaining(['prts://1234']),
      null,
      null,
      '自动战斗作业',
      'combat',
      false,
      { idempotencyKey: expect.stringMatching(/^run_task-/) },
    )

    await act(async () => execution.resolve(ok({
      runId: 'run-task-1',
      state: 'accepted',
      run: activeRun('run-task-1', 'accepted'),
    })))
    await flush()
    expect(buttonByText('终止执行')).toBeDefined()
  })

  it('previews an explicit PRTS single code without guessing a set with the same id', async () => {
    mocks.getCopilotInfo.mockResolvedValue({ status_code: 200, data: { content: JSON.stringify({
      stage_name: 'test_1', doc: { title: 'PRTS 单作业' },
    }) } })
    await renderComponent()
    await setInputValue(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!, 'prts://1234')
    await click(buttonByText('预览')!)
    expect(mocks.getCopilotInfo).toHaveBeenCalledWith('1234')
    expect(mocks.getCopilotSet).not.toHaveBeenCalled()
    expect(mocks.getCopilotSetPlan).not.toHaveBeenCalled()
    expect(container.textContent).toContain('PRTS 单作业')
  })

  it('links to the prts.plus copilot station', async () => {
    await renderComponent()
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://prts.plus/"]')
    expect(link?.textContent).toBe('prts.plus')
  })

  it.each(['prts://s48990', 'PRTS://S48990'])(
    'previews %s as a set with its plan entries',
    async uri => {
      mocks.getCopilotSetPlan.mockResolvedValue({
        success: true,
        data: { items: [{ id: 101, stage: 'TEST-1', stageId: 'test_1', supportsRaid: true }], entries: [] },
      })
      await renderComponent()
      await setInputValue(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!, uri)
      await click(buttonByText('预览')!)
      expect(mocks.getCopilotSetPlan).toHaveBeenCalledWith('48990', 'normal')
      expect(mocks.getCopilotInfo).not.toHaveBeenCalled()
      expect(container.textContent).toContain('续跑目标')
    },
  )

  it('falls back to the set list when the plan request fails', async () => {
    mocks.getCopilotSetPlan.mockRejectedValue(new Error('plan unavailable'))
    mocks.getCopilotSet.mockResolvedValue({
      success: true,
      data: { status_code: 200, data: { copilot_ids: [101] } },
    })
    mocks.getCopilotInfo.mockResolvedValue({ status_code: 200, data: { content: JSON.stringify({
      stage_name: 'TEST-1', doc: { title: '兜底作业' },
    }) } })

    await renderComponent()
    await setInputValue(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!, 'prts://s48990')
    await click(buttonByText('预览')!)
    await flush()

    expect(mocks.getCopilotSetPlan).toHaveBeenCalledWith('48990', 'normal')
    expect(mocks.getCopilotSet).toHaveBeenCalledWith('48990')
    expect(mocks.getCopilotInfo).toHaveBeenCalledWith('101')
    expect(container.textContent).toContain('共 1 个作业')
    expect(container.textContent).toContain('兜底作业')
  })

  it('supports roving focus across combat modes', async () => {
    await renderComponent()

    const modeShell = container.querySelector('.combat-mode-shell')
    expect(modeShell?.querySelector('[role="toolbar"]')).not.toBeNull()
    const modeButtons = modeShell?.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button') ?? []
    expect(modeButtons).toHaveLength(3)
    expect(Array.from(modeButtons).filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    expect(Array.from(modeButtons).map(button => button.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])

    const firstModeButton = modeButtons[0] as HTMLButtonElement
    const secondModeButton = modeButtons[1] as HTMLButtonElement
    firstModeButton.focus()
    await keyDown(firstModeButton, 'ArrowRight')
    expect(secondModeButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(secondModeButton)

    await keyDown(secondModeButton, 'Home')
    expect(firstModeButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(firstModeButton)

    const arrowDownEvent = await keyDown(firstModeButton, 'ArrowDown')
    expect(arrowDownEvent.defaultPrevented).toBe(false)
    expect(firstModeButton.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps an unsynced local draft across remounts and retries the save', async () => {
    vi.useFakeTimers()
    mocks.saveUserConfig.mockResolvedValueOnce({ success: false, message: '配置存储暂不可用' })
    await renderComponent()

    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'prts://24680')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    expect(localStorage.getItem('combatConfigSyncPending')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('combatTaskInputs') || '{}')).toMatchObject({ copilot: 'prts://24680' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('配置存储暂不可用')

    await act(async () => root.unmount())
    root = createRoot(container)
    mocks.loadUserConfig.mockClear()
    await renderComponent()

    expect(mocks.loadUserConfig).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')?.value).toBe('prts://24680')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('尚未同步到服务器')

    await click(buttonByText('重新同步')!)
    await flush()

    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('combatConfigSyncPending')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.setMessage).toHaveBeenCalledWith('自动战斗配置已同步', 'success')
  })

  it('does not let an older save response clear a newer remounted draft', async () => {
    vi.useFakeTimers()
    const olderSave = deferred<{ success: boolean }>()
    const newerSave = deferred<{ success: boolean }>()
    mocks.saveUserConfig
      .mockReturnValueOnce(olderSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    await renderComponent()

    let input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'prts://10001')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })

    await act(async () => root.unmount())
    root = createRoot(container)
    await renderComponent()
    input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'prts://10002')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    const newerSyncToken = localStorage.getItem('combatConfigSyncPending')
    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(1)

    await act(async () => olderSave.resolve({ success: true }))
    await flush()
    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(2)
    expect(mocks.saveUserConfig.mock.calls[1]?.[1]).toMatchObject({
      taskInputs: { copilot: 'prts://10002' },
    })
    expect(localStorage.getItem('combatConfigSyncPending')).toBe(newerSyncToken)
    expect(JSON.parse(localStorage.getItem('combatTaskInputs') || '{}')).toMatchObject({ copilot: 'prts://10002' })

    await act(async () => newerSave.resolve({ success: true }))
    await flush()
    expect(localStorage.getItem('combatConfigSyncPending')).toBeNull()
  })

  it('migrates a saved app set mode to cli and normalizes legacy raid values on load', async () => {
    mocks.loadUserConfig.mockResolvedValueOnce({
      success: true,
      data: {
        taskInputs: { copilot: 'prts://s1' },
        advancedParams: {
          copilot: { ignoreRequirements: true, loopTimes: '1', executionStrategy: 'continue', raid: '1' },
          paradoxcopilot: { executionStrategy: 'continue' },
          ssscopilot: { loopTimes: '1' },
        },
        copilotSetExecutionMode: 'app',
      },
    })

    await renderComponent()

    expect(container.querySelector<HTMLSelectElement>('#combat-copilot-set-mode')?.value).toBe('cli')
    expect(localStorage.getItem('combatCopilotSetExecutionMode')).toBe('cli')
    expect(JSON.parse(localStorage.getItem('combatAdvancedParams') || '{}')).toMatchObject({
      copilot: { raid: 'raid' },
    })
    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
  })

  it('migrates a local app set mode to cli and normalizes legacy raid values when the server copy is unavailable', async () => {
    localStorage.setItem('combatTaskInputs', JSON.stringify({ copilot: 'prts://local' }))
    localStorage.setItem('combatAdvancedParams', JSON.stringify({ copilot: { raid: '2' } }))
    localStorage.setItem('combatCopilotSetExecutionMode', 'app')

    await renderComponent()

    expect(container.querySelector<HTMLSelectElement>('#combat-copilot-set-mode')?.value).toBe('cli')
    expect(container.querySelector<HTMLSelectElement>('#combat-copilot-raid')?.value).toBe('both')
    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
    // 服务端不可用时会采用并回写规范化后的本地草稿。
    expect(localStorage.getItem('combatCopilotSetExecutionMode')).toBe('cli')
    expect(JSON.parse(localStorage.getItem('combatAdvancedParams') || '{}')).toMatchObject({
      copilot: { raid: 'both' },
    })
  })

  it('restores a previous session draft with set mode migration and saved selections without reading the server', async () => {
    localStorage.setItem('combatConfigSyncPending', 'previous-session-token')
    localStorage.setItem('combatTaskInputs', JSON.stringify({ copilot: 'prts://s48990' }))
    localStorage.setItem('combatAdvancedParams', JSON.stringify({ copilot: { raid: '2' } }))
    localStorage.setItem('combatAutoFormation', JSON.stringify({ copilot: 'off' }))
    localStorage.setItem('combatCopilotSetExecutionMode', 'app')
    localStorage.setItem('combatCopilotSetSelections', JSON.stringify({ '48990': [1] }))
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskInputs: { copilot: 'prts://server' } },
    })

    await renderComponent()

    expect(mocks.loadUserConfig).not.toHaveBeenCalled()
    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')?.value)
      .toBe('prts://s48990')
    expect(container.querySelector<HTMLSelectElement>('#combat-copilot-raid')?.value).toBe('both')
    expect(container.querySelector<HTMLSelectElement>('#combat-copilot-formation')?.value).toBe('off')
    expect(container.querySelector<HTMLSelectElement>('#combat-copilot-set-mode')?.value).toBe('cli')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('尚未同步到服务器')

    // 保存的待执行索引参与作业集回填：两项里只保留第二项。
    await previewSet('prts://s48990')
    expect(container.textContent).toContain('待 1')
    expect(container.textContent).toContain('共 2 个作业')
  })

  it('drops a pending marker whose local draft is unreadable and falls back to the server', async () => {
    localStorage.setItem('combatTaskInputs', '{not-json')
    localStorage.setItem('combatAdvancedParams', JSON.stringify({ copilot: 'invalid' }))
    localStorage.setItem('combatConfigSyncPending', 'stale-token')
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskInputs: { copilot: 'prts://server' } },
    })

    await renderComponent()

    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
    expect(localStorage.getItem('combatConfigSyncPending')).toBeNull()
    expect(localStorage.getItem('combatTaskInputs')).not.toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')?.value)
      .toBe('prts://server')
  })

  it('keeps a manual retry single-flight and announces success only after confirmation', async () => {
    vi.useFakeTimers()
    mocks.saveUserConfig.mockRejectedValueOnce(new Error('网络连接中断'))
    await renderComponent()

    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'prts://24680')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络连接中断')
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    // 自动保存成功不弹成功提示；只有用户主动重试确认后才提示。
    expect(mocks.setMessage).not.toHaveBeenCalledWith('自动战斗配置已同步', 'success')

    const retrySave = deferred<{ success: boolean }>()
    mocks.saveUserConfig.mockReturnValueOnce(retrySave.promise)
    await click(buttonByText('重新同步')!)
    expect(buttonByText('同步中')?.disabled).toBe(true)

    // 重试请求在途时再次点击不会产生第二个提交。
    await click(buttonByText('同步中')!)
    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(2)
    expect(mocks.setMessage).not.toHaveBeenCalledWith('自动战斗配置已同步', 'success')

    await act(async () => retrySave.resolve({ success: true }))
    await flush()

    expect(localStorage.getItem('combatConfigSyncPending')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.setMessage).toHaveBeenCalledWith('自动战斗配置已同步', 'success')
  })

  // 加载在途时出现编辑后，迟到的服务端副本必须被丢弃；协调器按 revision 与 pending
  // 标记校验加载身份，编辑自己的草稿继续提交。
  it('does not let a late server load overwrite an edit made before hydration', async () => {
    const serverLoad = deferred<{ success: boolean; data: { taskInputs: { copilot: string } } }>()
    mocks.loadUserConfig.mockReturnValueOnce(serverLoad.promise)

    await renderComponent()
    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'prts://local-draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => serverLoad.resolve({
      success: true,
      data: { taskInputs: { copilot: 'prts://server-copy' } },
    }))
    await flush()

    expect(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')?.value)
      .toBe('prts://local-draft')
  })

  it('keeps the hydrated draft and does not reload config after Activity restore', async () => {
    vi.useFakeTimers()
    mocks.loadUserConfig.mockResolvedValueOnce({
      success: true,
      data: { taskInputs: { copilot: 'prts://server' } },
    })

    await renderActivityMode('visible')
    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'prts://draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await renderActivityMode('hidden')
    await renderActivityMode('visible')
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await flush()

    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')?.value).toBe('prts://draft')
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()

    await renderActivityMode('hidden')
    await renderActivityMode('visible')
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await flush()
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
  })

  it('clears retained request loading when Activity restores the combat workspace', async () => {
    mocks.getCopilotInfo.mockReturnValueOnce(deferred<any>().promise)
    mocks.searchCopilot.mockReturnValueOnce(deferred<any>().promise)
    mocks.searchParadoxCopilot.mockReturnValueOnce(deferred<any>().promise)

    await renderActivityMode('visible')
    await click(buttonByText('单个作业')!)

    const previewInput = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!
    await setInputValue(previewInput, 'prts://1234')
    const previewButton = previewInput.parentElement?.querySelector<HTMLButtonElement>('button')
    await click(previewButton!)
    expect(previewButton?.disabled).toBe(true)
    expect(mocks.getCopilotInfo).toHaveBeenCalledOnce()

    await renderActivityMode('hidden')
    await renderActivityMode('visible')
    expect(previewButton?.disabled).toBe(false)
    expect(previewButton?.textContent).toContain('预览')

    const stageInput = container.querySelector<HTMLInputElement>('input[name="maa-copilot-stage-search"]')!
    await setInputValue(stageInput, '1-7')
    const stageSearchButton = stageInput.parentElement?.querySelector<HTMLButtonElement>('button')
    await click(stageSearchButton!)
    expect(stageSearchButton?.disabled).toBe(true)
    expect(mocks.searchCopilot).toHaveBeenCalledOnce()

    await renderActivityMode('hidden')
    await renderActivityMode('visible')
    expect(stageSearchButton?.disabled).toBe(false)
    expect(stageSearchButton?.textContent).toContain('搜索')

    const paradoxModeButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.combat-mode-button'))
      .find(button => button.textContent?.includes('悖论模拟'))
    await click(paradoxModeButton!)
    const paradoxInput = container.querySelector<HTMLInputElement>('input[name="maa-paradox-operator"]')!
    await setInputValue(paradoxInput, '能天使')
    const paradoxSearchButton = paradoxInput.parentElement?.querySelector<HTMLButtonElement>('button')
    await click(paradoxSearchButton!)
    expect(paradoxSearchButton?.disabled).toBe(true)
    expect(mocks.searchParadoxCopilot).toHaveBeenCalledOnce()

    await renderActivityMode('hidden')
    await renderActivityMode('visible')
    expect(paradoxSearchButton?.disabled).toBe(false)
    expect(paradoxSearchButton?.textContent).toContain('搜索')
  })

  it('ignores an older search response after the query changes', async () => {
    const olderSearch = deferred<any>()
    const newerSearch = deferred<any>()
    mocks.searchCopilot
      .mockReturnValueOnce(olderSearch.promise)
      .mockReturnValueOnce(newerSearch.promise)
    await renderComponent()

    const searchInput = container.querySelector<HTMLInputElement>('input[name="maa-copilot-stage-search"]')!
    await setInputValue(searchInput, '旧关卡')
    await click(buttonsByText('搜索')[0]!)
    await setInputValue(searchInput, '新关卡')
    await click(buttonsByText('搜索')[0]!)

    await act(async () => newerSearch.resolve({
      success: true,
      data: { copilots: [{ id: 2, uri: 'prts://2', title: '新作业' }] },
    }))
    await flush()
    expect(container.textContent).toContain('新作业')

    await act(async () => olderSearch.resolve({
      success: true,
      data: { copilots: [{ id: 1, uri: 'prts://1', title: '旧作业' }] },
    }))
    await flush()
    expect(container.textContent).toContain('新作业')
    expect(container.textContent).not.toContain('旧作业')
  })

  it('ignores an older copilot preview after the URI changes', async () => {
    const olderPreview = deferred<any>()
    const newerPreview = deferred<any>()
    mocks.getCopilotInfo
      .mockReturnValueOnce(olderPreview.promise)
      .mockReturnValueOnce(newerPreview.promise)
    await renderComponent()
    await click(buttonByText('单个作业')!)

    const input = container.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')!
    await setInputValue(input, 'prts://1')
    await click(buttonByText('预览')!)
    await setInputValue(input, 'prts://2')
    await click(buttonByText('预览')!)

    const previewResponse = (title: string, stage: string) => ({
      success: true,
      data: {
        status_code: 200,
        data: { content: JSON.stringify({ doc: { title }, stage_name: stage }) },
      },
    })
    await act(async () => newerPreview.resolve(previewResponse('新预览', 'NEW-2')))
    await flush()
    expect(container.textContent).toContain('新预览')

    await act(async () => olderPreview.resolve(previewResponse('旧预览', 'OLD-1')))
    await flush()
    expect(container.textContent).toContain('新预览')
    expect(container.textContent).not.toContain('旧预览')
  })

  it('associates every visible form control with a label', async () => {
    await renderComponent()

    const controls = Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'))
    expect(controls.length).toBeGreaterThan(0)
    controls.forEach(control => {
      expect(control.id).not.toBe('')
      const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label'))
        .find(candidate => candidate.htmlFor === control.id)
      expect(label).toBeDefined()
    })
  })

  it('keeps the reset dialog open when resetting progress fails', async () => {
    mocks.getCopilotSetPlan.mockResolvedValue({
      success: true,
      data: {
        items: [{ id: 101, stage: 'TEST-1', stageId: 'test_1', supportsRaid: true }],
        entries: [],
      },
    })
    mocks.resetCopilotSetProgress.mockResolvedValue({ success: false, message: '进度存储不可用' })

    await renderComponent()
    await click(buttonByText('作业集')!)

    const input = document.querySelector<HTMLInputElement>('input[name="maa-copilot-uri"]')
    expect(input).not.toBeNull()
    await setInputValue(input!, 'prts://s48990')
    await click(buttonByText('预览')!)
    await flush()

    await click(buttonByText('重置进度')!)
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    await click(buttonByText('确认重置')!)
    await flush()

    expect(mocks.resetCopilotSetProgress).toHaveBeenCalledWith('48990')
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(buttonByText('确认重置')?.disabled).toBe(false)
    expect(mocks.setMessage).toHaveBeenCalledWith('重置失败: 进度存储不可用', 'error')
  })
})
