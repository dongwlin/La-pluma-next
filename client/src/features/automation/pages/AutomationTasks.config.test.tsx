// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutomationTasks from './AutomationTasks'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
  getTaskStatus: vi.fn(),
  generateTrainingPlan: vi.fn(),
  loadUserConfig: vi.fn(),
  saveUserConfig: vi.fn(),
  setupSchedule: vi.fn(),
  stopSchedule: vi.fn(),
  testConnection: vi.fn(),
  executeScheduleNow: vi.fn(),
  setActive: vi.fn(),
  setMessage: vi.fn(),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  type MotionTestProps = Record<string, unknown> & { children?: ReactNode }
  const motionComponent = (tag: 'div' | 'span') => React.forwardRef<HTMLElement, MotionTestProps>(
    ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, layout: _layout, ...props }, ref) =>
      React.createElement(tag, { ...props, ref }, children as ReactNode),
  )

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: {
      div: motionComponent('div'),
      span: motionComponent('span'),
    },
    useReducedMotion: () => true,
  }
})

vi.mock('../api', () => ({
  getActivity: mocks.getActivity,
  getScheduleExecutionStatus: mocks.getScheduleExecutionStatus,
  setupSchedule: mocks.setupSchedule,
  stopSchedule: mocks.stopSchedule,
  executeScheduleNow: mocks.executeScheduleNow,
}))

vi.mock('@/features/task-execution', async () => {
  const actual = await vi.importActual<typeof import('@/features/task-execution')>('@/features/task-execution')
  const state = {
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
  }
  const controller = {
    getState: () => state,
    subscribe: () => () => {},
    submitExecution: vi.fn(),
    stopTrackedRun: vi.fn(),
    observeRun: vi.fn(),
    refresh: vi.fn(),
  }
  return {
    ...actual,
    executionController: controller,
    useExecutionSnapshot: () => state,
  }
})

vi.mock('@/features/user-config', () => ({
  loadUserConfig: mocks.loadUserConfig,
  saveUserConfig: mocks.saveUserConfig,
}))

vi.mock('@/features/settings', () => ({ testConnection: mocks.testConnection }))
vi.mock('@/features/training', () => ({ generateTrainingPlan: mocks.generateTrainingPlan }))

vi.mock('@/features/runtime-status', () => ({
  useStatusStore: () => ({ setMessage: mocks.setMessage, setActive: mocks.setActive }),
  FloatingStatusIndicator: () => null,
  useAutomationAvailability: () => ({ isAvailable: true, unavailableMessage: '' }),
}))

vi.mock('@/features/device-mirror', () => ({ ScreenMonitor: () => <div data-testid="screen-monitor" /> }))
vi.mock('../components/NotificationSettings', () => ({ default: () => <div /> }))

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

const taskFlowFixture = [
  {
    id: 'startup-1',
    commandId: 'startup',
    name: '启动游戏',
    description: '启动游戏并进入主界面',
    enabled: true,
    params: { clientType: 'Official', accountName: '' },
  },
  {
    id: 'fight-1',
    commandId: 'fight',
    name: '理智作战',
    description: '自动刷关卡消耗理智',
    enabled: true,
    params: { stages: [{ stage: '1-7', times: '1' }], drops: '', medicine: 0, expiringMedicine: 0, stone: 0, series: '1', clientType: '' },
  },
]

let container: HTMLDivElement
let root: Root
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

const click = async (element: HTMLElement) => {
  await act(async () => element.click())
  await settle()
}

const scheduleSwitch = () => container.querySelector<HTMLInputElement>('[aria-label="定时执行"]')!
const pendingDraft = () => localStorage.getItem('automationConfigSyncPending')

const renderAutomation = async () => {
  await act(async () => root.render(<AutomationTasks />))
  await settle()
}

describe('AutomationTasks config persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
    localStorage.clear()
    mocks.getActivity.mockReset().mockResolvedValue({ success: false })
    mocks.getScheduleExecutionStatus.mockReset().mockResolvedValue({ success: true, data: { isRunning: false } })
    mocks.getTaskStatus.mockReset().mockResolvedValue({ success: true, data: { isRunning: false } })
    mocks.generateTrainingPlan.mockReset().mockResolvedValue({ success: false })
    mocks.loadUserConfig.mockReset().mockResolvedValue({ success: true, data: { taskFlow: [] } })
    mocks.saveUserConfig.mockReset().mockResolvedValue({ success: true })
    mocks.setupSchedule.mockReset().mockResolvedValue({ success: true })
    mocks.stopSchedule.mockReset().mockResolvedValue({ success: true })
    mocks.testConnection.mockReset().mockResolvedValue({ success: true })
    mocks.executeScheduleNow.mockReset()
    mocks.setActive.mockReset()
    mocks.setMessage.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
    }
  })

  it('clears the pending draft only after the config and enabled schedule both succeed', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskFlow: taskFlowFixture, schedule: { enabled: false, times: ['08:00'] } },
    })

    await renderAutomation()
    await click(scheduleSwitch())

    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    const [configType, payload] = mocks.saveUserConfig.mock.calls[0] as [string, {
      taskFlow: unknown[]
      schedule: { enabled: boolean; times: string[] }
    }]
    expect(configType).toBe('automation-tasks')
    expect(payload.schedule).toEqual({ enabled: true, times: ['08:00'] })
    expect(payload.taskFlow).toHaveLength(2)
    expect(mocks.setupSchedule).toHaveBeenCalledWith('default', ['08:00'], payload.taskFlow)
    expect(mocks.stopSchedule).not.toHaveBeenCalled()
    expect(pendingDraft()).toBeNull()
    expect(JSON.parse(localStorage.getItem('maa-schedule') || '{}')).toMatchObject({
      enabled: true,
      times: ['08:00'],
    })
  })

  it('does not touch the server schedule when the config save fails', async () => {
    mocks.loadUserConfig.mockResolvedValue({ success: true, data: { taskFlow: taskFlowFixture } })
    mocks.saveUserConfig.mockResolvedValueOnce({ success: false, message: '配置存储暂不可用' })

    await renderAutomation()
    await click(scheduleSwitch())

    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    expect(mocks.setupSchedule).not.toHaveBeenCalled()
    expect(mocks.stopSchedule).not.toHaveBeenCalled()
    expect(pendingDraft()).not.toBeNull()
    expect(mocks.setMessage).toHaveBeenCalledWith('配置同步失败: 配置存储暂不可用', 'error')
  })

  it('keeps the pending draft when the schedule step fails after the config save, then clears it on a later full success', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskFlow: taskFlowFixture, schedule: { enabled: false, times: ['08:00'] } },
    })
    mocks.setupSchedule.mockResolvedValueOnce({ success: false, message: '排班设置失败' })

    await renderAutomation()
    await click(scheduleSwitch())

    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    expect(mocks.setupSchedule).toHaveBeenCalledOnce()
    expect(pendingDraft()).not.toBeNull()
    expect(mocks.setMessage).toHaveBeenCalledWith('配置同步失败: 排班设置失败', 'error')

    await act(async () => root.unmount())
    root = createRoot(container)
    mocks.loadUserConfig.mockClear()
    await renderAutomation()

    expect(mocks.loadUserConfig).not.toHaveBeenCalled()
    expect(pendingDraft()).not.toBeNull()
    expect(container.textContent).toContain('理智作战')

    await click(scheduleSwitch())
    await settle()

    expect(mocks.stopSchedule).toHaveBeenCalledWith('default')
    expect(pendingDraft()).toBeNull()
  })

  it('bounds the complete unit with a server stop when the schedule is disabled', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskFlow: taskFlowFixture, schedule: { enabled: true, times: ['08:00'] } },
    })

    await renderAutomation()
    await click(scheduleSwitch())

    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()
    const [, payload] = mocks.saveUserConfig.mock.calls[0] as [string, {
      schedule: { enabled: boolean; times: string[] }
    }]
    expect(payload.schedule).toEqual({ enabled: false, times: ['08:00'] })
    expect(mocks.setupSchedule).not.toHaveBeenCalled()
    expect(mocks.stopSchedule).toHaveBeenCalledWith('default')
    expect(pendingDraft()).toBeNull()
  })

  it('stops the server schedule when every entry is disabled', async () => {
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: {
        taskFlow: taskFlowFixture,
        schedule: { enabled: true, entries: [{ time: '08:00', enabled: false }] },
      },
    })

    await renderAutomation()
    const entrySwitch = container.querySelector<HTMLInputElement>('[aria-label="第 1 个执行时间开启"]')!
    await click(entrySwitch)
    mocks.setupSchedule.mockClear()
    await click(entrySwitch)

    const calls = mocks.saveUserConfig.mock.calls
    const [, payload] = calls[calls.length - 1] as [string, {
      schedule: { enabled: boolean; times: string[] }
    }]
    expect(payload.schedule).toEqual({ enabled: true, times: [] })
    expect(mocks.setupSchedule).not.toHaveBeenCalled()
    expect(mocks.stopSchedule).toHaveBeenCalledWith('default')
    expect(pendingDraft()).toBeNull()
  })

  it('does not let a save from the previous mount clear the newer draft', async () => {
    const olderSave = deferred<{ success: boolean }>()
    mocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskFlow: taskFlowFixture, schedule: { enabled: false } },
    })
    mocks.saveUserConfig.mockReturnValueOnce(olderSave.promise)

    await renderAutomation()
    await click(scheduleSwitch())
    expect(mocks.saveUserConfig).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    root = createRoot(container)
    await renderAutomation()

    const newerSave = deferred<{ success: boolean }>()
    mocks.saveUserConfig.mockReturnValueOnce(newerSave.promise)
    await click(scheduleSwitch())
    const newerSyncToken = pendingDraft()
    expect(mocks.saveUserConfig).toHaveBeenCalledTimes(2)
    expect(newerSyncToken).not.toBeNull()

    await act(async () => olderSave.resolve({ success: true }))
    await settle()
    expect(pendingDraft()).toBe(newerSyncToken)

    await act(async () => newerSave.resolve({ success: true }))
    await settle()
    expect(mocks.stopSchedule).toHaveBeenCalledWith('default')
    expect(pendingDraft()).toBeNull()
  })

  it('ignores a server load that settles after the user edits the schedule', async () => {
    const serverLoad = deferred<{
      success: boolean
      data: { taskFlow: typeof taskFlowFixture }
    }>()
    mocks.loadUserConfig.mockReturnValueOnce(serverLoad.promise)

    await renderAutomation()
    await click(scheduleSwitch())

    await act(async () => serverLoad.resolve({ success: true, data: { taskFlow: taskFlowFixture } }))
    await settle()

    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('理智作战')
    expect(JSON.parse(localStorage.getItem('maa-task-flow') || '[]')).toEqual([])
  })

  // Defect reproduction: a pending marker must not outlive its missing local draft.
  // The automation persistence task owns converting this into a normal test.
  it.fails('loads the server copy when a pending marker has no local draft', async () => {
    localStorage.setItem('automationConfigSyncPending', 'stale-token')
    mocks.loadUserConfig.mockResolvedValue({ success: true, data: { taskFlow: taskFlowFixture } })

    await renderAutomation()

    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()
  })

  it('reloads the automation flow when training applies a plan', async () => {
    mocks.loadUserConfig.mockResolvedValue({ success: true, data: { taskFlow: taskFlowFixture } })

    await renderAutomation()
    expect(mocks.loadUserConfig).toHaveBeenCalledOnce()

    await act(async () => {
      window.dispatchEvent(new CustomEvent('training-plan-applied', { detail: { stageCount: 3 } }))
    })
    await settle()

    expect(mocks.loadUserConfig).toHaveBeenCalledTimes(2)
    expect(mocks.setMessage).toHaveBeenCalledWith('智能养成计划已更新：3 个关卡', 'success')
  })
})
