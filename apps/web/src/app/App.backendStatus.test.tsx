// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { useStatusStore } from '@/features/runtime-status'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMocks = vi.hoisted(() => ({
  getTaskStatus: vi.fn(),
}))

vi.mock('@/features/task-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/task-execution')>()
  return {
    ...actual,
    getTaskStatus: apiMocks.getTaskStatus,
    useExecutionObservation: () => undefined,
  }
})

vi.mock('./layout/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('./layout/PWAInstallPrompt', () => ({ default: () => null }))
vi.mock('@/pages/automation/AutomationTasks', async () => {
  const { useStatusStore: useMockStatusStore } = await import('@/features/runtime-status')

  return {
    default: function MockAutomationTasks() {
      const backendStatus = useMockStatusStore(state => state.backendStatus)
      return <button disabled={backendStatus !== 'available'}>非首页执行入口</button>
    },
  }
})

interface ProbeResult {
  success: boolean
  message?: string
  data?: { isRunning: boolean }
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

let container: HTMLDivElement
let root: Root

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App backend status gate', () => {
  beforeEach(() => {
    apiMocks.getTaskStatus.mockReset()
    useStatusStore.getState().setBackendStatus('unknown')
    useStatusStore.getState().applyRunStatus({ phase: 'idle', isRunning: false, runId: null, label: null, detail: null })
    window.history.replaceState({}, '', '/app/automation')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    useStatusStore.getState().setBackendStatus('unknown')
    useStatusStore.getState().applyRunStatus({ phase: 'idle', isRunning: false, runId: null, label: null, detail: null })
  })

  it('keeps a restored non-dashboard page blocked during the global startup probe', async () => {
    const request = deferred<ProbeResult>()
    apiMocks.getTaskStatus.mockReturnValueOnce(request.promise)

    act(() => root.render(<App />))
    await flushEffects()

    const action = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === '非首页执行入口')

    expect(apiMocks.getTaskStatus).toHaveBeenCalledTimes(1)
    expect(useStatusStore.getState().backendStatus).toBe('checking')
    expect(action?.disabled).toBe(true)

    request.reject(new Error('后端服务不可用'))
    await flushEffects()

    expect(useStatusStore.getState().backendStatus).toBe('unavailable')
    expect(action?.disabled).toBe(true)
  })
})
