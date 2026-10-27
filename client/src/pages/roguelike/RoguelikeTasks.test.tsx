// @vitest-environment jsdom

import { Activity, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResponse } from '@/shared/api'
import {
  ExecutionController,
  type AgentRun,
  type RunSnapshot,
  type StopRunResult,
} from '@/features/task-execution'
import { userConfigCoordinator } from '@/features/user-config'
import RoguelikeTasks from './RoguelikeTasks'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  controller: { current: null as unknown as ExecutionController },
  executePredefinedTask: vi.fn(),
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
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
    executePredefinedTask: mocks.executePredefinedTask,
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

interface TestExecutionIdentity {
  runId: string
  operationId: string | null
  scope?: string | null
}

interface TestIdentityStorage {
  read(): TestExecutionIdentity | null
  write(identity: TestExecutionIdentity | null): void
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
  const storage: TestIdentityStorage & { current: () => TestExecutionIdentity | null } = {
    read: () => value,
    write: (identity) => {
      value = identity
    },
    current: () => value,
  }
  return storage
}

let api: ReturnType<typeof createApi>
let controller: ExecutionController
let releases: Array<() => void>
let container: HTMLDivElement
let root: Root

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

const buttonByText = (text: string) => Array.from(document.querySelectorAll('button'))
  .find(button => button.textContent?.trim() === text) as HTMLButtonElement | undefined

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

const renderPage = async () => {
  await act(async () => root.render(<RoguelikeTasks />))
  await flush()
}

const setTheme = async (value: string) => {
  const themeInput = container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')!
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(themeInput, value)
    themeInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const setControlValue = async (
  selector: string,
  value: string,
  eventName: 'input' | 'change' = 'input',
) => {
  const control = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!
  await act(async () => {
    const prototype = control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    valueSetter?.call(control, value)
    control.dispatchEvent(new Event(eventName, { bubbles: true }))
  })
  await flush()
}

const toggleSwitch = async (selector: string) => {
  const input = container.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    input.click()
  })
  await flush()
}

const findModeButton = (name: string) => Array.from(
  container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
).find(button => button.textContent?.includes(name))

describe('RoguelikeTasks execution', () => {
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
    mocks.executePredefinedTask.mockReset()
    mocks.loadUserConfig.mockReset().mockResolvedValue({ success: false })
    mocks.saveUserConfig.mockReset().mockResolvedValue({ success: true })
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
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('submits one idempotent run with the original command semantics', async () => {
    const submission = deferred<ApiResponse>()
    mocks.executePredefinedTask.mockReturnValueOnce(submission.promise)
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1', 'accepted')] })))
    useIdentity(null)
    startController()
    await flush()
    await renderPage()
    await setTheme('Phantom')

    await click(buttonByText('立即执行')!)

    expect(mocks.executePredefinedTask).toHaveBeenCalledOnce()
    expect(mocks.executePredefinedTask).toHaveBeenCalledWith(
      'roguelike',
      'Phantom',
      null,
      null,
      '集成战略',
      'roguelike',
      false,
      { idempotencyKey: expect.stringMatching(/^run_task-/) },
    )
    expect(buttonByText('正在启动')?.disabled).toBe(true)

    // 提交在途时重复点击（含直接派发）不会产生第二个请求。
    await click(buttonByText('正在启动')!)

    await act(async () => submission.resolve(ok({ runId: 'run-1', run: activeRun('run-1', 'accepted') })))
    await flush()

    expect(mocks.executePredefinedTask).toHaveBeenCalledOnce()
    expect(buttonByText('终止执行')).toBeDefined()
  })

  it('builds the command from the active mode and advanced fields', async () => {
    await renderPage()
    await setTheme('Phantom')
    await setControlValue('select[name="maa-roguelike-mode"]', '1', 'change')
    await setControlValue('input[name="maa-roguelike-squad"]', '指挥分队')
    await toggleSwitch('input[name="maa-roguelike-useSupport"]')

    await click(buttonByText('立即执行')!)

    expect(mocks.executePredefinedTask).toHaveBeenCalledWith(
      'roguelike',
      'Phantom --mode 1 --squad 指挥分队 --use-support',
      null,
      null,
      '集成战略',
      'roguelike',
      false,
      { idempotencyKey: expect.stringMatching(/^run_task-/) },
    )
  })

  it('submits the task selected by the active mode', async () => {
    await renderPage()
    await click(findModeButton('生息演算')!)
    await setControlValue('input[name="maa-reclamation-theme"]', 'Tales')

    await click(buttonByText('立即执行')!)

    expect(mocks.executePredefinedTask).toHaveBeenCalledWith(
      'reclamation',
      'Tales',
      null,
      null,
      '生息演算',
      'roguelike',
      false,
      { idempotencyKey: expect.stringMatching(/^run_task-/) },
    )
  })

  it('rejects an empty theme before creating a run', async () => {
    await renderPage()

    await click(buttonByText('立即执行')!)

    expect(mocks.executePredefinedTask).not.toHaveBeenCalled()
    expect(mocks.setMessage).toHaveBeenCalledWith('请输入主题名称')
  })

  it('keeps the run observable after the page unmounts without sending a stop', async () => {
    vi.useFakeTimers()
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    startController()
    await flush()
    await renderPage()
    expect(buttonByText('终止执行')).toBeDefined()

    await act(async () => root.unmount())
    root = createRoot(document.createElement('div'))
    const snapshotCalls = api.fetchSnapshot.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(api.stopRun).not.toHaveBeenCalled()
    expect(api.fetchSnapshot.mock.calls.length).toBeGreaterThan(snapshotCalls)
  })

  it('recovers its own run identity after a refresh without resubmitting', async () => {
    useIdentity({ runId: 'run-7', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-7')] })))
    startController()
    await flush()
    await renderPage()

    expect(buttonByText('终止执行')).toBeDefined()
    expect(mocks.executePredefinedTask).not.toHaveBeenCalled()

    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: activeRun('run-7', 'succeeded') })))
    await refreshController()

    expect(buttonByText('立即执行')).toBeDefined()
    expect(mocks.setMessage).toHaveBeenCalledWith('肉鸽任务执行成功', 'success')
  })

  it('does not present another domain run as a roguelike execution', async () => {
    useIdentity({ runId: 'run-combat', operationId: 'run_task', scope: 'combat' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-combat')] })))
    startController()
    await flush()
    await renderPage()

    expect(buttonByText('立即执行')).toBeDefined()
    expect(buttonByText('终止执行')).toBeUndefined()
  })

  it('stops by runId once and keeps confirming until the run reaches a terminal state', async () => {
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    startController()
    await flush()
    await renderPage()

    await click(buttonByText('终止执行')!)

    expect(api.stopRun).toHaveBeenCalledOnce()
    expect(api.stopRun).toHaveBeenCalledWith('run-1')
    expect(mocks.setMessage).toHaveBeenCalledWith('正在终止肉鸽任务...', 'warning')
    expect(buttonByText('正在终止')?.disabled).toBe(true)

    // 停止确认中的重复点击不会重复发送停止请求。
    await click(buttonByText('正在终止')!)
    expect(api.stopRun).toHaveBeenCalledOnce()

    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: activeRun('run-1', 'stopped') })))
    await refreshController()

    expect(buttonByText('立即执行')).toBeDefined()
    expect(mocks.setMessage).toHaveBeenCalledWith('肉鸽任务已终止', 'warning')
  })

  it('keeps the stop confirmation across Activity hide/show and never leaves a locked button', async () => {
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    startController()
    await flush()
    await act(async () => {
      root.render(
        <Activity mode="visible">
          <RoguelikeTasks />
        </Activity>,
      )
    })
    await flush()

    api.stopRun.mockResolvedValueOnce(ok({
      stopRequested: true,
      deviceStopRequested: true,
      run: activeRun('run-1', 'running'),
    }))
    await click(buttonByText('终止执行')!)
    expect(buttonByText('正在终止')?.disabled).toBe(true)

    const renderMode = async (mode: 'visible' | 'hidden') => {
      await act(async () => {
        root.render(
          <Activity mode={mode}>
            <RoguelikeTasks />
          </Activity>,
        )
      })
      await flush()
    }
    await renderMode('hidden')
    await renderMode('visible')
    expect(buttonByText('正在终止')?.disabled).toBe(true)
    expect(api.stopRun).toHaveBeenCalledOnce()

    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ lastRun: activeRun('run-1', 'stopped') })))
    await refreshController()

    expect(buttonByText('立即执行')?.disabled).toBe(false)
    expect(buttonByText('正在终止')).toBeUndefined()
  })

  it('unlocks the stop action when confirmation times out so it can be retried', async () => {
    vi.useFakeTimers()
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    startController()
    await flush()
    await renderPage()

    api.stopRun.mockResolvedValueOnce(ok({
      stopRequested: true,
      deviceStopRequested: true,
      run: activeRun('run-1', 'running'),
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

  it('unlocks the stop action when the stop request is rejected', async () => {
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    api.stopRun.mockResolvedValueOnce(failed('AGENT_RUN_NOT_CURRENT', '目标运行已不是当前运行'))
    startController()
    await flush()
    await renderPage()

    await click(buttonByText('终止执行')!)

    expect(mocks.setMessage).toHaveBeenCalledWith('终止失败: 目标运行已不是当前运行', 'error')
    expect(buttonByText('终止执行')?.disabled).toBe(false)
  })

  it('reports a failed run and returns to the execute action', async () => {
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    startController()
    await flush()
    await renderPage()

    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({
      lastRun: {
        ...activeRun('run-1', 'failed'),
        error: { code: 'AGENT_RUN_FAILED', message: '设备连接中断' },
      },
    })))
    await refreshController()

    expect(mocks.setMessage).toHaveBeenCalledWith('执行失败: 设备连接中断', 'error')
    expect(buttonByText('立即执行')).toBeDefined()
  })

  it('keeps the stop action while observation is disconnected', async () => {
    vi.useFakeTimers()
    useIdentity({ runId: 'run-1', operationId: 'run_task', scope: 'roguelike' })
    api.fetchSnapshot.mockResolvedValue(ok(runSnapshot({ activeRuns: [activeRun('run-1')] })))
    startController()
    await flush()
    await renderPage()

    api.fetchSnapshot.mockRejectedValueOnce(new Error('网络中断'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await flush()

    expect(buttonByText('终止执行')).toBeDefined()
    expect(mocks.setMessage).not.toHaveBeenCalledWith('肉鸽任务已终止', 'warning')
  })

  it('treats a transport failure while submitting as unknown and allows a retry', async () => {
    mocks.executePredefinedTask.mockRejectedValueOnce(new Error('无法连接后端服务'))
    await renderPage()
    await setTheme('Phantom')

    await click(buttonByText('立即执行')!)

    expect(mocks.setMessage).toHaveBeenCalledWith(
      '无法确认执行状态: 无法连接后端服务',
      'warning',
    )
    expect(buttonByText('立即执行')?.disabled).toBe(false)
  })
})

describe('RoguelikeTasks layout and config recovery', () => {
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
    mocks.executePredefinedTask.mockReset()
    mocks.loadUserConfig.mockReset().mockResolvedValue({ success: false })
    mocks.saveUserConfig.mockReset().mockResolvedValue({ success: true })
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
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps mode selection keyboard-navigable and toggles labelled', async () => {
    await renderPage()

    const modeShell = container.querySelector('.roguelike-mode-shell')
    expect(modeShell?.querySelector('[role="toolbar"]')).not.toBeNull()
    const modeButtons = Array.from(modeShell?.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button') ?? [])
    expect(modeButtons.filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)

    const switches = Array.from(container.querySelectorAll<HTMLInputElement>('[role="switch"]'))
    expect(switches).toHaveLength(2)
    switches.forEach(input => {
      const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label'))
        .find(candidate => candidate.htmlFor === input.id)
      expect(label).toBeDefined()
    })

    expect(modeButtons.map(button => button.tabIndex)).toEqual([0, -1])
    modeButtons[0]?.focus()
    await keyDown(modeButtons[0]!, 'End')
    expect(modeButtons[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(modeButtons[1])

    const arrowDownEvent = await keyDown(modeButtons[1]!, 'ArrowDown')
    expect(arrowDownEvent.defaultPrevented).toBe(false)
    expect(modeButtons[1]?.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps mode selection and its configuration panel in sync', async () => {
    await renderPage()

    const reclamationMode = findModeButton('生息演算')
    expect(reclamationMode).toBeDefined()
    await click(reclamationMode!)

    expect(reclamationMode?.getAttribute('aria-pressed')).toBe('true')
    expect(Array.from(container.querySelectorAll('button[aria-pressed="true"]'))
      .filter(button => button.textContent?.includes('生息演算'))).toHaveLength(1)
    expect(container.querySelector('input[name="maa-reclamation-theme"]')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('button[aria-pressed]'))
      .some(option => option.textContent?.includes('沙洲遗闻'))).toBe(true)
  })

  it('keeps per-mode drafts while switching modes', async () => {
    vi.useFakeTimers()
    await renderPage()

    await setTheme('Phantom')
    await click(findModeButton('生息演算')!)
    await setControlValue('input[name="maa-reclamation-theme"]', 'Tales')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    expect(mocks.saveUserConfig).toHaveBeenCalledWith('roguelike-tasks', {
      taskInputs: { roguelike: 'Phantom', reclamation: 'Tales' },
      advancedParams: {},
    })

    await click(findModeButton('集成战略')!)
    expect(container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')?.value)
      .toBe('Phantom')
  })

  it('keeps the selected mode across Activity hide/show and resets it on remount', async () => {
    const renderMode = async (mode: 'visible' | 'hidden') => {
      await act(async () => {
        root.render(
          <Activity mode={mode}>
            <RoguelikeTasks />
          </Activity>,
        )
      })
      await flush()
    }

    await renderMode('visible')
    await click(findModeButton('生息演算')!)
    expect(findModeButton('生息演算')?.getAttribute('aria-pressed')).toBe('true')

    await renderMode('hidden')
    await renderMode('visible')
    expect(findModeButton('生息演算')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('input[name="maa-reclamation-theme"]')).not.toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<RoguelikeTasks />))
    await flush()

    expect(findModeButton('集成战略')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('input[name="maa-roguelike-theme"]')).not.toBeNull()
  })

  it('keeps an unsynced local draft across remounts and retries the save', async () => {
    vi.useFakeTimers()
    mocks.saveUserConfig.mockRejectedValueOnce(new Error('网络连接中断'))
    await renderPage()

    const themeInput = container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(themeInput, 'Phantom')
      themeInput?.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    expect(localStorage.getItem('roguelikeConfigSyncPending')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('roguelikeTaskInputs') || '{}')).toMatchObject({ roguelike: 'Phantom' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络连接中断')

    await act(async () => root.unmount())
    root = createRoot(container)
    mocks.loadUserConfig.mockClear()
    await act(async () => root.render(<RoguelikeTasks />))
    await flush()

    expect(mocks.loadUserConfig).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')?.value).toBe('Phantom')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('尚未同步到服务器')

    await click(buttonByText('重新同步')!)

    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('roguelikeConfigSyncPending')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.setMessage).toHaveBeenCalledWith('肉鸽配置已同步', 'success')
  })

  it('keeps a manual retry single-flight and announces success only after confirmation', async () => {
    vi.useFakeTimers()
    mocks.saveUserConfig.mockRejectedValueOnce(new Error('网络连接中断'))
    await renderPage()

    const themeInput = container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(themeInput, 'Phantom')
      themeInput.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('网络连接中断')
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    // 自动保存成功不弹成功提示；只有用户主动重试确认后才提示。
    expect(mocks.setMessage).not.toHaveBeenCalledWith('肉鸽配置已同步', 'success')

    const retrySave = deferred<{ success: boolean }>()
    mocks.saveUserConfig.mockReturnValueOnce(retrySave.promise)
    await click(buttonByText('重新同步')!)
    expect(buttonByText('同步中')?.disabled).toBe(true)

    // 重试请求在途时再次点击不会产生第二个提交。
    await click(buttonByText('同步中')!)
    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(2)
    expect(mocks.setMessage).not.toHaveBeenCalledWith('肉鸽配置已同步', 'success')

    await act(async () => retrySave.resolve({ success: true }))
    await flush()

    expect(localStorage.getItem('roguelikeConfigSyncPending')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.setMessage).toHaveBeenCalledWith('肉鸽配置已同步', 'success')
  })

  it('prefers an unsynced local draft from a previous session without reading the server', async () => {
    localStorage.setItem('roguelikeConfigSyncPending', 'previous-session-token')
    localStorage.setItem('roguelikeTaskInputs', JSON.stringify({ roguelike: 'Sarkaz' }))
    localStorage.setItem('roguelikeAdvancedParams', JSON.stringify({ roguelike: { mode: '1' } }))
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskInputs: { roguelike: 'Sami' }, advancedParams: {} },
    })

    await renderPage()

    expect(mocks.loadUserConfig).not.toHaveBeenCalled()
    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')?.value).toBe('Sarkaz')
    expect(container.querySelector<HTMLSelectElement>('select[name="maa-roguelike-mode"]')?.value).toBe('1')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('尚未同步到服务器')
  })

  it('drops a pending marker whose local draft is unreadable and falls back to the server', async () => {
    localStorage.setItem('roguelikeTaskInputs', '{not-json')
    localStorage.setItem('roguelikeConfigSyncPending', 'stale-token')
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskInputs: { roguelike: 'Sami' }, advancedParams: {} },
    })

    await renderPage()

    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
    expect(localStorage.getItem('roguelikeConfigSyncPending')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')?.value).toBe('Sami')
  })

  it('keeps the hydrated draft and skips config reload after Activity restore', async () => {
    vi.useFakeTimers()
    mocks.loadUserConfig.mockResolvedValueOnce({
      success: true,
      data: { taskInputs: { roguelike: 'Phantom' }, advancedParams: {} },
    })
    const renderMode = async (mode: 'visible' | 'hidden') => {
      await act(async () => {
        root.render(
          <Activity mode={mode}>
            <RoguelikeTasks />
          </Activity>,
        )
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    await renderMode('visible')
    const themeInput = container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(themeInput, 'Sami')
      themeInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await renderMode('hidden')
    await renderMode('visible')
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await flush()

    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('input[name="maa-roguelike-theme"]')?.value).toBe('Sami')
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()

    await renderMode('hidden')
    await renderMode('visible')
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await flush()
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
  })

  it('associates every form control with a label', async () => {
    await renderPage()

    const controls = Array.from(container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'))
    expect(controls.length).toBeGreaterThan(0)
    controls.forEach(control => {
      expect(control.id).not.toBe('')
      const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label'))
        .find(candidate => candidate.htmlFor === control.id || candidate.contains(control))
      expect(label).toBeDefined()
    })
  })
})
