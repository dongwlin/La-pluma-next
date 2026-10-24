// @vitest-environment jsdom

import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AutomationTasks from './AutomationTasks'
import type { TaskFlowItem } from '../types'

// Keep the real Framer Motion lifecycle: mocking AnimatePresence hides this regression.
const mocks = vi.hoisted(() => ({ status: vi.fn(), execute: vi.fn() }))
const flow: TaskFlowItem[] = [
  ['startup', '启动游戏'], ['infrast', '基建换班'], ['fight', '理智作战'],
  ['recruit', '自动公招'], ['mall', '信用收支'], ['award', '领取奖励'],
].map(([command, name]) => ({
  id: `${command}-1`, commandId: command as TaskFlowItem['commandId'], name: name!,
  icon: null, description: '任务说明', defaultParams: {}, paramFields: [], params: {}, enabled: true,
}))

vi.mock('@/shared/api', () => ({
  maaApi: {
    getScheduleExecutionStatus: mocks.status,
    executeScheduleNow: mocks.execute,
    loadUserConfig: async () => ({ success: true, data: { taskFlow: flow } }),
    getActivity: async () => ({ success: false }),
    getTaskStatus: async () => ({ success: true, data: { isRunning: false } }),
  },
}))
vi.mock('@/features/training', () => ({
  generateTrainingPlan: vi.fn(),
}))
vi.mock('@/features/runtime-status', () => {
  const store = { setMessage: vi.fn(), setActive: vi.fn() }
  return {
    useStatusStore: () => store,
    FloatingStatusIndicator: () => null,
    useAutomationAvailability: () => ({ isAvailable: true, unavailableMessage: '' }),
  }
})
vi.mock('@/features/device-mirror', () => ({ ScreenMonitor: () => null }))
vi.mock('../components/NotificationSettings', () => ({ default: () => null }))

it('replaces the fight spinner and all later numbers after a six-task run finishes while hidden', async () => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  localStorage.clear()
  let finish!: (result: unknown) => void
  mocks.execute.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  mocks.status.mockResolvedValue({ success: true, data: { isRunning: false } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (mode: 'visible' | 'hidden') => {
    await act(async () => root.render(<Activity mode={mode}><AutomationTasks /></Activity>))
  }
  try {
    await render('visible')
    await act(async () => container.querySelector<HTMLButtonElement>('.automation-run-button')?.click())
    mocks.status.mockResolvedValue({ success: true, data: {
      isRunning: true, currentTaskId: 'fight-1', taskResults: flow.map((task, index) => ({
        taskId: task.id, task: task.name, status: index < 2 ? 'success' : index === 2 ? 'running' : 'pending',
      })),
    } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
    expect(container.querySelectorAll('.automation-sequence-progress')).toHaveLength(1)
    await render('hidden')
    const summary = {
      successCount: 6, failedCount: 0, skippedCount: 0, durationMs: 1000,
      taskResults: flow.map(task => ({ taskId: task.id, task: task.name, status: 'success' })),
      summaries: [], reports: [], actions: [], errors: [], warnings: [],
    }
    mocks.status.mockResolvedValue({ success: true, data: { isRunning: false, lastResult: summary } })
    await act(async () => finish({ success: true, data: { summary } }))
    await render('visible')
    expect(container.querySelectorAll('.automation-sequence-item.is-completed')).toHaveLength(6)
    expect(container.querySelectorAll('.automation-sequence-node .lucide-check')).toHaveLength(6)
    expect(container.querySelectorAll('.automation-sequence-progress')).toHaveLength(0)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
