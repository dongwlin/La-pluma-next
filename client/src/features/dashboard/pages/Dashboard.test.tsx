// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as taskExecutionModule from '@/features/task-execution'
import type { AgentRun, ExecutionController, RunSnapshot } from '@/features/task-execution'
import { useDashboardStore } from '../store/dashboardStore'
import { useStatusStore } from '@/features/runtime-status'
import Dashboard from './Dashboard'
import { DASHBOARD_REFRESH_INTERVAL_MS } from '../constants'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  getTaskStatus: vi.fn(),
  getDeviceStats: vi.fn(),
  getActivity: vi.fn(),
  getScheduleExecutionStatus: vi.fn(),
  loadUserConfig: vi.fn(),
  executeScheduleNow: vi.fn(),
  runCurrentActivity: vi.fn(),
  getTrainingQueue: vi.fn(),
  getTodayDrops: vi.fn(),
  getOpenTodayStages: vi.fn(),
  executionApi: {
    fetchSnapshot: vi.fn(),
    fetchRun: vi.fn(),
    stopRun: vi.fn(),
  },
  controllerRef: { current: null as ExecutionController | null },
}))
const renderSpies = vi.hoisted(() => ({
  dashboardSkeleton: vi.fn(),
}))

vi.mock('@/features/automation', () => ({
  getActivity: apiMocks.getActivity,
  getScheduleExecutionStatus: apiMocks.getScheduleExecutionStatus,
  executeScheduleNow: apiMocks.executeScheduleNow,
  runCurrentActivity: apiMocks.runCurrentActivity,
}))

vi.mock('@/features/device-mirror', () => ({
  getDeviceStats: apiMocks.getDeviceStats,
}))

// 真实 ExecutionController + 假 API：Dashboard 的执行接线按应用级控制器行为回归，
// 网络请求、身份存储与轮询节奏由测试控制，每个用例拿到独立控制器。
vi.mock('@/features/task-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/task-execution')>()
  const createController = () => {
    const controller = new actual.ExecutionController({
      api: apiMocks.executionApi,
      storage: null,
      intervals: { active: 60_000, idle: 60_000, disconnected: 60_000 },
    })
    apiMocks.controllerRef.current = controller
    return controller
  }
  const facade = {
    getState: () => apiMocks.controllerRef.current!.getState(),
    subscribe: (listener: () => void) => apiMocks.controllerRef.current!.subscribe(listener),
    start: () => apiMocks.controllerRef.current!.start(),
    submitExecution: (...args: Parameters<ExecutionController['submitExecution']>) =>
      apiMocks.controllerRef.current!.submitExecution(...args),
    stopTrackedRun: () => apiMocks.controllerRef.current!.stopTrackedRun(),
    refresh: () => apiMocks.controllerRef.current!.refresh('manual'),
    observeRun: (...args: Parameters<ExecutionController['observeRun']>) =>
      apiMocks.controllerRef.current!.observeRun(...args),
  }

  return {
    ...actual,
    getTaskStatus: apiMocks.getTaskStatus,
    executionController: facade,
    useExecutionSnapshot: (target: ExecutionController = facade as unknown as ExecutionController) =>
      actual.useExecutionSnapshot(target),
    __createExecutionController: createController,
  }
})

vi.mock('@/features/user-config', () => ({
  loadUserConfig: apiMocks.loadUserConfig,
}))

vi.mock('@/features/statistics', () => ({
  getTodayDrops: apiMocks.getTodayDrops,
  getOpenTodayStages: apiMocks.getOpenTodayStages,
}))

vi.mock('@/features/training', () => ({
  getTrainingQueue: apiMocks.getTrainingQueue,
}))

vi.mock('../hooks/useDashboardFlowLayout', () => ({
  useDashboardFlowLayout: () => ({
    flowGridRef: { current: null },
    flowCardRef: { current: null },
    flowPreviewRef: { current: null },
    flowGridStyle: undefined,
  }),
}))

vi.mock('../components/DashboardPreviewEntry', () => ({ default: () => <div>preview</div> }))
vi.mock('@/features/runtime-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/runtime-status')>()
  return { ...actual, FloatingStatusIndicator: () => null }
})
vi.mock('@/shared/ui/Icons', () => {
  const Icon = () => null
  return { default: new Proxy({}, { get: () => Icon }) }
})
vi.mock('../components/DashboardSkeleton', () => ({
  DashboardSkeleton: () => {
    renderSpies.dashboardSkeleton()
    return <div>loading</div>
  },
}))
vi.mock('@/shared/ui', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <header><h1>{title}</h1>{actions}</header>,
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SmoothPanel: ({
    children,
    className = '',
    cornerSize: _cornerSize,
    surfaceClassName = '',
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { cornerSize?: string; surfaceClassName?: string }) => (
    <div className={`smooth-panel-shell ${className}`} {...props}>
      <div className={`smooth-panel-surface ${surfaceClassName}`}>{children}</div>
    </div>
  ),
  Button: ({ children, icon: _icon, loading, loadingText, statusKey: _statusKey, variant: _variant, size: _size, className: _className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; loadingText?: React.ReactNode; statusKey?: string; variant?: string; size?: string; icon?: React.ReactNode }) => (
    <button {...props}>{loading ? loadingText : children}</button>
  ),
  IconButton: ({ icon: _icon, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode; variant?: string; size?: string }) => <button {...props} />,
}))

const createExecutionController = (taskExecutionModule as unknown as {
  __createExecutionController: () => ExecutionController
}).__createExecutionController

let online = true
let container: HTMLDivElement
let root: Root
let releaseExecution: (() => void) | null = null
let trackedRunState: AgentRun

const findButton = (text: string) => Array.from(container.querySelectorAll('button'))
  .find(button => button.textContent?.includes(text))

const ok = (data: unknown) => ({ success: true, data })

function buildRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: 'run-daily',
    operationId: 'run_daily_flow',
    state: 'running',
    links: {
      self: '/api/agent/runs/run-daily',
      stop: '/api/agent/actions/stop?runId=run-daily',
    },
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

function controller() {
  const current = apiMocks.controllerRef.current
  if (!current) throw new Error('执行控制器尚未创建')
  return current
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderDashboard() {
  root.render(
    <MemoryRouter initialEntries={['/app/dashboard']}>
      <Dashboard />
      <LocationProbe />
    </MemoryRouter>,
  )
}

async function flushDashboard() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Dashboard connectivity state', () => {
  beforeEach(() => {
    online = true
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => online,
    })
    trackedRunState = buildRun({ progress: { currentTask: '收取信用' } })
    apiMocks.getTaskStatus.mockResolvedValue({ success: true, data: { isRunning: false } })
    apiMocks.getDeviceStats.mockResolvedValue({ success: false })
    apiMocks.getActivity.mockResolvedValue({ success: true, data: { available: true, name: '测试活动' } })
    apiMocks.getScheduleExecutionStatus.mockResolvedValue({ success: true, data: { isRunning: false } })
    apiMocks.getTrainingQueue.mockResolvedValue({ success: true, data: { queue: [] } })
    apiMocks.getTodayDrops.mockResolvedValue({ success: true, data: [] })
    apiMocks.getOpenTodayStages.mockResolvedValue({ success: true, data: { open: [], closed: [] } })
    apiMocks.loadUserConfig.mockResolvedValue({
      success: true,
      data: { taskFlow: [{ id: 'startup-1', commandId: 'startup', name: '启动游戏', params: {}, enabled: true }] },
    })
    apiMocks.executeScheduleNow.mockResolvedValue(ok({
      runId: 'run-daily',
      state: 'running',
      accepted: true,
      run: trackedRunState,
    }))
    apiMocks.runCurrentActivity.mockResolvedValue(ok({ runId: 'run-activity', state: 'succeeded', executed: true }))
    apiMocks.executionApi.fetchSnapshot.mockImplementation(async () => ok(buildSnapshot()))
    apiMocks.executionApi.fetchRun.mockImplementation(async (runId: string) => ok({ ...trackedRunState, runId }))
    apiMocks.executionApi.stopRun.mockImplementation(async () => ok({
      stopRequested: true,
      deviceStopRequested: true,
      run: { ...trackedRunState, state: 'stopping' },
    }))

    useDashboardStore.getState().reset()
    useStatusStore.getState().clearMessage()
    useStatusStore.getState().applyRunStatus({ phase: 'idle', isRunning: false, runId: null, label: null, detail: null })
    useStatusStore.getState().setBackendStatus('unknown')
    releaseExecution = createExecutionController().start()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    releaseExecution?.()
    releaseExecution = null
    useDashboardStore.getState().reset()
    useStatusStore.getState().clearMessage()
    useStatusStore.getState().applyRunStatus({ phase: 'idle', isRunning: false, runId: null, label: null, detail: null })
    useStatusStore.getState().setBackendStatus('unknown')
    vi.clearAllMocks()
  })

  it('uses the full dashboard skeleton only for the first uncached load', async () => {
    let resolveActivity: ((value: { success: boolean; data: { available: boolean; name: string } }) => void) | undefined
    apiMocks.getActivity.mockReturnValueOnce(new Promise(resolve => {
      resolveActivity = resolve
    }))

    await act(async () => renderDashboard())

    expect(container.textContent).toContain('loading')
    expect(renderSpies.dashboardSkeleton).toHaveBeenCalled()

    await act(async () => resolveActivity?.({ success: true, data: { available: true, name: '首次活动' } }))
    await flushDashboard()

    expect(container.textContent).not.toContain('loading')
    expect(container.textContent).toContain('首次活动')
  })

  it('restores a fresh dashboard cache immediately without returning to the skeleton', async () => {
    apiMocks.getActivity.mockResolvedValueOnce({ success: true, data: { available: true, name: '缓存活动' } })

    await act(async () => renderDashboard())
    await flushDashboard()

    expect(container.textContent).toContain('缓存活动')
    const skeletonRenders = renderSpies.dashboardSkeleton.mock.calls.length

    await act(async () => root.render(<div>其他页面</div>))
    apiMocks.getActivity.mockClear()
    await act(async () => renderDashboard())

    expect(container.textContent).toContain('缓存活动')
    expect(container.textContent).not.toContain('loading')
    expect(renderSpies.dashboardSkeleton).toHaveBeenCalledTimes(skeletonRenders)
    expect(apiMocks.getActivity).not.toHaveBeenCalled()
  })

  it('keeps stale content visible while refreshing it in the background', async () => {
    apiMocks.getActivity.mockResolvedValueOnce({ success: true, data: { available: true, name: '缓存活动' } })

    await act(async () => renderDashboard())
    await flushDashboard()
    useDashboardStore.setState({
      lastRefreshAttemptAt: Date.now() - DASHBOARD_REFRESH_INTERVAL_MS,
    })

    let resolveActivity: ((value: { success: boolean; data: { available: boolean; name: string } }) => void) | undefined
    apiMocks.getActivity.mockReturnValueOnce(new Promise(resolve => {
      resolveActivity = resolve
    }))
    const skeletonRenders = renderSpies.dashboardSkeleton.mock.calls.length

    await act(async () => root.render(<div>其他页面</div>))
    await act(async () => renderDashboard())

    expect(container.textContent).toContain('缓存活动')
    expect(container.textContent).not.toContain('loading')
    expect(renderSpies.dashboardSkeleton).toHaveBeenCalledTimes(skeletonRenders)
    expect(apiMocks.getActivity).toHaveBeenCalledTimes(2)

    await act(async () => resolveActivity?.({ success: true, data: { available: true, name: '更新活动' } }))
    await flushDashboard()

    expect(container.textContent).toContain('更新活动')
  })

  it('keeps the last complete snapshot when one background request fails', async () => {
    apiMocks.getActivity.mockResolvedValueOnce({ success: true, data: { available: true, name: '已确认活动' } })

    await act(async () => renderDashboard())
    await flushDashboard()
    const lastSuccessfulUpdate = useDashboardStore.getState().lastUpdate
    const persistedSnapshot = window.localStorage.getItem('la-pluma-dashboard-cache')
    useDashboardStore.setState({
      lastRefreshAttemptAt: Date.now() - DASHBOARD_REFRESH_INTERVAL_MS,
    })

    apiMocks.getActivity.mockResolvedValueOnce({ success: true, data: { available: true, name: '未确认活动' } })
    apiMocks.getTodayDrops.mockResolvedValueOnce({ success: false, message: '暂时不可用' })

    await act(async () => root.render(<div>其他页面</div>))
    await act(async () => renderDashboard())
    await flushDashboard()

    expect(container.textContent).toContain('已确认活动')
    expect(container.textContent).not.toContain('未确认活动')
    expect(useDashboardStore.getState().lastUpdate).toBe(lastSuccessfulUpdate)
    expect(window.localStorage.getItem('la-pluma-dashboard-cache')).toBe(persistedSnapshot)
  })

  it('keeps the last complete snapshot when a successful response has malformed data', async () => {
    apiMocks.getActivity.mockResolvedValueOnce({ success: true, data: { available: true, name: '稳定活动' } })

    await act(async () => renderDashboard())
    await flushDashboard()
    const lastSuccessfulUpdate = useDashboardStore.getState().lastUpdate
    const persistedSnapshot = window.localStorage.getItem('la-pluma-dashboard-cache')
    useDashboardStore.setState({
      lastRefreshAttemptAt: Date.now() - DASHBOARD_REFRESH_INTERVAL_MS,
    })

    apiMocks.getActivity.mockResolvedValueOnce({ success: true, data: { available: true, name: '异常活动' } })
    apiMocks.getOpenTodayStages.mockResolvedValueOnce({ success: true, data: undefined })

    await act(async () => root.render(<div>其他页面</div>))
    await act(async () => renderDashboard())
    await flushDashboard()

    expect(container.textContent).toContain('稳定活动')
    expect(container.textContent).not.toContain('异常活动')
    expect(useDashboardStore.getState().lastUpdate).toBe(lastSuccessfulUpdate)
    expect(window.localStorage.getItem('la-pluma-dashboard-cache')).toBe(persistedSnapshot)
  })

  it('keeps the most recent device sample when a later sample fails', async () => {
    vi.useFakeTimers()
    apiMocks.getDeviceStats.mockResolvedValue({ success: true, data: { cpuPct: 42, temp: 38 } })

    await act(async () => renderDashboard())
    await flushDashboard()
    expect(container.textContent).toContain('38°C')

    apiMocks.getDeviceStats.mockResolvedValue({ success: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    await flushDashboard()

    expect(container.textContent).toContain('38°C')
    expect(useDashboardStore.getState().deviceStats?.temp).toBe(38)
  })

  it('disables execution actions as soon as the browser goes offline', async () => {
    await act(async () => renderDashboard())
    await flushDashboard()

    expect(container.textContent).toContain('准备就绪')
    expect(findButton('开始今日流程')?.disabled).toBe(false)
    expect(findButton('打当前活动')?.disabled).toBe(false)

    online = false
    act(() => window.dispatchEvent(new Event('offline')))

    expect(container.textContent).toContain('当前网络离线')
    expect(findButton('开始今日流程')?.disabled).toBe(true)
    expect(findButton('打当前活动')?.disabled).toBe(true)
  })

  it('shows a retry action and recovers after the backend becomes available', async () => {
    apiMocks.getTaskStatus.mockRejectedValueOnce(new Error('无法连接后端服务，请确认服务已启动'))

    await act(async () => renderDashboard())
    await flushDashboard()

    expect(container.textContent).toContain('后端服务不可用')
    expect(container.textContent).toContain('测试活动')
    expect(useDashboardStore.getState().lastUpdate).not.toBeNull()
    expect(findButton('重试连接')).toBeDefined()
    expect(findButton('开始今日流程')?.disabled).toBe(true)
    expect(findButton('打当前活动')?.disabled).toBe(true)

    await act(async () => findButton('重试连接')?.click())
    await flushDashboard()

    expect(container.textContent).toContain('准备就绪')
    expect(findButton('开始今日流程')?.disabled).toBe(false)
    expect(findButton('打当前活动')?.disabled).toBe(false)
  })

  it('omits redundant manual refresh controls', async () => {
    await act(async () => renderDashboard())
    await flushDashboard()

    expect(findButton('刷新数据')).toBeUndefined()
    expect(container.querySelector('.dashboard-mobile-refresh')).toBeNull()
    expect(container.querySelector('button[aria-label="刷新执行状态"]')).toBeNull()
  })

  it('navigates to the destination tab from dashboard shortcuts', async () => {
    await act(async () => renderDashboard())
    await flushDashboard()

    await act(async () => findButton('添加首个培养目标')?.click())

    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/app/training')
  })

  it('activates the status beam for a run projected from the execution snapshot', async () => {
    const activeRun = buildRun({ runId: 'run-external-domain', operationId: 'run_copilot_set' })
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot({
      run: activeRun,
      activeRuns: [activeRun],
      occupancy: 'run',
    })))

    await act(async () => controller().refresh())
    await act(async () => renderDashboard())
    await flushDashboard()

    const flow = container.querySelector('.dashboard-flow-glow-shell')
    expect(flow?.getAttribute('aria-busy')).toBe('true')
    expect(findButton('正在运行')?.disabled).toBe(true)
    expect(useStatusStore.getState().runStatus.phase).toBe('idle')
  })

  it('shows immediate preflight feedback while checking the current activity', async () => {
    trackedRunState = buildRun({
      runId: 'run-activity',
      operationId: 'run_current_activity_copilots',
      state: 'succeeded',
    })
    let resolveRun: ((value: {
      success: boolean
      data: { runId: string; state: string; executed: boolean; plan: { reason: string } }
    }) => void) | undefined
    apiMocks.runCurrentActivity.mockReturnValueOnce(new Promise(resolve => {
      resolveRun = resolve
    }))

    await act(async () => renderDashboard())
    await flushDashboard()

    const activityButton = container.querySelector<HTMLButtonElement>('button[aria-label="打当前活动"]')
    await act(async () => {
      activityButton?.click()
      await Promise.resolve()
    })

    const flow = container.querySelector('.dashboard-flow-glow-shell')
    const status = useStatusStore.getState()
    expect(apiMocks.runCurrentActivity).toHaveBeenCalledTimes(1)
    expect(activityButton?.disabled).toBe(true)
    expect(activityButton?.textContent).toContain('检查中')
    expect(flow?.getAttribute('aria-busy')).toBe('true')
    expect(status.message).toContain('当前活动')
    expect(status.messageType).toBe('info')

    await act(async () => resolveRun?.({
      success: true,
      data: {
        runId: 'run-activity',
        state: 'succeeded',
        executed: false,
        plan: { reason: '测试结束' },
      },
    }))
    await flushDashboard()
  })

  it('surfaces the exact activity preflight blocker as a warning', async () => {
    const blocker = 'AD「红丝绒」的资源未包含从主页进入活动关卡的完整导航链。'
    trackedRunState = buildRun({
      runId: 'run-activity',
      operationId: 'run_current_activity_copilots',
      state: 'succeeded',
    })
    apiMocks.runCurrentActivity.mockResolvedValueOnce(ok({
      runId: 'run-activity',
      state: 'succeeded',
      executed: false,
      plan: { reason: blocker },
    }))

    await act(async () => renderDashboard())
    await flushDashboard()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="打当前活动"]')?.click()
    })
    await flushDashboard()

    const flow = container.querySelector('.dashboard-flow-glow-shell')
    const feedback = container.querySelector('[data-dashboard-flow-feedback]')
    const status = useStatusStore.getState()
    expect(feedback?.textContent).toBe(blocker)
    expect(status.message).toBe(blocker)
    expect(status.messageType).toBe('warning')
    expect(flow?.getAttribute('aria-busy')).toBe('false')
  })

  it('submits the daily flow once as an async run with a dashboard scope key', async () => {
    let resolveSubmit: ((value: { success: boolean; data: unknown }) => void) | undefined
    apiMocks.executeScheduleNow.mockReturnValueOnce(new Promise(resolve => {
      resolveSubmit = resolve
    }))

    await act(async () => renderDashboard())
    await flushDashboard()

    const action = findButton('开始今日流程')
    await act(async () => {
      action?.click()
      action?.click()
      await Promise.resolve()
    })

    expect(apiMocks.executeScheduleNow).toHaveBeenCalledTimes(1)
    const [scheduleId, flow, options] = apiMocks.executeScheduleNow.mock.calls[0]!
    expect(scheduleId).toBe('dashboard-quick-start')
    expect(flow).toEqual([{ id: 'startup-1', commandId: 'startup', name: '启动游戏', params: {}, enabled: true }])
    expect(options.waitForCompletion).toBe(false)
    expect(options.idempotencyKey).toMatch(/^run_daily_flow-/)
    expect(findButton('启动中')?.disabled).toBe(true)

    await act(async () => resolveSubmit?.(ok({
      runId: 'run-daily',
      state: 'running',
      accepted: true,
      run: trackedRunState,
    })))
    await flushDashboard()

    expect(container.querySelector('[data-dashboard-flow-feedback]')?.textContent).toBe('今日流程已开始执行')
    expect(findButton('正在运行')?.disabled).toBe(true)
    expect(controller().getState().trackedScope).toBe('dashboard')
  })

  it('observes the accepted daily flow until its terminal state', async () => {
    await act(async () => renderDashboard())
    await flushDashboard()

    await act(async () => findButton('开始今日流程')?.click())
    await flushDashboard()
    expect(container.textContent).toContain('正在执行: 收取信用')

    const terminalRun = buildRun({
      state: 'succeeded',
      result: { message: '今日流程执行完成', summary: { successCount: 2, failedCount: 0, skippedCount: 0, durationMs: 1000 } },
    })
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot({
      lastRun: terminalRun,
      occupancy: 'idle',
    })))
    await act(async () => controller().refresh())
    await flushDashboard()

    expect(useStatusStore.getState().message).toBe('今日流程执行完成')
    expect(useStatusStore.getState().messageType).toBe('success')
    expect(container.textContent).toContain('准备就绪')
    expect(findButton('开始今日流程')?.disabled).toBe(false)
  })

  it('lets another domain stop the dashboard run while keeping the global state consistent', async () => {
    await act(async () => renderDashboard())
    await flushDashboard()
    await act(async () => findButton('开始今日流程')?.click())
    await flushDashboard()
    expect(findButton('正在运行')?.disabled).toBe(true)

    // 另一个页面通过共享控制器按 runId 停止；Dashboard 只是观察者，不再发送第二次停止。
    trackedRunState = buildRun({ state: 'stopping' })
    await act(async () => {
      await controller().stopTrackedRun()
    })
    await flushDashboard()
    expect(apiMocks.executionApi.stopRun).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('正在停止')

    const stoppedRun = buildRun({ state: 'stopped', result: { message: '今日流程已停止' } })
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot({ lastRun: stoppedRun })))
    await act(async () => controller().refresh())
    await flushDashboard()

    expect(useStatusStore.getState().message).toBe('今日流程已停止')
    expect(useStatusStore.getState().messageType).toBe('warning')
    expect(container.textContent).toContain('准备就绪')
  })

  it('does not claim a run started by another domain as the dashboard flow', async () => {
    const foreignRun = buildRun({ runId: 'run-automation', operationId: 'run_daily_flow' })
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot({
      run: foreignRun,
      activeRuns: [foreignRun],
      occupancy: 'run',
    })))
    await act(async () => controller().refresh())

    await act(async () => renderDashboard())
    await flushDashboard()
    expect(container.textContent).toContain('任务执行中')
    expect(findButton('正在运行')?.disabled).toBe(true)

    // 该 run 结束但不属于本页：不产生“今日流程”终态提示，只回到空闲。
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot()))
    await act(async () => controller().refresh())
    await flushDashboard()

    expect(useStatusStore.getState().message).toBe('')
    expect(container.textContent).toContain('准备就绪')
  })

  it('reports unmanaged device occupancy and keeps the start entries disabled', async () => {
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot({ occupancy: 'external' })))
    await act(async () => controller().refresh())

    await act(async () => renderDashboard())
    await flushDashboard()

    expect(container.textContent).toContain('设备被其他任务占用')
    expect(findButton('开始今日流程')?.disabled).toBe(true)
    expect(findButton('打当前活动')?.disabled).toBe(true)
  })

  it('keeps the unknown phase and the last active run when observation disconnects', async () => {
    const activeRun = buildRun()
    apiMocks.executionApi.fetchSnapshot.mockResolvedValue(ok(buildSnapshot({
      run: activeRun,
      activeRuns: [activeRun],
      occupancy: 'run',
    })))
    await act(async () => controller().refresh())

    await act(async () => renderDashboard())
    await flushDashboard()

    apiMocks.executionApi.fetchSnapshot.mockRejectedValue(new Error('网络中断'))
    await act(async () => controller().refresh())
    await flushDashboard()

    expect(container.textContent).toContain('执行状态未知')
    expect(container.textContent).toContain('网络中断')
    expect(findButton('开始今日流程')?.disabled).toBe(true)
    expect(useStatusStore.getState().message).toBe('')
  })
})
